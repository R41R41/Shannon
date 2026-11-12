import { Vec3 } from 'vec3';
import { activateItemFacing } from '../activateItemFacing.js';
import { allSolidsBetween, rayView } from '../liquidAim.js';
import { equipToHandVerified } from '../equipVerified.js';
import { feetCell, type Cell } from '../localMap.js';
import { holdsWater } from '../waterBlocks.js';
import { PROTECTED_UTILITY_BLOCKS } from '../../constants.js';
import { blockAt, cellText, DIG_REACH, findItem, guard, inventoryCount, isAirLike, placeText, stopped, USE_REACH, waitUntil, type StepContext, type StepOutcome } from './common.js';
import { dig } from './dig.js';
import { place } from './place.js';
import { damBlockHeld, waterLevel } from './stanch.js';
import { steadyInWater } from './footing.js';

/**
 * fillStand: filling a bucket from a source the body does not stand beside (run 6, 2026-11-11: 49 hands and 400 s to a water bucket, every `use` refused "not in reach / something in the way"
 * from where the body happened to be, the head never knowing which of the cells round the pool had a clear line to the water). The body looks for the dry floor to fill from:
 *   - a stand within reach of the source with the eye's line clear: go there (by a way that does not enter water) and fill;
 *   - none, but one with exactly ONE ordinary block on the line: from that dry floor the wall block is dug, the bucket filled at once, and the wall laid again with a cheap block
 *     (the water that comes in with the opening is the source just taken: nothing reaches the feet).
 * Never a flowing cell: only a source (level 0) is filled. Called by `use` for a bucket on water when the cell asked cannot be filled from where the body stands.
 */

const RADIUS = 6;
const MAX_NODES = 160;
const WALL_NO = new Set(['water', 'lava', 'bedrock', 'barrier', 'end_portal_frame', 'obsidian', 'crying_obsidian', 'spawner', 'trial_spawner']);

const open = (block: any) => !!block && (isAirLike(block) || block.boundingBox !== 'block') && block.name !== 'water' && block.name !== 'lava';
/** A cell a body stands in: a floor under it, the feet and head open (no water, no lava), no lava beside. */
function standable(bot: any, at: Cell): boolean {
  const floor = blockAt(bot, { x: at.x, y: at.y - 1, z: at.z });
  if (!floor || floor.boundingBox !== 'block' || floor.name === 'lava') return false;
  if (!open(blockAt(bot, at)) || !open(blockAt(bot, { x: at.x, y: at.y + 1, z: at.z }))) return false;
  return true;
}

/** The solid blocks on the line from `eye` to the middle of `cell` (the cell itself excluded), nearest first. */
export function blockersFrom(bot: any, eye: { x: number; y: number; z: number }, cell: Cell): Array<{ cell: Cell; name: string }> {
  return blockersTo(bot, eye, cell, { x: cell.x + 0.5, y: cell.y + 0.5, z: cell.z + 0.5 });
}

/** The solid blocks on the line from `eye` to the point `to` of `cell` (the cell itself excluded), nearest first. */
function blockersTo(bot: any, eye: { x: number; y: number; z: number }, cell: Cell, to: { x: number; y: number; z: number }): Array<{ cell: Cell; name: string }> {
  // A walk over every cell of the line (the corner of a block the line clips counts), the world as the server's ray sees it (utils/liquidAim).
  return allSolidsBetween(rayView(bot), new Vec3(eye.x, eye.y, eye.z), new Vec3(to.x, to.y, to.z), new Vec3(cell.x, cell.y, cell.z))
    .map(hit => ({ cell: { x: hit.at.x, y: hit.at.y, z: hit.at.z }, name: hit.name }));
}

/**
 * The five points a right click may aim at on a source cell: its middle and four points on the face turned to the eye (a click lands on any visible face: a line to the middle alone
 * is cut by a corner that hides nothing of the face).
 */
function aimPoints(eye: { x: number; y: number; z: number }, cell: Cell): Array<{ x: number; y: number; z: number }> {
  const c = { x: cell.x + 0.5, y: cell.y + 0.5, z: cell.z + 0.5 };
  const d = { x: eye.x - c.x, y: eye.y - c.y, z: eye.z - c.z };
  const axis = (['x', 'y', 'z'] as const).reduce((best, key) => (Math.abs(d[key]) > Math.abs(d[best]) ? key : best), 'x' as 'x' | 'y' | 'z');
  const face = { ...c, [axis]: c[axis] + Math.sign(d[axis] || 1) * 0.49 };
  const others = (['x', 'y', 'z'] as const).filter(key => key !== axis);
  const points = [c];
  for (const a of [-0.3, 0.3]) for (const b of [-0.3, 0.3]) points.push({ ...face, [others[0]!]: c[others[0]!] + a, [others[1]!]: c[others[1]!] + b });
  return points;
}

export interface FillPlan { stand: Cell; /** Where the right click aims (a point on the source cell with the clearest line). */ aim?: { x: number; y: number; z: number }; /** The one block between the stand and the source, to open and close again. */ wall?: Cell; wallName?: string; steps: number }

