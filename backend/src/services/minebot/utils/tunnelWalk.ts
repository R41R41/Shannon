/**
 * Walks a list of cells (utils/stairLine), cutting the rock of each step itself: no route search, no block laid.
 *
 * Why not the route search: it prices a dug block at 3 steps and a laid block at 5, so a far walk over a hill came out as a mix of both
 * (run 21: seven far walks of 37-43 m took 58-82 s each, with cliff-edge stops, escapes from being stuck and a timeout, and the way
 * back was cut again). Here the cells are fixed beforehand, a step is dug as a whole (three cells for a stair step down, three for a step
 * up, two for a level one) and walked, and the cells walked are remembered (TunnelTrail) so that the way back digs nothing.
 *
 * Anything the walk is not sure of ends it with a reason (lava beside a cell to be dug, a block that will not break, no floor, a block
 * that falls), told with the block, its coordinates and where it lies from the body and the route search takes over from where the body stands.
 */
import { Vec3 } from 'vec3';
import type { CustomBot } from '../types/CustomBot.js';
import { createLogger } from '../../../utils/logger.js';
import { PROTECTED_UTILITY_BLOCKS } from '../constants.js';
import { actionDelay } from '../execution/observedWait.js';
import { assertActionActive } from '../execution/ActionExecution.js';
import { chooseTool } from './toolChoice.js';
import { digBlockVerified } from './digBlockVerified.js';
import { trailOf } from './stairLine.js';
import { explainShaftRefusal, shaftStepRefusal } from './shaftDown.js';

const log = createLogger('Minebot:tunnelWalk');

const LIQUIDS = new Set(['water', 'lava', 'flowing_water', 'flowing_lava', 'bubble_column']);
/** Blocks that fall into the gap when what holds them up is dug. */
const FALLING = /^(gravel|sand|red_sand|suspicious_sand|suspicious_gravel|.*_concrete_powder)$/;
/** Floors not stood on. */
const BAD_FLOORS = new Set(['magma_block', 'powder_snow', 'pointed_dripstone', 'campfire', 'soul_campfire', 'cactus', 'fire', 'soul_fire', 'sweet_berry_bush']);
const SIDES6: Array<[number, number, number]> = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
/** What a step costs apart from its digging (the dig's own start and confirmation are in DIG_OVERHEAD_MS). */
export const STEP_MOVE_MS = 450;
const DIG_OVERHEAD_MS = 250;
/** A floor missing under a step is stepped down to when it is this many blocks lower at most (a fall of three does no harm). */
const MAX_EXTRA_DROP = 2;

type Cell = { x: number; y: number; z: number };
const at = (cell: Cell, dx = 0, dy = 0, dz = 0) => new Vec3(cell.x + dx, cell.y + dy, cell.z + dz);
export const cellKey = (cell: Cell) => `${cell.x},${cell.y},${cell.z}`;

export interface StepNeeds {
  /** The cells the body has to be able to pass: dug when solid. */
  clear: Vec3[];
  /** The cell under the cell the step ends in. */
  floor: Vec3;
}

/** Whether `to` is one legal step from `from`: one cell along x or z, a level up or down or none. */
export function isStep(from: Cell, to: Cell): boolean {
  const across = Math.abs(to.x - from.x) + Math.abs(to.z - from.z), up = Math.abs(to.y - from.y);
  return (across === 1 && up <= 1) || (across === 0 && up === 1);   // a vertical step: a shaft down or a pillar up
}

/** The cells a step passes and the floor it ends on (see the block comment of utils/stairLine for the shapes). */
export function stepNeeds(from: Cell, to: Cell): StepNeeds {
  const dy = to.y - from.y;
  // A shaft down opens the floor cell and drops onto the rock under it; a pillar up opens the cell over the head and stands on a block laid.
  if (to.x === from.x && to.z === from.z) return dy < 0 ? { clear: [at(to)], floor: at(to, 0, -1) } : { clear: [at(from, 0, 2)], floor: at(from) };
  // Down: the column ahead at the head's height and the feet's height of the level left (walked into), and the cell stepped down to.
  if (dy < 0) return { clear: [at({ x: to.x, y: from.y, z: to.z }, 0, 1), at({ x: to.x, y: from.y, z: to.z }), at(to)], floor: at(to, 0, -1) };
  if (dy === 0) return { clear: [at(to), at(to, 0, 1)], floor: at(to, 0, -1) };
  return { clear: [at(from, 0, 2), at(to), at(to, 0, 1)], floor: at(to, 0, -1) };
}

