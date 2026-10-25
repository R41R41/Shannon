/**
 * dc-voice: everything for one guild's VC conversation through the head, wired together:
 *
 *   receiver -> UtteranceCollector (per person) -> STT (the head, Groq) -> TurnQueue (one turn at a time) -> runDcVoiceTurn
 *                  |                                                           |
 *             SpeakerTracker  <-  BargeInMonitor / BackchannelMonitor      SpeechPlayer (one continuous raw stream)
 *                  ^
 *             the mouth (VoiceMouth) waits on it, and speaks through `speakLine`
 *
 * No discord.js here: the Discord pieces (receiver, AudioPlayer, member lookups) arrive through `DcVoiceGuildDeps`,
 * which is what lets the whole thing run against fakes in tests.
 */
import { makeWav, pcm48kStereoTo16kMono } from './pcm.js';
import { BackchannelMonitor } from './backchannel.js';
import { BargeInMonitor } from './bargeIn.js';
import { SpeakerTracker } from './speakerTracker.js';
import { voiceSentence } from './sentenceVoice.js';
import { TurnQueue, type HeardEntry, type TurnItem } from './turnQueue.js';
import { UtteranceCollector, type ReceiverLike, type Utterance } from './utteranceCollector.js';
import type { FillerSource } from './speechFillerStore.js';
import type { SpeechPlayer } from './speechPlayer.js';
import type { MouthHost, MouthLineHandle } from './voiceMouthCore.js';
import type { EventLoopDelayLogger } from './dcVoiceMetrics.js';
import type { ShannonCoreVoiceClient } from '../../integration/shannonCoreVoiceClient.js';
import type { DcVoiceStt } from '../../llm/voice/dcVoiceStt.js';
import { runDcVoiceTurn } from '../../llm/voice/dcVoiceTurn.js';

export interface DcVoiceGuildDeps {
  guildId: string;
  textChannelId: string;
  voiceChannelId: string;
  /** The text channel's own name, for the head to title a conversation nobody bound (one head). */
  title?: () => string | undefined;
  receiver: ReceiverLike;
  /** EndBehaviorType.AfterSilence */
  endBehaviorAfterSilence: number;
  decodeOpus: (packets: Buffer[]) => Buffer;
  isBot: (userId: string) => boolean;
  displayName: (userId: string) => string;
  /** Everybody in the VC except bots. */
  humanIds: () => string[];
  /** Open mic: everyone. PTT: the PTT person only. */
  shouldListen: (userId: string) => boolean;
  player: SpeechPlayer;
  client: ShannonCoreVoiceClient;
  fillers: FillerSource;
  stt: DcVoiceStt;
  voicepeakWav: (text: string) => Promise<Buffer>;
  /** The old path for one utterance; resolves when its playback is over. */
  legacy: (item: TurnItem) => Promise<void>;
  /** Post to the VC's text channel. */
  postText: (text: string) => void;
  /** The mouth, or null when it is switched off. */
  mouth: { attach(host: MouthHost): () => void; getSituation(): string | undefined } | null;
  backchannel: boolean;
  loopMonitor?: EventLoopDelayLogger;
  log: (line: string) => void;
  warn: (line: string) => void;
  now?: () => number;
  /** Test hooks. */
  decisionTimeoutMs?: number;
  drainMs?: number;
}

interface SpeechSpan { start: number; end: number | null }

const FOLLOW_WINDOW_MS = 8_000;

export class DcVoiceGuildSession implements MouthHost {
  readonly guildId: string;
  readonly conversationId: string;
  readonly client: ShannonCoreVoiceClient;
  readonly tracker: SpeakerTracker;
  readonly queue: TurnQueue;
  readonly collector: UtteranceCollector;
  private readonly now: () => number;
  private readonly abort = new AbortController();
  private readonly spans: SpeechSpan[] = [];
  private lastConversationAt = 0;
  private disposed = false;
  private readonly cleanups: Array<() => void> = [];
  private readonly background = new Set<Promise<unknown>>();