/**
 * Where the stand search starts: the cell the feet are in when a body can stand there; else (in water, in a flooded shaft, half buried) the nearest cell within three that a body stands in.
 */
function originOf(bot: any): Cell | null {
  const feet = feetCell(bot);
  if (!feet) return null;
  if (standable(bot, feet)) return feet;
  let best: { at: Cell; d: number } | null = null;
  for (let dx = -3; dx <= 3; dx++) for (let dy = -3; dy <= 3; dy++) for (let dz = -3; dz <= 3; dz++) {
    const at = { x: feet.x + dx, y: feet.y + dy, z: feet.z + dz };
    const d = Math.hypot(dx, dy, dz);
    if ((!best || d < best.d) && standable(bot, at)) best = { at, d };
  }
  return best?.at ?? null;
}

/** Dry stands reachable on foot from the body (breadth first, one step up or down, no water entered), up to MAX_NODES. */
export function standsNear(bot: any, source: Cell): Array<{ at: Cell; steps: number }> {
  const start = originOf(bot);
  if (!start) return [];
  const key = (c: Cell) => `${c.x},${c.y},${c.z}`;
  const seen = new Set([key(start)]);
  const out: Array<{ at: Cell; steps: number }> = [];
  let layer: Array<{ at: Cell; steps: number }> = [{ at: start, steps: 0 }];
  while (layer.length && seen.size < MAX_NODES) {
    const next: Array<{ at: Cell; steps: number }> = [];
    for (const node of layer) {
      out.push(node);
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        for (const dy of [0, 1, -1]) {
          const at = { x: node.at.x + dx, y: node.at.y + dy, z: node.at.z + dz };
          if (seen.has(key(at)) || Math.hypot(at.x - source.x, at.z - source.z) > RADIUS + 2) continue;
          // A step up needs the cell over the stepping-from cell's head open too.
          if (dy === 1 && !open(blockAt(bot, { x: node.at.x, y: node.at.y + 2, z: node.at.z }))) continue;
          if (!standable(bot, at)) continue;
          seen.add(key(at));
          next.push({ at, steps: node.steps + 1 });
        }
      }
    }
    layer = next;
  }
  return out;
}

/** The stand to fill `source` from: a clear line first (nearest by steps), else the one with a single wall block (and a cheap block held to close it). */
export function planFill(bot: any, source: Cell, assumeDam = false, stands = standsNear(bot, source)): FillPlan | null {
  let wallPlan: FillPlan | null = null;
  const hasDam = assumeDam || damBlockHeld(bot) !== null;
  for (const { at, steps } of [...stands].sort((x, y) => x.steps - y.steps)) {
    const eye = { x: at.x + 0.5, y: at.y + 1.62, z: at.z + 0.5 };
    if (Math.hypot(eye.x - (source.x + 0.5), eye.y - (source.y + 0.5), eye.z - (source.z + 0.5)) > USE_REACH) continue;
    // The clearest of five aims: none in the way is a clear line; else the one with exactly one block on it is the wall.
    let clear: { x: number; y: number; z: number } | null = null, single: { aim: { x: number; y: number; z: number }; wall: { cell: Cell; name: string } } | null = null;
    for (const aim of aimPoints(eye, source)) {
      const blockers = blockersTo(bot, eye, source, aim);
      if (!blockers.length) { clear = aim; break; }
      if (!single && blockers.length === 1) single = { aim, wall: blockers[0]! };
    }
    if (clear) return { stand: at, steps, aim: clear };
    if (wallPlan || !hasDam || !single) continue;
    const wall = single.wall;
    const block = blockAt(bot, wall.cell);
    if (!block || WALL_NO.has(wall.name) || PROTECTED_UTILITY_BLOCKS.has(wall.name) || block.diggable === false || !(block.hardness >= 0)) continue;
    if (Math.hypot(eye.x - (wall.cell.x + 0.5), eye.y - (wall.cell.y + 0.5), eye.z - (wall.cell.z + 0.5)) > Math.min(DIG_REACH, USE_REACH)) continue;
    wallPlan = { stand: at, wall: wall.cell, wallName: wall.name, steps, aim: single.aim };
  }
  return wallPlan;
}

/** Up to eight water sources within six cells of `asked`, nearest first: a pool has more than one, and one of them is seen when another is behind rock. */
function sourcesNear(bot: any, asked: Cell): Cell[] {
  const found: Array<{ at: Cell; d: number }> = [];
  for (let dx = -RADIUS; dx <= RADIUS; dx++) for (let dy = -RADIUS; dy <= RADIUS; dy++) for (let dz = -RADIUS; dz <= RADIUS; dz++) {
    const at = { x: asked.x + dx, y: asked.y + dy, z: asked.z + dz };
    if (waterLevel(bot, at) === 0) found.push({ at, d: Math.hypot(dx, dy, dz) });
  }
  return found.sort((x, y) => x.d - y.d).slice(0, 8).map(entry => entry.at);
}