interface BlockLike { name: string; boundingBox?: string; diggable?: boolean; position?: Vec3; harvestTools?: unknown;
  digTime?(type: number | null, creative: boolean, inWater: boolean, notOnGround: boolean, enchants: unknown[], effects: unknown): number }
type WorldBot = Pick<CustomBot, 'blockAt' | 'entity' | 'inventory'>;

function blockOf(bot: WorldBot, cell: Cell): BlockLike | null {
  try { return (bot.blockAt(new Vec3(cell.x, cell.y, cell.z), false) as unknown as BlockLike | null) ?? null; } catch { return null; }
}
const solid = (block: BlockLike | null) => !!block && block.boundingBox === 'block';

/** How a floor cell stands: 0 when it holds the body, 1-2 when the ground is that many blocks lower (and clear), null when it cannot be stood on. */
export function floorDrop(bot: WorldBot, floor: Cell, allowDrop: boolean): number | null {
  const block = blockOf(bot, floor);
  if (!block) return null;
  if (solid(block)) return LIQUIDS.has(block.name) || BAD_FLOORS.has(block.name) ? null : 0;
  if (!allowDrop || LIQUIDS.has(block.name) || BAD_FLOORS.has(block.name)) return null;
  for (let extra = 1; extra <= MAX_EXTRA_DROP; extra++) {
    const cell = blockOf(bot, at(floor, 0, -extra));
    if (!cell) return null;
    if (LIQUIDS.has(cell.name) || BAD_FLOORS.has(cell.name)) return null;
    if (solid(cell)) return extra;
    if (cell.boundingBox !== 'empty') return null;
  }
  return null;
}

/**
 * Why a cell may not be dug (null when it may): protected, will not break, liquid in it or touching it, or a block that falls over it.
 * A cell already empty has nothing to ask but whether it is liquid.
 */
export function digRefusal(bot: WorldBot, cell: Cell, others: Cell[], options: { allowFalling?: boolean } = {}): string | null {
  return digRefusalAt(bot, cell, others, options)?.reason ?? null;
}

/** A refusal and the cell it is about (the cell itself, or the neighbour that is lava, unloaded, a falling block). */
export interface Refusal { reason: string; at: Cell }

/**
 * digRefusal with the place of the thing that stopped it. Water beside a cell is not a refusal here: the body no longer keeps from
 * digging beside water on its own (run 25: a shore, the only place a bucket can be filled from, is always beside water, and the rule
 * kept the body in the rock at 7 shores, 280 cells dug on the way round). Whoever asks for a dig is told what is beside it instead
 * (see explainRefusal and nearbyLiquid).
 */
export function digRefusalAt(bot: WorldBot, cell: Cell, others: Cell[], options: { allowFalling?: boolean } = {}): Refusal | null {
  const block = blockOf(bot, cell);
  if (!block) return { reason: 'unloaded', at: cell };
  if (LIQUIDS.has(block.name)) return { reason: `liquid:${block.name}`, at: cell };
  const empty = block.boundingBox === 'empty';
  if (!empty) {
    if (block.diggable === false || block.name === 'bedrock') return { reason: `undiggable:${block.name}`, at: cell };
    if (PROTECTED_UTILITY_BLOCKS.has(block.name)) return { reason: `protected:${block.name}`, at: cell };
  }
  for (const [dx, dy, dz] of SIDES6) {
    const side = at(cell, dx, dy, dz);
    // The cells of the step itself are dealt with on their own (a neighbour of the same step is dug or empty by then).
    if (others.some(other => other.x === side.x && other.y === side.y && other.z === side.z)) continue;
    const next = blockOf(bot, side);
    if (!next) return { reason: 'unloaded', at: side };
    // Lava beside any cell the body will stand in or open.
    if (next.name === 'lava' || next.name === 'flowing_lava') return { reason: `lava_beside:${next.name}`, at: side };
    // A block that falls is not a reason to stop for a walk that digs it out as it falls (settleFalling): the gravel over a cell comes
    // down into it, and is dug again (run 24: a tunnel walk planned the same stop at gravel nine times in a minute).
    if (!empty && dy === 1 && FALLING.test(next.name) && !options.allowFalling) return { reason: `falling_above:${next.name}`, at: side };
  }
  return null;
}

