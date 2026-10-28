import type { EventsMore, EventsReply, InventoryEvent } from './continueContract.js';
import type { MinecraftSkillDefinition } from './minecraftControlContract.js';

/**
 * The inventory events of the commands (continue contracts, 3): the receipt carries as many as fit; the rest the head takes by the internal
 * read-only command `events` ({ command, fromSeq, max }), page by page, in the order they were given (`deliverySeq`, 0 up, across passes and hands).
 * The body keeps a command's record until the head has the receipt and every page (`release` is called when the receipt is acknowledged and the
 * pages are taken, or when the record is old). Asking the same range again gives the same events. A record the body lost (a restart) is `lost: true`.
 * A-6 (6): only a record whose receipt the head acknowledged is ever pruned (by age or by count); one it has not acknowledged is kept however old. When the
 * events kept pass `MAX_EVENTS` (5,000) the acknowledged records go first; only if that is not enough the oldest unacknowledged record is dropped, and it is
 * dropped explicitly: its pages answer `lost: true` (with the total it had), never an empty page that looks like "nothing happened".
 */
export const EVENTS_SKILL: MinecraftSkillDefinition = {
  name: 'events', readOnly: true,
  description: '内部用（LLM には見せない）。command の持ち物の出来事を fromSeq から max 件、配送の番号の順に返す。同じ範囲をもう一度頼むと同じ出来事を返す。体が記録を失っていたら lost: true。',
  inputSchema: { type: 'object', properties: { command: { type: 'string' }, fromSeq: { type: 'integer', minimum: 0 }, max: { type: 'integer', minimum: 1, maximum: 200 } },
    required: ['command', 'fromSeq'], additionalProperties: false },
};
/** The page size when the head does not say. */
export const EVENTS_PAGE = 100;
/** An acknowledged record nobody has taken the pages of is dropped after this long. An unacknowledged one is never dropped for age. */
const KEEP_MS = 30 * 60_000;
const MAX_COMMANDS = 400;
/** The most events the store keeps in all; past this the oldest records go, acknowledged ones first, and an unacknowledged one only with an explicit `lost`. */
export const MAX_EVENTS = 5_000;
/** The notes of dropped (lost) records are kept this many, oldest out, so a late fetch still hears `lost: true`. */
const MAX_LOST_NOTES = 1_000;

interface Record_ { events: InventoryEvent[]; at: number; receiptAcknowledged: boolean; pagesDone: boolean; lost?: { total: number } }

export class EventStore {
  private readonly records = new Map<string, Record_>();
  constructor(private readonly now: () => number = Date.now) {}

  /** The events a command made (all of them), kept until the head has them. */
  add(command: string, events: readonly InventoryEvent[]): void {
    this.records.set(command, { events: events.map(event => ({ ...event })), at: this.now(), receiptAcknowledged: false, pagesDone: events.length === 0 });
    this.prune();
  }
  has(command: string): boolean { return this.records.has(command); }
  /** The receipt carried every event: there are no pages to take. */
  markComplete(command: string): void { const record = this.records.get(command); if (record) record.pagesDone = true; }
  total(command: string): number { const record = this.records.get(command); return record?.lost?.total ?? record?.events.length ?? 0; }
  /** Whether the body dropped this command's events on purpose (the cap), as the head will be told. */
  isLost(command: string): boolean { return !!this.records.get(command)?.lost; }
  /** What the receipt did not carry: from which delivery number the head must fetch. */
  more(command: string, carried: readonly InventoryEvent[]): EventsMore | undefined {
    const record = this.records.get(command);
    if (!record) return undefined;
    if (record.lost) return { command, nextSeq: 0, total: record.lost.total };
    const delivered = new Set(carried.map(event => event.deliverySeq));
    const next = record.events.find(event => !delivered.has(event.deliverySeq));
    if (!next) { record.pagesDone = true; return undefined; }
    record.pagesDone = false;
    return { command, nextSeq: next.deliverySeq ?? 0, total: record.events.length };
  }
  page(command: string, fromSeq: number, max: number = EVENTS_PAGE): EventsReply {
    const record = this.records.get(command);
    if (!record) return { command, from: fromSeq, to: fromSeq, total: 0, nextSeq: fromSeq, done: false, lost: true, events: [] };
    if (record.lost) return { command, from: fromSeq, to: fromSeq, total: record.lost.total, nextSeq: fromSeq, done: false, lost: true, events: [] };
    const size = Math.max(1, Math.min(200, Math.floor(max)));
    const events = record.events.filter(event => (event.deliverySeq ?? 0) >= fromSeq).slice(0, size);
    const to = events.length ? (events[events.length - 1].deliverySeq ?? fromSeq) + 1 : fromSeq;
    const done = to >= record.events.length;
    if (done) record.pagesDone = true;
    return { command, from: fromSeq, to, total: record.events.length, nextSeq: done ? record.events.length : to, done, lost: false, events };
  }
  /** The head acknowledged the command's receipt. The record goes when its pages are taken too. */
  acknowledgeReceipt(command: string): void {
    const record = this.records.get(command);
    if (!record) return;
    record.receiptAcknowledged = true;
    if (record.pagesDone || record.lost) this.records.delete(command);
  }
  private prune(): void {
    const cutoff = this.now() - KEEP_MS;
    // By age: only the records the head has acknowledged the receipt of.
    for (const [command, record] of this.records) if (record.receiptAcknowledged && record.at < cutoff) this.records.delete(command);
    // By count of commands: the oldest acknowledged first; an unacknowledged one is not dropped for this.
    for (const [command, record] of this.records) { if (this.records.size < MAX_COMMANDS) break; if (record.receiptAcknowledged) this.records.delete(command); }
    // By count of events: acknowledged first, then (the only way an unacknowledged one goes) explicitly lost.
    const held = () => { let n = 0; for (const record of this.records.values()) n += record.events.length; return n; };
    for (const [command, record] of this.records) { if (held() <= MAX_EVENTS) break; if (record.receiptAcknowledged) this.records.delete(command); }
    for (const [, record] of this.records) {
      if (held() <= MAX_EVENTS) break;
      if (record.lost || !record.events.length) continue;
      record.lost = { total: record.events.length };
      record.events = [];
    }
    // The notes of the lost ones are bounded too (oldest out).
    const notes = [...this.records.entries()].filter(([, record]) => record.lost);
    for (const [command] of notes.slice(0, Math.max(0, notes.length - MAX_LOST_NOTES))) this.records.delete(command);
  }
}