  constructor(private readonly deps: DcVoiceGuildDeps) {
    this.guildId = deps.guildId;
    this.conversationId = `discord:${deps.guildId}:${deps.textChannelId}`;
    this.client = deps.client;
    this.now = deps.now ?? Date.now;
    this.tracker = new SpeakerTracker({ now: this.now });
    this.queue = new TurnQueue({
      now: this.now,
      run: async (item) => {
        const result = await runDcVoiceTurn(this.turnEnv(), item);
        this.lastConversationAt = this.now();
        this.track(result.settled);
        return { responded: result.responded };
      },
      onDrop: (item, reason) => deps.warn(`[DcVoice] turn dropped (${reason}) user=${item.userId} chars=${item.text.length}`),
    });
    this.collector = new UtteranceCollector({
      receiver: deps.receiver,
      tracker: this.tracker,
      endBehaviorAfterSilence: deps.endBehaviorAfterSilence,
      decode: deps.decodeOpus,
      isIgnored: deps.isBot,
      shouldCollect: deps.shouldListen,
      onUtterance: (utterance) => this.track(this.handleUtterance(utterance)),
      onDiscard: (info) => deps.log(`[DcVoice] discard user=${info.userId} reason=${info.reason} ms=${Math.round(info.durationMs)}`),
      now: this.now,
      log: deps.warn,
    });
  }

  start(): void {
    this.collector.start();
    // When did Shannon speak? (for `followsShannonTurn`)
    this.cleanups.push(this.deps.player.onSpeakingChange((speaking, kind) => {
      const now = this.now();
      if (speaking) {
        this.spans.push({ start: now, end: null });
        if (this.spans.length > 30) this.spans.shift();
      } else {
        const open = [...this.spans].reverse().find(span => span.end === null);
        if (open) open.end = now;
        if (kind !== 'backchannel') this.lastConversationAt = now;
      }
    }));
    const barge = new BargeInMonitor({
      tracker: this.tracker,
      player: this.deps.player,
      shouldListen: this.deps.shouldListen,
      now: this.now,
      onBargeIn: ({ userId, report }) => this.deps.log(
        `[DcVoice] barge-in user=${userId} playedMs=${report.playedMs} spokenChars=${report.spokenText.length}`,
      ),
    });
    this.cleanups.push(() => barge.dispose());
    if (this.deps.backchannel) {
      const backchannel = new BackchannelMonitor({
        tracker: this.tracker,
        collector: this.collector,
        player: this.deps.player,
        fillers: this.deps.fillers,
        shouldListen: this.deps.shouldListen,
        humanCount: () => this.deps.humanIds().length,
        lastConversationAt: () => this.lastConversationAt,
        now: this.now,
        log: this.deps.log,
      });
      this.cleanups.push(() => backchannel.dispose());
    }
    if (this.deps.mouth) this.cleanups.push(this.deps.mouth.attach(this));
    if (this.deps.loopMonitor) this.cleanups.push(this.deps.loopMonitor.acquire());
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.abort.abort();
    for (const cleanup of this.cleanups.splice(0)) {
      try { cleanup(); } catch { /* best effort */ }
    }
    this.collector.dispose();
    this.queue.dispose();
    this.deps.player.dispose();
  }

  /** Resolves when all work started so far (STT, turns, drains) has settled. Tests. */
  async idle(): Promise<void> {
    while (this.background.size > 0) await Promise.allSettled([...this.background]);
  }

  // ── MouthHost ─────────────────────────────────────────────────────────────

  conversationActive(): boolean { return this.queue.isActive(); }

  playbackBusy(): boolean { return this.deps.player.current() !== null; }

  onConversationChange(listener: () => void): () => void {
    const offQueue = this.queue.onChange(() => listener());
    const offPlayer = this.deps.player.onSpeakingChange(() => listener());
    return () => { offQueue(); offPlayer(); };
  }

  participants(): string[] { return this.deps.humanIds().slice(0, 50); }

  heard(): HeardEntry[] { return this.queue.heard(); }