const DIRECTIONS: Array<[string, number, number, number]> = [['東', 1, 0, 0], ['西', -1, 0, 0], ['上', 0, 1, 0], ['下', 0, -1, 0], ['南', 0, 0, 1], ['北', 0, 0, -1]];
/** Where `to` lies from `from`, in words: "東2・上1・南3（約3.7m）". */
export function relativeTo(from: Cell, to: Cell): string {
  const d = { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z };
  const parts = DIRECTIONS.map(([name, dx, dy, dz]) => ({ name, n: d.x * dx + d.y * dy + d.z * dz })).filter(entry => entry.n > 0).map(entry => `${entry.name}${entry.n}`);
  const distance = Math.hypot(d.x, d.y, d.z);
  return distance === 0 ? '自分の位置' : `${parts.join('・')}（約${distance.toFixed(1)}m）`;
}

/**
 * What stopped a dig, said exactly: which block, at which coordinates, and where that is from the body (`from`, its feet). The planner
 * is told this instead of a bare kind, so that it can choose the way round itself.
 */
export function explainRefusal(bot: WorldBot, refusal: Refusal, cell: Cell, from: Cell): string {
  const kind = refusal.reason.split(':')[0];
  const found = blockOf(bot, refusal.at)?.name;
  const where = `(${refusal.at.x},${refusal.at.y},${refusal.at.z})`;
  const rel = relativeTo(from, refusal.at);
  const target = `掘る予定の(${cell.x},${cell.y},${cell.z})`;
  switch (kind) {
    case 'lava_beside': return `${target}の隣の${where}に${found ?? '溶岩'}がある（自分から${rel}）`;
    case 'falling_above': return `${target}の真上の${where}に${found ?? '落ちるブロック'}がある（自分から${rel}）`;
    case 'protected': return `${found ?? refusal.reason.split(':')[1]}${where}は壊さない決まりのブロック（自分から${rel}）`;
    case 'undiggable': return `${found ?? refusal.reason.split(':')[1]}${where}は掘れないブロック（自分から${rel}）`;
    case 'liquid': return `${where}は${found ?? '液体'}（自分から${rel}）`;
    case 'unloaded': return `${where}はまだ読み込まれていない（自分から${rel}）`;
    default: return `${where}（自分から${rel}）`;
  }
}

/**
 * The liquid cells beside a cell that is about to be dug (water and lava, the cell's six sides), each with its place and where it lies
 * from the body: what a stop is told with, and what a dig that goes on beside water can be told with.
 */
export function nearbyLiquid(bot: WorldBot, cell: Cell, from: Cell): string[] {
  const out: string[] = [];
  for (const [dx, dy, dz] of SIDES6) {
    const side = at(cell, dx, dy, dz);
    const name = blockOf(bot, side)?.name;
    if (name && LIQUIDS.has(name)) out.push(`${name}(${side.x},${side.y},${side.z})自分から${relativeTo(from, side)}`);
  }
  return out;
}

export interface StepEstimate { ms: number; digs: number; extraDrop: number }

/** Blocks that can be laid under a pillar, and what a level of a pillar and of a shaft costs apart from digging. */
const PILLAR_BLOCKS = new Set(['cobblestone', 'cobbled_deepslate', 'stone', 'deepslate', 'dirt', 'andesite', 'diorite', 'granite', 'tuff', 'netherrack']);
const PILLAR_MS = 1300;
const SHAFT_DROP_MS = 600;
export function pillarBlocks(bot: WorldBot): number {
  try { return bot.inventory.items().filter(item => PILLAR_BLOCKS.has(item.name)).reduce((sum, item) => sum + item.count, 0); } catch { return 0; }
}

