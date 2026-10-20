/**
 * dc-voice: "the speaking mouth" (spec: dc-speak-interface.md). Other agents call
 * `getVoiceMouth().say({...})` / `.setSituation({...})` when something happens; the mouth decides if and when it
 * can be said in the voice channel. This file holds the logic with no config / discord imports (testable);
 * `voiceMouth.ts` exposes the process-wide instance.
 *
 * The rules (all the caller's problem is gone):
 *   1. Never start while a person is talking (they must have been quiet for 0.8 s). Past `maxWaitMs` -> expired.
 *   2. Never cut into Shannon's reply to a person: wait until the reply is over.
 *   3. A person starting to talk while a mouth line plays stops that line (interrupted); it is not repeated.
 *   4. 5 s between lines (high: 1.5 s); at most 6 accepted per minute (more -> rate_limited).
 *   5. The same `source` is not repeated within 20 s (duplicate); `high` is exempt.
 *   6. When a conversation turn starts while lines wait: low is dropped, normal waits until the reply is over,
 *      high goes right after the reply. Order in the line: high, normal, low; first come first served.
 *   7. What was said goes into the head's record of the conversation (`said`, source 'mouth').
 * `facts` are turned into a wording by the head (`wording`); it may decide to say nothing (`declined`).
 */
import {
  defaultMaxWait,
  type MouthPriority,
  type MouthQueueItem,
  type MouthResultStatus,
  type ShannonCoreVoiceClient,
  type VoiceHeardItem,
} from '../../integration/shannonCoreVoiceClient.js';
import type { HeardEntry } from './turnQueue.js';
import type { SpeakerTracker } from './speakerTracker.js';

export type MouthDone =
  | 'spoken' | 'dropped_busy' | 'expired' | 'superseded' | 'not_in_voice' | 'disabled' | 'interrupted' | 'declined';

export interface MouthSayInput {
  /** Said as it is (1-2 sentences, cut at 120 characters). Exactly one of `text` / `facts`. */
  text?: string;
  /** 1-5 short facts; the head turns them into Shannon's words (and may stay silent). */
  facts?: string[];
  source: string;
  key?: string;
  priority?: MouthPriority;
  maxWaitMs?: number;
  /** ElevenLabs performance tags such as '[excited]'. */
  tags?: string;
}

export interface MouthSayResult {
  id: string;
  accepted: boolean;
  reason?: 'disabled' | 'not_in_voice' | 'rate_limited' | 'duplicate' | 'invalid';
  done: Promise<MouthDone>;
}

export interface MouthLineHandle {
  done: Promise<{ status: 'spoken' | 'stopped' | 'failed'; spokenText: string }>;
  stop(reason: 'human_speech'): void;
}

export interface MouthHost {
  readonly guildId: string;
  readonly conversationId: string;
  readonly client: Pick<ShannonCoreVoiceClient, 'wording' | 'said' | 'mouthPoll' | 'mouthResult'>;
  readonly tracker: SpeakerTracker;
  /** A turn is being heard, run or is waiting (a reply is coming or being given). */
  conversationActive(): boolean;
  /** Shannon is voicing / playing something. */
  playbackBusy(): boolean;
  onConversationChange(listener: () => void): () => void;
  participants(): string[];
  heard(): HeardEntry[];
  /** Voice and play one line. */
  speakLine(text: string, tags: string | undefined): MouthLineHandle;
}

export interface VoiceMouthDeps {
  enabled: () => boolean;
  now?: () => number;
  log?: (line: string) => void;
  /** Long-poll wait asked of the head. */
  pollWaitMs?: number;
}

interface Entry {
  id: string;
  remote: boolean;
  text?: string;
  facts?: string[];
  source: string;
  key?: string;
  priority: MouthPriority;
  maxWaitMs: number;
  tags?: string;
  createdAt: number;
  acceptedAt: number;
  state: 'wording' | 'ready' | 'speaking';
  settled: boolean;
  resolve: (done: MouthDone) => void;
}

const MAX_TEXT_CHARS = 120;
const SPACING_MS = 5_000;
const SPACING_HIGH_MS = 1_500;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 6;
const DUPLICATE_WINDOW_MS = 20_000;
const RETRY_MS = 250;
const SITUATION_MAX = 300;

const PRIORITY_RANK: Record<MouthPriority, number> = { high: 0, normal: 1, low: 2 };

export class VoiceMouth {
  private readonly now: () => number;
  private readonly hosts = new Map<string, { host: MouthHost; offs: Array<() => void> }>();
  private entries: Entry[] = [];
  private sequence = 0;
  private speaking: Entry | null = null;
  private acceptedLog: Entry[] = [];
  private readonly spokenAtBySource = new Map<string, number>();
  private lastLineEnd = 0;
  private wake: { at: number; handle: NodeJS.Timeout } | null = null;
  private situation: { text: string; expiresAt: number } | null = null;
  private pollAbort: AbortController | null = null;
  private pollClient: MouthHost['client'] | null = null;

