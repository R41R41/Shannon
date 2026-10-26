import { z } from 'zod';
import { ACT_CONDITION, type ActCondition } from '../../utils/actConditions.js';
import type { MinecraftControlCommand as Command } from './minecraftControlContract.js';

/**
 * The body's queue of `act` items (the head's `tq/contract.md` section 3; design: the head hands the body what to do next while an item runs,
 * the body runs them one after the other and decides nothing). One item runs and up to two wait; the owner is the control loop's owner key.
 * A queue item that ends well lets the next one start at once; any other end drops everything that waits (nothing that waits was started, so a
 * dropped item says its hands did not move). This holds the order and the words; the loop runs the items.
 */
const ID = /^q[0-9]{1,6}$/u;
const ENVELOPE = z.object({
  item: z.string().regex(ID), after: z.string().regex(ID).nullable(), node: z.string().max(64).nullable(),
  pre: ACT_CONDITION.optional(), maxMs: z.number().int().min(1000).max(180_000),
  startBy: z.string().refine(value => Number.isFinite(Date.parse(value))),
}).strict();
export type QueueEnvelope = z.infer<typeof ENVELOPE>;

/** Waiting items at most (the running one is beside them). */
const WAITING_MAX = 2;
const RECENT_MAX = 16;
/** How far ahead a queue command's deadline may lie (it only has to reach the item; the item's own limit is `maxMs` from its start). */
export const QUEUE_ACCEPT_WINDOW_MS = 630_000;

/** The command's envelope: undefined for an ordinary command, null when it carries one that is not a well formed act item, else the envelope. */
export function readEnvelope(command: Command): QueueEnvelope | null | undefined {
  if (command.queue === undefined) return undefined;
  if (command.kind !== 'skill' || command.skill !== 'act') return null;
  const parsed = ENVELOPE.safeParse(command.queue);
  return parsed.success ? parsed.data : null;
}

export type Admission = 'start' | 'wait' | { failureType: 'queue_after_gone' | 'queue_busy' | 'queue_full'; result: string };

export class BodyQueue {
  /** The commands waiting, in order. */
  readonly waiting: Command[] = [];
  /** The running item's command id and item id, or null. */
  runningId: string | null = null;
  private runningItem: string | null = null;
  private readonly recent = new Map<string, boolean>();
  get busy(): boolean { return this.runningId !== null || this.waiting.length > 0; }
  ids(): string[] { return this.waiting.map(command => command.id); }
  /** The item a new item must follow: the last waiting one, else the running one, else null. */
  private tail(): string | null { return this.waiting.at(-1)?.queue?.item ?? this.runningItem; }
  /** Whether a command with this envelope starts now, waits, or is refused (the queue is not changed). */
  admit(envelope: QueueEnvelope): Admission {
    const gone = (text: string) => ({ failureType: 'queue_after_gone' as const, result: `${text}この項目は始めていない（手は動いていない）` });
    if (!this.busy) {
      if (envelope.after === null || this.recent.get(envelope.after) === true) return 'start';
      return gone(`前の項目 ${envelope.after} は${this.recent.has(envelope.after) ? '止まった' : '列に無い'}。`);
    }
    if (envelope.after === null) return { failureType: 'queue_busy', result: '列は空ではない（after が無い）。この項目は始めていない（手は動いていない）' };
    if (envelope.after !== this.tail()) return gone(`前の項目 ${envelope.after} は列の最後ではない（今の最後は ${this.tail() ?? '無し'}）。`);
    if (this.waiting.length >= WAITING_MAX) return { failureType: 'queue_full', result: '列は満杯（実行中を含めて 3 つまで）。この項目は始めていない（手は動いていない）' };
    return 'wait';
  }
  /** An item began running. */
  begin(command: Command): void { this.runningId = command.id; this.runningItem = command.queue?.item ?? null; }
  /** The running item ended; `ok` is whether it ended well (the next may start). */
  end(item: string, ok: boolean): void {
    this.runningId = null; this.runningItem = null;
    this.note(item, ok);
  }
  note(item: string, ok: boolean): void {
    this.recent.delete(item);
    this.recent.set(item, ok);
    if (this.recent.size > RECENT_MAX) this.recent.delete(this.recent.keys().next().value as string);
  }
  /** The first waiting command, taken. */
  next(): Command | undefined { return this.waiting.shift(); }
  /** The waiting command with this id and every one after it (they follow it), taken. */
  removeFrom(id: string): Command[] {
    const index = this.waiting.findIndex(command => command.id === id);
    return index < 0 ? [] : this.waiting.splice(index);
  }
  /** The first waiting command whose start-by time has passed, or undefined. */
  firstExpired(now: number): Command | undefined { return this.waiting.find(command => Date.parse(command.queue?.startBy ?? '') < now); }
  /** Every waiting command, taken. */
  clear(): Command[] { return this.waiting.splice(0); }
}

export const EXPIRED_TEXT = '捨てた: 始める期限（startBy）を過ぎた。手は動いていない';

/** Why an item is not started though it was admitted: its start-by time passed, or its condition does not hold (words from the loop's check). */
export function notStarted(envelope: QueueEnvelope, now: number, check?: (pre: ActCondition) => { ok: boolean; words: string }):
  { outcome: 'failed' | 'cancelled'; failureType: string; result: string } | null {
  if (Date.parse(envelope.startBy) < now) return { outcome: 'cancelled', failureType: 'queue_expired', result: EXPIRED_TEXT };
  if (!envelope.pre) return null;
  const verdict = check?.(envelope.pre) ?? { ok: false, words: '前提を確かめる手立てが無い' };
  return verdict.ok ? null : { outcome: 'failed', failureType: 'precondition', result: `前提を満たさず始めなかった: ${verdict.words}（手は動かしていない）` };
}

export const droppedBecause = (item: string, why: string) => `捨てた: 前の項目 ${item} が止まった（${why}）。手は動いていない`;