/** The time to dig the cell with the tool that would be used (0 for an empty cell). */
function digMs(bot: WorldBot, cell: Cell): number {
  const block = blockOf(bot, cell);
  if (!block || block.boundingBox === 'empty') return 0;
  try {
    const effects = (bot.entity as unknown as { effects?: unknown })?.effects ?? {};
    const tool = chooseTool(block as never, bot.inventory.items() as never[], { requireHarvest: !!block.harvestTools, effects }) as { type: number } | null;
    const time = Number(block.digTime?.(tool ? tool.type : null, false, false, false, [], effects));
    return (Number.isFinite(time) && time > 0 ? time : 1500) + DIG_OVERHEAD_MS;
  } catch { return 1500; }
}

/** What one step costs: null when it cannot be taken (a cell that must not be dug, no floor). `ctx.blocks`: what the pillars still have to lay. */
export function estimateStep(bot: WorldBot, from: Cell, to: Cell, ctx: { blocks: number; avoid?: ReadonlySet<string> } = { blocks: pillarBlocks(bot) }): StepEstimate | null {
  const needs = stepNeeds(from, to);
  // A cell a walk stopped at twice for the same reason (see avoidKey): no plan passes through it, so the planner goes round.
  if (ctx.avoid?.size && [...needs.clear, needs.floor].some(cell => ctx.avoid!.has(cellKey(cell)))) return null;
  if (to.x === from.x && to.z === from.z) {
    // Straight down: the floor under the feet dug and dropped onto, only where the rock under it is whole (utils/shaftDown). Straight up: a pillar.
    if (to.y < from.y) {
      if (shaftStepRefusal(bot as never, new Vec3(from.x, from.y, from.z)) || digRefusal(bot, needs.clear[0], [])) return null;
      return { ms: SHAFT_DROP_MS + digMs(bot, needs.clear[0]), digs: 1, extraDrop: 0 };
    }
    if (ctx.blocks < 1 || digRefusal(bot, needs.clear[0], [])) return null;
    ctx.blocks--;
    return { ms: PILLAR_MS + digMs(bot, needs.clear[0]), digs: blockOf(bot, needs.clear[0])?.boundingBox === 'empty' ? 0 : 1, extraDrop: 0 };
  }
  const items = (() => { try { return bot.inventory.items(); } catch { return []; } })();
  const effects = (bot.entity as unknown as { effects?: unknown })?.effects ?? {};
  let ms = STEP_MOVE_MS, digs = 0;
  for (const cell of needs.clear) {
    if (digRefusal(bot, cell, needs.clear, { allowFalling: true })) return null;
    const block = blockOf(bot, cell);
    if (!block || block.boundingBox === 'empty') continue;
    let dig = 1500;
    try {
      const tool = chooseTool(block as never, items as never[], { requireHarvest: !!block.harvestTools, effects }) as { type: number } | null;
      if (!tool && block.harvestTools) return null;   // by hand it drops nothing and takes seconds: not a way to tunnel
      const time = Number(block.digTime?.(tool ? tool.type : null, false, false, false, [], effects));
      if (Number.isFinite(time) && time > 0) dig = time;
    } catch { /* the figure stands */ }
    ms += dig + DIG_OVERHEAD_MS; digs++;
  }
  const dy = to.y - from.y;
  const drop = floorDrop(bot, needs.floor, dy <= 0);
  if (drop === null) return null;
  return { ms: ms + drop * 200, digs, extraDrop: drop };
}

export interface PlanEstimate { feasible: boolean; ms: number; digs: number; steps: number; stoppedAt: number; why?: string }

/** Why a step cannot be taken (for the journal): the first thing in its way. */
export function explainStep(bot: WorldBot, from: Cell, to: Cell): string {
  const needs = stepNeeds(from, to);
  const vertical = to.x === from.x && to.z === from.z;
  if (vertical && to.y < from.y) return shaftStepRefusal(bot as never, new Vec3(from.x, from.y, from.z)) ?? digRefusal(bot, needs.clear[0], []) ?? 'ok';
  for (const cell of needs.clear) {
    const refusal = digRefusalAt(bot, cell, vertical ? [] : needs.clear);
    if (refusal) return `${refusal.reason}(${cell.x},${cell.y},${cell.z}) ${explainRefusal(bot, refusal, cell, from)}`;
  }
  if (vertical) return 'no_blocks_to_pillar';
  return `no_floor(${needs.floor.x},${needs.floor.y},${needs.floor.z}:${blockOf(bot, needs.floor)?.name ?? 'unloaded'})`;
}

