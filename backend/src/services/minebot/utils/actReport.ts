import { nativeActionHost } from '../execution/ActionExecution.js';
import { MINE_MAKE_SMELT_WORDS } from './handCodes.js';
import { feetCell, localMapFor, symbolFor, type BlockReader, type Cell } from './localMap.js';
import type { ActOutcome, CutBy, GoalOutcome, Handover, InventoryEvent, Progress, RunEnd } from '../integration/commonFca/continueContract.js';
import { lifeOf } from './life.js';

/**
 * What an `act` returns (the head's contract: minecraftActContract.ts `ActResult`, mb-llm-centric-contract.md 1.3): a JSON object in the
 * receipt's `result` with one line per hand, why it stopped, where the body is now and the map. A reflex that takes the body aborts
 * the act's action, and the action layer then answers with its own bare "interrupted" (ActionExecution): the act's report is kept here
 * so that the body still says which hands were done and what the reflex did, with the place and the map after the reflex let go
 * (nativeBody renders it again then).
 */
/** `failed`: the hand failed by itself and the act went on to the next (its `onFail`); `stopped`: the hand where the act stopped. */
export type HandStatus = 'done' | 'stopped' | 'failed' | 'skipped';
/** `around` (the head's contract r2, 2026-10-22): a stopped hand's 3x3x3 round `where`, in the map's symbols. */
export interface HandLine {
  i: number; do: string; status: HandStatus; line: string; where?: Cell; around?: string;
  /** Continue contracts (1): the hand's own result on the two axes (HandOutcome, flat), the closed code of its stop, how far it got, what it changed in the pack, and the pass it belongs to. */
  goal?: GoalOutcome; end?: RunEnd; cutBy?: CutBy; code?: string; progress?: Progress; delta?: InventoryEvent[]; pass?: number;
  /** The effective motor operations this hand sent (0: it never moved the body; what tells not_started from failed). */
  motorOps?: number;
}

/**
 * The 3x3x3 round a cell in the map's symbols and its coordinates (r2, 2026-10-22: a stopped line said the cell's block, and the next
 * decision still could not see the shaft above it or the stone beside the water): the top layer first, each layer three rows north to
 * south of three cells west to east, `/` between rows; her feet `@`.
 *
 *   x=200..202 z=276..278 y=49: #.#/#.#/### y=48: #.#/#.#/#@# y=47: ###/###/###
 */
export function aroundText(read: BlockReader, at: Cell, feet?: Cell | null): string {
  const layers: string[] = [];
  for (let y = at.y + 1; y >= at.y - 1; y--) {
    const rows: string[] = [];
    for (let z = at.z - 1; z <= at.z + 1; z++) {
      let row = '';
      for (let x = at.x - 1; x <= at.x + 1; x++) row += feet && feet.x === x && feet.y === y && feet.z === z ? '@' : symbolFor(read(x, y, z));
      rows.push(row);
    }
    layers.push(`y=${y}: ${rows.join('/')}`);
  }
  return `x=${at.x - 1}..${at.x + 1} z=${at.z - 1}..${at.z + 1} ${layers.join(' ')}`;
}
export type StoppedBy = 'failure' | 'reflex' | 'stopIf' | 'inventoryFull' | 'cancelled' | 'deadline' | 'noProgress' | 'damage' | 'fall';
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
  /** With `repeat`: the passes finished and the most asked. */
  repeat?: { done: number; of: number };
  /** With `done`: the satisfied alternative with its values (`have:log 10/10`). */
  doneMet?: string;
  /** Continue contracts (1): how the act ended on the two axes (the life is put in when it is rendered). */
  outcome?: { goal: GoalOutcome; end: RunEnd; cutBy?: CutBy };
  /** A-6 (5): the life number when the act began; the outcome's `life` is this, not the life the act is rendered in (a death in between does not change it). */
  life?: number;
  /** Continue contracts (4): the reflex this act took the body over from. */
  handover?: Handover;
  /** Continue contracts (3): every inventory event of this act, in delivery order (`deliverySeq` 0 up); the receipt carries as many as fit. */
  events?: InventoryEvent[];
  /** The command the events belong to (for `eventsMore`). */
  command?: string;
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
 * `掘れない`, `置けない`, `無い`, `満杯`, `見られる`, `守られた物`, `溶岩が流れ込む`, `足場が無い`, `時間切れ`, `反射`, `stopIf`, `上から落ちる`).
 */