/** The best plan over the sources of a pool: a clear line (fewest steps) before one wall block (fewest steps). The stands are read once. */
export function bestPlan(bot: any, asked: Cell, assumeDam = false): { source: Cell; plan: FillPlan } | null {
  const stands = standsNear(bot, asked);
  let best: { source: Cell; plan: FillPlan } | null = null;
  const rank = (plan: FillPlan) => (plan.wall ? 1000 : 0) + plan.steps;
  for (const source of sourcesNear(bot, asked)) {
    const plan = planFill(bot, source, assumeDam, stands);
    if (plan && (!best || rank(plan) < rank(best.plan))) best = { source, plan };
  }
  return best;
}

/**
 * Fills the bucket held from `asked` (a water source, or a flow with a source beside it) from a dry stand the body finds; null when there is no such stand (the caller says its own
 * refusal). A stop with its own words when the walk to the stand or the fill fails. The first words say which stand and whether a wall was opened.
 */
export async function fillFromStand(ctx: StepContext, asked: Cell, liquid = 'water'): Promise<StepOutcome | null> {
  const bot = ctx.bot;
  if (liquid !== 'water') return null;
  // A body in water (or in a flooded shaft) is put on its feet first: the stands are looked for from where it stands, not from the water.
  const feetNow = feetCell(bot);
  if (feetNow && holdsWater(blockAt(bot, feetNow))) await steadyInWater(ctx);
  // Every source of the pool within six cells is looked at (one is behind rock and another is not).
  const found = bestPlan(bot, asked);
  if (!found) {
    // One wall block is all that is between the body and the water, and nothing to close it with: the words name the block to carry.
    const wallOnly = damBlockHeld(bot) === null ? bestPlan(bot, asked, true) : null;
    return wallOnly ? stopped(bot, 'no_wall_block', `${placeText(bot, wallOnly.source)} の水は壁 1 枚（${cellText(wallOnly.plan.wall!)} の ${wallOnly.plan.wallName}）の向こう。開けて汲むには塞ぐ dirt か cobblestone を 1 個持つ（持てば use bucket だけでよい）`, wallOnly.source) : null;
  }
  const { source, plan } = found;
  const here = feetCell(bot);
  const there = !here || here.x !== plan.stand.x || here.y !== plan.stand.y || here.z !== plan.stand.z;
  let words = '';
  if (there) {
    const { go } = await import('./go.js');
    const gone = await go(ctx, { goals: [plan.stand], range: 0.6, seconds: 25, sprint: 'auto' } as never);
    if (!gone.ok) return stopped(bot, 'stand_unreachable', `水を汲む立ち位置 ${cellText(plan.stand)} へ行けなかった（${gone.text.slice(0, 80)}）`, source);
    words = `乾いた ${cellText(plan.stand)} から。`;
  }
  const before = inventoryCount(bot, 'bucket');
  let opened = '';
  if (plan.wall) {
    const dug = await dig(ctx, { at: [plan.wall], collect: false, wallOpen: true });
    if (!dug.ok) return stopped(bot, 'not_filled', `${words}壁 ${cellText(plan.wall)} の ${plan.wallName} を開けられなかった（${dug.text.slice(0, 80)}）`, source);
    opened = `壁 ${cellText(plan.wall)} の ${plan.wallName} を開けて`;
    // The dig held its own tool (a pickaxe for stone): the bucket goes back to the hand before the right click.
    const bucket = findItem(bot, 'bucket');
    if (bot.heldItem?.name !== 'bucket' && bucket) {
      const held = await guard(ctx, equipToHandVerified(bot, bucket), 5000);
      if (!held?.value.held) {
        // Close the wall at once: what came in with the opening must not run on.
        const block = damBlockHeld(bot);
        if (block) await place(ctx, { block, at: [plan.wall] });
        return stopped(bot, 'not_filled', `${words}${opened}、バケツを手に持てなかった（${held?.value.detail ?? '時間切れ'}）${block ? `。壁は ${block} で塞いだ` : ''}`, source);
      }
    }
  }
  await activateItemFacing(bot, plan.aim ? new Vec3(plan.aim.x, plan.aim.y, plan.aim.z) : new Vec3(source.x + 0.5, source.y + 0.5, source.z + 0.5));
  const filled = await waitUntil(ctx, () => inventoryCount(bot, 'bucket') < before || bot.heldItem?.name === 'water_bucket', 1500);
  // The wall is closed whether or not the bucket filled (what came in with the opening must not run on).
  let closed = '';
  if (plan.wall) {
    const block = damBlockHeld(bot);
    if (block) {
      const laid = await place(ctx, { block, at: [plan.wall] });
      closed = laid.ok ? `、壁を ${block} で塞いだ` : `、壁 ${cellText(plan.wall)} は塞げなかった（${laid.text.slice(0, 50)}）`;
    } else closed = `、壁 ${cellText(plan.wall)} は開いたまま（塞ぐ dirt か cobblestone が無い）`;
  }
  if (!filled) return stopped(bot, 'not_filled', `${words}${opened}${placeText(bot, source)} の水を汲めなかった${closed}`, source);
  return { ok: true, text: `${words}${opened}${cellText(source)} の水源を汲んだ（water_bucket）${closed}`, at: source };
}