/**
 * The time of walking `cells` from `start`: the steps up to the first that cannot be taken (`stoppedAt` is its index, or the length).
 * Feasible when at least `minSteps` steps can be taken.
 */
export function estimateCells(bot: WorldBot, start: Cell, cells: Vec3[], minSteps = 3, avoid?: ReadonlySet<string>): PlanEstimate {
  let ms = 0, digs = 0, from: Cell = start, index = 0;
  const ctx = { blocks: pillarBlocks(bot), avoid };
  for (; index < cells.length; index++) {
    const step = estimateStep(bot, from, cells[index], ctx);
    if (!step) break;
    ms += step.ms; digs += step.digs;
    from = cells[index];
  }
  return { feasible: index >= Math.min(minSteps, cells.length) && index > 0, ms, digs, steps: index, stoppedAt: index,
    why: index < cells.length ? `${index}/${cells.length}歩目: ${explainStep(bot, from, cells[index])}` : undefined };
}

export interface TunnelOutcome {
  stopped: 'reached' | 'plan_end' | 'blocked' | 'timeout' | 'off_line' | 'step_failed';
  steps: number;
  digs: number;
  reason?: string;
  /** The cell the walk could not pass (a cell refused, or the one a step failed to reach): what a repeated stop is told by (avoidKey). */
  at?: { x: number; y: number; z: number };
}

/**
 * What a stop of the tunnel walk is called when it is asked whether the same thing happened before: the way it ended and the kind of
 * reason without the coordinates ("falling_above:gravel", "lava_beside:lava", "liquid_beside:water"), and the cell it was at.
 */
