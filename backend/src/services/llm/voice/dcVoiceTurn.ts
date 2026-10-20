/**
 * dc-voice: one conversation turn through the head.
 *
 * After speech-to-text, `POST /v1/platform/voice/turn` is called and its NDJSON is played as it arrives:
 *   decision (within 4 s, or the old path takes this utterance)  ->  filler (pre-voiced, instant)  ->  sentences.
 * Each sentence is voiced by the head's ElevenLabs endpoint (up to 2 sentences requested in parallel, played in order,
 * as one continuous stream); a sentence whose voice request fails is said by VOICEPEAK. An `error` line after the
 * decision ends the turn quietly: what was already said stays said, the old path is NOT used to say it again.
 * A person talking over the reply (barge-in) stops playback; the head is told with `said` (interrupted + spokenText).
 */
import { randomUUID } from 'node:crypto';
import type {
  ShannonCoreVoiceClient,
  VoiceHeardItem,
  VoiceTurnOpenResult,
  VoiceTurnRequest,
} from '../../integration/shannonCoreVoiceClient.js';
import type { FillerSource } from '../../discord/voice/speechFillerStore.js';
import type { PlaybackReport, PlaybackSession, SpeechPlayer } from '../../discord/voice/speechPlayer.js';
import type { HeardEntry, TurnItem, TurnRunResult } from '../../discord/voice/turnQueue.js';
import { voiceSentence } from '../../discord/voice/sentenceVoice.js';
import { formatTurnLog, type TurnMetrics, type TurnPath } from '../../discord/voice/dcVoiceMetrics.js';

export interface DcVoiceTurnEnv {
  conversationId: string;
  voiceChannelId: string;
  /** The conversation's channel name, when known (one head titles a conversation nobody bound by it). */
  title?(): string | undefined;
  client: Pick<ShannonCoreVoiceClient, 'turn' | 'speech' | 'said'>;
  fillers: FillerSource;
  player: Pick<SpeechPlayer, 'open'>;
  /** Whether Shannon is speaking right now. */
  speakingNow(): boolean;
  /** Whether an utterance that began at `startedAt` came while Shannon was speaking or within 8 s after. */
  followsShannonTurn(startedAt: number): boolean;
  /** How long before an utterance began she last finished speaking (ms; 0: speaking), undefined when not lately: the head's follow-up window. */
  shannonSpokeMsAgo?(startedAt: number): number | undefined;
  participants(): string[];
  heard(excludeUserId: string): HeardEntry[];
  situation(): string | undefined;
  /** VOICEPEAK for one sentence (WAV). */
  voicepeakWav(text: string): Promise<Buffer>;
  /** The old path (invokeGraph -> VOICEPEAK) for this utterance; resolves when its playback is over. */
  legacy(item: TurnItem): Promise<void>;
  /** Post to the VC's text channel. */
  postText(text: string): void;
  now?: () => number;
  /** Metric line sink. */
  log?: (line: string) => void;
  warn?: (line: string) => void;
  signal?: AbortSignal;
  decisionTimeoutMs?: number;
  maxParallelSpeech?: number;
  /** After an interruption, how long to keep reading the head's remaining lines so it can finish its record. */
  drainMs?: number;
  newRequestId?: () => string;
  /** For choosing among backchannels (tests). */
  random?: () => number;
}

export interface DcVoiceTurnResult extends TurnRunResult {
  path: TurnPath;
  /** Background work after the turn returned (draining after an interruption, `said`). Never rejects. */
  settled: Promise<void>;
}

class Limiter {
  private running = 0;
  private readonly waiting: Array<() => void> = [];
  constructor(private readonly limit: number) {}
  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.running >= this.limit) await new Promise<void>(resolve => this.waiting.push(resolve));
    this.running += 1;
    try {
      return await task();
    } finally {
      this.running -= 1;
      this.waiting.shift()?.();
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.(); });
}

