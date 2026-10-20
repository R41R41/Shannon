/**
 * dc-voice: per-person capture of speech from the Discord receiver.
 *
 * One independent collection per speaking person (several people at once never mix). A collection ends after
 * `afterSilenceMs` (600 ms) of silence (the receiver's `AfterSilence`), or is cut at `maxMs` (30 s). Anything
 * shorter than `minMs` (0.5 s) of speech is thrown away. The collector also feeds the SpeakerTracker with every
 * non-ignored speaker's start/end.
 */
import type { SpeakerTracker } from './speakerTracker.js';
import { pcmMs48kStereo } from './pcm.js';

export interface ReceiverLike {
  speaking: {
    on(event: 'start' | 'end', listener: (userId: string) => void): unknown;
    off(event: 'start' | 'end', listener: (userId: string) => void): unknown;
  };
  subscribe(userId: string, options: { end: { behavior: number; duration: number } }): StreamLike;
}

export interface StreamLike {
  on(event: 'data', listener: (chunk: Buffer) => void): unknown;
  on(event: 'end' | 'close', listener: () => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  destroy(error?: Error): unknown;
}

export interface Utterance {
  userId: string;
  /** 48 kHz stereo s16le. */
  pcm: Buffer;
  /** Epoch ms of the first packet. */
  startedAt: number;
  /** Epoch ms of the last packet (latency baseline). */
  endAt: number;
  /** Epoch ms the collection ended (last packet + the silence wait). */
  closedAt: number;
  /** Speech length (silence gaps are not sent by Discord, so this is voiced time). */
  durationMs: number;
  /** last packet -> stream end. */
  endpointMs: number;
  /** True when it was cut at the maximum length. */
  cut: boolean;
}

export interface UtteranceCollectorOptions {
  receiver: ReceiverLike;
  tracker: SpeakerTracker;
  /** EndBehaviorType.AfterSilence (passed in so this file has no discord dependency). */
  endBehaviorAfterSilence: number;
  /** Opus packets -> 48 kHz stereo s16le. */
  decode: (packets: Buffer[]) => Buffer;
  /** Bots and anyone who should not even be tracked. */
  isIgnored: (userId: string) => boolean;
  /** Whether to transcribe this person (open mic: everyone; PTT: the PTT person). */
  shouldCollect: (userId: string) => boolean;
  onUtterance: (utterance: Utterance) => void;
  onDiscard?: (info: { userId: string; durationMs: number; reason: 'short' | 'empty' }) => void;
  afterSilenceMs?: number;
  minMs?: number;
  maxMs?: number;
  now?: () => number;
  log?: (message: string) => void;
}

interface Collection {
  userId: string;
  stream: StreamLike;
  packets: Buffer[];
  startedAt: number;
  lastPacketAt: number;
  closed: boolean;
}

const PACKET_MS = 20;

export class UtteranceCollector {
  private readonly active = new Map<string, Collection>();
  private readonly now: () => number;
  private readonly afterSilenceMs: number;
  private readonly minMs: number;
  private readonly maxPackets: number;
  private started = false;
  private disposed = false;

  private readonly onStart = (userId: string): void => {
    if (this.disposed || this.options.isIgnored(userId)) return;
    this.options.tracker.start(userId);
    if (this.options.shouldCollect(userId)) this.begin(userId);
  };

  private readonly onEnd = (userId: string): void => {
    if (this.disposed || this.options.isIgnored(userId)) return;
    this.options.tracker.end(userId);
  };

  constructor(private readonly options: UtteranceCollectorOptions) {
    this.now = options.now ?? Date.now;
    this.afterSilenceMs = options.afterSilenceMs ?? 600;
    this.minMs = options.minMs ?? 500;
    this.maxPackets = Math.floor((options.maxMs ?? 30_000) / PACKET_MS);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.options.receiver.speaking.on('start', this.onStart);
    this.options.receiver.speaking.on('end', this.onEnd);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.options.receiver.speaking.off('start', this.onStart);
    this.options.receiver.speaking.off('end', this.onEnd);
    for (const collection of [...this.active.values()]) {
      collection.closed = true;
      try { collection.stream.destroy(); } catch { /* already gone */ }
    }
    this.active.clear();
  }

  /** How long this person's current collection has been running (0 when not collecting). */
  collectingMs(userId: string): number {
    const collection = this.active.get(userId);
    return collection ? this.now() - collection.startedAt : 0;
  }

  isCollecting(userId: string): boolean { return this.active.has(userId); }

  private begin(userId: string): void {
    if (this.active.has(userId)) return;
    let stream: StreamLike;
    try {
      stream = this.options.receiver.subscribe(userId, {
        end: { behavior: this.options.endBehaviorAfterSilence, duration: this.afterSilenceMs },
      });
    } catch (error) {
      this.options.log?.(`subscribe failed (${userId}): ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const now = this.now();
    const collection: Collection = { userId, stream, packets: [], startedAt: now, lastPacketAt: now, closed: false };
    this.active.set(userId, collection);
    stream.on('error', (error: Error) => {
      this.options.log?.(`receive stream error (${userId}): ${error.message}`);
    });
    stream.on('data', (chunk: Buffer) => {
      if (collection.closed) return;
      if (collection.packets.length === 0) collection.startedAt = this.now();
      collection.packets.push(chunk);
      collection.lastPacketAt = this.now();
      if (collection.packets.length >= this.maxPackets) this.finish(collection, true);
    });
    const onClose = () => this.finish(collection, false);
    stream.on('end', onClose);
    stream.on('close', onClose);
  }

  private finish(collection: Collection, cut: boolean): void {
    if (collection.closed) return;
    collection.closed = true;
    if (this.active.get(collection.userId) === collection) this.active.delete(collection.userId);
    if (cut) {
      try { collection.stream.destroy(); } catch { /* already gone */ }
    }
    const { userId } = collection;
    if (collection.packets.length === 0) {
      this.options.onDiscard?.({ userId, durationMs: 0, reason: 'empty' });
    } else {
      const closedAt = this.now();
      let pcm: Buffer;
      try {
        pcm = this.options.decode(collection.packets);
      } catch {
        pcm = Buffer.alloc(0);
      }
      const durationMs = pcmMs48kStereo(pcm.length);
      if (durationMs < this.minMs) {
        this.options.onDiscard?.({ userId, durationMs, reason: 'short' });
      } else if (!this.disposed) {
        this.options.onUtterance({
          userId,
          pcm,
          startedAt: collection.startedAt,
          endAt: collection.lastPacketAt,
          closedAt,
          durationMs,
          endpointMs: Math.max(0, closedAt - collection.lastPacketAt),
          cut,
        });
      }
    }
    // The person kept talking past the cut: carry on with a fresh collection (no new 'start' will come).
    if (cut && !this.disposed && this.options.tracker.isSpeaking(userId) && this.options.shouldCollect(userId)) {
      this.begin(userId);
    }
  }
}