export function stopKey(outcome: TunnelOutcome, feet: Cell): string {
  const reason = (outcome.reason ?? '').replace(/\(.*$/u, '');
  return `${outcome.stopped}|${reason}|${cellKey(outcome.at ?? feet)}`;
}

export interface WalkOptions {
  /** The goal's own end test, asked of the feet cell before each step. */
  isEnd: (feet: Vec3) => boolean;
  deadline: number;
  /** Straight up by `height` levels (the tower-up skill): the pillar of a plan that climbs more than its stair can. */
  pillar?: (height: number) => Promise<unknown>;
  /**
   * What a step that took the body lower than the cell asked for does. `replan` (the default, a tunnel cut now): the plan is of no use from
   * here, the walk ends and is planned again. `continue` (a tunnel cut before, the trail): the cells are the places the body has stood, so the
   * walk goes on from the cell it landed in, to the next cell of the plan it can step to (run 24: "off_line (drop)" five times a second).
   */
  onDrop?: 'replan' | 'continue';
}

const sleep = (bot: CustomBot, ms: number) => actionDelay(bot, ms);

/** Digs the cell with the tool that fits (true when it is empty after; false when the carried tools cannot break it). Exported for the vertical hand (primitives/vertical), which counts and limits the digs itself. */
export async function digCell(bot: CustomBot, cell: Cell): Promise<boolean> {
  const block = blockOf(bot, cell);
  if (!block || block.boundingBox === 'empty') return true;
  const tool = chooseTool(block as never, bot.inventory.items() as never[], { requireHarvest: !!block.harvestTools, effects: (bot.entity as unknown as { effects?: unknown })?.effects ?? {} }) as { type: number; slot: number } | null;
  if (tool && (bot.heldItem?.type !== tool.type || bot.heldItem?.slot !== tool.slot)) await bot.equip(tool as never, 'hand');
  else if (!tool && block.harvestTools) return false;
  await digBlockVerified(bot, block as never);
  return blockOf(bot, cell)?.boundingBox === 'empty';
}

/** One step walked towards the middle of the next column, the way stair-mine walks its stairs. True when the body stands in the cell. */
export async function moveOneCell(bot: CustomBot, start: Cell, to: Cell, extraDrop: number): Promise<boolean> {
  const ascending = to.y > start.y;
  const dx = to.x - start.x, dz = to.z - start.z;
  const target = { x: to.x, y: to.y - extraDrop, z: to.z };
  const centre = { x: target.x + 0.5, z: target.z + 0.5 };
  const offCentre = () => Math.hypot(centre.x - bot.entity.position.x, centre.z - bot.entity.position.z);
  // Mineflayer yaw: north=0, west=pi/2, south=pi, east=-pi/2.
  const aim = async () => { const p = bot.entity.position; await bot.look(Math.atan2(-(centre.x - p.x), -(centre.z - p.z)), 0, true); };
  await aim();
  bot.setControlState('forward', true);
  if (ascending) bot.setControlState('jump', true);
  let released = false;
  try {
    for (let tick = 0; tick < 40; tick++) {
      assertActionActive(bot);
      await sleep(bot, 50);
      const pos = bot.entity.position;
      const progress = (pos.x - (start.x + 0.5)) * dx + (pos.z - (start.z + 0.5)) * dz;
      if (!released && ((progress >= 0.85 && offCentre() < 0.3) || progress >= 1.15)) {
        bot.setControlState('forward', false);
        if (ascending) bot.setControlState('jump', false);
        released = true;
      } else if (!released && tick % 2 === 1) await aim();
      else if (released && Math.floor(pos.y) > target.y && !ascending && offCentre() > 0.35 && tick < 32) {
        await aim(); bot.setControlState('forward', true); released = false;
      }
      const inColumn = Math.floor(pos.x) === target.x && Math.floor(pos.z) === target.z;
      if (inColumn && Math.floor(pos.y) === target.y && (bot.entity as unknown as { onGround?: boolean }).onGround !== false) {
        await sleep(bot, 50);
        const landed = bot.entity.position;
        if (Math.floor(landed.x) === target.x && Math.floor(landed.z) === target.z && Math.floor(landed.y) === target.y) return true;
      }
    }
    return false;
  } finally {
    bot.setControlState('forward', false);
    if (ascending) bot.setControlState('jump', false);
  }
}

/**
 * The body's box over the shaft's column alone (it stays on the rim of the next otherwise). Null when it is, otherwise why not. A part of
 * shaftDownOne, apart for the vertical hand (primitives/vertical), which digs the floor itself (it counts and limits its digs).
 */
export async function centreInColumn(bot: CustomBot, feet: Vec3): Promise<string | null> {
  const centre = feet.offset(0.5, 0, 0.5);
  const off = () => Math.max(Math.abs(bot.entity.position.x - centre.x), Math.abs(bot.entity.position.z - centre.z));
  if (off() > 0.2) {
    try {
      await bot.lookAt(centre.offset(0, 1.6, 0), true);
      bot.setControlState('sneak', true);
      bot.setControlState('forward', true);
      for (let tick = 0; tick < 16 && off() > 0.15; tick++) { assertActionActive(bot); await sleep(bot, 50); }
    } finally {
      bot.setControlState('forward', false);
      bot.setControlState('sneak', false);
    }
    if (off() > 0.2 || Math.floor(bot.entity.position.y) !== feet.y) return 'not_centred';
  }
  return null;
}

/** Waits (1.5 s at most) for the body to drop one level below `feet` after the floor under it was dug. Null when it did, otherwise why not. */
export async function waitDropOne(bot: CustomBot, feet: Vec3): Promise<string | null> {
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline && (Math.floor(bot.entity.position.y) >= feet.y || (bot.entity as unknown as { onGround?: boolean }).onGround === false)) {
    assertActionActive(bot);
    await sleep(bot, 50);
  }
  return Math.floor(bot.entity.position.y) === feet.y - 1 ? null : 'did_not_drop';
}

/**
 * One level straight down: the floor under the feet is dug and the body drops onto the rock under it (the shaft step of stair-mine,
 * held to the same rules, utils/shaftDown). Null when it did, otherwise why not.
 */
async function shaftDownOne(bot: CustomBot, feet: Vec3): Promise<string | null> {
  const refusal = shaftStepRefusal(bot as never, feet);
  if (refusal) return refusal;
  const centred = await centreInColumn(bot, feet);
  if (centred) return centred;
  try { if (!(await digCell(bot, at(feet, 0, -1)))) return 'dig_failed'; } catch (error) {
    if (/interrupt/i.test(String((error as Error)?.message))) throw error;
    return `dig_failed:${String((error as Error)?.message ?? error).slice(0, 60)}`;
  }
  return waitDropOne(bot, feet);
}

