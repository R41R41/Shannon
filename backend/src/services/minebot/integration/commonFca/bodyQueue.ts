import { z } from 'zod';
import { ACT_CONDITION, type ActCondition } from '../../utils/actConditions.js';
import type { MinecraftControlCommand as Command } from './minecraftControlContract.js';
import { dependStateOf, isReliable, keepVerdict, type DependState, type GoalOutcome, type ItemOutcome, type QueueRef, type RunEnd } from './continueContract.js';

/**
 * The body's queue of `act` items (the head's `tq/contract.md` section 3; design: the head hands the body what to do next while an item runs,
 * the body runs them one after the other and decides nothing). One item runs and up to two wait; the owner is the control loop's owner key.
 *
 * Continue contracts (1, 2): an item that ends without something to rely on (done or already, finished, released) no longer drops everything that waits.
 * What waits is judged by what it says it depends on (`dependsOn`, the items of this queue): an item that says nothing is dropped as before
 * (writing nothing is no proof of independence); one that names other items and not the one that failed is kept and starts in its turn; one that names
 * a failed or dropped item is dropped. The table is the fixtures' `continue/dependency-table.json`; the pure rules are in continueContract.ts.
 * This holds the order, the words and the memory of how each item ended; the loop runs the items.
 */
const ID = /^q[0-9]{1,6}$/u;
const DIM = z.enum(['overworld', 'the_nether', 'the_end']);
const MADE_IN = z.object({
  life: z.number().int().min(0), dim: DIM, dimSince: z.string().min(1).max(64), bodyBoot: z.string().min(1).max(80), connectionId: z.string().min(1).max(160),
  headBoot: z.string().min(1).max(80), obsSeq: z.number().int().min(0),
}).strict();
const ENVELOPE = z.object({
  item: z.string().regex(ID), after: z.string().regex(ID).nullable(), node: z.string().max(64).nullable(),
  pre: ACT_CONDITION.optional(), maxMs: z.number().int().min(1000).max(180_000),
  startBy: z.string().refine(value => Number.isFinite(Date.parse(value))),
  queue: z.string().min(1).max(200),
  dependsOn: z.array(z.string().regex(ID)).max(3).optional(),
  madeIn: MADE_IN,
}).strict().refine(envelope => !envelope.dependsOn || (new Set(envelope.dependsOn).size === envelope.dependsOn.length && !envelope.dependsOn.includes(envelope.item)));
export type QueueEnvelope = z.infer<typeof ENVELOPE>;

/** Waiting items at most (the running one is beside them). */
const WAITING_MAX = 2;
/** How many ended items are remembered (the references of `dependsOn` can name any of the items of the queue; a queue holds three at a time). */
const RECENT_MAX = 64;
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

/** How an item ended, as the queue remembers it (what `dependsOn` is judged by). */
export interface ItemEnd { goal: GoalOutcome; end: RunEnd; released: boolean; code?: string }
export interface Dropped { command: Command; code: 'depends_failed' | 'depends_unknown'; item?: QueueRef }
export interface Kept { command: Command; item: QueueRef; code: string }

const refKey = (queue: string, item: string) => `${queue}\u0000${item}`;

export class BodyQueue {
  /** The commands waiting, in order. */
  readonly waiting: Command[] = [];
  /** The running item's command id and item id, or null. */
  runningId: string | null = null;
  private runningItem: string | null = null;
  private runningQueue = '';
  private readonly recent = new Map<string, ItemEnd>();
  get busy(): boolean { return this.runningId !== null || this.waiting.length > 0; }
  ids(): string[] { return this.waiting.map(command => command.id); }
  /** The item a new item must follow: the last waiting one, else the running one, else null. */
  private tail(): string | null { return this.waiting.at(-1)?.queue?.item ?? this.runningItem; }
  /** The queue and item of what runs now, or null. */
  get running(): QueueRef | null { return this.runningItem ? { queue: this.runningQueue, item: this.runningItem } : null; }