  constructor(private readonly deps: VoiceMouthDeps) {
    this.now = deps.now ?? Date.now;
  }

  // ── public API (dc-speak-interface.md §1, §5) ─────────────────────────────

  say(input: MouthSayInput): MouthSayResult {
    const id = `mouth-${(this.sequence += 1)}`;
    const reject = (reason: NonNullable<MouthSayResult['reason']>): MouthSayResult => ({
      id,
      accepted: false,
      reason,
      done: Promise.resolve(reasonToDone(reason)),
    });
    try {
      if (!this.deps.enabled()) return reject('disabled');
      const host = this.pickHost();
      if (!host) return reject('not_in_voice');
      return this.accept(input, id, host, false) ?? reject('invalid');
    } catch {
      return reject('invalid');
    }
  }

  setSituation(input: { text: string; ttlMs?: number }): void {
    const text = typeof input?.text === 'string' ? input.text.trim().slice(0, SITUATION_MAX) : '';
    if (!text) {
      this.situation = null;
      return;
    }
    const ttl = Number.isFinite(input.ttlMs) && (input.ttlMs as number) > 0 ? (input.ttlMs as number) : 60_000;
    this.situation = { text, expiresAt: this.now() + ttl };
  }

  /** The latest situation text, or undefined once it went stale. */
  getSituation(): string | undefined {
    if (!this.situation) return undefined;
    if (this.now() >= this.situation.expiresAt) {
      this.situation = null;
      return undefined;
    }
    return this.situation.text;
  }

  // ── VC attachment ─────────────────────────────────────────────────────────

  /** A VC conversation exists for this guild. Returns the detach function. */
  attach(host: MouthHost): () => void {
    this.detach(host.guildId);
    const offs = [
      host.tracker.on('start', () => this.pump()),
      host.tracker.on('end', () => this.pump()),
      host.onConversationChange(() => this.pump()),
    ];
    this.hosts.set(host.guildId, { host, offs });
    this.pollClient = host.client;
    this.startPolling();
    return () => this.detach(host.guildId);
  }

  detach(guildId: string): void {
    const attached = this.hosts.get(guildId);
    if (!attached) return;
    for (const off of attached.offs) off();
    this.hosts.delete(guildId);
    if (this.hosts.size === 0) {
      this.stopPolling();
      this.pollClient = null;
      for (const entry of [...this.entries]) this.settle(entry, 'not_in_voice');
      if (this.wake) { clearTimeout(this.wake.handle); this.wake = null; }
    } else {
      this.pollClient = [...this.hosts.values()][0]!.host.client;
    }
  }

  hasHost(): boolean { return this.hosts.size > 0; }

  /** Whether the head-queue polling loop is running (tests, diagnostics). */
  get polling(): boolean { return this.pollAbort !== null && !this.pollAbort.signal.aborted; }

  queuedCount(): number { return this.entries.length; }

  // ── accepting ─────────────────────────────────────────────────────────────

  private accept(input: MouthSayInput, id: string, host: MouthHost, remote: boolean, remoteId?: string): MouthSayResult | null {
    const hasText = typeof input.text === 'string' && input.text.trim().length > 0;
    const facts = Array.isArray(input.facts)
      ? input.facts.filter((fact): fact is string => typeof fact === 'string' && fact.trim().length > 0).map(fact => fact.trim()).slice(0, 5)
      : [];
    if ((hasText ? 1 : 0) + (facts.length > 0 ? 1 : 0) !== 1) return null;
    const source = typeof input.source === 'string' ? input.source.trim().slice(0, 200) : '';
    if (!source) return null;
    const priority: MouthPriority = input.priority === 'low' || input.priority === 'high' ? input.priority : 'normal';
    const now = this.now();
    const maxWaitMs = Number.isFinite(input.maxWaitMs) && (input.maxWaitMs as number) > 0
      ? Math.min(60_000, input.maxWaitMs as number)
      : defaultMaxWait(priority);
    const key = typeof input.key === 'string' && input.key.trim() ? input.key.trim().slice(0, 200) : undefined;

    // A newer line with the same key replaces the waiting one.
    if (key) {
      for (const waiting of this.entries.filter(entry => entry.key === key && entry.state !== 'speaking')) {
        this.settle(waiting, 'superseded');
      }
    }
    this.pruneAccepted(now);
    if (priority !== 'high') {
      const lastSpoken = this.spokenAtBySource.get(source);
      const duplicateWaiting = this.entries.some(entry => entry.source === source && !entry.settled);
      if ((lastSpoken !== undefined && now - lastSpoken < DUPLICATE_WINDOW_MS) || duplicateWaiting) {
        return { id, accepted: false, reason: 'duplicate', done: Promise.resolve('dropped_busy') };
      }
    }
    if (this.acceptedLog.length >= RATE_LIMIT) {
      return { id, accepted: false, reason: 'rate_limited', done: Promise.resolve('dropped_busy') };
    }

    let resolve!: (done: MouthDone) => void;
    const done = new Promise<MouthDone>(res => { resolve = res; });
    const entry: Entry = {
      id: remoteId ?? id,
      remote,
      source,
      priority,
      maxWaitMs,
      createdAt: now,
      acceptedAt: now,
      state: hasText ? 'ready' : 'wording',
      settled: false,
      resolve,
      ...(key ? { key } : {}),
      ...(typeof input.tags === 'string' && input.tags.trim() ? { tags: input.tags.trim().slice(0, 80) } : {}),
      ...(hasText ? { text: clipText(input.text!.trim()) } : { facts }),
    };
    this.entries.push(entry);
    this.acceptedLog.push(entry);

    if (!hasText) this.startWording(entry, host);
    this.pump();
    return { id, accepted: true, done };
  }

