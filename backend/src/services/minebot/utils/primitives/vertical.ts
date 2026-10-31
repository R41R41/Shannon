import { Vec3 } from 'vec3';
import { feetCell, type Cell } from '../localMap.js';
import { bodyOverlap } from '../placeFacts.js';
import { centreInColumn, digCell, floorDrop, moveOneCell, relativeTo, waitDropOne } from '../tunnelWalk.js';
import { explainShaftRefusal, shaftStepRefusal } from '../shaftDown.js';
import { trailOf } from '../stairLine.js';
import type { Progress } from '../../integration/commonFca/continueContract.js';
import { nativeActionHost } from '../../execution/ActionExecution.js';
import { blockAt, cellText, fullPackWatch, eyeDistance, guard, inventoryCount, letGo, StepStopped, USE_REACH, wait, waitUntil, type StepContext, type StepOutcome } from './common.js';
import { blockInHand, digRuleOf, hasFace, mayLayAt, placeNamesOf } from './go.js';
import { PILLAR_FALL_MARGIN, shortFloor } from './pillarUp.js';
import { ThreatExposedError } from '../exposureGuard.js';
import { verticalProblem } from '../actHandRules.js';

export { verticalProblem };

/**
 * vertical: a long way straight down or up, one level at a time (continue contracts, chapter 6). The planner decides the direction, the shape
 * (`stairs`, `shaft` down, `pillar` up), the height to reach (`toY`), what may be dug and laid, the limits and what to do with a liquid. The
 * body digs, lays and walks one level after the other and nothing more: no route search, no way round, no change of shape or direction, no ore
 * followed (an ore that shows is only told, `seen`). Each level is asked of the world again when it is taken.
 *
 * It stops, with the closed code and the progress it made (`StepOutcome.progress`), at: `unloaded`, `world_limit`, `displaced`, `no_foothold`, `cannot_dig`,
 * `no_floor`, `no_place`, `limit_dig`, `limit_place`, `limit_time`, `lava`, `water`, `seal_failed`, `place_unconfirmed`.
 *
 * Four numbers are kept apart (contract 6): `placeAttempts` (places sent; the `maxPlace` budget), `stockUsed` (what the pack lost, by looking),
 * `placedConfirmed` (places the world showed in a block update) and `stepsValid` (the levels taken whose floor and room are still there).
 * The budget `maxDig` counts digs sent. Block updates and forced moves that corrected a count go out on `minebotVerticalEvidence`.
 */

/** How far above the top of the cell a block is laid into, in metres, for a pillar's level. A hypothesis (contract 6: 0.2); the lab decides. */
export const PILLAR_MARGIN = 0.2;
/** The lowest block of the world and the height that is not reached (a cell at or over it is out of the world). */
export const WORLD_MIN_Y = -64;
export const WORLD_TOP_Y = 320;
/** What a field left out means (the contract gives none): the widest the hand's schema takes for the budgets, go's seconds. */
export const VERTICAL_DEFAULTS = { seconds: 60, maxDig: 200, maxPlace: 100, range: 1 } as const;
/** The event the hand emits on the body for what corrected its counts (a block update used for stepsValid or a place, a forced move). */
export const VERTICAL_EVIDENCE_EVENT = 'minebotVerticalEvidence';

/** Places in a row that the world did not show before the stop `place_unconfirmed`. */
const UNCONFIRMED_LIMIT = 2;
/** How long after a place is sent the block update for its cell is waited for. */
const CONFIRM_WAIT_MS = 500;
const SEEN_MAX = 8;
const SEEN_RADIUS = 3;
const SETTLE_ROUNDS = 12;
const JUMP_TRIES = 3;

export type VerticalDir = 'down' | 'up';
export type VerticalShape = 'stairs' | 'shaft' | 'pillar';
export type VerticalToward = 'north' | 'east' | 'south' | 'west';
export interface VerticalArgs {
  dir: VerticalDir; shape: VerticalShape; toward?: VerticalToward; toY: number;
  canDig: string[]; maxDig?: number; canPlace?: string[]; maxPlace?: number;
  liquid: 'stop' | 'seal' | 'seal_water'; range?: number; seconds?: number;
}
/** What `minebotVerticalEvidence` carries (the operation record keeps these for the boundary-2 check). */
export interface VerticalEvidence {
  kind: 'block_update' | 'forced_move';
  t: number;
  /** block_update: the cell, what it held and what it holds. */
  at?: Cell; from?: string; to?: string;
  /** block_update: what the update was used for. */
  usedFor?: 'steps_valid' | 'place_confirmed';
  /** The level (1 from) the update is about, when it is one. */
  step?: number;
  /** forced_move: where the server put the body. */
  pos?: { x: number; y: number; z: number };
}

/**
 * Run 46 (15 verticals, none done): what the planner left out of `canPlace` for stairs and a shaft is the stock a body would put under its feet anyway; the planner who does not
 * want any writes `canPlace: ['none']`. A pillar is made of what the planner names (it has no default).
 */
export const DEFAULT_FOOTING = ['cobblestone', 'cobbled_deepslate', 'dirt'] as const;
/**
 * Blocks that are in the way of a stair or a shaft and cost nothing to break (a mineshaft's fence and rails, a web, a torch, a ladder, vines): dug without being in `canDig`
 * (run 46: a stair of 22 levels stopped at an oak fence for the planner to say it may be dug). Planks, doors, chests, beds and the rest are the planner's to allow.
 */
export const INCIDENTAL_IN_THE_WAY = /^(?:.*_fence|.*_rail|rail|cobweb|torch|wall_torch|soul_torch|redstone_torch|ladder|vine|string|tripwire|tripwire_hook)$/u;
const TOWARD: Record<VerticalToward, [number, number]> = { north: [0, -1], south: [0, 1], west: [-1, 0], east: [1, 0] };
const LIQUIDS = new Set(['water', 'lava', 'flowing_water', 'flowing_lava', 'bubble_column']);
const FALLING = /^(?:gravel|sand|red_sand|suspicious_sand|suspicious_gravel|.*_concrete_powder)$/u;
const ORDER: Array<[string, number, number, number]> = [['down', 0, -1, 0], ['north', 0, 0, -1], ['south', 0, 0, 1], ['west', -1, 0, 0], ['east', 1, 0, 0], ['up', 0, 1, 0]];
const NEIGHBOURS: Array<[number, number, number]> = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

const sameCell = (a: Cell, b: Cell) => a.x === b.x && a.y === b.y && a.z === b.z;
const keyOf = (cell: Cell) => `${cell.x},${cell.y},${cell.z}`;
const shift = (cell: Cell, dx = 0, dy = 0, dz = 0): Cell => ({ x: cell.x + dx, y: cell.y + dy, z: cell.z + dz });
const liquidKind = (block: any): 'lava' | 'water' | null => (block && LIQUIDS.has(String(block.name)) ? (/lava/u.test(String(block.name)) ? 'lava' : 'water') : null);
const solid = (block: any) => !!block && block.boundingBox === 'block' && !liquidKind(block);
const isLiquidName = (name: string) => LIQUIDS.has(name);