const CLOSED: Record<string, string> = {
  out_of_reach: '届かない', cannot_reach: '届かない', not_opened: '届かない',
  wall: '一歩ではない', low_ceiling: '一歩ではない', drop: '一歩ではない', lava: '一歩ではない', no_path: '一歩ではない', stuck: '一歩ではない',
  target_solid: '一歩ではない', walk_failed: '一歩ではない', ceiling: '一歩ではない', unloaded: '一歩ではない',
  // r5 (2026-10-22): a walk that ended short of its target, a target no body stands in, a shut iron door in the way; a dig the eye cannot see.
  not_arrived: '一歩ではない', target_unstandable: '一歩ではない', iron_door: '一歩ではない',
  // obsidian and portal (2026-10-26): their lines carry the contract's own code; these words only count where they stopped.
  unreachable: '届かない', lava_danger: '溶岩が流れ込む', blocked: '置けない', ignite_failed: '置けない',
  unbreakable: '掘れない', no_harvest_tool: '掘れない', dig_unconfirmed: '掘れない', dig_failed: '掘れない', not_visible: '掘れない',
  occupied: '置けない', body_in_cell: '置けない', creature_in_cell: '置けない', nothing_to_set_against: '置けない', not_placed: '置けない',
  not_set: '置けない', already_filled: '置けない', not_poured: '置けない', not_lit: '置けない', not_filled: '置けない', no_floor: '足場が無い',
  inventory_full: '満杯', threat_exposed: '見られる', protected: '守られた物', lava_behind: '溶岩が流れ込む', footing: '足場が無い',
  timeout: '時間切れ', time_up: '時間切れ', reflex: '反射', interrupted_by_reflex: '反射', stop_if: 'stopIf',
  no_progress: '進まない', damage_taken: '被弾', fell: '落下',
  // go (2026-10-26): its stops carry the contract's own code in the line; these words only count where it stopped.
  no_tool: '掘れない', limit_dig: '掘れない', no_blocks: '置けない', limit_place: '置けない', limit_time: '時間切れ', dead_end: '一歩ではない', unsafe: '一歩ではない', not_loaded: '一歩ではない',
  // run 41 fixes (2026-10-27): the search ran out of its time (no way known, nor none); a floor lower than the feet cell; a dig under a block that falls.
  search_timeout: '時間切れ', low_floor: '足場が無い', falling_above: '上から落ちる',
  // vertical (continue contracts 6): its lines carry the contract's own code; these words only count where it stopped (lava, no_floor, limit_* are above).
  world_limit: '一歩ではない', displaced: '一歩ではない', no_foothold: '足場が無い', water: '一歩ではない', cannot_dig: '掘れない', no_place: '置けない', seal_failed: '置けない', place_unconfirmed: '置けない',
  ...MINE_MAKE_SMELT_WORDS,
};
export function closedWord(reason: string | undefined): string {
  if (!reason) return '無い';
  if (reason.startsWith('stop_if')) return 'stopIf';
  return CLOSED[reason] ?? '無い';
}

/** At most `max` characters (the contract's 160 a line). */
export const clip = (text: string, max = 160) => text.length <= max ? text : `${text.slice(0, max - 1)}…`;

/** The most a stopped hand's line holds: the contract's 160; with a root cause (below) 260, the cause itself never cut (at most CAUSE_MAX). */
export const LINE_MAX = 160;
export const LINE_MAX_WITH_CAUSE = 260;
export const CAUSE_MAX = 110;

/**
 * A stopped hand's line: the closed word first, then (mb-llmc-cand 3, run 37) the root of the stop when the hand knows it — `一歩ではない（元: 経路探索は
 * 道を見つけたが体は進まなかった・水の流れ 5）` —, then the place and what happened, then (what is cut first, from the back) what the cell holds
 * now and the count of the same stop. Run 37 put the root at the back of a long text and 4 of 6 "4 秒進めず" lines were cut before it.
 */
export function stoppedLine(reason: string | undefined, text: string, cellNow?: string, cause?: string, again = ''): string {
  const word = closedWord(reason);
  const root = cause ? `（元: ${clip(cause, CAUSE_MAX)}）` : '';
  // A text that already says what the cell holds (place: "そのマスは stone") is not given the same again.
  const tail = `${again}${cellNow && !text.includes('そのマスは') ? `。そのマスは ${cellNow}` : ''}`;
  const max = cause ? LINE_MAX_WITH_CAUSE : LINE_MAX;
  return `${word}${root}: ${clip(text, max - word.length - root.length - 2 - tail.length)}${tail}`;
}

/**
 * The receipt's text: the contract's ActResult as JSON (16,000 characters at most: the map is left out when it would not fit). `note` is
 * what the reflexes did meanwhile (the reflex ledger's), added to `stoppedWhy` when a reflex stopped the act.
 */