  private pruneAccepted(now: number): void {
    this.acceptedLog = this.acceptedLog.filter(entry => now - entry.acceptedAt < RATE_WINDOW_MS);
  }

  private startWording(entry: Entry, host: MouthHost): void {
    // A low line is not worth a head call while a conversation is going on: it would be dropped anyway.
    if (entry.priority === 'low' && host.conversationActive()) {
      this.settle(entry, 'dropped_busy');
      return;
    }
    void (async () => {
      const result = await host.client.wording({
        conversationId: host.conversationId,
        facts: entry.facts ?? [],
        source: entry.source,
        participants: host.participants(),
        heard: host.heard().map(toHeardItem),
        ...(this.getSituation() ? { situation: this.getSituation() } : {}),
      });
      if (entry.settled) return;
      if (result.status !== 'ok' || !result.say || !result.text) {
        this.settle(entry, 'declined');
        return;
      }
      entry.text = clipText(result.text);
      if (result.tags && !entry.tags) entry.tags = result.tags.slice(0, 80);
      entry.state = 'ready';
      this.pump();
    })().catch(() => this.settle(entry, 'declined'));
  }

  // ── scheduling ────────────────────────────────────────────────────────────

  private pickHost(): MouthHost | null {
    for (const { host } of this.hosts.values()) return host;
    return null;
  }

  private pump(): void {
    const now = this.now();
    for (const entry of [...this.entries]) {
      if (entry.state !== 'speaking' && now - entry.createdAt >= entry.maxWaitMs) this.settle(entry, 'expired');
    }
    const host = this.pickHost();
    if (!host) {
      for (const entry of [...this.entries]) this.settle(entry, 'not_in_voice');
      return;
    }
    if (host.conversationActive()) {
      for (const entry of [...this.entries]) if (entry.priority === 'low' && entry.state !== 'speaking') this.settle(entry, 'dropped_busy');
    }
    if (this.entries.length === 0) return;
    for (const entry of this.entries) if (entry.state !== 'speaking') this.wakeAt(entry.createdAt + entry.maxWaitMs);
    if (this.speaking) return;

    const next = this.entries
      .filter(entry => entry.state === 'ready')
      .sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.createdAt - b.createdAt)[0];
    if (!next) return;

