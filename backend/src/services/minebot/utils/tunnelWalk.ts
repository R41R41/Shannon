/**
 * Walks a list of cells (utils/stairLine), cutting the rock of each step itself: no route search, no block laid.
 *
 * Why not the route search: it prices a dug block at 3 steps and a laid block at 5, so a far walk over a hill came out as a mix of both
 * (run 21: seven far walks of 37-43 m took 58-82 s each, with cliff-edge stops, escapes from being stuck and a timeout, and the way
 * back was cut again). Here the cells are fixed beforehand, a step is dug as a whole (three cells for a stair step down, three for a step
 * up, two for a level one) and walked, and the cells walked are remembered (TunnelTrail) so that the way back digs nothing.
 *
 * Anything the walk is not sure of ends it with a reason (liquid beside a cell to be dug, a block that will not break, no floor, a block
 * that falls) and the route search takes over from where the body stands.
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
import { shaftStepRefusal } from './shaftDown.js';

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
export function digRefusal(bot: WorldBot, cell: Cell, others: Cell[]): string | null {
  const block = blockOf(bot, cell);
  if (!block) return 'unloaded';
  if (LIQUIDS.has(block.name)) return `liquid:${block.name}`;
  const empty = block.boundingBox === 'empty';
  if (!empty) {
    if (block.diggable === false || block.name === 'bedrock') return `undiggable:${block.name}`;
    if (PROTECTED_UTILITY_BLOCKS.has(block.name)) return `protected:${block.name}`;
  }
  for (const [dx, dy, dz] of SIDES6) {
    const side = at(cell, dx, dy, dz);
    // The cells of the step itself are dealt with on their own (a neighbour of the same step is dug or empty by then).
    if (others.some(other => other.x === side.x && other.y === side.y && other.z === side.z)) continue;
    const next = blockOf(bot, side);
    if (!next) return 'unloaded';
    // Lava beside any cell the body will stand in or open; water only beside a cell that is dug (an open cell does not let it in).
    if (next.name === 'lava' || next.name === 'flowing_lava') return `lava_beside:${next.name}`;
    if (!empty && LIQUIDS.has(next.name)) return `liquid_beside:${next.name}`;
    if (!empty && dy === 1 && FALLING.test(next.name)) return `falling_above:${next.name}`;
  }
  return null;
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
export function estimateStep(bot: WorldBot, from: Cell, to: Cell, ctx: { blocks: number } = { blocks: pillarBlocks(bot) }): StepEstimate | null {
  const needs = stepNeeds(from, to);
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
    if (digRefusal(bot, cell, needs.clear)) return null;
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
  for (const cell of needs.clear) { const refusal = digRefusal(bot, cell, vertical ? [] : needs.clear); if (refusal) return `${refusal}(${cell.x},${cell.y},${cell.z})`; }
  if (vertical) return 'no_blocks_to_pillar';
  return `no_floor(${needs.floor.x},${needs.floor.y},${needs.floor.z}:${blockOf(bot, needs.floor)?.name ?? 'unloaded'})`;
}

/**
 * The time of walking `cells` from `start`: the steps up to the first that cannot be taken (`stoppedAt` is its index, or the length).
 * Feasible when at least `minSteps` steps can be taken.
 */
export function estimateCells(bot: WorldBot, start: Cell, cells: Vec3[], minSteps = 3): PlanEstimate {
  let ms = 0, digs = 0, from: Cell = start, index = 0;
  const ctx = { blocks: pillarBlocks(bot) };
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
}

export interface WalkOptions {
  /** The goal's own end test, asked of the feet cell before each step. */
  isEnd: (feet: Vec3) => boolean;
  deadline: number;
  /** Called every few steps: the stone the tunnel brings in is thrown away here. */
  tidy?: () => Promise<void>;
  /** Straight up by `height` levels (the tower-up skill): the pillar of a plan that climbs more than its stair can. */
  pillar?: (height: number) => Promise<unknown>;
}

const sleep = (bot: CustomBot, ms: number) => actionDelay(bot, ms);

async function digCell(bot: CustomBot, cell: Cell): Promise<boolean> {
  const block = blockOf(bot, cell);
  if (!block || block.boundingBox === 'empty') return true;
  const tool = chooseTool(block as never, bot.inventory.items() as never[], { requireHarvest: !!block.harvestTools, effects: (bot.entity as unknown as { effects?: unknown })?.effects ?? {} }) as { type: number; slot: number } | null;
  if (tool && (bot.heldItem?.type !== tool.type || bot.heldItem?.slot !== tool.slot)) await bot.equip(tool as never, 'hand');
  else if (!tool && block.harvestTools) return false;
  await digBlockVerified(bot, block as never);
  return blockOf(bot, cell)?.boundingBox === 'empty';
}

