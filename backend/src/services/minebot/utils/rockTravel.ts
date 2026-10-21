/**
 * How a walk that may need digging is made: walked on the ground as it is, along a tunnel dug before, or along a tunnel cut now.
 *
 * Run 21 (live, watched by Rai): the far walks across a hill (y 93 down to the water at y 58, y 57 up to the furnace at y 97, 37-43 m,
 * 58-82 s each, and the same again on the way back) went down and up in a zigzag, laying blocks here and there, with a stop at each
 * rim; every intermediate point of utils/farLegs fell inside the rock. "Dig straight, or a stair at 1:1, and come back up the same hole."
 * Run 23 (Rai): "move by vertical, level or stair tunnels, or those together". The route search of the path library (a mix of digging and
 * laying, priced by a rule of thumb) is left for the walk that needs no digging; anything that does is a plan of axis-aligned runs.
 *
 * For a walk to a place with a height (any length from a block and a half) the ways are priced in seconds and the cheapest is taken:
 *   - a tunnel the body cut before that leads to the goal (TunnelTrail): nothing to dig, 0.35 s a step;
 *   - a walk on the ground that neither digs nor lays a block (a route search with a short think, travelProfile.walkOnlyProfile);
 *   - a tunnel cut now: straight runs along x then z (either first), shafts and 1:1 stairs (utils/stairLine, utils/tunnelWalk), priced block
 *     by block at the tool's time. A block in the way (a liquid beside it, equipment, bedrock, no floor) is gone round by a jog of one or
 *     two cells to the side, in parallel with the run, at the start or just before the obstacle.
 * The tunnel is taken when the ground cannot be walked: the walk-only search found no way at all, or the first stretch of the straight
 * line is mostly rock. None of them fits (no tool, a liquid all round, an unloaded chunk): "default", the route search as before.
 */
import { Vec3 } from 'vec3';
import type { CustomBot, Goal } from '../types/CustomBot.js';
import { goalTarget, rockShare } from './farLegs.js';
import { planStairLine, trailOf, type LegOrder } from './stairLine.js';
import { estimateCells, type PlanEstimate } from './tunnelWalk.js';
import { trailCellsOpen } from './trailRecorder.js';
import { buildMovements } from './setMovements.js';
import { walkOnlyProfile } from './travelProfile.js';

/** Walks shorter than this (m) are left to the route search: the body is all but there. */
export const ROCK_TRAVEL_MIN_M = 1.5;
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
/** How far to the side a run is moved to get round what is in its way (cells), and the horizontal directions it is moved in. */
const JOG_WIDTHS = [1, 2];
const JOG_DIRECTIONS: Array<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const LEG_ORDERS: LegOrder[] = ['long', 'short'];

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

interface WalkEstimate { status: 'success' | 'noPath' | 'other'; movements?: unknown; seconds: number }

/**
 * The ground walk priced. `success` with the movements and the seconds when a whole route that neither digs nor lays was found within the
 * think; `noPath` when the search ran out of ground to try (the way needs digging or laying, or there is none); null when it could not
 * say (no navigator, a think that ran out, an error).
 */
function walkOnlyEstimate(bot: CustomBot, goal: Goal): WalkEstimate | null {
  const navigator = bot.pathfinder as unknown as Navigator | undefined;
  if (!navigator?.getPathFromTo) return null;
  try {
    const movements = buildMovements(bot, ...walkOnlyProfile(false));
    const result = navigator.getPathFromTo(movements, bot.entity.position, goal, { timeout: WALK_THINK_MS, tickTimeout: WALK_THINK_MS }).next().value?.result;
    if (!result) return null;
    if (result.status === 'noPath') return { status: 'noPath', seconds: Infinity };
    if (result.status !== 'success' || !Array.isArray(result.path)) return null;
    return { status: 'success', movements, seconds: result.path.length * WALK_MS_PER_MOVE / 1000 };
  } catch { return null; }
}

/** A tunnel plan priced: the cells, the estimate of walking them, and the seconds (the cells that cannot be cut priced as the route search's). */
export interface TunnelPlan { cells: Vec3[]; estimate: PlanEstimate; seconds: number; complete: boolean; note: string }

function priceCells(bot: CustomBot, feet: Vec3, cells: Vec3[], note: string, avoid?: ReadonlySet<string>): TunnelPlan {
  const estimate = estimateCells(bot, feet, cells, 3, avoid);
  const uncut = cells.length - estimate.stoppedAt;
  return { cells, estimate, seconds: (estimate.ms + uncut * UNCUT_MS_PER_CELL) / 1000, complete: estimate.feasible && uncut === 0, note };
}