/** One level taken: the cells that hold it up, and whether they still do. */
interface Level { index: number; to: Cell; needs: Array<{ cell: Cell; want: 'solid' | 'not_solid' }>; valid: boolean }
/** The cells one level is made of. */
interface Plan {
  kind: 'stairs_down' | 'stairs_up' | 'shaft' | 'pillar';
  from: Cell; to: Cell;
  /** Cells to open (dug when solid), in the order they are dug. */
  clear: Cell[];
  /** The cell the next feet cell stands on. */
  floor: Cell;
  /** The cells the body is in after the level (and, for a liquid beside them, the cells that count). */
  enter: Cell[];
  /** The lowest and highest cell the level needs (the world's edges). */
  lowest: number; highest: number;
}

/** A stop of the hand: the closed code, the sentence, and the cell it is about. Thrown inside, turned into the outcome at the end. */
class VStop extends Error {
  constructor(readonly code: string, readonly why: string, readonly where?: Cell, readonly hint?: string) { super(`vertical stop: ${code}`); this.name = 'VStop'; }
}
const isInterrupt = (error: unknown) => error instanceof StepStopped || /Action interrupted|Motor owner expired/u.test(String((error as Error)?.message));

export async function vertical(ctx: StepContext, args: VerticalArgs): Promise<StepOutcome> {
  const bot = ctx.bot;
  const problem = verticalProblem(args);
  if (problem) return { ok: false, reason: 'invalid_input', text: `vertical 止まった invalid_input: ${problem}` };
  const start = feetCell(bot);
  if (!start) return { ok: false, reason: 'invalid_input', text: 'vertical 止まった invalid_input: 体の位置が分からない' };
  const down = args.dir === 'down';
  // Amendment A-3: the hand is a laying hand (a reflex's note does not stop it, floorReflexes LAYING_HANDS) only while it places: a pillar's whole climb, and a block laid to seal.
  // Digging stairs or a shaft (up to 60 s) is not: a melee and a flight must be able to start then.
  const host = nativeActionHost(bot) as { actHandNow?: string };
  const laying = (on: boolean) => { host.actHandNow = on ? 'vertical-place' : 'vertical'; };
  if (args.shape === 'pillar') laying(true);
  const limits = { maxDig: args.maxDig ?? VERTICAL_DEFAULTS.maxDig, maxPlace: args.maxPlace ?? VERTICAL_DEFAULTS.maxPlace, range: args.range ?? VERTICAL_DEFAULTS.range };
  const startedAt = Date.now();
  const seconds = args.seconds ?? VERTICAL_DEFAULTS.seconds;
  const deadline = Math.min(ctx.deadline, startedAt + seconds * 1000);
  const rule = digRuleOf(bot.registry, args.canDig);
  const reached = (cell: Cell) => (down ? cell.y <= args.toY : cell.y >= args.toY);
  const leftFrom = (cell: Cell) => Math.max(0, down ? cell.y - args.toY : args.toY - cell.y);
  const work = { dug: 0, placeAttempts: 0, stockUsed: 0, placedConfirmed: 0 };
  const seen: Array<{ block: string; at: Cell }> = [];

  // ---- already ----
  if (reached(start)) {
    return { ok: true, goal: 'already', text: `vertical 済み ${cellText(start)} は既に y=${args.toY} ${down ? '以下' : '以上'}`, at: start,
      progress: { unit: 'step', done: 0, left: 0, at: start, work: { ...work } } };
  }

  // ---- the levels taken, and what holds them up ----
  const levels: Level[] = [];
  const needed = new Map<string, Level[]>();
  let moved = 0;
  let unconfirmedRun = 0;
  let at: Cell = start;
  const evidence = (event: Omit<VerticalEvidence, 't'>) => { try { bot.emit?.(VERTICAL_EVIDENCE_EVENT, { ...event, t: Date.now() } satisfies VerticalEvidence); } catch { /* a listener must not stop the hand */ } };
  const satisfies = (need: Level['needs'][number], block: any) => (need.want === 'solid' ? solid(block) : !!block && block.boundingBox !== 'block');
  const nameOf = (block: any) => (block ? String(block.name) : 'unloaded');
  const addLevel = (to: Cell, needs: Level['needs']) => {
    const level: Level = { index: levels.length + 1, to, needs, valid: true };
    levels.push(level);
    for (const need of needs) {
      const list = needed.get(keyOf(need.cell)) ?? [];
      list.push(level);
      needed.set(keyOf(need.cell), list);
    }
    moved++;
  };
  /** A block update at a cell a level stands on: the level stops being (or becomes again) a level. Only what is observed counts. */
  /** Amendment A-5: the steps that were found no longer there (a block update or a look again), told once in the progress and the line. */
  const corrections: Array<{ at: { x: number; y: number; z: number }; was?: string; now: string; step: number }> = [];
  const onBlockUpdate = (_old: any, next: any) => {
    const position = next?.position ?? _old?.position;
    if (!position) return;
    const list = needed.get(keyOf(position));
    if (!list) return;
    for (const level of list) {
      const holds = level.needs.every(need => {
        if (keyOf(need.cell) === keyOf(position)) return satisfies(need, next);
        const block = blockAt(bot, need.cell);
        return block === null ? true : satisfies(need, block);   // not loaded or not observed: not "gone"
      });
      if (holds !== level.valid) {
        level.valid = holds;
        evidence({ kind: 'block_update', at: { x: position.x, y: position.y, z: position.z }, from: nameOf(_old), to: nameOf(next), usedFor: 'steps_valid', step: level.index });
        if (!holds && corrections.length < 8) corrections.push({ at: { x: position.x, y: position.y, z: position.z }, was: nameOf(_old), now: nameOf(next), step: level.index });
      }
    }
  };
  const onForcedMove = () => {
    const p = bot.entity?.position;
    evidence({ kind: 'forced_move', ...(p ? { pos: { x: p.x, y: p.y, z: p.z } } : {}), step: levels.length });
  };
  /** Looks again at the cells of every level that are loaded now (a change nobody told about); the ones not loaded are left as they were. */
  const lookAgain = () => {
    for (const level of levels) {
      let holds = true;
      for (const need of level.needs) { const block = blockAt(bot, need.cell); if (block && !satisfies(need, block)) holds = false; }
      if (holds !== level.valid) {
        level.valid = holds;
        const bad = level.needs.find(need => { const block = blockAt(bot, need.cell); return block && !satisfies(need, block); });
        if (!holds && bad) {
          evidence({ kind: 'block_update', at: bad.cell, to: nameOf(blockAt(bot, bad.cell)), usedFor: 'steps_valid', step: level.index });
          if (corrections.length < 8) corrections.push({ at: { x: bad.cell.x, y: bad.cell.y, z: bad.cell.z }, now: nameOf(blockAt(bot, bad.cell)), step: level.index });
        }
      }
    }
  };
  const valid = () => levels.filter(level => level.valid).length;
  const stockMark = new Map<string, number>();
  const progress = (): Progress => {
    // A fall of the count that arrived after the last place was read is the last place's.
    for (const [block, mark] of stockMark) { const now1 = inventoryCount(bot, block); if (now1 < mark) { work.stockUsed += mark - now1; stockMark.set(block, now1); } }
    const here = feetCell(bot) ?? at;
    return { unit: 'step', done: valid(), left: leftFrom(here), at: here, ...(moved > 0 ? { msPerUnit: Math.round((Date.now() - startedAt) / moved) } : {}), work: { ...work }, ...(corrections.length ? { corrected: corrections.map(entry => ({ ...entry, at: { ...entry.at } })) } : {}), ...(seen.length ? { seen: seen.map(entry => ({ block: entry.block, at: { ...entry.at } })) } : {}) };
  };

  // ---- the clock, the stop, the body ----
  const checkClock = () => {
    if (ctx.stop.aborted) throw new StepStopped(String(ctx.stop.reason ?? 'stopped'));
    if (Date.now() >= deadline) throw new VStop('limit_time', `${seconds} 秒の上限に着いた`, undefined, 'seconds を増やして続きを出す');
  };
  const away = (cell: Cell) => { const here = feetCell(bot); return here ? `自分から${relativeTo(here, cell)}` : ''; };
  const needDisplacedCheck = (expected: Cell[]) => {
    const here = feetCell(bot);
    if (!here) throw new VStop('displaced', '体の位置が分からない');
    if (!expected.some(cell => sameCell(cell, here))) {
      throw new VStop('displaced', `予定の段 ${cellText(expected[0])} から ${cellText(here)} へずれた（落ちたか押し戻された）`, here, '今の位置から新しい手で');
    }
  };

  // ---- ore seen (told, never followed) ----
  const ORE = /(?:_ore|ancient_debris)$/u;
  const lookForOre = () => {
    const here = feetCell(bot);
    if (!here || seen.length >= SEEN_MAX) return;
    for (let dx = -SEEN_RADIUS; dx <= SEEN_RADIUS && seen.length < SEEN_MAX; dx++) for (let dy = -SEEN_RADIUS; dy <= SEEN_RADIUS && seen.length < SEEN_MAX; dy++) for (let dz = -SEEN_RADIUS; dz <= SEEN_RADIUS && seen.length < SEEN_MAX; dz++) {
      const cell = shift(here, dx, dy, dz);
      const block = blockAt(bot, cell);
      if (!block || !ORE.test(String(block.name)) || seen.some(entry => sameCell(entry.at, cell))) continue;
      // Seen: a face of it touches a cell that is not solid.
      const exposed = NEIGHBOURS.some(([ox, oy, oz]) => { const next = blockAt(bot, shift(cell, ox, oy, oz)); return !!next && next.boundingBox !== 'block'; });
      if (exposed) seen.push({ block: String(block.name), at: cell });
    }
  };

  // ---- placing ----
  const placeOrder = (args.canPlace === undefined && args.shape !== 'pillar' ? [...DEFAULT_FOOTING] : (args.canPlace ?? [])).map(name => String(name).replace(/^minecraft:/u, '').toLowerCase()).filter(name => name !== 'none');
  /** The first block of `canPlace` (in the order written) that the pack holds and that can be laid as a step (placeNamesOf). */
  const pickBlock = (): string | null => {
    const { held } = placeNamesOf(bot, placeOrder);
    return placeOrder.find(name => held.includes(name)) ?? null;
  };
  const watchPlace = (cell: Cell, block: string) => {
    let seenIt = false;
    let wake: (() => void) | undefined;
    const listener = (_old: any, next: any) => {
      const p = next?.position;
      if (p && p.x === cell.x && p.y === cell.y && p.z === cell.z && String(next.name) === block) { seenIt = true; wake?.(); }
    };
    bot.on?.('blockUpdate', listener);
    const done = () => { try { bot.removeListener?.('blockUpdate', listener); } catch { /* gone */ } };
    return {
      cancel: done,
      async result(ms: number): Promise<boolean> {
        if (!seenIt) await new Promise<void>(resolve => { const timer = setTimeout(resolve, ms); wake = () => { clearTimeout(timer); resolve(); }; });
        done();
        return seenIt;
      },
    };
  };
  /**
   * Sends the place and looks for the block update of its cell. The place is counted when it is sent (`placeAttempts`); it is confirmed only when
   * the update shows the block there (`placedConfirmed`). Two in a row that the world did not show stop the hand (`place_unconfirmed`).
   */
  const sendPlace = async (cell: Cell, block: string, reference: any, face: Vec3, levelIndex?: number): Promise<{ confirmed: boolean }> => {
    work.placeAttempts++;
    // The pack's count falls when the server's slot update arrives, which can be after the wait below: that late fall is counted at the next place (the sum is the same),
    // never lost. A rise since the last reading is the drops of what was dug and is not taken off.
    const now0 = inventoryCount(bot, block), last = stockMark.get(block);
    const before = last !== undefined && now0 < last ? last : now0;
    const watch = watchPlace(cell, block);
    try { await guard(ctx, Promise.resolve(bot.placeBlock(reference, face)), 4000); } catch (error) {
      if (isInterrupt(error)) { watch.cancel(); throw error; }
      // The library gives up when the server's update does not come; the cell itself is looked at through the update wait below.
    }
    const confirmed = await watch.result(CONFIRM_WAIT_MS);
    const after0 = inventoryCount(bot, block);
    work.stockUsed += Math.max(0, before - after0);
    stockMark.set(block, after0);
    if (confirmed) {
      work.placedConfirmed++; unconfirmedRun = 0;
      evidence({ kind: 'block_update', at: cell, to: block, usedFor: 'place_confirmed', ...(levelIndex ? { step: levelIndex } : {}) });
    } else {
      unconfirmedRun++;
      if (unconfirmedRun >= UNCONFIRMED_LIMIT) {
        throw new VStop('place_unconfirmed', `${block} を ${unconfirmedRun} 回続けて置いたが、${cellText(cell)} のブロックの更新が来ない（今 ${nameOf(blockAt(bot, cell))}）`, cell);
      }
    }
    return { confirmed };
  };
  /**
   * A block laid into `cell` that is not a pillar's: against the first solid neighbour (below first). Not sent (and not counted) when the pack has none
   * of `canPlace`, the budget is spent, nothing solid is beside the cell, it is out of reach or the body is in it.
   */
  type Laid = { ok: true; confirmed: boolean; block: string } | { ok: false; reason: 'no_block' | 'budget' | 'no_face' | 'unreachable' | 'body' };
  const layCell = async (cell: Cell): Promise<Laid> => {
    if (work.placeAttempts >= limits.maxPlace) return { ok: false, reason: 'budget' };
    const block = pickBlock();
    if (!block) return { ok: false, reason: 'no_block' };
    let reference: any = null, face: Vec3 | null = null;
    for (const [, dx, dy, dz] of ORDER) {
      const neighbour = blockAt(bot, shift(cell, dx, dy, dz));
      if (hasFace(neighbour)) { reference = neighbour; face = new Vec3(-dx, -dy, -dz); break; }
    }
    if (!reference || !face) return { ok: false, reason: 'no_face' };
    if (eyeDistance(bot, cell) > USE_REACH) return { ok: false, reason: 'unreachable' };
    if (!mayLayAt(bot, cell)) return { ok: false, reason: 'body' };
    await blockInHand(bot, [block]);
    laying(true);
    try {
      const sent = await sendPlace(cell, block, reference, face);
      return { ok: true, confirmed: sent.confirmed, block };
    } finally { if (args.shape !== 'pillar') laying(false); }
  };

  // ---- digging ----
  const broke = new Map<string, number>();
  const allowed = (name: string) => rule.names.has(name) || INCIDENTAL_IN_THE_WAY.test(name);
  const refuseDig = (cell: Cell, block: any): VStop => {
    const name = nameOf(block);
    // Run 48 (hold 1): a name the planner wrote in canDig that the body does not dig (a door, a spawner, a bed...) is said as such, not asked for again.
    const refusedByRule = (args.canDig ?? []).some(word => String(word).replace(/^minecraft:/u, '').toLowerCase() === name) && !rule.names.has(name);
    const unbreakable = block?.diggable === false || name === 'bedrock' || refusedByRule;
    const why = unbreakable ? `${name}${cellText(cell)} は${refusedByRule ? ' canDig に書かれているが体は壊さない決まりの' : '壊せない'}ブロック` : `${name}${cellText(cell)} は canDig に無い（${away(cell)}）`;
    return new VStop('cannot_dig', why, cell, unbreakable ? undefined : `canDig に ${name} を足せば進む`);
  };
  /** Before anything of a level is dug: a cell it must open that is not allowed stops it now, not after two others were dug. */
  const precheckDig = (cells: Cell[]) => {
    for (const cell of cells) {
      const block = blockAt(bot, cell);
      if (solid(block) && !allowed(String(block.name))) throw refuseDig(cell, block);
    }
  };
  // A falling block disappears from blockAt while travelling as an entity. Air in
  // that interval is not a cleared worksite (run54, upward stairs after gravel).
  let fallingUntil = 0;
  const fallingThrough = (cells: Cell[]) => (Object.values(bot.entities ?? {}) as any[]).some(entity => {
    const p = entity?.position;
    return entity?.name === 'falling_block' && p && cells.some(cell => Math.floor(p.x) === cell.x
      && Math.floor(p.z) === cell.z && p.y >= cell.y - 1 && p.y <= cell.y + 8);
  });
  const settleFalling = async (cells: Cell[]) => {
    const began = Date.now();
    while (Date.now() < fallingUntil || fallingThrough(cells)) {
      checkClock();
      if (Date.now() - began >= SETTLE_ROUNDS * 350) throw new VStop('no_foothold', '次の段の落下物が収まらず、空間の安定を確認できない', cells[0], '落下が収まるのを待つか、別の経路へ');
      await wait(ctx, 50);
    }
  };
  const openCell = async (cell: Cell): Promise<void> => {
    for (let round = 0; round < SETTLE_ROUNDS * 4; round++) {
      await settleFalling([cell]);
      const block = blockAt(bot, cell);
      if (!block) throw new VStop('unloaded', `${cellText(cell)} はまだ読み込まれていない`, cell);
      if (!solid(block)) return;
      if (!allowed(String(block.name))) throw refuseDig(cell, block);
      if (!rule.names.has(String(block.name))) broke.set(String(block.name), (broke.get(String(block.name)) ?? 0) + 1);
      checkClock();
      if (work.dug >= limits.maxDig) throw new VStop('limit_dig', `掘る数の上限 ${limits.maxDig} に着いた（次は ${nameOf(block)}${cellText(cell)}）`, cell, 'maxDig を増やして続きを出す');
      work.dug++;
      const dislodgesFalling = FALLING.test(nameOf(blockAt(bot, shift(cell, 0, 1, 0))));
      try {
        if (!(await digCell(bot, cell)) && solid(blockAt(bot, cell)) && !FALLING.test(nameOf(blockAt(bot, cell)))) {
          throw new VStop('cannot_dig', `${nameOf(block)}${cellText(cell)} を持っている道具では掘れない`, cell, '道具を持ってから');
        }
      } catch (error) {
        if (error instanceof VStop) throw error;
        if (isInterrupt(error) || /interrupt/iu.test(String((error as Error)?.message))) throw error;
        // Run 46: the exposure guard refused the dig (a hostile behind the rock would see the body): said as that, with who and which cell, as go says it; the cell stays closed to the routes.
        if (error instanceof ThreatExposedError) {
          throw new VStop('threat_exposed', `${nameOf(block)}${cellText(cell)} を開けると ${error.threat.name}（約${error.threat.distance.toFixed(0)}m）から身体が見える`, cell,
            args.shape === 'shaft' || args.shape === 'pillar' ? '敵が離れるのを待つか、別の場所から' : '敵が離れるのを待つか、toward を変える');
        }
        if ((error as Error)?.name === 'LavaReleaseError') {
          const lava = (error as { lava?: Vec3 }).lava;
          throw new VStop('lava', `${nameOf(block)}${cellText(cell)} を掘ると隣の溶岩${lava ? cellText(lava) : ''}が流れ込む`, lava ? { x: lava.x, y: lava.y, z: lava.z } : cell);
        }
        throw new VStop('cannot_dig', `${nameOf(block)}${cellText(cell)} を掘れなかった: ${String((error as Error)?.message ?? error).slice(0, 70)}`, cell);
      }
      // Remember the support before digging: afterwards the gravel may already
      // be an entity. Allow its nearby fall to land, then inspect and dig again.
      if (dislodgesFalling) fallingUntil = Date.now() + 700;
    }
    throw new VStop('cannot_dig', `${cellText(cell)} を掘り切れない（${nameOf(blockAt(bot, cell))}）`, cell);
  };
  const openAll = async (cells: Cell[]) => {
    for (const cell of cells) await openCell(cell);
    // Gravel and sand over the cells came down into them: dug out again.
    for (let round = 0; round < SETTLE_ROUNDS; round++) {
      await settleFalling(cells);
      const pending = cells.some(cell => FALLING.test(nameOf(blockAt(bot, shift(cell, 0, 1, 0)))) || FALLING.test(nameOf(blockAt(bot, shift(cell, 0, 2, 0)))));
      const filled = cells.filter(cell => solid(blockAt(bot, cell)));
      if (!pending && !filled.length) return;
      if (!filled.length) await wait(ctx, 350);
      for (const cell of filled) await openCell(cell);
    }
    throw new VStop('no_foothold', '掘っても次の段が埋まり、空間の安定を確認できない', cells[0], '別の経路へ');
  };

  // ---- the plan of a level ----
  const planOf = (from: Cell): Plan => {
    if (args.shape === 'shaft') {
      const to = shift(from, 0, -1);
      return { kind: 'shaft', from, to, clear: [to], floor: shift(to, 0, -1), enter: [to, from], lowest: to.y - 1, highest: from.y + 1 };
    }
    if (args.shape === 'pillar') {
      const to = shift(from, 0, 1);
      return { kind: 'pillar', from, to, clear: [shift(from, 0, 2), shift(from, 0, 3)], floor: shift(from, 0, -1), enter: [from, to, shift(from, 0, 2)], lowest: from.y - 1, highest: from.y + 3 };
    }
    const [dx, dz] = TOWARD[args.toward!];
    if (down) {
      const to = shift(from, dx, -1, dz);
      return { kind: 'stairs_down', from, to, clear: [shift(from, dx, 1, dz), shift(from, dx, 0, dz), to], floor: shift(to, 0, -1), enter: [to, shift(to, 0, 1)], lowest: to.y - 1, highest: from.y + 2 };
    }
    const to = shift(from, dx, 1, dz);
    return { kind: 'stairs_up', from, to, clear: [shift(from, 0, 2), to, shift(to, 0, 1)], floor: shift(to, 0, -1), enter: [to, shift(to, 0, 1)], lowest: from.y - 1, highest: to.y + 2 };
  };
  const stepCells = (plan: Plan) => [...plan.clear, ...plan.enter, plan.floor];
  const unique = (cells: Cell[]) => { const map = new Map<string, Cell>(); for (const cell of cells) map.set(keyOf(cell), cell); return [...map.values()]; };

  // ---- liquids ----
  /** Liquids that threaten the level: touching a cell it opens or enters (at range 2 also those one cell off with an open cell between), nearest first. */
  const liquidsAround = (plan: Plan): Array<{ cell: Cell; kind: 'lava' | 'water'; distance: number }> => {
    const radius = args.liquid === 'stop' ? 1 : limits.range;
    const own = unique([...plan.clear, ...plan.enter]);
    const core = unique([...own, plan.floor]);
    const found = new Map<string, { cell: Cell; kind: 'lava' | 'water'; distance: number }>();
    const consider = (cell: Cell, distance: number) => {
      const block = blockAt(bot, cell);
      const kind = liquidKind(block);
      if (!kind) return;
      const have = found.get(keyOf(cell));
      if (!have || distance < have.distance) found.set(keyOf(cell), { cell, kind, distance });
    };
    for (const cell of core) consider(cell, 0);
    for (const cell of own) for (const [ox, oy, oz] of NEIGHBOURS) consider(shift(cell, ox, oy, oz), 1);
    if (radius >= 2) {
      // One cell further: only when a cell that is not solid lies between it and a cell of the level.
      for (const cell of own) for (const [ox, oy, oz] of NEIGHBOURS) {
        const between = shift(cell, ox, oy, oz);
        const block = blockAt(bot, between);
        if (!block || block.boundingBox === 'block' || liquidKind(block)) continue;
        for (const [px, py, pz] of NEIGHBOURS) {
          const far = shift(between, px, py, pz);
          if (!core.some(c => sameCell(c, far))) consider(far, 2);
        }
      }
    }
    const list = [...found.values()];
    const eye = bot.entity?.position;
    list.sort((a, b) => a.distance - b.distance
      || (eye ? Math.hypot(a.cell.x + 0.5 - eye.x, a.cell.y + 0.5 - eye.y, a.cell.z + 0.5 - eye.z) - Math.hypot(b.cell.x + 0.5 - eye.x, b.cell.y + 0.5 - eye.y, b.cell.z + 0.5 - eye.z) : 0)
      || a.cell.x - b.cell.x || a.cell.y - b.cell.y || a.cell.z - b.cell.z);
    return list;
  };
  const kindJa = (kind: 'lava' | 'water') => (kind === 'lava' ? '溶岩' : '水');
  /** The open cells beside a liquid that lie between it and a cell of the level (the second kind of seal candidate). */
  const shieldCells = (liquid: Cell, plan: Plan): Cell[] => {
    const core = unique([...plan.clear, ...plan.enter, plan.floor]);
    const eye = bot.entity?.position;
    const list: Cell[] = [];
    for (const [ox, oy, oz] of NEIGHBOURS) {
      const cell = shift(liquid, ox, oy, oz);
      const block = blockAt(bot, cell);
      if (!block || block.boundingBox === 'block' || liquidKind(block)) continue;
      if (core.some(c => sameCell(c, cell))) continue;
      if (NEIGHBOURS.some(([px, py, pz]) => core.some(c => sameCell(c, shift(cell, px, py, pz))))) list.push(cell);
    }
    if (eye) list.sort((a, b) => Math.hypot(a.x + 0.5 - eye.x, a.y + 0.5 - eye.y, a.z + 0.5 - eye.z) - Math.hypot(b.x + 0.5 - eye.x, b.y + 0.5 - eye.y, b.z + 0.5 - eye.z));
    return list;
  };
  const seal = async (target: { cell: Cell; kind: 'lava' | 'water'; distance: number }, plan: Plan): Promise<void> => {
    // The liquid cell itself first; then (a liquid one cell off) the open cells between it and the level, nearest first.
    const candidates = target.distance >= 2 ? shieldCells(target.cell, plan) : [target.cell];
    if (target.distance >= 2) candidates.unshift(target.cell);
    const reasons: string[] = [];
    for (const cell of candidates) {
      const laid = await layCell(cell);
      if (laid.ok) return;   // the level's liquids are looked at again
      reasons.push(laid.reason);
      if (laid.reason === 'budget') break;
    }
    const why = reasons.includes('budget') ? 'budget' : reasons.length && reasons.every(reason => reason === 'no_block') ? 'no_block' : 'unreachable';
    const words = why === 'budget' ? `置く数の上限 ${limits.maxPlace} に着いた` : why === 'no_block' ? `canPlace の物を持っていない（${placeOrder.join('・') || 'canPlace が空'}）` : `${kindJa(target.kind)}のマスに届かない・当てる面が無い（${reasons.join('・')}）`;
    throw new VStop('seal_failed', `${kindJa(target.kind)}${cellText(target.cell)} を塞げない（${why}: ${words}）`, target.cell,
      why === 'no_block' ? '置ける物を持ってから' : why === 'budget' ? 'maxPlace を増やして' : '別の形か、手で塞いで');
  };
  const handleLiquid = async (plan: Plan): Promise<void> => {
    for (let round = 0; round < 64; round++) {
      checkClock();
      const around = liquidsAround(plan);
      if (!around.length) return;
      const lava = around.find(entry => entry.kind === 'lava');
      const first = args.liquid === 'seal_water' ? (lava ?? around[0]) : around[0];
      if (args.liquid === 'stop' || (args.liquid === 'seal_water' && first.kind === 'lava')) {
        throw new VStop(first.kind, `${kindJa(first.kind)}${cellText(first.cell)} が${first.distance === 0 ? '次の段のマスにある' : '次の段のマスの隣にある'}（${away(first.cell)}）`, first.cell,
          args.liquid === 'stop' ? '塞いで進むなら liquid=seal' : undefined);
      }
      await seal(first, plan);
    }
    throw new VStop('seal_failed', '塞いでも液体が無くならない', undefined, 'maxPlace を見直して');
  };

  // ---- before a level: the world's edges, what is not loaded ----
  const worldAndLoad = (plan: Plan) => {
    if (plan.lowest < WORLD_MIN_Y) throw new VStop('world_limit', `世界の下端（y=${WORLD_MIN_Y}）で、次の段が要る y=${plan.lowest} は世界の外`, shift(plan.from, 0, plan.lowest - plan.from.y));
    if (plan.highest >= WORLD_TOP_Y) throw new VStop('world_limit', `世界の上端（y=${WORLD_TOP_Y}）の手前で、次の段が要る y=${plan.highest} は世界の外`, plan.from);
    const cells = unique([...stepCells(plan), ...unique([...plan.clear, ...plan.enter]).flatMap(cell => NEIGHBOURS.map(([ox, oy, oz]) => shift(cell, ox, oy, oz)))]);
    for (const cell of cells) if (blockAt(bot, cell) === null) throw new VStop('unloaded', `次の段のまわりの ${cellText(cell)} がまだ読み込まれていない（${away(cell)}）`, cell, '読み込まれる所まで近づいてから');
  };

  // ---- the levels ----
  /** A level taken. It counts (stepsValid, done) only when what it stood on was shown by the world: a scaffold laid and not confirmed is a level walked, not counted. */
  const finishLevel = (plan: Plan, needs: Level['needs'], counted = true) => {
    const here = feetCell(bot) ?? plan.to;
    at = here;
    if (counted) addLevel(plan.to, needs); else moved++;
    try { trailOf(bot).add(plan.from, plan.to); } catch { /* the trail is a help */ }
    lookForOre();
    ctx.progress?.(`${valid()}段`);
  };
  /** The level's feet cell reached? A body that is not there after the level is `displaced`, where it stands. */
  const arrived = async (plan: Plan, extra = 0) => {
    await wait(ctx, 100);
    // Run 47: a body that ran one cell on in the stair's direction at the level of the step it took (a slope under it, a sprint's last tick) has taken the step: the next level is drawn from where it stands.
    const expected = [shift(plan.to, 0, -extra)];
    if (plan.kind === 'stairs_down' || plan.kind === 'stairs_up') { const [dx, dz] = TOWARD[args.toward!]; expected.push(shift(plan.to, dx, -extra, dz)); }
    needDisplacedCheck(expected);
  };
  const precheckStandingRoof = (plan: Plan) => {
    // Opening a falling column over the body is unsafe for every ascending shape.
    // Run54: pillar could open the same support that stairs refused, then jump into falling gravel.
    if (!down) {
      const roof = plan.clear.find(cell => cell.x === plan.from.x && cell.z === plan.from.z
        && FALLING.test(nameOf(blockAt(bot, shift(cell, 0, 1, 0)))));
      if (roof) {
        const falling = shift(roof, 0, 1, 0);
        throw new VStop('falling_above', `現在位置の頭上: ${cellText(roof)} を掘ると上の ${nameOf(blockAt(bot, falling))}${cellText(falling)} が頭へ落ちる`, falling,
          '向きだけを変えても同じ頭上を掘る。横の安全な立ち位置へ移り、下に立たず支えを開けるか別の上り口へ');
      }
    }
  };
  const stairsLevel = async (plan: Plan) => {
    precheckStandingRoof(plan);
    precheckDig(plan.clear);
    await openAll(plan.clear);
    await handleLiquid(plan);   // what the digging let out
    let scaffoldUnconfirmed = false;
    if (!down) {
      // Up: the step ahead at the feet's level is the floor of the next cell; a gap is laid.
      for (let tries = 0; tries < 4; tries++) {
        const floorBlock = blockAt(bot, plan.floor);
        if (solid(floorBlock)) break;
        if (tries === 3) throw new VStop('no_place', `足場 ${cellText(plan.floor)} を置いても世界に現れない`, plan.floor);
        if (!placeOrder.length) throw new VStop('no_place', `${cellText(plan.floor)} が ${nameOf(floorBlock)} で足場が無く、canPlace も無い`, plan.floor, 'canPlace に置ける物を足して');
        const laid = await layCell(plan.floor);
        if (!laid.ok) {
          if (laid.reason === 'budget') throw new VStop('limit_place', `置く数の上限 ${limits.maxPlace} に着いた（足場 ${cellText(plan.floor)} が要る）`, plan.floor, 'maxPlace を増やして続きを出す');
          throw new VStop('no_place', `足場 ${cellText(plan.floor)} を置けない（${laid.reason === 'no_block' ? `canPlace の物 ${placeOrder.join('・')} を持っていない` : laid.reason === 'no_face' ? '当てる面が無い' : '届かない・体が重なる'}）`, plan.floor, laid.reason === 'no_block' ? '置ける物を持ってから' : undefined);
        }
        if (!laid.confirmed) scaffoldUnconfirmed = true;   // the world did not show it in a block update: walked on, not counted
      }
    }
    // Run 47: a stair down into a cave (the next foothold is air with rock one or two cells under it) is taken as a fall of at most three, which does no harm; up, and onto liquid, magma or a drop
    // beyond that, it stays a stop.
    const extra = floorDrop(bot as never, plan.floor, down);
    if (extra === null || (!down && extra !== 0)) {
      const under = nameOf(blockAt(bot, plan.floor));
      throw new VStop('no_floor', `次の足場 ${cellText(plan.floor)} が ${under} で立てない（落ちる段が ${down ? 3 : 1} を超える・立てない床）`, plan.floor, '別の形か、足場を置いて');
    }
    const landing = shift(plan.to, 0, -extra);
    if (extra > 0) {
      const wet = [0, 1, 2].flatMap(dy => NEIGHBOURS.slice(0, 2).concat(NEIGHBOURS.slice(4)).map(([ox, oy, oz]) => shift(landing, ox, oy + dy, oz))).find(cell => isLiquidName(nameOf(blockAt(bot, cell))));
      if (wet) throw new VStop(liquidKind(blockAt(bot, wet)) === 'lava' ? 'lava' : 'water', `落ちる先 ${cellText(landing)} の隣 ${cellText(wet)} が ${nameOf(blockAt(bot, wet))}`, wet);
    }
    needDisplacedCheck([plan.from]);
    const stepped = await moveOneCell(bot as never, plan.from, plan.to, extra);
    if (!stepped && sameCell(feetCell(bot) ?? plan.from, plan.from)) {
      throw new VStop('no_foothold', `次の段 ${cellText(plan.to)} へ踏み出せなかった（今 ${cellText(plan.from)}）`, plan.from, '頭の上や足元を見てから');
    }
    await arrived(plan, extra);
    finishLevel({ ...plan, to: landing }, [{ cell: shift(landing, 0, -1), want: 'solid' }, { cell: landing, want: 'not_solid' }, { cell: shift(landing, 0, 1), want: 'not_solid' }], !scaffoldUnconfirmed);
    for (let i = 1; i <= extra; i++) addLevel(shift(plan.to, 0, -i), []);   // the cells fallen through are levels taken
  };
  const shaftLevel = async (plan: Plan) => {
    const floorBlock = blockAt(bot, plan.clear[0]);
    if (!solid(floorBlock)) throw new VStop('no_floor', `足の下 ${cellText(plan.clear[0])} が ${nameOf(floorBlock)} で、下りる先に岩が無い`, plan.clear[0]);
    precheckDig(plan.clear);
    let refusal = shaftStepRefusal(bot as never, new Vec3(plan.from.x, plan.from.y, plan.from.z));
    // Run 47: the cell dropped into has air under it (a cave): the body falls on to the rock one or two cells below, three in all, which does no harm; liquid in that column or beside it is still a stop.
    let cave = 0;
    if (refusal === 'no_rock_under') {
      const extra = floorDrop(bot as never, shift(plan.to, 0, -1), true);
      if (extra !== null && extra > 0) {
        const landing = shift(plan.to, 0, -extra);
        const wet = [0, 1].flatMap(dy => NEIGHBOURS.slice(0, 2).concat(NEIGHBOURS.slice(4)).map(([ox, oy, oz]) => shift(landing, ox, oy + dy, oz))).find(cell => isLiquidName(nameOf(blockAt(bot, cell))));
        if (!wet) { cave = extra; refusal = null; }
      }
    }
    if (refusal) {
      const text = explainShaftRefusal(bot as never, new Vec3(plan.from.x, plan.from.y, plan.from.z), refusal);
      if (refusal === 'floor_not_diggable' || refusal === 'floor_protected') throw new VStop('cannot_dig', text, plan.clear[0]);
      if (refusal === 'unloaded') throw new VStop('unloaded', text, plan.clear[0]);
      if (refusal === 'liquid_beside') {
        const side = NEIGHBOURS.slice(0, 2).concat(NEIGHBOURS.slice(4)).map(([ox, oy, oz]) => shift(plan.to, ox, oy, oz)).find(cell => isLiquidName(nameOf(blockAt(bot, cell))));
        throw new VStop(side && liquidKind(blockAt(bot, side)) === 'lava' ? 'lava' : 'water', text, side ?? plan.to);
      }
      throw new VStop('no_floor', text, shift(plan.to, 0, -1), '別の形か、下を確かめてから');
    }
    const centred = await centreInColumn(bot as never, new Vec3(plan.from.x, plan.from.y, plan.from.z));
    if (centred) throw new VStop('displaced', `縦穴の真ん中に立てない（${centred}）`, feetCell(bot) ?? plan.from);
    needDisplacedCheck([plan.from]);
    await openAll(plan.clear);
    const dropped = await waitDropOne(bot as never, new Vec3(plan.from.x, plan.from.y, plan.from.z), cave);
    if (dropped) throw new VStop('displaced', `足の下を掘ったが ${1 + cave} 段落ちなかった（${dropped}。今 ${cellText(feetCell(bot) ?? plan.from)}）`, feetCell(bot) ?? plan.from);
    await arrived(plan, cave);
    finishLevel(plan, [{ cell: plan.to, want: 'not_solid' }, { cell: plan.from, want: 'not_solid' }]);
    for (let i = 1; i <= cave; i++) addLevel(shift(plan.to, 0, -i), []);
  };
  const pillarLevel = async (plan: Plan) => {
    const floorBlock = blockAt(bot, plan.floor);
    const feetBlock = blockAt(bot, plan.from);
    if (!floorBlock || floorBlock.boundingBox !== 'block' || liquidKind(floorBlock)) throw new VStop('no_floor', `足元 ${cellText(plan.floor)} が ${nameOf(floorBlock)} で、跳んでも積む土台が無い`, plan.floor);
    const short = shortFloor(bot, plan.from);
    if (short) throw new VStop('no_floor', `足元 ${cellText(short.cell)} の ${short.name} は高さ ${short.top.toFixed(2)} で、足が ${short.lowBy.toFixed(2)} 低く、跳んでも積む高さに届かない`, short.cell);
    if (feetBlock && feetBlock.boundingBox === 'block') throw new VStop('displaced', `足のマス ${cellText(plan.from)} が ${nameOf(feetBlock)} で埋まっている`, plan.from);
    precheckStandingRoof(plan);
    precheckDig(plan.clear);
    // A-6 (3): digging the cells over the head is not placing: the hand is not a laying hand for it (a reflex's note may stop it then), and is again for the climb.
    laying(false);
    try { await openAll(plan.clear); } finally { laying(true); }
    await handleLiquid(plan);
    for (let tries = 0; tries < JUMP_TRIES; tries++) {
      checkClock();
      const block = pickBlock();
      if (!block) throw new VStop('no_place', `canPlace の物 ${placeOrder.join('・') || '(なし)'} を持っていない（足の下に積めない）`, plan.from, '置ける物を持ってから');
      if (work.placeAttempts >= limits.maxPlace) throw new VStop('limit_place', `置く数の上限 ${limits.maxPlace} に着いた`, plan.from, 'maxPlace を増やして続きを出す');
      await blockInHand(bot, [block]);
      await guard(ctx, Promise.resolve(bot.look(bot.entity.yaw, -Math.PI / 2, true)), 1000);
      let sent = false, confirmed = false, filledBy = '', noFace = false;
      bot.setControlState('jump', true);
      try {
        for (let tick = 0; tick < 28 && !sent; tick++) {
          await wait(ctx, 35);
          const p = bot.entity.position, vy = bot.entity.velocity?.y ?? 0;
          if (p.y < plan.from.y + 1 + PILLAR_MARGIN || vy > 0.14 || vy < -0.45) continue;
          if (p.y + 2 * Math.min(vy, 0) < plan.from.y + 1 + PILLAR_FALL_MARGIN) continue;   // run 48 (hold 4): the feet two ticks on, while the server handles the place
          const there = blockAt(bot, plan.from);
          if (there && there.boundingBox === 'block') { filledBy = nameOf(there); break; }
          if (bodyOverlap(p, plan.from) > 0) continue;
          if (!hasFace(floorBlock)) { noFace = true; break; }
          sent = true;
          confirmed = (await sendPlace(plan.from, block, floorBlock, new Vec3(0, 1, 0), levels.length + 1)).confirmed;
        }
      } finally { try { bot.setControlState('jump', false); } catch { /* released */ } }
      await wait(ctx, 250);
      await waitUntil(ctx, () => bot.entity?.onGround !== false, 600);
      if (noFace) throw new VStop('no_place', `当てる面 ${cellText(plan.floor)} が ${nameOf(blockAt(bot, plan.floor))} で置けない`, plan.floor);
      if (filledBy) throw new VStop('displaced', `跳んでいる間に足のマス ${cellText(plan.from)} が ${filledBy} になった`, plan.from);
      if (!sent) continue;   // the jump did not reach the height; again
      const here = feetCell(bot);
      if (!here) throw new VStop('displaced', '体の位置が分からない');
      if (confirmed) {
        if (!sameCell(here, plan.to)) throw new VStop('no_foothold', `${plan.from.y + 1} 段目に乗れなかった（今 ${cellText(here)}）`, here);
        finishLevel(plan, [{ cell: plan.from, want: 'solid' }]);
        return;
      }
      // Not shown by the world: the body may stand on it all the same, but it is not counted as a level.
      if (sameCell(here, plan.to)) at = here; else if (!sameCell(here, plan.from)) throw new VStop('displaced', `予定の段から ${cellText(here)} へずれた`, here);
      return;
    }
    throw new VStop('no_place', `${JUMP_TRIES} 回跳んでも置く高さ（足が y=${(plan.from.y + 1 + PILLAR_MARGIN).toFixed(2)} 以上）に届かず、置けなかった`, plan.from, '足場か頭の上を見てから');
  };

  // ---- the run ----
  const packNote = fullPackWatch(bot);
  const fullText = () => { const full = packNote(); return full ? `。${full}` : ''; };
  const tail = () => `${cellText(feetCell(bot) ?? at)} 段 ${valid()}・掘 ${work.dug}・置 ${work.placeAttempts}${work.placedConfirmed !== work.placeAttempts ? `（確 ${work.placedConfirmed}）` : ''}`;
  const correctedText = () => (corrections.length ? `。置いた ${corrections.slice(0, 3).map(entry => `${cellText(entry.at)} が無くなった（今 ${entry.now}）`).join('・')}（有効な段数を直した）` : '');
  const brokeText = () => (broke.size ? `。邪魔な物を壊した ${[...broke.entries()].slice(0, 3).map(([name, count]) => `${name}×${count}`).join('・')}` : '');
  const seenText = () => (seen.length ? `。鉱石 ${seen.slice(0, 3).map(entry => `${entry.block}${cellText(entry.at)}`).join(' ')}${seen.length > 3 ? ` ほか${seen.length - 3}` : ''}` : '');

  bot.on?.('blockUpdate', onBlockUpdate);
  bot.on?.('forcedMove', onForcedMove);
  let cut = false;
  try {
    lookForOre();
    for (;;) {
      checkClock();
      const here = feetCell(bot);
      if (!here) throw new VStop('displaced', '体の位置が分からない');
      if (reached(here)) break;
      // A pillar that has no place left to send stops for that, wherever the body stands (the budget is the reason, not the position).
      if (args.shape === 'pillar' && work.placeAttempts >= limits.maxPlace) throw new VStop('limit_place', `置く数の上限 ${limits.maxPlace} に着いた`, here, 'maxPlace を増やして続きを出す');
      needDisplacedCheck([at]);
      const plan = planOf(at);
      worldAndLoad(plan);
      await handleLiquid(plan);
      if (plan.kind === 'shaft') await shaftLevel(plan);
      else if (plan.kind === 'pillar') await pillarLevel(plan);
      else await stairsLevel(plan);
    }
    lookAgain();
    const here = feetCell(bot) ?? at;
    return { ok: true, text: `vertical 着いた ${tail()}${fullText()}${seenText()}${brokeText()}${correctedText()}`, at: here, from: start, progress: progress() };
  } catch (error) {
    if (error instanceof VStop) {
      // A stop in the air (a jump that laid nothing): the position told is where the body lands, not where it was at that instant.
      try { await waitUntil(ctx, () => bot.entity?.onGround !== false, 1200); } catch { /* stopped meanwhile: told as it stands */ }
      lookAgain();
      const where = error.where ?? feetCell(bot) ?? at;
      const head = `vertical 止まった ${error.code}: `;
      const fixed = ` ${tail()}${fullText()}`;
      const room = 160 - head.length - fixed.length;
      const hint = error.hint ? `。${error.hint}` : '';
      // The line is 160 characters at most (the act cuts it from the back): when it is too long the reason is cut and the way out stays (run 46: the planner has to read it).
      const whyRoom = room - hint.length;
      const why = error.why.length <= whyRoom ? `${error.why}${fixed}${hint}` : `${error.why.slice(0, Math.max(16, whyRoom - 1))}…${fixed}${hint}`;
      return { ok: false, reason: error.code, code: error.code, text: `${head}${why}`, at: where, from: start, progress: progress() };
    }
    // Cut from outside (a reflex, a stopIf, the clock of the whole act) or an unexpected error: the act answers it; what the hand had done goes with it.
    cut = true;
    try { lookAgain(); (error as { verticalProgress?: Progress }).verticalProgress = progress(); } catch { /* the error stands */ }
    throw error;
  } finally {
    try { bot.removeListener?.('blockUpdate', onBlockUpdate); bot.removeListener?.('forcedMove', onForcedMove); } catch { /* gone */ }
    // A cut body is the reflex's or the act's to steer now: nothing of it is let go here (the parts released their own keys).
    if (!cut) letGo(bot);
  }
}
