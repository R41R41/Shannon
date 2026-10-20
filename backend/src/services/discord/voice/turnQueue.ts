/**
 * dc-voice: the order of conversation turns in one VC (one queue per guild).
 *
 * - Turns run one at a time: while Shannon is generating / speaking a reply, other people's utterances wait.
 * - The same person's consecutive waiting utterances become one (joined with "、").
 * - A waiting utterance older than `maxWaitMs` (15 s) is dropped; at most `maxPending` (3) wait, the oldest of a
 *   longer line is dropped. Waiting ones run oldest first.
 * - What Shannon did not answer (silent decision, failed turn, dropped while waiting) is remembered as "heard"
 *   (newest first, 8 entries, 90 s) and travels with the next request, so the head knows the conversation flow.
 */

export interface TurnItem {
  userId: string;
  name: string;
  text: string;
  /** Epoch ms of the first audio packet of the (first merged) utterance. */
  startedAt: number;
  /** Epoch ms of the last audio packet: the baseline for every latency number. */
  endAt: number;
  /** Epoch ms the item entered the queue (the oldest part when merged). */
  queuedAt: number;
  sttMs: number;
  utteranceMs: number;
  /** last packet -> stream end (the silence wait). */
  endpointMs: number;
  /** How many utterances were merged into this item. */
  parts: number;
}

export interface HeardEntry {
  userId: string;
  name: string;
  text: string;
  /** Epoch ms. */
  at: number;
}

export interface TurnRunResult { responded: boolean }

export type TurnQueueEvent = 'start' | 'idle';

export interface TurnQueueOptions {
  run: (item: TurnItem) => Promise<TurnRunResult>;
  now?: () => number;
  maxPending?: number;
  maxWaitMs?: number;
  heardMax?: number;
  heardWindowMs?: number;
  joiner?: string;
  onDrop?: (item: TurnItem, reason: 'stale' | 'overflow') => void;
}

export class TurnQueue {
  private readonly now: () => number;
  private readonly maxPending: number;
  private readonly maxWaitMs: number;
  private readonly heardMax: number;
  private readonly heardWindowMs: number;
  private readonly joiner: string;
  private running: TurnItem | null = null;
  private pending: TurnItem[] = [];
  private reservations = 0;
  private disposed = false;
  private heardList: HeardEntry[] = [];
  private readonly listeners = new Set<(event: TurnQueueEvent) => void>();

  constructor(private readonly options: TurnQueueOptions) {
    this.now = options.now ?? Date.now;
    this.maxPending = options.maxPending ?? 3;
    this.maxWaitMs = options.maxWaitMs ?? 15_000;
    this.heardMax = options.heardMax ?? 8;
    this.heardWindowMs = options.heardWindowMs ?? 90_000;
    this.joiner = options.joiner ?? '、';
  }

  onChange(listener: (event: TurnQueueEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** A turn is running or waiting. */
  isBusy(): boolean { return this.running !== null || this.pending.length > 0; }

  /** A turn is running, waiting, or an utterance is still being transcribed (see `reserve`). */
  isActive(): boolean { return this.isBusy() || this.reservations > 0; }

  pendingCount(): number { return this.pending.length; }

  runningUserId(): string | null { return this.running?.userId ?? null; }

  /**
   * Mark "an utterance is being transcribed" so the mouth does not start talking in the gap between the end of a
   * person's speech and their turn entering the queue. Release it (once) after `submit`.
   */
  reserve(): () => void {
    this.reservations += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.reservations -= 1;
      if (!this.isActive()) this.emit('idle');
    };
  }

  submit(input: Omit<TurnItem, 'queuedAt' | 'parts'> & { parts?: number }): void {
    if (this.disposed) return;
    const now = this.now();
    const item: TurnItem = { ...input, queuedAt: now, parts: input.parts ?? 1 };
    this.dropStale();
    if (this.running === null && this.pending.length === 0) {
      void this.runLoop(item);
      return;
    }
    const last = this.pending[this.pending.length - 1];
    if (last && last.userId === item.userId) {
      last.text = `${last.text}${this.joiner}${item.text}`;
      last.endAt = item.endAt;
      last.sttMs += item.sttMs;
      last.utteranceMs += item.utteranceMs;
      last.endpointMs = item.endpointMs;
      last.parts += item.parts;
      return;
    }
    this.pending.push(item);
    while (this.pending.length > this.maxPending) {
      const dropped = this.pending.shift()!;
      this.remember(dropped);
      this.options.onDrop?.(dropped, 'overflow');
    }
  }

  /** Put something Shannon heard but did not answer into the list of "heard". */
  remember(item: Pick<TurnItem, 'userId' | 'name' | 'text' | 'endAt'>): void {
    this.heardList.unshift({ userId: item.userId, name: item.name, text: item.text, at: item.endAt });
    this.trimHeard();
  }

  /** Newest first. The speaker's own earlier lines are left out (the head remembers what a person said). */
  heard(excludeUserId?: string): HeardEntry[] {
    this.trimHeard();
    return this.heardList.filter(entry => entry.userId !== excludeUserId).slice(0, this.heardMax);
  }

  dispose(): void {
    this.disposed = true;
    this.pending = [];
    this.listeners.clear();
  }

  private trimHeard(): void {
    const limit = this.now() - this.heardWindowMs;
    this.heardList = this.heardList.filter(entry => entry.at >= limit).slice(0, this.heardMax * 2);
  }

  private dropStale(): void {
    const limit = this.now() - this.maxWaitMs;
    const keep: TurnItem[] = [];
    for (const item of this.pending) {
      if (item.queuedAt < limit) {
        this.remember(item);
        this.options.onDrop?.(item, 'stale');
      } else {
        keep.push(item);
      }
    }
    this.pending = keep;
  }

  private async runLoop(first: TurnItem): Promise<void> {
    let item: TurnItem | undefined = first;
    while (item && !this.disposed) {
      this.running = item;
      this.emit('start');
      let responded = false;
      try {
        responded = (await this.options.run(item)).responded;
      } catch {
        responded = false;
      }
      if (!responded) this.remember(item);
      this.running = null;
      this.dropStale();
      item = this.pending.shift();
    }
    this.running = null;
    if (!this.isActive()) this.emit('idle');
  }

  private emit(event: TurnQueueEvent): void {
    for (const listener of [...this.listeners]) {
      try { listener(event); } catch { /* listeners must not break the queue */ }
    }
  }
}