/** Whether `a` is the better plan: a whole one over a part, the quicker of two whole ones, the one that gets further of two parts. */
function betterPlan(a: TunnelPlan, b: TunnelPlan | null): boolean {
  if (!b) return true;
  if (a.complete !== b.complete) return a.complete;
  if (a.complete) return a.seconds < b.seconds;
  if (a.estimate.stoppedAt !== b.estimate.stoppedAt) return a.estimate.stoppedAt > b.estimate.stoppedAt;
  return a.seconds < b.seconds;
}

/**
 * The tunnel to cut from `feet` to `aim`: the straight runs of planStairLine in either order; and, when neither can be cut the whole way,
 * the better of them moved aside by a jog (1 or 2 cells, any of the four directions) at the start, or one or two cells before the step
 * that stopped it. Null when the plan has nothing to cut (no cells, or more levels short than a plan may leave).
 */
export function planTunnel(bot: CustomBot, feet: Vec3, aim: Vec3, avoid?: ReadonlySet<string>): TunnelPlan | null {
  let best = null as TunnelPlan | null;
  let base = null as TunnelPlan | null;
  const seen = new Set<string>();
  const keyOf = (cells: Vec3[]) => cells.map(cell => `${cell.x},${cell.y},${cell.z}`).join(';');
  const consider = (cells: Vec3[], note: string): TunnelPlan | null => {
    const key = keyOf(cells);
    if (!cells.length || seen.has(key)) return null;
    seen.add(key);
    const plan = priceCells(bot, feet, cells, note, avoid);
    if (betterPlan(plan, best)) best = plan;
    return plan;
  };
  for (const order of LEG_ORDERS) {
    const plan = planStairLine(feet, aim, order);
    if (plan.cells.length === 0 || plan.shortBy > MAX_SHORT_BY) continue;
    const priced = consider(plan.cells, `straight ${order}`);
    if (priced && betterPlan(priced, base)) base = priced;
  }
  const first = base;
  if (!first || first.complete) return best;
  // Round the obstacle: the jog is made at the start, or a cell or two before the step that could not be cut.
  const stopped = first.estimate.stoppedAt;
  const at = [...new Set([-1, stopped - 2, stopped - 1])].filter(index => index >= -1 && index < first.cells.length);
  for (const order of LEG_ORDERS) {
    for (const index of at) {
      const prefix = first.cells.slice(0, index + 1);
      const from = prefix.length ? prefix[prefix.length - 1] : feet;
      for (const [dx, dz] of JOG_DIRECTIONS) {
        for (const width of JOG_WIDTHS) {
          const jog: Vec3[] = [];
          for (let step = 1; step <= width; step++) jog.push(new Vec3(from.x + dx * step, from.y, from.z + dz * step));
          const after = planStairLine(jog[jog.length - 1], aim, order);
          if (after.shortBy > MAX_SHORT_BY) continue;
          consider([...prefix, ...jog, ...after.cells], `jog ${width} ${dx},${dz} at ${index}`);
        }
      }
    }
  }
  return best;
}

const LIQUID_NAMES = new Set(['water', 'lava', 'flowing_water', 'flowing_lava', 'bubble_column']);
/** How far above and below the body's level the ground of a column with no height is looked for. */
const GROUND_SEARCH = 40;

/**
 * The level a body stands at in the column (x, z), nearest to `aroundY` (the higher of two equally near): a solid block that is not a
 * liquid with two empty cells over it. Null when the column is not loaded or has no such place (water, solid rock all through).
 */
export function standingHeightAt(bot: Pick<CustomBot, 'blockAt'>, x: number, z: number, aroundY: number): number | null {
  const read = (y: number) => { try { return bot.blockAt(new Vec3(x, y, z), false) as { name?: string; boundingBox?: string } | null; } catch { return null; } };
  for (let distance = 0; distance <= GROUND_SEARCH; distance++) {
    for (const y of distance === 0 ? [aroundY] : [aroundY + distance, aroundY - distance]) {
      const floor = read(y - 1), feet = read(y), head = read(y + 1);
      if (!floor || !feet || !head) continue;
      if (floor.boundingBox === 'block' && !LIQUID_NAMES.has(floor.name ?? '') && feet.boundingBox === 'empty' && head.boundingBox === 'empty'
        && !LIQUID_NAMES.has(feet.name ?? '') && !LIQUID_NAMES.has(head.name ?? '')) return y;
    }
  }
  return null;
}

export interface RockTravelOptions {
  /** Cells (`x,y,z`) no plan may pass through: where a tunnel walk stopped twice for the same reason (utils/gotoSafe). */
  avoid?: ReadonlySet<string>;
}