  speakLine(text: string, tags: string | undefined): MouthLineHandle {
    const session = this.deps.player.open('mouth');
    const writer = session.addSegment(text, 'line');
    const controller = new AbortController();
    void voiceSentence(
      { client: this.deps.client, voicepeakWav: this.deps.voicepeakWav, log: this.deps.warn },
      writer,
      { text, style: tags, signal: controller.signal },
    ).then(() => session.finish(), () => session.finish());
    const done = session.whenDone().then((report) => {
      if (report.reason === 'completed') {
        return { status: report.spokenText ? 'spoken' as const : 'failed' as const, spokenText: report.spokenText };
      }
      return { status: 'stopped' as const, spokenText: report.spokenText };
    });
    return {
      done,
      stop: (reason) => {
        controller.abort();
        session.stop(reason);
      },
    };
  }

  // ── conversation ──────────────────────────────────────────────────────────

  private track<T>(promise: Promise<T>): void {
    const tracked = promise.catch(() => undefined).finally(() => { this.background.delete(tracked); });
    this.background.add(tracked);
  }

  private async handleUtterance(utterance: Utterance): Promise<void> {
    if (this.disposed) return;
    const release = this.queue.reserve();
    try {
      const wav = makeWav(pcm48kStereoTo16kMono(utterance.pcm), 16_000, 1);
      const result = await this.deps.stt(wav, { durationMs: utterance.durationMs, speakerId: utterance.userId });
      if (this.disposed) return;
      if (result.status !== 'ok') {
        this.deps.log(`[DcVoice] stt user=${utterance.userId} status=${result.status} ms=${result.sttMs}`);
        return;
      }
      // The `🎤 name: text` post is not made here: runDcVoiceTurn makes it once she has decided to answer (an utterance she does not answer stays out of the channel).
      const name = this.deps.displayName(utterance.userId);
      this.lastConversationAt = this.now();
      this.queue.submit({
        userId: utterance.userId,
        name,
        text: result.text,
        startedAt: utterance.startedAt,
        endAt: utterance.endAt,
        sttMs: result.sttMs,
        utteranceMs: utterance.durationMs,
        endpointMs: utterance.endpointMs,
      });
    } finally {
      release();
    }
  }

  /**
   * How long before an utterance began she last finished speaking, in ms (0: she was speaking when it began); undefined when she has not
   * lately. The head counts its follow-up window (~20 s, `SHANNON_ADDRESSED`) from this.
   */
  private shannonSpokeMsAgo(startedAt: number): number | undefined {
    let latest: number | undefined;
    for (const span of this.spans) {
      if (span.start > startedAt) continue;
      if (span.end === null || span.end >= startedAt) return 0;
      latest = Math.max(latest ?? -Infinity, span.end);
    }
    return latest === undefined ? undefined : Math.max(0, startedAt - latest);
  }

  private followsShannonTurn(startedAt: number): boolean {
    return this.spans.some(span => span.start <= startedAt && (span.end === null || startedAt <= span.end + FOLLOW_WINDOW_MS));
  }

  private turnEnv() {
    return {
      conversationId: this.conversationId,
      voiceChannelId: this.deps.voiceChannelId,
      title: () => this.deps.title?.(),
      client: this.deps.client,
      fillers: this.deps.fillers,
      player: this.deps.player,
      speakingNow: () => this.deps.player.speaking() !== null,
      followsShannonTurn: (startedAt: number) => this.followsShannonTurn(startedAt),
      shannonSpokeMsAgo: (startedAt: number) => this.shannonSpokeMsAgo(startedAt),
      participants: () => this.deps.humanIds(),
      heard: (userId: string) => this.queue.heard(userId),
      situation: () => this.deps.mouth?.getSituation(),
      voicepeakWav: this.deps.voicepeakWav,
      legacy: this.deps.legacy,
      postText: this.deps.postText,
      now: this.now,
      log: this.deps.log,
      warn: this.deps.warn,
      signal: this.abort.signal,
      decisionTimeoutMs: this.deps.decisionTimeoutMs,
      drainMs: this.deps.drainMs,
    };
  }
}