/** One step walked towards the middle of the next column, the way stair-mine walks its stairs. True when the body stands in the cell. */
async function moveOneCell(bot: CustomBot, start: Cell, to: Cell, extraDrop: number): Promise<boolean> {
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
 * One level straight down: the floor under the feet is dug and the body drops onto the rock under it (the shaft step of stair-mine,
 * held to the same rules, utils/shaftDown). Null when it did, otherwise why not.
 */
async function shaftDownOne(bot: CustomBot, feet: Vec3): Promise<string | null> {
  const refusal = shaftStepRefusal(bot as never, feet);
  if (refusal) return refusal;
  // The body's box has to be over this column alone, or it stays on the rim of the next.
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
  try { if (!(await digCell(bot, at(feet, 0, -1)))) return 'dig_failed'; } catch (error) {
    if (/interrupt/i.test(String((error as Error)?.message))) throw error;
    return `dig_failed:${String((error as Error)?.message ?? error).slice(0, 60)}`;
  }
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline && (Math.floor(bot.entity.position.y) >= feet.y || (bot.entity as unknown as { onGround?: boolean }).onGround === false)) {
    assertActionActive(bot);
    await sleep(bot, 50);
  }
  return Math.floor(bot.entity.position.y) === feet.y - 1 ? null : 'did_not_drop';
}

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
    if (!isStep(feet, next)) return { stopped: 'off_line', steps, digs, reason: `(${feet.x},${feet.y},${feet.z})から(${next.x},${next.y},${next.z})は一歩ではありません` };
    if (next.x === feet.x && next.z === feet.z) {
      // A level straight down (a shaft) or a run of levels straight up (a pillar).
      const cell = stepNeeds(feet, next).clear[0];
      const refused = digRefusal(bot, cell, []);
      if (refused) return { stopped: 'blocked', steps, digs, reason: `${refused}(${cell.x},${cell.y},${cell.z})` };
      if (next.y < feet.y) {
        const why = await shaftDownOne(bot, feet);
        if (why) return { stopped: 'blocked', steps, digs, reason: `縦穴で下りられません(${why})` };
        digs++;
        trail.add(feet, bot.entity.position.floored());
        steps++;
        continue;
      }
      let run = 1;
      while (cells[index + run] && cells[index + run].x === next.x && cells[index + run].z === next.z && cells[index + run].y === next.y + run) run++;
      if (!options.pillar) return { stopped: 'blocked', steps, digs, reason: '直上登りの手段がありません' };
      try { await options.pillar(run); } catch (error) {
        if (/interrupt/i.test(String((error as Error)?.message))) throw error;
        return { stopped: 'blocked', steps, digs, reason: `直上登りに失敗: ${String((error as Error)?.message ?? error).slice(0, 60)}` };
      }
      const gained = Math.floor(bot.entity.position.y) - feet.y;
      for (let level = 0; level < gained; level++) trail.add(at(feet, 0, level), at(feet, 0, level + 1));
      steps += Math.max(0, gained);
      if (gained < run) return { stopped: 'blocked', steps, digs, reason: `直上登りが${Math.max(0, gained)}/${run}段で止まりました` };
      index += run - 1;
      continue;
    }
    const needs = stepNeeds(feet, next);
    for (const cell of needs.clear) {
      const refusal = digRefusal(bot, cell, needs.clear);
      if (refusal) return { stopped: 'blocked', steps, digs, reason: `${refusal}(${cell.x},${cell.y},${cell.z})` };
    }
    for (const cell of needs.clear) {
      if (blockOf(bot, cell)?.boundingBox === 'empty') continue;
      let dug = false;
      try { dug = await digCell(bot, cell); } catch (error) {
        if (/interrupt/i.test(String((error as Error)?.message))) throw error;
        return { stopped: 'blocked', steps, digs, reason: `掘れません(${cell.x},${cell.y},${cell.z}): ${String((error as Error)?.message ?? error).slice(0, 80)}` };
      }
      if (!dug) return { stopped: 'blocked', steps, digs, reason: `掘れません(${cell.x},${cell.y},${cell.z})` };
      digs++;
    }
    const drop = floorDrop(bot, needs.floor, next.y <= feet.y);
    if (drop === null) return { stopped: 'blocked', steps, digs, reason: `足場がありません(${needs.floor.x},${needs.floor.y},${needs.floor.z})` };
    if (!(await moveOneCell(bot, feet, next, drop))) {
      return { stopped: 'step_failed', steps, digs, reason: `(${next.x},${next.y - drop},${next.z})へ踏み出せませんでした` };
    }
    trail.add(feet, bot.entity.position.floored());
    steps++;
    if (options.tidy && steps % 12 === 0) { try { await options.tidy(); } catch (error) { if (/interrupt/i.test(String((error as Error)?.message))) throw error; } }
    // A drop that took the body lower than the plan: the plan is of no use from here.
    if (drop) { log.info(`⛏️ トンネル: 足場が${drop}ブロック下だったので降りました`); return { stopped: 'off_line', steps, digs, reason: 'drop' }; }
  }
  return { stopped: options.isEnd(bot.entity.position.floored()) ? 'reached' : 'plan_end', steps, digs };
}