  /** The state of a reference, as the dependency table says (priority: not remembered, not ended, not released, end unknown, reliable, else failed). */
  stateOf(queue: string, item: string): DependState {
    if (this.runningItem === item && this.runningQueue === queue) return 'pending';
    if (this.waiting.some(command => command.queue?.item === item && command.queue.queue === queue)) return 'pending';
    const ended = this.recent.get(refKey(queue, item));
    return dependStateOf(ended ? { ...ended, ended: true } : null);
  }
  /** How an ended item ended, or null when it is not remembered. */
  endOf(queue: string, item: string): ItemEnd | null { return this.recent.get(refKey(queue, item)) ?? null; }

  /** Whether a command with this envelope starts now, waits, or is refused (the queue is not changed). */
  admit(envelope: QueueEnvelope): Admission {
    const gone = (text: string) => ({ failureType: 'queue_after_gone' as const, result: `${text}この項目は始めていない（手は動いていない）` });
    // `after` is the order only: an item behind one that stopped is admitted when it names (as an array) the items it depends on and `after` is not among
    // them; it never skips the tail (the last item of the queue is the one it follows).
    const independentOf = (after: string) => Array.isArray(envelope.dependsOn) && !envelope.dependsOn.includes(after);
    if (!this.busy) {
      if (envelope.after === null) return 'start';
      const last = this.recent.get(refKey(envelope.queue, envelope.after));
      if (last && (isReliable(last) && last.released || independentOf(envelope.after))) return 'start';
      return gone(`前の項目 ${envelope.after} は${last ? '止まった' : '列に無い'}。`);
    }
    if (envelope.after === null) return { failureType: 'queue_busy', result: '列は空ではない（after が無い）。この項目は始めていない（手は動いていない）' };
    if (envelope.after !== this.tail()) return gone(`前の項目 ${envelope.after} は列の最後ではない（今の最後は ${this.tail() ?? '無し'}）。`);
    if (this.waiting.length >= WAITING_MAX) return { failureType: 'queue_full', result: '列は満杯（実行中を含めて 3 つまで）。この項目は始めていない（手は動いていない）' };
    return 'wait';
  }
  /** An item began running. */
  begin(command: Command): void {
    this.runningId = command.id; this.runningItem = command.queue?.item ?? null; this.runningQueue = command.queue?.queue ?? '';
  }
  /** The running item ended with this result. */
  end(item: string, queue: string, ended: ItemEnd): void {
    this.runningId = null; this.runningItem = null; this.runningQueue = '';
    this.note(queue, item, ended);
  }
  /** Remembers how an item ended (a dropped or never started one too: `dependsOn` can name it). */
  note(queue: string, item: string, ended: ItemEnd): void {
    const key = refKey(queue, item);
    this.recent.delete(key);
    this.recent.set(key, ended);
    if (this.recent.size > RECENT_MAX) this.recent.delete(this.recent.keys().next().value as string);
  }
  /** The first waiting command, taken. */
  next(): Command | undefined { return this.waiting.shift(); }

