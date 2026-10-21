import { nativeActionHost } from '../execution/ActionExecution.js';
import { feetCell, localMapFor, type Cell } from './localMap.js';

/**
 * What an `act` returns (the head's contract: minecraftActContract.ts `ActResult`, mb-llm-centric-contract.md 1.3): a JSON object in the
 * receipt's `result` with one line per hand, why it stopped, where the body is now and the map. A reflex that takes the body aborts
 * the act's action, and the action layer then answers with its own bare "interrupted" (ActionExecution): the act's report is kept here
 * so that the body still says which hands were done and what the reflex did, with the place and the map after the reflex let go
 * (nativeBody renders it again then).
 */
export type HandStatus = 'done' | 'stopped' | 'skipped';
export interface HandLine { i: number; do: string; status: HandStatus; line: string; where?: Cell }
export type StoppedBy = 'failure' | 'reflex' | 'stopIf' | 'inventoryFull' | 'cancelled' | 'deadline';
export interface ActReport {
  startedAt: number;
  lines: HandLine[];
  ok: boolean;
  done: number;
  of: number;
  stoppedBy?: StoppedBy;
  stoppedWhy?: string;
  /** The first failure's code (the receipt's failureType). */
  failureType?: string;
  eye?: { from: Cell; bearingDeg: number; flew: number; to: Cell; broke: boolean };
  container?: { at: Cell; kind: string; items: string[] };
  arrowsLeft?: number;
}
const reports = new WeakMap<object, ActReport>();

export function keepActReport(bot: object, report: ActReport): void { reports.set(nativeActionHost(bot), report); }
/** The report of the act begun at or after `since`, taken (once). */
export function takeActReport(bot: object, since: number): ActReport | null {
  const host = nativeActionHost(bot);
  const report = reports.get(host);
  if (!report || report.startedAt < since) return null;
  reports.delete(host);
  return report;
}

/**
 * The contract's closed words for a stop, from a part's reason code: the first word of a stopped line (`届かない`, `一歩ではない`,
 * `掘れない`, `置けない`, `無い`, `満杯`, `見られる`, `守られた物`, `溶岩が流れ込む`, `足場が無い`, `時間切れ`, `反射`, `stopIf`).
 */
const CLOSED: Record<string, string> = {
  out_of_reach: '届かない', cannot_reach: '届かない', not_opened: '届かない',
  wall: '一歩ではない', low_ceiling: '一歩ではない', drop: '一歩ではない', lava: '一歩ではない', no_path: '一歩ではない', stuck: '一歩ではない',
  target_solid: '一歩ではない', walk_failed: '一歩ではない', ceiling: '一歩ではない', unloaded: '一歩ではない',
  unbreakable: '掘れない', no_harvest_tool: '掘れない', dig_unconfirmed: '掘れない', dig_failed: '掘れない',
  occupied: '置けない', body_in_cell: '置けない', creature_in_cell: '置けない', nothing_to_set_against: '置けない', not_placed: '置けない',
  not_set: '置けない', already_filled: '置けない', not_poured: '置けない', not_lit: '置けない', not_filled: '置けない', no_floor: '足場が無い',
  inventory_full: '満杯', threat_exposed: '見られる', protected: '守られた物', lava_behind: '溶岩が流れ込む', footing: '足場が無い',
  timeout: '時間切れ', time_up: '時間切れ', reflex: '反射', interrupted_by_reflex: '反射', stop_if: 'stopIf',
};
export function closedWord(reason: string | undefined): string {
  if (!reason) return '無い';
  if (reason.startsWith('stop_if')) return 'stopIf';
  return CLOSED[reason] ?? '無い';
}

/** At most `max` characters (the contract's 160 a line). */
export const clip = (text: string, max = 160) => text.length <= max ? text : `${text.slice(0, max - 1)}…`;

/** A stopped hand's line: the closed word first, then the place and what happened, then what the cell holds now. */
export function stoppedLine(reason: string | undefined, text: string, cellNow?: string): string {
  const word = closedWord(reason);
  const tail = cellNow ? `。そのマスは ${cellNow}` : '';
  return `${word}: ${clip(text, 160 - word.length - 2 - tail.length)}${tail}`;
}

/**
 * The receipt's text: the contract's ActResult as JSON (16,000 characters at most: the map is left out when it would not fit). `note` is
 * what the reflexes did meanwhile (the reflex ledger's), added to `stoppedWhy` when a reflex stopped the act.
 */
export function renderActReport(bot: any, report: ActReport, note?: string | null): string {
  const at = feetCell(bot) ?? { x: 0, y: 0, z: 0 };
  let stoppedWhy = report.stoppedWhy;
  if (report.stoppedBy === 'reflex') stoppedWhy = clip(`${note ? note.replace(/^［体の反射: |］$/gu, '') : stoppedWhy ?? '反射'} 今 (${at.x},${at.y},${at.z})`, 200);
  const result: Record<string, unknown> = {
    v: 1, ok: report.ok, done: report.done, of: report.of,
    ...(report.ok ? {} : { partial: report.done > 0 }),
    ...(report.stoppedBy ? { stoppedBy: report.stoppedBy } : {}), ...(stoppedWhy ? { stoppedWhy } : {}),
    lines: report.lines, at, hp: Math.round((bot.health ?? 0) * 10) / 10, food: bot.food ?? 0,
    ...(report.eye ? { eye: report.eye } : {}), ...(report.container ? { container: report.container } : {}),
    ...(typeof report.arrowsLeft === 'number' ? { arrowsLeft: report.arrowsLeft } : {}),
    ms: Date.now() - report.startedAt,
  };
  let map = '';
  try { map = localMapFor(bot, { fresh: true }) ?? ''; } catch { map = ''; }
  const withMap = JSON.stringify({ ...result, ...(map ? { map } : {}) });
  return withMap.length <= 16_000 ? withMap : JSON.stringify(result);
}
