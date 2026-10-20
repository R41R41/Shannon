/**
 * dc-voice: who is speaking in the VC right now.
 *
 * Fed from the Discord receiver's `speaking` start/end events (every non-bot member, not only the ones the bot
 * transcribes). The mouth waits on it ("never start while a person talks"), the barge-in monitor reads how long
 * a person has been talking, and the backchannel reads pauses.
 */

export type SpeakerEvent = 'start' | 'end';
type Listener = (userId: string) => void;

interface SpeakerState {
  speakingSince: number | null;
  /** Start of the current run of speech; runs separated by <= mergeGapMs are one run. */
  runStart: number | null;
  lastEnd: number | null;
}

export interface SpeakerTrackerOptions {
  /** After someone stops, they still count as "talking" for this long. Default 800 ms. */
  hangoverMs?: number;
  /** Two bursts closer than this are one run of speech (breaths). Default 250 ms. */
  mergeGapMs?: number;
  now?: () => number;
}

export class SpeakerTracker {
  readonly hangoverMs: number;
  private readonly mergeGapMs: number;
  private readonly now: () => number;
  private readonly users = new Map<string, SpeakerState>();
  private lastAnyEnd: number | null = null;
  private readonly listeners: Record<SpeakerEvent, Set<Listener>> = { start: new Set(), end: new Set() };

  constructor(options: SpeakerTrackerOptions = {}) {
    this.hangoverMs = options.hangoverMs ?? 800;
    this.mergeGapMs = options.mergeGapMs ?? 250;
    this.now = options.now ?? Date.now;
  }

  on(event: SpeakerEvent, listener: Listener): () => void {
    this.listeners[event].add(listener);
    return () => { this.listeners[event].delete(listener); };
  }

  start(userId: string): void {
    const now = this.now();
    const state = this.users.get(userId) ?? { speakingSince: null, runStart: null, lastEnd: null };
    this.users.set(userId, state);
    if (state.speakingSince !== null) return;
    const continues = state.lastEnd !== null && state.runStart !== null && now - state.lastEnd <= this.mergeGapMs;
    if (!continues) state.runStart = now;
    state.speakingSince = now;
    this.emit('start', userId);
  }

  end(userId: string): void {
    const state = this.users.get(userId);
    if (!state || state.speakingSince === null) return;
    const now = this.now();
    state.speakingSince = null;
    state.lastEnd = now;
    this.lastAnyEnd = now;
    this.emit('end', userId);
  }

  /** Drop a user (left the VC). */
  forget(userId: string): void {
    this.end(userId);
    this.users.delete(userId);
  }

  isSpeaking(userId: string): boolean {
    return this.users.get(userId)?.speakingSince != null;
  }

  speakingUsers(): string[] {
    const result: string[] = [];
    for (const [userId, state] of this.users) if (state.speakingSince !== null) result.push(userId);
    return result;
  }

  /** Someone is talking now, or stopped less than `hangoverMs` ago. */
  isBusy(excludeUserId?: string): boolean {
    const now = this.now();
    for (const [userId, state] of this.users) {
      if (userId === excludeUserId) continue;
      if (state.speakingSince !== null) return true;
      if (state.lastEnd !== null && now - state.lastEnd < this.hangoverMs) return true;
    }
    return false;
  }

  /** When `isBusy()` will become false if nobody speaks again; null while someone speaks; 0 when already quiet. */
  quietAt(): number | null {
    if (this.speakingUsers().length > 0) return null;
    if (this.lastAnyEnd === null) return 0;
    return this.lastAnyEnd + this.hangoverMs;
  }

  /** How long nobody has spoken: 0 while someone does; null when nobody has spoken yet. */
  sinceAnyoneMs(): number | null {
    if (this.speakingUsers().length > 0) return 0;
    return this.lastAnyEnd === null ? null : Math.max(0, this.now() - this.lastAnyEnd);
  }

  /** Start of this person's current run of speech (gaps <= mergeGapMs ignored), or undefined if not in a run. */
  runStart(userId: string): number | undefined {
    const state = this.users.get(userId);
    if (!state || state.runStart === null) return undefined;
    if (state.speakingSince !== null) return state.runStart;
    if (state.lastEnd !== null && this.now() - state.lastEnd <= this.mergeGapMs) return state.runStart;
    return undefined;
  }

  private emit(event: SpeakerEvent, userId: string): void {
    for (const listener of [...this.listeners[event]]) {
      try {
        listener(userId);
      } catch {
        // a listener must never break the receiver
      }
    }
  }
}
