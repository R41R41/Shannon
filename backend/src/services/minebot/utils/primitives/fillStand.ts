import { Vec3 } from 'vec3';
import { activateItemFacing } from '../activateItemFacing.js';
import { feetCell, type Cell } from '../localMap.js';
import { PROTECTED_UTILITY_BLOCKS } from '../../constants.js';
import { blockAt, cellText, DIG_REACH, inventoryCount, isAirLike, placeText, stopped, USE_REACH, waitUntil, type StepContext, type StepOutcome } from './common.js';
import { dig } from './dig.js';
import { place } from './place.js';
import { damBlockHeld, waterLevel } from './stanch.js';

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
  const to = { x: cell.x + 0.5, y: cell.y + 0.5, z: cell.z + 0.5 };
  const length = Math.hypot(to.x - eye.x, to.y - eye.y, to.z - eye.z), steps = Math.max(1, Math.ceil(length / 0.1));
  const found: Array<{ cell: Cell; name: string }> = [];
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const at = { x: Math.floor(eye.x + (to.x - eye.x) * t), y: Math.floor(eye.y + (to.y - eye.y) * t), z: Math.floor(eye.z + (to.z - eye.z) * t) };
    if (at.x === cell.x && at.y === cell.y && at.z === cell.z) break;
    if (found.some(entry => entry.cell.x === at.x && entry.cell.y === at.y && entry.cell.z === at.z)) continue;
    const block = blockAt(bot, at);
    if (block && block.boundingBox === 'block') found.push({ cell: at, name: String(block.name) });
  }
  return found;
}

export interface FillPlan { stand: Cell; /** The one block between the stand and the source, to open and close again. */ wall?: Cell; wallName?: string; steps: number }

/** Dry stands reachable on foot from the body (breadth first, one step up or down, no water entered), up to MAX_NODES. */
function standsNear(bot: any, source: Cell): Array<{ at: Cell; steps: number }> {
  const start = feetCell(bot);
  if (!start) return [];
  const key = (c: Cell) => `${c.x},${c.y},${c.z}`;
  const seen = new Set([key(start)]);
  const out: Array<{ at: Cell; steps: number }> = [];
  let layer: Array<{ at: Cell; steps: number }> = [{ at: start, steps: 0 }];
  const origin = standable(bot, start) ? [start] : [];
  if (!origin.length) return [];
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
export function planFill(bot: any, source: Cell): FillPlan | null {
  const stands = standsNear(bot, source);
  let wallPlan: FillPlan | null = null;
  const hasDam = damBlockHeld(bot) !== null;
  for (const { at, steps } of stands.sort((a, b) => a.steps - b.steps)) {
    const eye = { x: at.x + 0.5, y: at.y + 1.62, z: at.z + 0.5 };
    if (Math.hypot(eye.x - (source.x + 0.5), eye.y - (source.y + 0.5), eye.z - (source.z + 0.5)) > USE_REACH) continue;
    const blockers = blockersFrom(bot, eye, source);
    if (!blockers.length) return { stand: at, steps };
    if (wallPlan || !hasDam || blockers.length !== 1) continue;
    const wall = blockers[0]!;
    const block = blockAt(bot, wall.cell);
    if (!block || WALL_NO.has(wall.name) || PROTECTED_UTILITY_BLOCKS.has(wall.name) || block.diggable === false || !(block.hardness >= 0)) continue;
    if (Math.hypot(eye.x - (wall.cell.x + 0.5), eye.y - (wall.cell.y + 0.5), eye.z - (wall.cell.z + 0.5)) > Math.min(DIG_REACH, USE_REACH)) continue;
    wallPlan = { stand: at, wall: wall.cell, wallName: wall.name, steps };
  }
  return wallPlan;
}

/** The source to fill: the cell asked when it is one, else a source the flow in it comes from (the cells upstream, a few away). */
export function sourceFor(bot: any, asked: Cell): Cell | null {
  if (waterLevel(bot, asked) === 0) return asked;
  for (let radius = 1; radius <= 3; radius++) {
    for (let dx = -radius; dx <= radius; dx++) for (let dy = -radius; dy <= radius; dy++) for (let dz = -radius; dz <= radius; dz++) {
      const at = { x: asked.x + dx, y: asked.y + dy, z: asked.z + dz };
      if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) === radius && waterLevel(bot, at) === 0) return at;
    }
  }
  return null;
}

/**
 * Fills the bucket held from `asked` (a water source, or a flow with a source beside it) from a dry stand the body finds; null when there is no such stand (the caller says its own
 * refusal). A stop with its own words when the walk to the stand or the fill fails. The first words say which stand and whether a wall was opened.
 */
export async function fillFromStand(ctx: StepContext, asked: Cell, liquid = 'water'): Promise<StepOutcome | null> {
  const bot = ctx.bot;
  if (liquid !== 'water') return null;
  const source = sourceFor(bot, asked);
  if (!source) return null;
  const plan = planFill(bot, source);
  if (!plan) return null;
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
  }
  await activateItemFacing(bot, new Vec3(source.x + 0.5, source.y + 0.5, source.z + 0.5));
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