export function chooseRockTravel(bot: CustomBot, goal: Goal, env: NodeJS.ProcessEnv = process.env, options: RockTravelOptions = {}): RockTravelChoice {
  if (!rockTravelEnabled(env)) return { mode: 'default', why: 'off' };
  const target = goalTarget(goal);
  if (!target) return { mode: 'default', why: 'no_height' };
  const here = bot.entity.position;
  const feet = here.floored();
  // A goal with no height (a sheep to within six blocks, a column in the XZ plane) is walked to the ground of its column when that is loaded
  // (run 24: 36 m to a sheep went the old legs, four times "in the rock" and three stuck, 24 s, for want of a height).
  let targetY = target.y;
  if (targetY === null) {
    targetY = standingHeightAt(bot, Math.floor(target.x), Math.floor(target.z), feet.y);
    if (targetY === null) return { mode: 'default', why: 'no_height' };
  }
  const aim = new Vec3(Math.floor(target.x), Math.floor(targetY), Math.floor(target.z));
  const space = Math.hypot(aim.x - here.x, aim.y - here.y, aim.z - here.z);
  if (goal.isEnd(feet as never)) return { mode: 'default', why: 'there' };
  if (space < ROCK_TRAVEL_MIN_M) return { mode: 'default', why: 'near' };

  // A tunnel cut before that leads to the goal: the way back is the way there, and nothing is dug.
  const along = Math.abs(aim.x - feet.x) + Math.abs(aim.z - feet.z) + Math.abs(aim.y - feet.y);
  const known = trailOf(bot).route(feet, cell => goal.isEnd(cell as never));
  // The trail is walked only while its cells are still open (a cell filled in since, or flooded, is not the way back any more).
  const trail = known && known.length > 0 && known.length <= 3 * along + 12 && trailCellsOpen(bot, known)
    ? { cells: known, seconds: known.length * TRAIL_MS_PER_STEP / 1000 } : null;
  if (trail && trail.seconds <= 30) return { mode: 'cells', cells: trail.cells, seconds: trail.seconds, source: 'trail', digs: 0 };

  // Rock on the straight line: the first stretch of it is mostly to be dug.
  const probe = Math.min(PROBE_M, space);
  const end = { x: here.x + (aim.x - here.x) * probe / space, y: here.y + (aim.y - here.y) * probe / space, z: here.z + (aim.z - here.z) * probe / space };
  const rocky = rockShare(bot as never, here, end) >= ROCK_SHARE;
  // A walk begun in the water is chosen from land when it goes through rock: gotoSafe brings the body out of the water first and asks again.
  if ((bot.entity as unknown as { isInWater?: boolean }).isInWater) return { mode: 'default', why: rocky ? 'in_water' : 'open_ground' };

  const walk = walkOnlyEstimate(bot, goal);
  const walkable = walk?.status === 'success' ? walk : null;
  // Ground that can be walked is walked, whatever the line looks like. A way that cannot (the search ran out of ground to try) is
  // dug, even for a few blocks; open ground the search could not settle in its think is left to the route search, as before.
  // (Only within PROBE_M: a goal further off than the loaded ground is "no path" to the search for want of ground, not for want of a way.)
  const needsDig = rocky || (walk?.status === 'noPath' && space <= PROBE_M);
  if (!needsDig) {
    if (walkable) return { mode: 'walk', movements: walkable.movements, seconds: walkable.seconds };
    return { mode: 'default', why: 'open_ground' };
  }

  const tunnel = planTunnel(bot, feet, aim, options.avoid);
  const tunnelPlan = tunnel && tunnel.estimate.feasible ? tunnel : null;
  const tunnelWhy = !tunnel ? 'no_plan' : tunnel.estimate.why ?? 'ok';
  if (trail && (!walkable || trail.seconds <= walkable.seconds + 5) && (!tunnelPlan || trail.seconds <= tunnelPlan.seconds)) {
    return { mode: 'cells', cells: trail.cells, seconds: trail.seconds, source: 'trail', digs: 0 };
  }
  if (walkable && (!tunnelPlan || walkable.seconds <= tunnelPlan.seconds + WALK_PREFERENCE_MS / 1000)) return { mode: 'walk', movements: walkable.movements, seconds: walkable.seconds };
  if (tunnelPlan) return { mode: 'cells', cells: tunnelPlan.cells, seconds: tunnelPlan.seconds, source: 'tunnel', digs: tunnelPlan.estimate.digs };
  return { mode: 'default', why: `nothing_fits（地面を歩く道: ${walkable ? 'あり' : 'なし'}、掘る道: ${tunnelWhy}）` };
}
