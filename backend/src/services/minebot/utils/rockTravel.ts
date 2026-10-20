/**
 * How a far walk through rock is made: walked on the ground as it is, along a tunnel dug before, or along a tunnel cut now.
 *
 * Run 21 (live, watched by Rai): the far walks across a hill (y 93 down to the water at y 58, y 57 up to the furnace at y 97, 37-43 m,
 * 58-82 s each, and the same again on the way back) went down and up in a zigzag, laying blocks here and there, with a stop at each
 * rim; every intermediate point of utils/farLegs fell inside the rock. "Dig straight, or a stair at 1:1, and come back up the same hole."
 *
 * For a walk of 10 m or more to a place with a height, whose first stretch of straight line is mostly rock, the three ways are priced
 * in seconds and the cheapest is taken:
 *   - a tunnel the body cut before that leads to the goal (TunnelTrail): nothing to dig, 0.35 s a step;
 *   - a walk on the ground that neither digs nor lays a block (a route search with a short think, travelProfile.walkOnlyProfile);
 *   - a tunnel cut now along a straight or 1:1 stair line (utils/stairLine, utils/tunnelWalk), priced block by block at the tool's time.
 * None of them fits (no tool, a liquid, an unloaded chunk): "default", the route search as before.
 */
import { Vec3 } from 'vec3';
import type { CustomBot, Goal } from '../types/CustomBot.js';
import { goalTarget, rockShare } from './farLegs.js';
import { planStairLine, trailOf } from './stairLine.js';
import { estimateCells } from './tunnelWalk.js';
import { buildMovements } from './setMovements.js';
import { walkOnlyProfile } from './travelProfile.js';

/** Walks shorter than this (m) are left to the route search. */
export const ROCK_TRAVEL_MIN_M = 10;
/** The straight line is read for this many metres to tell rock from open ground. */
const PROBE_M = 24;
const ROCK_SHARE = 0.4;
/** A step along the ground, and along a tunnel already cut. */
const WALK_MS_PER_MOVE = 300;
const TRAIL_MS_PER_STEP = 350;
/** A walk on the ground has to beat a new tunnel by less than this to be taken anyway (it digs and lays nothing). */
const WALK_PREFERENCE_MS = 3000;
/** The think the ground walk is priced with (the search blocks the body's thread for this long at most). */
const WALK_THINK_MS = 400;
/** A tunnel plan that leaves more levels than this untaken (the height asked is more than the way along) is not cut. */
const MAX_SHORT_BY = 6;
/** What a step of the plan that cannot be cut is priced at: the route search takes it over. */
const UNCUT_MS_PER_CELL = 900;

export type RockTravelChoice =
  | { mode: 'default'; why: string }
  | { mode: 'walk'; movements: unknown; seconds: number }
  | { mode: 'cells'; cells: Vec3[]; seconds: number; source: 'trail' | 'tunnel'; digs: number };

/** MINEBOT_ROCK_TRAVEL=off: the route search for every far walk, as before run 21 (a comparison or a rollback). */
export function rockTravelEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MINEBOT_ROCK_TRAVEL !== 'off';
}

interface Navigator {
  getPathFromTo?(movements: unknown, start: unknown, goal: unknown, options?: { timeout?: number; tickTimeout?: number }):
    Iterator<{ result?: { status?: string; path?: unknown[] } }>;
}

/** The ground walk priced: null when no whole route that neither digs nor lays was found within the think. */
function walkOnlyEstimate(bot: CustomBot, goal: Goal): { movements: unknown; seconds: number } | null {
  const navigator = bot.pathfinder as unknown as Navigator | undefined;
  if (!navigator?.getPathFromTo) return null;
  try {
    const movements = buildMovements(bot, ...walkOnlyProfile(false));
    const result = navigator.getPathFromTo(movements, bot.entity.position, goal, { timeout: WALK_THINK_MS, tickTimeout: WALK_THINK_MS }).next().value?.result;
    if (!result || result.status !== 'success' || !Array.isArray(result.path)) return null;
    return { movements, seconds: result.path.length * WALK_MS_PER_MOVE / 1000 };
  } catch { return null; }
}

