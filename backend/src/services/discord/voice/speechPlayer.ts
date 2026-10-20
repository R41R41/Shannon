/**
 * dc-voice: plays sentences into the guild's AudioPlayer as ONE continuous raw stream (48 kHz stereo s16le,
 * `StreamType.Raw`, no ffmpeg).
 *
 * A playback session is one reply / one mouth line. Its segments (a filler, each sentence) are written in order into a
 * single PassThrough as their PCM arrives, so there is no silence between sentences unless the next sentence's audio
 * is genuinely late. The session can be stopped at any instant and then says how much was actually said, per segment
 * (the head wants `spokenText` when a person cuts Shannon off).
 *
 * This file does not import discord.js; the AudioPlayer is behind `PlayerPort` (see discordSpeechPlayer.ts).
 */
import { PassThrough, type Readable } from 'node:stream';
import { BYTES_PER_MS_48K_STEREO, Pcm24kMonoTo48kStereo } from './pcm.js';

export type PlaybackKind = 'reply' | 'mouth' | 'backchannel';
export type SegmentKind = 'filler' | 'sentence' | 'line';
export type StopReason = 'barge_in' | 'human_speech' | 'preempted' | 'disposed' | 'manual';

export interface ResourceLike {
  /** ms of real audio sent so far (the library counts only real packets here). */
  playbackDuration: number;
}

export interface PlayerPort {
  play(resource: ResourceLike): void;
  stop(force?: boolean): void;
  /** `status` is the new AudioPlayerStatus value ('idle', 'buffering', 'playing', ...). */
  onStateChange(listener: (status: string) => void): () => void;
  onError(listener: (error: Error) => void): () => void;
}

export interface SpeechPlayerDeps {
  port: PlayerPort;
  createResource: (stream: Readable) => ResourceLike;
  now?: () => number;
  /** How often the playback position is checked (segment starts, watchdog). Default 10 ms. */
  pollMs?: number;
}

export interface SegmentReport {
  index: number;
  kind: SegmentKind;
  text: string;
  state: 'played' | 'partial' | 'unplayed';
  playedChars: number;
}

export interface PlaybackReport {
  reason: 'completed' | StopReason | 'error';
  playedMs: number;
  /** When the first audio went out (null if none did). */
  startedAt: number | null;
  endedAt: number;
  segments: SegmentReport[];
  /** What was actually said: fully played segments, plus the played part of the cut one. */
  spokenText: string;
}

export interface SegmentStart {
  index: number;
  kind: SegmentKind;
  text: string;
  at: number;
}

export interface PlaybackHooks {
  onSegmentStart?(start: SegmentStart): void;
}

export interface SegmentWriter {
  readonly index: number;
  /** PCM from the head: s16le, 24 kHz, mono. Chunks may split a sample. */
  writeMono24k(chunk: Buffer): void;
  /** Already 48 kHz stereo s16le. */
  writeStereo48k(chunk: Buffer): void;
  /** No more audio for this segment. Safe to call twice. */
  end(): void;
}

interface Segment {
  index: number;
  kind: SegmentKind;
  text: string;
  converter: Pcm24kMonoTo48kStereo;
  parts: Buffer[];
  writtenBytes: number;
  startByte: number | null;
  ended: boolean;
  startFired: boolean;
}

const START_THRESHOLD_BYTES = 20 * BYTES_PER_MS_48K_STEREO;
const WATCHDOG_SLACK_MS = 2_500;
/** Japanese speech runs about 7-8 characters a second; used only to estimate a cut, not-yet-complete segment. */
const ESTIMATED_MS_PER_CHAR = 130;

export class SpeechPlayer {
  private session: PlaybackSession | null = null;
  private readonly now: () => number;
  private readonly speakingListeners = new Set<(speaking: boolean, kind: PlaybackKind) => void>();
  private readonly unsubscribe: Array<() => void> = [];

  constructor(private readonly deps: SpeechPlayerDeps) {
    this.now = deps.now ?? Date.now;
    this.unsubscribe.push(deps.port.onStateChange(status => this.session?.handleStatus(status)));
    this.unsubscribe.push(deps.port.onError(error => this.session?.handleError(error)));
  }

  /** Start a new playback. Anything still playing is stopped (`preempted`). */
  open(kind: PlaybackKind, hooks: PlaybackHooks = {}): PlaybackSession {
    if (this.session && !this.session.isOver) this.session.stop('preempted');
    const session = new PlaybackSession(kind, this.deps, hooks, this.now, (speaking) => {
      for (const listener of [...this.speakingListeners]) {
        try { listener(speaking, kind); } catch { /* listeners must not break playback */ }
      }
    });
    this.session = session;
    return session;
  }

  /** The playback that is open (even before its first audio), if any. */
  current(): PlaybackSession | null {
    return this.session && !this.session.isOver ? this.session : null;
  }