    if (host.conversationActive() || host.playbackBusy()) {
      this.wakeAt(now + RETRY_MS);
      return;
    }
    const quietAt = host.tracker.quietAt();
    if (quietAt === null) {
      this.wakeAt(now + RETRY_MS);
      return;
    }
    if (quietAt > now) {
      this.wakeAt(quietAt);
      return;
    }
    const spacing = next.priority === 'high' ? SPACING_HIGH_MS : SPACING_MS;
    const readyAt = this.lastLineEnd + spacing;
    if (this.lastLineEnd > 0 && now < readyAt) {
      this.wakeAt(readyAt);
      return;
    }
    this.speak(next, host);
  }

  private wakeAt(at: number): void {
    const now = this.now();
    const target = Math.max(at, now + 1);
    if (this.wake && this.wake.at <= target) return;
    if (this.wake) clearTimeout(this.wake.handle);
    const handle = setTimeout(() => {
      this.wake = null;
      this.pump();
    }, Math.max(1, target - now));
    handle.unref?.();
    this.wake = { at: target, handle };
  }

  private speak(entry: Entry, host: MouthHost): void {
    this.speaking = entry;
    entry.state = 'speaking';
    const text = entry.text!;
    let handle: MouthLineHandle;
    try {
      handle = host.speakLine(text, entry.tags);
    } catch {
      this.speaking = null;
      this.settle(entry, 'dropped_busy');
      return;
    }
    // Rule 3: anybody starting to talk stops this line.
    const off = host.tracker.on('start', () => handle.stop('human_speech'));
    void handle.done
      .catch(() => ({ status: 'failed' as const, spokenText: '' }))
      .then(async (result) => {
        off();
        const ended = this.now();
        this.lastLineEnd = ended;
        if (result.status !== 'failed') this.spokenAtBySource.set(entry.source, ended);
        this.speaking = null;
        const at = new Date(ended).toISOString();
        if (result.status === 'spoken') {
          this.settle(entry, 'spoken');
          void host.client.said({ conversationId: host.conversationId, text, source: 'mouth', at });
        } else if (result.status === 'stopped') {
          this.settle(entry, 'interrupted');
          if (result.spokenText) {
            void host.client.said({
              conversationId: host.conversationId, text, source: 'mouth', at, interrupted: true, spokenText: result.spokenText,
            });
          }
        } else {
          this.settle(entry, 'dropped_busy');
        }
        this.pump();
      });
  }

  private settle(entry: Entry, done: MouthDone): void {
    if (entry.settled) return;
    entry.settled = true;
    this.entries = this.entries.filter(candidate => candidate !== entry);
    if (done === 'superseded') this.acceptedLog = this.acceptedLog.filter(candidate => candidate !== entry);
    this.deps.log?.(`[DcVoice] mouth id=${entry.id} source=${entry.source} priority=${entry.priority} result=${done} chars=${entry.text?.length ?? 0}`);
    entry.resolve(done);
  }

  // ── the head's queue (long poll) ──────────────────────────────────────────

  private startPolling(): void {
    if (this.pollAbort || !this.deps.enabled() || !this.pollClient) return;
    const controller = new AbortController();
    this.pollAbort = controller;
    void this.pollLoop(controller.signal);
  }

  private stopPolling(): void {
    this.pollAbort?.abort();
    this.pollAbort = null;
  }

  private async pollLoop(signal: AbortSignal): Promise<void> {
    const waitMs = this.deps.pollWaitMs ?? 25_000;
    let failures = 0;
    while (!signal.aborted) {
      const client = this.pollClient;
      if (!client) return;
      const startedAt = this.now();
      const polled = await client.mouthPoll(waitMs, { signal }).catch(() => ({ status: 'unavailable' as const, reason: 'network' as const }));
      if (signal.aborted) return;
      if (polled.status === 'ok') {
        failures = 0;
        for (const item of polled.items) this.acceptRemote(item, client);
        // A well-behaved head holds the request open; if it answered an empty poll at once, do not spin.
        if (polled.items.length === 0 && this.now() - startedAt < 300) await abortableSleep(300, signal);
        continue;
      }
      failures += 1;
      await abortableSleep(Math.min(30_000, 1_000 * 2 ** (failures - 1)), signal);
    }
  }

  private acceptRemote(item: MouthQueueItem, client: MouthHost['client']): void {
    const report = (done: MouthDone) => {
      void client.mouthResult({ id: item.id, status: done as MouthResultStatus });
    };
    const host = this.pickHost();
    if (!this.deps.enabled()) return report('disabled');
    if (!host) return report('not_in_voice');
    const input: MouthSayInput = {
      source: item.source,
      priority: item.priority,
      maxWaitMs: item.maxWaitMs,
      ...(item.key ? { key: item.key } : {}),
      ...(item.tags ? { tags: item.tags } : {}),
      ...(item.text ? { text: item.text } : { facts: item.facts }),
    };
    const result = this.accept(input, `remote-${item.id}`, host, true, item.id) ?? {
      id: item.id, accepted: false, done: Promise.resolve<MouthDone>('dropped_busy'),
    };
    void result.done.then(report);
  }
}

function reasonToDone(reason: NonNullable<MouthSayResult['reason']>): MouthDone {
  switch (reason) {
    case 'disabled': return 'disabled';
    case 'not_in_voice': return 'not_in_voice';
    default: return 'dropped_busy';
  }
}

/** At most 120 characters, preferring to end on a sentence end. */
export function clipText(text: string): string {
  if (text.length <= MAX_TEXT_CHARS) return text;
  const head = text.slice(0, MAX_TEXT_CHARS);
  const cut = Math.max(head.lastIndexOf('。'), head.lastIndexOf('！'), head.lastIndexOf('？'), head.lastIndexOf('!'), head.lastIndexOf('?'));
  return cut >= 20 ? head.slice(0, cut + 1) : head;
}

function toHeardItem(entry: HeardEntry): VoiceHeardItem {
  return { userId: entry.userId, name: entry.name, text: entry.text, at: new Date(entry.at).toISOString() };
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}
