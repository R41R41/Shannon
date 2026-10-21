import { nativeActionHost } from '../execution/ActionExecution.js';
import type { Cell } from './localMap.js';

/**
 * The hands and stops of the body's acts, with where (r4 contract 1, `probe` kind `history`): the body keeps the last HISTORY_MAX hands
 * an act ran (done, failed, stopped; a skipped hand did not run and is not kept), each with the feet when it began (`from`), the cell it
 * was about or where it stopped (`at`) and its line as the act's result gave it. Read only by the probe; nothing in the body acts on it.
 *
 * Arch-check 6 (S1, S2): the same stop came back twice and the decision did not know what had been tried at that place before.
 */
export const HISTORY_MAX = 200;
/** A line is kept to this many characters (the act's line is at most 160). */
const LINE_MAX = 120;

export interface HandRecord {
  /** When the hand ended (ms since the epoch). */
  t: number;
  /** The hand's kind (walk, dig, place ...). */
  do: string;
  status: 'done' | 'failed' | 'stopped';
  /** The act's line for the hand (closed word first for a stop). */
  line: string;
  /** The cell the hand was about, or where it stopped; else the feet after it. */
  at: Cell;
  /** The feet when the hand began. */
  from?: Cell;
}

const histories = new WeakMap<object, HandRecord[]>();

function historyOf(bot: object): HandRecord[] {
  const host = nativeActionHost(bot);
  let list = histories.get(host);
  if (!list) { list = []; histories.set(host, list); }
  return list;
}

/** Keeps one hand (the oldest goes past HISTORY_MAX). */
export function noteHand(bot: object, record: HandRecord): void {
  const list = historyOf(bot);
  list.push({ ...record, line: record.line.length <= LINE_MAX ? record.line : `${record.line.slice(0, LINE_MAX - 1)}…` });
  if (list.length > HISTORY_MAX) list.splice(0, list.length - HISTORY_MAX);
}

/** Every hand kept, oldest first (a copy). */
export function handHistory(bot: object): HandRecord[] { return [...historyOf(bot)]; }

const near = (a: Cell | undefined, b: Cell, radius: number) => !!a && Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) <= radius;

/** The hands at or from a place: `at` or `from` within `radius` of the cell, newest first, at most `most`. */
export function handsNear(bot: object, at: Cell, radius: number, most = 10): HandRecord[] {
  const list = historyOf(bot), out: HandRecord[] = [];
  for (let index = list.length - 1; index >= 0 && out.length < most; index--) {
    const record = list[index];
    if (near(record.at, at, radius) || near(record.from, at, radius)) out.push(record);
  }
  return out;
}