/**
 * The blocks that fall into the cells just dug are dug again as they come down (a column of gravel over a dug cell falls into it, one
 * block at a time): up to SETTLE_ROUNDS looks, a short wait before each. Returns how many blocks it dug.
 */
const SETTLE_ROUNDS = 6;
async function settleFalling(bot: CustomBot, clear: Vec3[]): Promise<number> {
  let dug = 0;
  for (let round = 0; round < SETTLE_ROUNDS; round++) {
    const pendingAbove = clear.some(cell => FALLING.test(blockOf(bot, at(cell, 0, 1))?.name ?? '') || FALLING.test(blockOf(bot, at(cell, 0, 2))?.name ?? ''));
    const landed = clear.filter(cell => blockOf(bot, cell)?.boundingBox === 'block');
    if (!pendingAbove && !landed.length) break;
    await sleep(bot, 350);
    for (const cell of clear) {
      if (blockOf(bot, cell)?.boundingBox !== 'block') continue;
      assertActionActive(bot);
      try { if (await digCell(bot, cell)) dug++; } catch (error) { if (/interrupt/i.test(String((error as Error)?.message))) throw error; return dug; }
    }
  }
  return dug;
}

const sameCell = (a: Cell, b: Cell) => a.x === b.x && a.y === b.y && a.z === b.z;
/** How many cells further on a trail walk looks for one it can step to from where a drop left the body. */
const SKIP_AHEAD = 6;