  /**
   * An item ended (`unit`): what waits is judged in order. After a reliable end everything stays. After any other end: an item without `dependsOn`
   * is dropped (`depends_failed`, naming the item that ended); one that names a list: dropped if the list holds the item that ended or an item dropped
   * in this pass (`depends_failed`) or one not remembered (`depends_unknown`); else it stays, and says it was kept despite the failure (`keptDespite`).
   * The dropped are taken out of the queue and returned with their reasons.
   */
  judgeWaiting(ended: { queue: string; item: string; unit: ItemEnd }): { dropped: Dropped[]; kept: Kept[] } {
    const dropped: Dropped[] = [], kept: Kept[] = [];
    if (isReliable(ended.unit) && ended.unit.released) return { dropped, kept };
    const gone = new Map<string, QueueRef>();   // items dropped in this pass, by item id
    const failedItem = { queue: ended.queue, item: ended.item };
    const survivors: Command[] = [];
    for (const command of this.waiting) {
      const item = command.queue!.item, list = command.queue!.dependsOn, queue = command.queue!.queue ?? ended.queue;
      if (!Array.isArray(list)) {
        dropped.push({ command, code: 'depends_failed', item: failedItem });
        gone.set(item, { queue, item });
        continue;
      }
      const states = list.map(ref => gone.has(ref) ? 'failed' as const : ref === ended.item ? 'failed' as const : this.stateOf(queue, ref));
      const verdict = keepVerdict(states);
      if (verdict !== 'keep') {
        const culprit = list.find((ref, index) => states[index] === (verdict === 'depends_failed' ? 'failed' : 'unknown'));
        dropped.push({ command, code: verdict, ...(culprit ? { item: gone.get(culprit) ?? { queue, item: culprit } } : {}) });
        gone.set(item, { queue, item });
        continue;
      }
      survivors.push(command);
      kept.push({ command, item: failedItem, code: ended.unit.goal });
    }
    this.waiting.splice(0, this.waiting.length, ...survivors);
    return { dropped, kept };
  }

  /**
   * The waiting command with this id and every one after it that depends on it or on what is dropped with it, taken (a cancel or a replace: the
   * cancelled item counts as failed for what follows). The ones that name a list without the dropped items stay. Returns the taken, with the reason
   * each one has, the first being the cancelled one itself.
   */
  removeWithDependents(id: string): Command[] {
    const index = this.waiting.findIndex(command => command.id === id);
    if (index < 0) return [];
    const taken: Command[] = [this.waiting[index]];
    const gone = new Set<string>([this.waiting[index].queue?.item ?? '']);
    const survivors: Command[] = this.waiting.slice(0, index);
    for (const command of this.waiting.slice(index + 1)) {
      const list = command.queue?.dependsOn;
      if (!Array.isArray(list) || list.some(ref => gone.has(ref))) { taken.push(command); gone.add(command.queue?.item ?? ''); } else survivors.push(command);
    }
    this.waiting.splice(0, this.waiting.length, ...survivors);
    return taken;
  }
  /** The first waiting command whose start-by time has passed, or undefined. */
  firstExpired(now: number): Command | undefined { return this.waiting.find(command => Date.parse(command.queue?.startBy ?? '') < now); }
  /** Every waiting command, taken. */
  clear(): Command[] { return this.waiting.splice(0); }
  /** Every waiting command that matches, taken. */
  takeWhere(match: (command: Command) => boolean): Command[] {
    const taken = this.waiting.filter(match);
    if (taken.length) this.waiting.splice(0, this.waiting.length, ...this.waiting.filter(command => !match(command)));
    return taken;
  }
}

export const EXPIRED_TEXT = '捨てた: 始める期限（startBy）を過ぎた。手は動いていない';

/** Why an item is not started though it was admitted: its start-by time passed, or its condition does not hold (words from the loop's check). */
export function notStarted(envelope: QueueEnvelope, now: number, check?: (pre: ActCondition) => { ok: boolean; words: string; unknown?: boolean }):
  { outcome: 'failed' | 'cancelled'; failureType: string; result: string } | null {
  if (Date.parse(envelope.startBy) < now) return { outcome: 'cancelled', failureType: 'queue_expired', result: EXPIRED_TEXT };
  if (!envelope.pre) return null;
  const verdict = check?.(envelope.pre) ?? { ok: false, words: '前提を確かめる手立てが無い', unknown: true };
  if (verdict.ok) return null;
  return { outcome: 'failed', failureType: verdict.unknown ? 'precondition_unknown' : 'precondition',
    result: `前提を満たさず始めなかった: ${verdict.words}（手は動かしていない）${verdict.unknown ? '。前提を判定できなかったので始めない' : ''}` };
}

export const droppedBecause = (item: string, why: string) => `捨てた: 前の項目 ${item} が止まった（${why}）。手は動いていない`;
export type { ItemOutcome };