  /** Set once audio is actually going out; null while silent. */
  speaking(): { kind: PlaybackKind; since: number } | null {
    const session = this.current();
    if (!session || session.startedAt === null) return null;
    return { kind: session.kind, since: session.startedAt };
  }

  stop(reason: StopReason): PlaybackReport | null {
    const session = this.current();
    return session ? session.stop(reason) : null;
  }

  onSpeakingChange(listener: (speaking: boolean, kind: PlaybackKind) => void): () => void {
    this.speakingListeners.add(listener);
    return () => { this.speakingListeners.delete(listener); };
  }

  dispose(): void {
    this.stop('disposed');
    for (const off of this.unsubscribe.splice(0)) off();
    this.speakingListeners.clear();
  }
}

export class PlaybackSession {
  private readonly segments: Segment[] = [];
  private cursor = 0;
  private finished = false;
  private over = false;
  private source: PassThrough | null = null;
  private resource: ResourceLike | null = null;
  private bytesToSource = 0;
  private playedBase = 0;
  private started: number | null = null;
  private allWrittenDeadline: number | null = null;
  private sourceEnded = false;
  private carry: Buffer | null = null;
  private timer: NodeJS.Timeout | null = null;
  private resolveDone!: (report: PlaybackReport) => void;
  private readonly donePromise: Promise<PlaybackReport>;
  private report: PlaybackReport | null = null;

  constructor(
    readonly kind: PlaybackKind,
    private readonly deps: SpeechPlayerDeps,
    private readonly hooks: PlaybackHooks,
    private readonly now: () => number,
    private readonly speakingChanged: (speaking: boolean) => void,
  ) {
    this.donePromise = new Promise(resolve => { this.resolveDone = resolve; });
  }

  get isOver(): boolean { return this.over; }
  get startedAt(): number | null { return this.started; }

  /** Resolves when all audio has played or the session was stopped. */
  whenDone(): Promise<PlaybackReport> { return this.donePromise; }

  /** Add the next piece (filler, sentence). Pieces play in the order they are added. */
  addSegment(text: string, kind: SegmentKind, options: { gain?: number } = {}): SegmentWriter {
    const segment: Segment = {
      index: this.segments.length,
      kind,
      text,
      converter: new Pcm24kMonoTo48kStereo(options.gain ?? 1),
      parts: [],
      writtenBytes: 0,
      // The playback position this segment starts at, when everything before it is already written.
      startByte: this.cursor === this.segments.length ? this.bytesToSource : null,
      ended: false,
      startFired: false,
    };
    this.segments.push(segment);
    const accept = (): boolean => !this.over && !segment.ended;
    return {
      index: segment.index,
      writeMono24k: (chunk) => {
        if (!accept()) return;
        const out = segment.converter.push(chunk);
        if (out.length > 0) { segment.parts.push(out); this.pump(); }
      },
      writeStereo48k: (chunk) => {
        if (!accept() || chunk.length === 0) return;
        segment.parts.push(chunk);
        this.pump();
      },
      end: () => {
        if (this.over || segment.ended) return;
        const tail = segment.converter.flush();
        if (tail.length > 0) segment.parts.push(tail);
        segment.ended = true;
        this.pump();
      },
    };
  }

  /** No more segments will be added; the session completes when everything has played. */
  finish(): void {
    if (this.over || this.finished) return;
    this.finished = true;
    this.pump();
  }

  /** Stop right now. Returns what was said. Safe to call after the end (returns the final report). */
  stop(reason: StopReason): PlaybackReport {
    if (this.over && this.report) return this.report;
    return this.complete(reason);
  }

  // ── internals (called by SpeechPlayer / the player port) ──────────────────

  handleStatus(status: string): void {
    if (this.over) return;
    if (status === 'playing') this.poll();
    if (status !== 'idle' || !this.resource) return;
    // The library stopped our resource: either it finished (we ended the source) or it ran dry.
    if (this.sourceEnded) {
      this.poll();
      this.complete('completed');
      return;
    }
    let leftover: Buffer | null = null;
    if (this.source && this.source.readableLength > 0) leftover = this.source.read() as Buffer | null;
    this.source?.destroy();
    this.source = null;
    this.resource = null;
    if (leftover && leftover.length > 0) {
      this.bytesToSource -= leftover.length;
      this.carry = leftover;
    }
    this.playedBase = this.bytesToSource / BYTES_PER_MS_48K_STEREO;
    this.pump();
  }

  handleError(_error: Error): void {
    if (this.over) return;
    this.complete('error');
  }

  private ensureResource(): void {
    if (this.resource) return;
    // Big buffer: a PassThrough over its highWaterMark would hold later writes back instead of queueing them.
    this.source = new PassThrough({ highWaterMark: 16 * 1024 * 1024 });
    this.sourceEnded = false;
    this.resource = this.deps.createResource(this.source);
    this.deps.port.play(this.resource);
    this.startTimer();
  }