export function chooseRockTravel(bot: CustomBot, goal: Goal, env: NodeJS.ProcessEnv = process.env): RockTravelChoice {
  if (!rockTravelEnabled(env)) return { mode: 'default', why: 'off' };
  const target = goalTarget(goal);
  if (!target || target.y === null) return { mode: 'default', why: 'no_height' };
  const here = bot.entity.position;
  if ((bot.entity as unknown as { isInWater?: boolean }).isInWater) return { mode: 'default', why: 'in_water' };
  const feet = here.floored();
  const aim = new Vec3(Math.floor(target.x), Math.floor(target.y), Math.floor(target.z));
  const space = Math.hypot(aim.x - here.x, aim.y - here.y, aim.z - here.z);
  if (goal.isEnd(feet as never)) return { mode: 'default', why: 'there' };
  if (space < ROCK_TRAVEL_MIN_M) return { mode: 'default', why: 'near' };

  // A tunnel cut before that leads to the goal: the way back is the way there, and nothing is dug.
  const along = Math.abs(aim.x - feet.x) + Math.abs(aim.z - feet.z) + Math.abs(aim.y - feet.y);
  const known = trailOf(bot).route(feet, cell => goal.isEnd(cell as never));
  const trail = known && known.length > 0 && known.length <= 3 * along + 12
    ? { cells: known, seconds: known.length * TRAIL_MS_PER_STEP / 1000 } : null;
  if (trail && trail.seconds <= 30) return { mode: 'cells', cells: trail.cells, seconds: trail.seconds, source: 'trail', digs: 0 };

  // Only a line that goes through rock is a case for this: open ground is walked by the route search as always.
  const probe = Math.min(PROBE_M, space);
  const end = { x: here.x + (aim.x - here.x) * probe / space, y: here.y + (aim.y - here.y) * probe / space, z: here.z + (aim.z - here.z) * probe / space };
  if (rockShare(bot as never, here, end) < ROCK_SHARE) return { mode: 'default', why: 'open_ground' };

  const walk = walkOnlyEstimate(bot, goal);
  const plan = planStairLine(feet, aim);
  let tunnel: { cells: Vec3[]; seconds: number; digs: number } | null = null;
  let tunnelWhy = plan.cells.length === 0 ? 'no_plan' : `short_by_${plan.shortBy}`;
  if (plan.cells.length > 0 && plan.shortBy <= MAX_SHORT_BY) {
    const estimate = estimateCells(bot, feet, plan.cells);
    tunnelWhy = estimate.why ?? 'ok';
    if (estimate.feasible) {
      const uncut = plan.cells.length - estimate.stoppedAt;
      tunnel = { cells: plan.cells, seconds: (estimate.ms + uncut * UNCUT_MS_PER_CELL) / 1000, digs: estimate.digs };
    }
  }
  if (trail && (!walk || trail.seconds <= walk.seconds + 5) && (!tunnel || trail.seconds <= tunnel.seconds)) {
    return { mode: 'cells', cells: trail.cells, seconds: trail.seconds, source: 'trail', digs: 0 };
  }
  if (walk && (!tunnel || walk.seconds <= tunnel.seconds + WALK_PREFERENCE_MS / 1000)) return { mode: 'walk', movements: walk.movements, seconds: walk.seconds };
  if (tunnel) return { mode: 'cells', cells: tunnel.cells, seconds: tunnel.seconds, source: 'tunnel', digs: tunnel.digs };
  return { mode: 'default', why: `nothing_fits（地面を歩く道: ${walk ? 'あり' : 'なし'}、掘る道: ${tunnelWhy}）` };
}