export const RECEIPT_MAX = 16_000;
export function renderActReport(bot: any, report: ActReport, note?: string | null, afterReflex?: string): string {
  const at = feetCell(bot) ?? { x: 0, y: 0, z: 0 };
  let stoppedWhy = report.stoppedWhy;
  if (report.stoppedBy === 'reflex') stoppedWhy = clip(`${note ? note.replace(/^［体の反射: |］$/gu, '') : stoppedWhy ?? '反射'} 今 (${at.x},${at.y},${at.z})`, 200);
  const life = report.life ?? lifeOf(bot)?.number ?? 0;
  const outcome: ActOutcome | undefined = report.outcome ? { ...report.outcome, life } : undefined;
  const result: Record<string, unknown> = {
    v: 1, ok: report.ok, done: report.done, of: report.of,
    ...(outcome ? { outcome } : {}),
    // r10: the act came while a reflex held the body and began when it let go ("反射 flee（低体力の逃走）の最中のため、放された後に始めた（待ち 2.3秒）").
    ...(afterReflex ? { afterReflex: clip(afterReflex, 200) } : {}),
    ...(report.handover ? { handover: report.handover } : {}),
    ...(report.ok ? {} : { partial: report.done > 0 }),
    ...(report.stoppedBy ? { stoppedBy: report.stoppedBy } : {}), ...(stoppedWhy ? { stoppedWhy } : {}),
    lines: report.lines, at, hp: Math.round((bot.health ?? 0) * 10) / 10, food: bot.food ?? 0,
    ...(report.eye ? { eye: report.eye } : {}), ...(report.container ? { container: report.container } : {}),
    ...(typeof report.arrowsLeft === 'number' ? { arrowsLeft: report.arrowsLeft } : {}),
    ...(report.repeat ? { repeat: report.repeat } : {}), ...(report.doneMet ? { doneMet: clip(report.doneMet, 200) } : {}),
    ms: Date.now() - report.startedAt,
  };
  let map = '';
  try { map = localMapFor(bot, { fresh: true }) ?? ''; } catch { map = ''; }
  return fitReceipt(result, map, report);
}

/**
 * The receipt's text is 16,000 characters at most (contract 8). In this order: the map is left out; the lines of the older passes become a count (their
 * inventory events move to `earlierEvents`, so none is lost); the line texts are clipped; then the events are taken off from the END of the delivery
 * order, and `eventsMore` says from which delivery number the head fetches the rest (the `events` command, contract 3). What the receipt carries is
 * always the events with the smallest delivery numbers, in order. The body keeps all of them until the head has them.
 */
function fitReceipt(result: Record<string, unknown>, map: string, report: ActReport): string {
  let lines = (result.lines as HandLine[]).map(line => ({ ...line }));
  let earlierEvents: InventoryEvent[] = [];
  let earlier: Array<{ pass: number; lines: number; done: number; stopped: number }> | undefined;
  /** The delivery number the receipt stops at: what is at or after it is fetched. */
  let cutAt: number | null = null;
  const build = (withMap: boolean) => {
    const more = cutAt !== null && report.command ? { command: report.command, nextSeq: cutAt, total: report.events?.length ?? 0 } : undefined;
    return JSON.stringify({ ...result, lines, ...(earlier ? { earlierPasses: earlier } : {}), ...(earlierEvents.length ? { earlierEvents } : {}), ...(more ? { eventsMore: more } : {}),
      ...(withMap && map ? { map } : {}) });
  };
  let out = build(true);
  if (out.length <= RECEIPT_MAX) return out;
  out = build(false);
  if (out.length <= RECEIPT_MAX) return out;
  // The older passes: only the newest passes' lines stay; the rest are a count, and their events ride on beside.
  const passes = [...new Set(lines.map(line => line.pass ?? 1))].sort((a, b) => a - b);
  if (passes.length > 2) {
    const keep = new Set(passes.slice(-2));
    earlier = passes.filter(pass => !keep.has(pass)).map(pass => {
      const mine = lines.filter(line => (line.pass ?? 1) === pass);
      return { pass, lines: mine.length, done: mine.filter(line => line.status === 'done').length, stopped: mine.filter(line => line.status === 'stopped' || line.status === 'failed').length };
    });
    earlierEvents = lines.filter(line => !keep.has(line.pass ?? 1)).flatMap(line => line.delta ?? []);
    lines = lines.filter(line => keep.has(line.pass ?? 1));
    out = build(false);
    if (out.length <= RECEIPT_MAX) return out;
  }
  // The line texts: the closed words, the numbers and the codes stay.
  lines = lines.map(line => ({ ...line, line: clip(line.line, 90), around: undefined }));
  out = build(false);
  if (out.length <= RECEIPT_MAX) return out;
  // The events: from the last one back, until it fits.
  for (let index = lines.length - 1; index >= 0 && out.length > RECEIPT_MAX; index--) {
    const delta = lines[index].delta;
    if (!delta?.length) continue;
    cutAt = Math.min(cutAt ?? Infinity, ...delta.map(event => event.deliverySeq ?? Infinity));
    lines[index] = { ...lines[index], delta: undefined };
    out = build(false);
  }
  while (out.length > RECEIPT_MAX && earlierEvents.length) {
    const keepCount = Math.floor(earlierEvents.length / 2);
    cutAt = Math.min(cutAt ?? Infinity, ...earlierEvents.slice(keepCount).map(event => event.deliverySeq ?? Infinity));
    earlierEvents = earlierEvents.slice(0, keepCount);
    out = build(false);
  }
  return out;
}