export async function runDcVoiceTurn(env: DcVoiceTurnEnv, item: TurnItem): Promise<DcVoiceTurnResult> {
  const now = env.now ?? Date.now;
  const requestId = env.newRequestId?.() ?? randomUUID();
  const metrics: TurnMetrics = {
    id: requestId.slice(0, 8),
    user: item.userId,
    endpointMs: item.endpointMs,
    sttMs: item.sttMs,
    path: 'head',
    respond: false,
    inChars: item.text.length,
  };
  const finishLog = () => env.log?.(formatTurnLog(metrics));
  const spokeAgo = env.shannonSpokeMsAgo?.(item.startedAt);
  const request: VoiceTurnRequest = {
    requestId,
    conversationId: env.conversationId,
    voiceChannelId: env.voiceChannelId,
    ...(env.title?.()?.trim() ? { conversationTitle: env.title?.()?.trim() } : {}),
    sourceUserId: item.userId,
    sourceDisplayName: item.name,
    userMessage: item.text,
    observedAt: new Date(item.endAt).toISOString(),
    participants: [...new Set([...env.participants(), item.userId])].slice(0, 50),
    heard: env.heard(item.userId).map(toHeardItem),
    followsShannonTurn: env.followsShannonTurn(item.startedAt),
    speakingNow: env.speakingNow(),
    ...(spokeAgo === undefined ? {} : { shannonSpokeMsAgo: spokeAgo }),
    ...(env.situation() ? { situation: env.situation() } : {}),
    sttMs: item.sttMs,
    utteranceMs: item.utteranceMs,
  };

  // Written from callbacks, so kept in an object (control-flow narrowing would otherwise pin these to null).
  const state: { stopped: PlaybackReport | null; error: { status: number; error: string } | null } = { stopped: null, error: null };
  const speechController = new AbortController();
  const onTurnAbort = () => speechController.abort();
  env.signal?.addEventListener('abort', onTurnAbort, { once: true });
  const pb: { ref: { session: PlaybackSession; stoppedPromise: Promise<PlaybackReport> } | null } = { ref: null };
  const ensurePlayback = () => {
    if (pb.ref) return pb.ref;
    const session = env.player.open('reply', {
      onSegmentStart: (start) => {
        const sinceEnd = start.at - item.endAt;
        if (metrics.firstAudioMs === undefined) metrics.firstAudioMs = sinceEnd;
        if (start.kind === 'filler' && metrics.fillerStartMs === undefined) metrics.fillerStartMs = sinceEnd;
        if (start.kind === 'sentence' && metrics.firstSentenceMs === undefined) metrics.firstSentenceMs = sinceEnd;
      },
    });
    const stoppedPromise = session.whenDone().then((report) => {
      if (report.reason !== 'completed') {
        state.stopped = report;
        speechController.abort();
      }
      return report;
    });
    pb.ref = { session, stoppedPromise };
    return pb.ref;
  };
  /** The head will not (or cannot) say anything more: let an early backchannel finish, then move on. */
  const settleEarlyPlayback = async (): Promise<void> => {
    if (!pb.ref) return;
    pb.ref.session.finish();
    await pb.ref.stoppedPromise;
  };

  // A person alone in the VC will certainly be answered: start a short backchannel now, without waiting for the
  // head's decision (the head can be slow when its process is busy), and tell the head which one it was.
  let fillerQueued = false;
  const early = pickEarlyFiller(env, item, request.participants);
  if (early) {
    request.fillerId = early.id;
    const writer = ensurePlayback().session.addSegment(early.text, 'filler');
    writer.writeMono24k(early.pcm);
    writer.end();
    fillerQueued = true;
  }

  const open: VoiceTurnOpenResult = await env.client.turn(request, {
    signal: env.signal,
    decisionTimeoutMs: env.decisionTimeoutMs,
  });

  if (open.status === 'rate_limited') {
    metrics.note = 'rate_limited';
    await settleEarlyPlayback();
    env.signal?.removeEventListener('abort', onTurnAbort);
    metrics.totalMs = now() - item.endAt;
    finishLog();
    return { responded: false, path: 'head', settled: Promise.resolve() };
  }
  if (open.status === 'unavailable') {
    if (open.reason === 'aborted') {
      metrics.path = 'none';
      metrics.note = 'aborted';
      env.signal?.removeEventListener('abort', onTurnAbort);
      finishLog();
      return { responded: true, path: 'none', settled: Promise.resolve() };
    }
    // Before the first line: hand this utterance to the old path.
    metrics.path = 'legacy';
    metrics.respond = true;
    metrics.note = `head_${open.reason}${open.httpStatus ? `_${open.httpStatus}` : ''}`;
    await settleEarlyPlayback(); // the legacy path plays through the same player: let the backchannel end first
    env.signal?.removeEventListener('abort', onTurnAbort);
    try {
      await env.legacy(item);
    } catch (error) {
      env.warn?.(`legacy path failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    metrics.totalMs = now() - item.endAt;
    finishLog();
    return { responded: true, path: 'legacy', settled: Promise.resolve() };
  }

  // From here on the head owns the turn.
  metrics.decisionMs = open.decisionMs;
  const onAbort = () => open.cancel();
  env.signal?.addEventListener('abort', onAbort, { once: true });
  const cleanup = () => env.signal?.removeEventListener('abort', onAbort);

  const consumeSilently = async (): Promise<void> => {
    try {
      for await (const line of open.lines) {
        if (line.type === 'error') env.warn?.(`turn error line: ${line.status} ${line.error}`);
      }
    } catch { /* the client does not throw; stay safe */ }
  };

  if (!open.decision.respond) {
    await Promise.race([consumeSilently(), sleep(2_000)]);
    open.cancel();
    cleanup();
    await settleEarlyPlayback();
    env.signal?.removeEventListener('abort', onTurnAbort);
    metrics.totalMs = now() - item.endAt;
    finishLog();
    return { responded: false, path: 'head', settled: Promise.resolve() };
  }

  metrics.respond = true;
  const { session: playback, stoppedPromise } = ensurePlayback();
  if (open.decision.filler && !fillerQueued) {
    const stored = env.fillers.get(open.decision.filler.id);
    if (stored) {
      const writer = playback.addSegment(stored.text || open.decision.filler.text, 'filler');
      writer.writeMono24k(stored.pcm);
      writer.end();
      fillerQueued = true;
    }
  }
  const limiter = new Limiter(env.maxParallelSpeech ?? 2);
  const sentences: string[] = [];
  const jobs: Array<Promise<unknown>> = [];
  const consume = (async (): Promise<void> => {
    try {
      for await (const line of open.lines) {
        if (line.type === 'sentence') {
          sentences.push(line.text);
          if (state.stopped) continue;
          const writer = playback.addSegment(line.text, 'sentence');
          jobs.push(limiter.run(() => voiceSentence(
            { client: env.client, voicepeakWav: env.voicepeakWav, log: env.warn },
            writer,
            { text: line.text, voiceText: line.voiceText, signal: speechController.signal },
          )));
        } else if (line.type === 'intent') {
          env.warn?.(`turn intent: ${line.kind} delivered=${line.delivered === true}`);
        } else if (line.type === 'error') {
          state.error = { status: line.status, error: line.error };
          break; // nothing after an error line is spoken
        } else if (line.type === 'done') {
          break;
        }
      }
    } catch { /* the client does not throw; stay safe */ }
  })();

  // Wait for the lines to end, or for playback to be cut off, whichever comes first.
  await Promise.race([consume, stoppedPromise]);

  const finalize = (report: PlaybackReport): { settled: Promise<void>; interrupted: boolean } => {
    const interrupted = report.reason !== 'completed';
    const spokenSentences = report.segments
      .filter(segment => segment.kind === 'sentence')
      .map(segment => segment.text.slice(0, segment.playedChars))
      .join('');
    metrics.totalMs = now() - item.endAt;
    metrics.outChars = interrupted ? spokenSentences.length : sentences.join('').length;
    const spokenSomething = report.segments.some(segment => segment.playedChars > 0);
    if (interrupted) metrics.note = `interrupted:${report.reason}`;
    else if (state.error) metrics.note = `error:${state.error.error}`;
    if (!sentences.length && fillerQueued && spokenSomething) metrics.path = 'filler_only';
    if (metrics.outChars > 0) env.postText(`🔊 シャノン: ${interrupted ? spokenSentences : sentences.join('')}`);
    if (!interrupted) {
      env.signal?.removeEventListener('abort', onTurnAbort);
      cleanup();
      finishLog();
      return { settled: Promise.resolve(), interrupted };
    }
    // Interrupted: let the head finish writing its record (read its remaining lines), then tell it what was said.
    const settled = (async () => {
      await Promise.race([consume, sleep(env.drainMs ?? 8_000)]);
      open.cancel();
      cleanup();
      env.signal?.removeEventListener('abort', onTurnAbort);
      const intended = sentences.join('');
      const said = await env.client.said({
        conversationId: env.conversationId,
        text: intended || report.spokenText,
        source: 'reply',
        at: new Date(now()).toISOString(),
        interrupted: true,
        spokenText: report.spokenText,
      });
      if (said.status !== 'ok') env.warn?.(`said (interrupted) failed: ${said.reason}`);
      finishLog();
    })().catch(() => undefined);
    return { settled, interrupted };
  };

  if (state.stopped) {
    const result = finalize(state.stopped);
    return { responded: true, path: metrics.path, settled: result.settled };
  }
  // Lines are over (done / error / broken stream): no more sentences, let the audio finish.
  await Promise.all(jobs);
  playback.finish();
  const report = await stoppedPromise;
  const result = finalize(report);
  const spokenSomething = report.segments.some(segment => segment.playedChars > 0);
  return { responded: spokenSomething || sentences.length > 0, path: metrics.path, settled: result.settled };
}

const URGENT_WORDS = /止まっ|止まれ|危な|あぶな|逃げ|助けて|やばい|死ぬ|落ち|燃え|ストップ/;
const APOLOGY_OR_THANKS = /ごめん|すみません|申し訳|ありがと|感謝|助かった|お礼/;
let lastEarlyFillerId = '';

/**
 * The backchannel to start before the decision: only for one person alone in the VC, a message of at least 8
 * characters, and not for urgent words, apologies or thanks (a "うん" would be wrong there). Short clips first.
 */
export function pickEarlyFiller(
  env: Pick<DcVoiceTurnEnv, 'fillers' | 'random'>,
  item: Pick<TurnItem, 'userId' | 'text'>,
  participants: string[],
): { id: string; text: string; pcm: Buffer } | null {
  if (participants.length !== 1 || participants[0] !== item.userId) return null;
  const text = item.text.trim();
  if (text.length < 8 || URGENT_WORDS.test(text) || APOLOGY_OR_THANKS.test(text)) return null;
  const all = env.fillers.ids()
    .map(id => env.fillers.get(id))
    .filter((filler): filler is NonNullable<typeof filler> => filler !== undefined && filler.pcm.length > 0);
  if (all.length === 0) return null;
  const short = all.filter(filler => filler.text.length <= 6);
  const pool = (short.length > 0 ? short : all).filter(filler => filler.id !== lastEarlyFillerId);
  const choices = pool.length > 0 ? pool : all;
  const chosen = choices[Math.floor((env.random ?? Math.random)() * choices.length) % choices.length]!;
  lastEarlyFillerId = chosen.id;
  return chosen;
}

function toHeardItem(entry: HeardEntry): VoiceHeardItem {
  return { userId: entry.userId, name: entry.name, text: entry.text, at: new Date(entry.at).toISOString() };
}