/** Walks the cells, one step at a time. Returns why it stopped and how far it got; the body stands where it stopped. */
export async function walkCells(bot: CustomBot, cells: Vec3[], options: WalkOptions): Promise<TunnelOutcome> {
  const trail = trailOf(bot);
  let steps = 0, digs = 0;
  for (let index = 0; index < cells.length; index++) {
    assertActionActive(bot);
    const feet = bot.entity.position.floored();
    if (options.isEnd(feet)) return { stopped: 'reached', steps, digs };
    if (Date.now() > options.deadline) return { stopped: 'timeout', steps, digs };
    const next = cells[index];
    if (feet.x === next.x && feet.y === next.y && feet.z === next.z) continue;
    if (!isStep(feet, next)) {
      // A trail is the places the body has stood: after a step down it did not plan, the way goes on at the first cell further along that
      // the body can step to (or is standing in), not from the start again.
      if (options.onDrop === 'continue') {
        let ahead = -1;
        for (let j = index + 1; j < cells.length && j <= index + SKIP_AHEAD; j++) if (sameCell(cells[j], feet) || isStep(feet, cells[j])) { ahead = j; break; }
        if (ahead > index) { index = sameCell(cells[ahead], feet) ? ahead : ahead - 1; continue; }
      }
      return { stopped: 'off_line', steps, digs, at: feet, reason: `(${feet.x},${feet.y},${feet.z})から(${next.x},${next.y},${next.z})は一歩ではありません` };
    }
    if (next.x === feet.x && next.z === feet.z) {
      // A level straight down (a shaft) or a run of levels straight up (a pillar).
      const cell = stepNeeds(feet, next).clear[0];
      const refused = digRefusalAt(bot, cell, []);
      if (refused) return { stopped: 'blocked', steps, digs, at: cell, reason: `${refused.reason}(${cell.x},${cell.y},${cell.z}) ${explainRefusal(bot, refused, cell, feet)}` };
      if (next.y < feet.y) {
        const why = await shaftDownOne(bot, feet);
        if (why) return { stopped: 'blocked', steps, digs, at: cell, reason: `縦穴で下りられません(${why}) ${explainShaftRefusal(bot as never, feet, why)}` };
        digs++;
        trail.add(feet, bot.entity.position.floored());
        steps++;
        continue;
      }
      let run = 1;
      while (cells[index + run] && cells[index + run].x === next.x && cells[index + run].z === next.z && cells[index + run].y === next.y + run) run++;
      if (!options.pillar) return { stopped: 'blocked', steps, digs, at: cell, reason: '直上登りの手段がありません' };
      try { await options.pillar(run); } catch (error) {
        if (/interrupt/i.test(String((error as Error)?.message))) throw error;
        return { stopped: 'blocked', steps, digs, at: cell, reason: `直上登りに失敗: ${String((error as Error)?.message ?? error).slice(0, 60)}` };
      }
      const gained = Math.floor(bot.entity.position.y) - feet.y;
      for (let level = 0; level < gained; level++) trail.add(at(feet, 0, level), at(feet, 0, level + 1));
      steps += Math.max(0, gained);
      if (gained < run) return { stopped: 'blocked', steps, digs, at: cell, reason: `直上登りが${Math.max(0, gained)}/${run}段で止まりました` };
      index += run - 1;
      continue;
    }
    const needs = stepNeeds(feet, next);
    for (const cell of needs.clear) {
      const refusal = digRefusalAt(bot, cell, needs.clear, { allowFalling: true });
      if (refusal) return { stopped: 'blocked', steps, digs, at: cell, reason: `${refusal.reason}(${cell.x},${cell.y},${cell.z}) ${explainRefusal(bot, refusal, cell, feet)}` };
    }
    for (const cell of needs.clear) {
      if (blockOf(bot, cell)?.boundingBox === 'empty') continue;
      const liquids = nearbyLiquid(bot, cell, feet).filter(text => !text.startsWith('lava'));
      if (liquids.length) log.info(`⛏️ 水の隣のブロックを掘ります: (${cell.x},${cell.y},${cell.z})の隣に ${liquids.slice(0, 3).join('、')}`);
      let dug = false;
      try { dug = await digCell(bot, cell); } catch (error) {
        if (/interrupt/i.test(String((error as Error)?.message))) throw error;
        return { stopped: 'blocked', steps, digs, at: cell, reason: `掘れません(${cell.x},${cell.y},${cell.z}) ${blockOf(bot, cell)?.name ?? ''}（自分から${relativeTo(feet, cell)}）: ${String((error as Error)?.message ?? error).slice(0, 80)}` };
      }
      // What was dug and came down again is gravel from above (settled below), not a block that would not break.
      if (!dug && FALLING.test(blockOf(bot, cell)?.name ?? '')) dug = true;
      if (!dug) return { stopped: 'blocked', steps, digs, at: cell, reason: `掘れません(${cell.x},${cell.y},${cell.z}) ${blockOf(bot, cell)?.name ?? ''}（自分から${relativeTo(feet, cell)}）` };
      digs++;
    }
    // Gravel and sand over the cells came down into them: dug out again before the step.
    if (needs.clear.some(cell => FALLING.test(blockOf(bot, at(cell, 0, 1))?.name ?? '') || blockOf(bot, cell)?.boundingBox === 'block')) digs += await settleFalling(bot, needs.clear);
    const stillShut = needs.clear.find(cell => blockOf(bot, cell)?.boundingBox === 'block');
    if (stillShut) return { stopped: 'blocked', steps, digs, at: stillShut, reason: `落ちてくる物を掘り切れません(${stillShut.x},${stillShut.y},${stillShut.z})` };
    const drop = floorDrop(bot, needs.floor, next.y <= feet.y);
    if (drop === null) {
      const under = blockOf(bot, needs.floor)?.name ?? '未読み込み';
      return { stopped: 'blocked', steps, digs, at: needs.floor,
        reason: `足場がありません(${needs.floor.x},${needs.floor.y},${needs.floor.z}) 足場になるはずの所は${under}（自分から${relativeTo(feet, needs.floor)}）。その下${MAX_EXTRA_DROP}マス以内にも立てる所がありません` };
    }
    if (!(await moveOneCell(bot, feet, next, drop))) {
      return { stopped: 'step_failed', steps, digs, at: next, reason: `(${next.x},${next.y - drop},${next.z})へ踏み出せませんでした` };
    }
    const landed = bot.entity.position.floored();
    if (isStep(feet, landed)) trail.add(feet, landed);
    else if (drop === 1) { trail.add(feet, next); trail.add(next, landed); }
    steps++;
    // A drop that took the body lower than the plan: the plan is of no use from here (a trail goes on from where the body landed).
    if (drop) {
      log.info(`⛏️ トンネル: 足場が${drop}ブロック下だったので降りました`);
      if (options.onDrop !== 'continue') return { stopped: 'off_line', steps, digs, at: landed, reason: 'drop' };
    }
  }
  return { stopped: options.isEnd(bot.entity.position.floored()) ? 'reached' : 'plan_end', steps, digs };
}