  private pump(): void {
    if (this.over) return;
    if (this.carry && this.carry.length > 0) {
      this.ensureResource();
      this.source!.write(this.carry);
      this.bytesToSource += this.carry.length;
      this.carry = null;
    }
    while (this.cursor < this.segments.length) {
      const segment = this.segments[this.cursor]!;
      if (segment.parts.length > 0) {
        this.ensureResource();
        for (const part of segment.parts) {
          this.source!.write(part);
          this.bytesToSource += part.length;
          segment.writtenBytes += part.length;
        }
        segment.parts = [];
      }
      if (!segment.ended) break;
      this.cursor += 1;
      const next = this.segments[this.cursor];
      if (next) next.startByte = this.bytesToSource;
    }
    if (this.finished && this.cursor >= this.segments.length && !this.sourceEnded) {
      if (this.source) {
        this.sourceEnded = true;
        this.source.end();
        this.allWrittenDeadline = this.now()
          + Math.max(0, this.bytesToSource / BYTES_PER_MS_48K_STEREO - this.positionMs())
          + WATCHDOG_SLACK_MS;
      } else {
        // Nothing is playing and nothing more will come.
        this.complete('completed');
      }
    }
  }

  private positionMs(): number {
    const live = this.resource ? this.resource.playbackDuration : 0;
    return Math.min(this.playedBase + live, this.bytesToSource / BYTES_PER_MS_48K_STEREO);
  }

  private startTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.poll(), this.deps.pollMs ?? 10);
    this.timer.unref?.();
  }

  /** Detect segment starts from the playback position; run the watchdog. */
  poll(): void {
    if (this.over) return;
    const positionBytes = this.positionMs() * BYTES_PER_MS_48K_STEREO;
    for (const segment of this.segments) {
      if (segment.startFired || segment.startByte === null || segment.writtenBytes === 0) continue;
      if (positionBytes < segment.startByte + Math.min(START_THRESHOLD_BYTES, segment.writtenBytes)) break;
      segment.startFired = true;
      const at = this.now();
      if (this.started === null) {
        this.started = at;
        this.speakingChanged(true);
      }
      try {
        this.hooks.onSegmentStart?.({ index: segment.index, kind: segment.kind, text: segment.text, at });
      } catch { /* hooks must not break playback */ }
    }
    if (this.allWrittenDeadline !== null && this.now() > this.allWrittenDeadline) this.complete('completed');
  }

  private complete(reason: PlaybackReport['reason']): PlaybackReport {
    if (this.report) return this.report;
    const completed = reason === 'completed';
    const positionBytes = completed ? Infinity : this.positionMs() * BYTES_PER_MS_48K_STEREO;
    const segments: SegmentReport[] = this.segments.map(segment => {
      const total = segment.writtenBytes + segment.parts.reduce((sum, part) => sum + part.length, 0);
      if (completed) {
        const had = total > 0;
        return { index: segment.index, kind: segment.kind, text: segment.text, state: had ? 'played' : 'unplayed', playedChars: had ? segment.text.length : 0 };
      }
      if (segment.startByte === null || total === 0 || positionBytes <= segment.startByte) {
        return { index: segment.index, kind: segment.kind, text: segment.text, state: 'unplayed', playedChars: 0 };
      }
      const playedBytes = positionBytes - segment.startByte;
      if (segment.ended && playedBytes >= total - START_THRESHOLD_BYTES) {
        return { index: segment.index, kind: segment.kind, text: segment.text, state: 'played', playedChars: segment.text.length };
      }
      const estimatedTotal = segment.ended
        ? total
        : Math.max(total, segment.text.length * ESTIMATED_MS_PER_CHAR * BYTES_PER_MS_48K_STEREO);
      const chars = Math.max(0, Math.min(segment.text.length - 1, Math.floor((playedBytes / estimatedTotal) * segment.text.length)));
      return {
        index: segment.index, kind: segment.kind, text: segment.text,
        state: chars > 0 ? 'partial' : 'unplayed', playedChars: chars,
      };
    });
    const report: PlaybackReport = {
      reason,
      playedMs: Math.round(this.positionMs()),
      startedAt: this.started,
      endedAt: this.now(),
      segments,
      spokenText: segments.map(item => item.text.slice(0, item.playedChars)).join(''),
    };
    this.report = report;
    this.over = true;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    const hadResource = this.resource !== null;
    const source = this.source;
    this.source = null;
    this.resource = null;
    if (!completed && hadResource) {
      try { this.deps.port.stop(true); } catch { /* the player may already be gone */ }
    }
    source?.destroy();
    if (this.started !== null) this.speakingChanged(false);
    this.resolveDone(report);
    return report;
  }
}
