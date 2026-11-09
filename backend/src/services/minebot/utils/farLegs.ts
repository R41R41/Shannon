/**
 * Long walks are planned a leg at a time.
 *
 * The path search (mineflayer-pathfinder's A*) is given a goal and searches the loaded ground for it. A goal 400 m
 * away across chunks that are not loaded (or are still arriving) leaves it exploring every cell it can reach in the
 * loaded ring, again and again, since each new chunk beside the search throws the search away ('chunk_loaded'). In
 * run 20 a 400 m walk begun right after a respawn was followed by 69.7 s without a line in the body's journal and a
 * dropped connection. A walk of more than FAR_LEG_M is therefore made of legs: an intermediate point on the straight
 * line, no further than ground that is loaded, reached as a goal of its own; the real goal is only the last leg.
 *
 * Through rock the legs are shorter (UNDERGROUND_LEG_M) and keep the height of the line. The search prices a block dug
 * at several steps but measures what is left by the straight line, so toward a goal 30 m off through solid rock it tries
 * every cave and tunnel it can reach before it digs (run 20, y -58: four moves of 17-110 s toward places 30-100 m off, "no path"
 * or out of time after 1 m in 2-8 s, the search timing out again at each re-plan). A goal 20 m off has little to try.
 */
import pathfinder from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import type { Goal } from '../types/CustomBot.js';
const { goals } = pathfinder;

/** Legs over open ground are this long (m, horizontally); a walk shorter than 1.5 legs is one leg. */
export const FAR_LEG_M = 64;
/** Legs through rock are this long (m, in a straight line); the last may be 1.5 of them. */
export const UNDERGROUND_LEG_M = 20;
/** The line is rock when at least this share of the cells along it need digging. */
const ROCK_SHARE = 0.4;
/** An intermediate point counts as reached within this many blocks over open ground, and through rock. */
export const LEG_REACH_M = 6;
export const UNDERGROUND_REACH_M = 2;
/** Legs over open ground are never shorter than this (m) unless the goal is closer. */
const MIN_LEG_M = 24;
/** The leg's point is looked for in steps of this many metres back from the full leg. */
const LEG_STEP_M = 8;
/**
 * end1108c S9 (11/8, 20:03 to 20:18): the head walked 100 to 150 m waypoints at the height it stood at (y 69) over hills; the first 20 m
 * of each line ran into a hill, so the legs went through rock at y 69 and each go dug 105 to 192 cells (about 25 m a minute, the pack full
 * of cobblestone). A body under the open sky walking to a place not well below it walks over the ground: the rock legs are for a body
 * already under the ground, or a place well below it. The sky is read this many cells up from the head; leaves do not count.
 */
const SKY_SCAN = 24;
/** A place more than this far below a body on the surface is under the ground (a stronghold, a cave): the rock legs still go to it. */
const SURFACE_DROP = 8;
/**
 * end1108f S9 (11/8, 22:09 to 22:33): on a 1,300 m walk to the portal crossing an open-ground leg (a goal about x and z only) let the path
 * search end in a ravine 60 m down; under the ground the rock legs then kept the line's height (the crossing about 90 m up and 600 m off:
 * 3 m a leg), so she went on at y -25 to -51 for 600 m, dug hundreds of blocks into the pack, met the cave's mobs and died. In the
 * overworld a body under the ground walking far to a place not well below it climbs back up first: each leg goes CLIMB_LEG_M on and up
 * to CLIMB_M towards the surface over the leg's point. Open-ground legs name the surface's height at their point, so a leg is not reached
 * at the bottom of a ravine.
 */
const CLIMB_LEG_M = 16;
const CLIMB_M = 8;
/** The surface is looked for from this height down (the overworld's top) to the world's bottom. */
const SURFACE_TOP = 319;
const WORLD_BOTTOM = -64;
/** Solid blocks a body does not stand on top of as the ground (a tree; leaves are passed by name). */
const NOT_GROUND = /(_log|_wood|_stem|_hyphae|leaves|bamboo|cactus)$/;
/** Turns (radians) tried, in order, when the straight line's point is no good (water, a wall, nothing loaded). */
const TURNS = [0, 0.6, -0.6, 1.2, -1.2];

export interface GoalTarget { x: number; z: number; y: number | null }

/** The ground position a goal is about, when it is about one (the goals that name x and z). */
export function goalTarget(goal: Goal): GoalTarget | null {
  const g = goal as unknown as Record<string, unknown>;
  const name = (goal as object).constructor?.name ?? '';
  if (!['GoalNear', 'GoalNearXZ', 'GoalXZ', 'GoalBlock', 'GoalGetToBlock', 'GoalReachBlock'].includes(name)) return null;
  if (typeof g.x !== 'number' || typeof g.z !== 'number' || !Number.isFinite(g.x) || !Number.isFinite(g.z)) return null;
  return { x: g.x, z: g.z, y: typeof g.y === 'number' && Number.isFinite(g.y) ? g.y : null };
}

export interface LegBot {
  entity: { position: { x: number; y: number; z: number } };
  blockAt(position: Vec3, extraInfos?: boolean): { name?: string; boundingBox?: string } | null;
  game?: { dimension?: string };
}

/** Whether the body is in the overworld (the surface and the climbing legs are only about it; the Nether has a roof). */
function inOverworld(bot: LegBot): boolean {
  return !/nether|the_end/.test(String(bot.game?.dimension ?? ''));
}

/**
 * The height a body stands at on the top of the column (x, z): one over its highest solid block, or over water or lava; trees are passed.
 * Null when the column is not loaded or nothing in it is ground.
 */
export function surfaceY(bot: LegBot, x: number, z: number): number | null {
  const fx = Math.floor(x), fz = Math.floor(z);
  for (let y = SURFACE_TOP; y >= WORLD_BOTTOM; y--) {
    let block: { name?: string; boundingBox?: string } | null = null;
    try { block = bot.blockAt(new Vec3(fx, y, fz), false); } catch { return null; }
    if (!block) return null;
    const name = String(block.name ?? '');
    if (name === 'water' || name === 'lava') return y + 1;
    if (block.boundingBox === 'block' && !NOT_GROUND.test(name)) return y + 1;
  }
  return null;
}

export interface Leg {
  /** The goal to walk to now. */
  goal: Goal;
  /** True when it is the caller's goal itself. */
  final: boolean;
  /** Where the intermediate point is, for the log. */
  via: { x: number; y?: number; z: number } | null;
  /** True when the leg goes through rock (shorter, keeps the height). */
  rock: boolean;
}

/** Whether the column at (x, z) is loaded: some block is known at the body's height or at either end of the world's height. */
function loaded(bot: LegBot, x: number, z: number): boolean {
  const y = Math.floor(bot.entity.position.y);
  for (const dy of [0, 1, -1, 20, -20]) {
    try { if (bot.blockAt(new Vec3(Math.floor(x), y + dy, Math.floor(z)), false)) return true; } catch { /* unloaded */ }
  }
  return false;
}

/** Whether nothing solid but leaves is over the body's head for SKY_SCAN cells (cells not loaded, or past the world's top, are open). */
export function underSky(bot: LegBot): boolean {
  const p = bot.entity.position;
  const x = Math.floor(p.x), z = Math.floor(p.z), head = Math.floor(p.y) + 1;
  for (let y = head + 1; y <= head + SKY_SCAN; y++) {
    let block: { name?: string; boundingBox?: string } | null = null;
    try { block = bot.blockAt(new Vec3(x, y, z), false); } catch { block = null; }
    if (!block) return true;
    if (block.boundingBox === 'block' && !String(block.name ?? '').endsWith('leaves')) return false;
  }
  return true;
}

/**
 * The share of the cells along a straight line (a body fills two: feet and head) that have to be dug. Cells whose chunk is not loaded
 * are not counted as rock (nothing is known of them).
 */
export function rockShare(bot: LegBot, from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }): number {
  const length = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
  const steps = Math.max(1, Math.ceil(length));
  let rock = 0;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const x = Math.floor(from.x + (to.x - from.x) * t), y = Math.floor(from.y + (to.y - from.y) * t), z = Math.floor(from.z + (to.z - from.z) * t);
    let dug = false;
    for (const dy of [0, 1]) {
      try { if (bot.blockAt(new Vec3(x, y + dy, z), false)?.boundingBox === 'block') dug = true; } catch { /* unloaded */ }
    }
    if (dug) rock++;
  }
  return rock / steps;
}

/**
 * The goal for the next leg of a walk to `goal`. The caller's own goal when it is near (or not about a ground position);
 * otherwise a goal on the straight line towards it, `attempt` turns away from the line (0 first). Over open ground the point is on
 * loaded ground and only the line's ground position counts; through rock it is 20 m on and keeps the line's height.
 */
export function nextLeg(bot: LegBot, goal: Goal, attempt = 0, legM = FAR_LEG_M): Leg {
  const target = legM > 0 ? goalTarget(goal) : null;
  if (!target) return { goal, final: true, via: null, rock: false };
  const here = bot.entity.position;
  const dx = target.x - here.x, dz = target.z - here.z;
  const flat = Math.hypot(dx, dz);
  const dy = target.y === null ? 0 : target.y - here.y;
  const space = Math.hypot(flat, dy);
  const turn = TURNS[Math.min(attempt, TURNS.length - 1)];
  const heading = Math.atan2(dz, dx) + turn;

  // Through rock: the first stretch of the line is mostly to be dug.
  const probeLength = Math.min(UNDERGROUND_LEG_M, space);
  const probe = { x: here.x + dx * (probeLength / space), y: here.y + dy * (probeLength / space), z: here.z + dz * (probeLength / space) };
  const sky = underSky(bot);
  const overworld = inOverworld(bot);
  // Under the ground, far from a place not well below: up towards the surface first (end1108f S9).
  if (overworld && !sky && flat > legM * 1.5 && dy >= -SURFACE_DROP) {
    const point = { x: here.x + Math.cos(heading) * CLIMB_LEG_M, z: here.z + Math.sin(heading) * CLIMB_LEG_M };
    const top = surfaceY(bot, point.x, point.z) ?? (target.y ?? here.y + CLIMB_M);
    const y = here.y + Math.max(-2, Math.min(CLIMB_M, top - here.y));
    const via = { x: Math.round(point.x), y: Math.round(y), z: Math.round(point.z) };
    return { goal: new goals.GoalNear(via.x, via.y, via.z, UNDERGROUND_REACH_M) as unknown as Goal, final: false, via, rock: true };
  }
  const overGround = dy >= -SURFACE_DROP && sky;
  const rock = space > UNDERGROUND_LEG_M * 1.5 && !overGround && rockShare(bot, here, probe) >= ROCK_SHARE;
  if (rock) {
    // The point is on the line itself, turned by the attempt (in the level, as the height is the line's).
    const fraction = UNDERGROUND_LEG_M / space;
    const point = { x: here.x + Math.cos(heading) * flat * fraction, y: here.y + dy * fraction, z: here.z + Math.sin(heading) * flat * fraction };
    const via = { x: Math.round(point.x), y: Math.round(point.y), z: Math.round(point.z) };
    return { goal: (target.y === null ? new goals.GoalNearXZ(via.x, via.z, UNDERGROUND_REACH_M) : new goals.GoalNear(via.x, via.y, via.z, UNDERGROUND_REACH_M)) as unknown as Goal,
      final: false, via, rock: true };
  }

  if (flat <= legM * 1.5) return { goal, final: true, via: null, rock: false };
  const pointAt = (length: number) => ({ x: here.x + Math.cos(heading) * length, z: here.z + Math.sin(heading) * length });
  let via = pointAt(MIN_LEG_M);
  for (let length = legM; length >= MIN_LEG_M; length -= LEG_STEP_M) {
    const point = pointAt(length);
    if (loaded(bot, point.x, point.z)) { via = point; break; }
  }
  const vx = Math.round(via.x), vz = Math.round(via.z);
  // In the overworld the leg is the ground at its point, not anywhere under it (a ravine's bottom is not on the way: end1108f S9).
  const ground = overworld ? surfaceY(bot, vx, vz) : null;
  if (ground !== null) {
    return { goal: new goals.GoalNear(vx, ground, vz, LEG_REACH_M) as unknown as Goal, final: false, via: { x: vx, y: ground, z: vz }, rock: false };
  }
  return { goal: new goals.GoalNearXZ(vx, vz, LEG_REACH_M) as unknown as Goal, final: false, via: { x: vx, z: vz }, rock: false };
}

/** MINEBOT_FAR_LEG_M: the leg length (m); 0 plans every walk as one goal (the way before run 20, for a comparison or a rollback). */
export function configuredLegM(env: NodeJS.ProcessEnv = process.env): number {
  const value = env.MINEBOT_FAR_LEG_M;
  const parsed = Number(value);
  return value !== undefined && value !== '' && Number.isFinite(parsed) && parsed >= 0 ? parsed : FAR_LEG_M;
}

/** How many different legs are tried at one place before the walk gives up with the path search's own answer. */
export const LEG_ATTEMPTS = TURNS.length;

/** How far off (flat) a buried place must be before a long walk takes the ground over it instead, and how deep it may lie. */
export const BURIED_FAR_M = 24;
// end1109s02 S9: legs at y=70 lay under a mountain whose ground was y=123 (53 down). With 48 they stayed in the rock and the walk tunnelled
// for 6 minutes (limit_dig 13, a night slept in the stone). The walk to a far place goes over the ground however high it is.
const BURIED_DEPTH_MAX = 160;
/**
 * end1108g S9 (11/8): the head gave every leg of a 1.3 km walk at y=62, and in the hills the place was inside the rock: the walk tunnelled
 * to it (one go: 171 dug for 161 steps, 0.35 m/s). In the overworld a place more than BURIED_FAR_M off whose feet or head cell is solid is
 * walked to on the ground over it: the height of that ground, or null (near, not loaded, open, or deeper than BURIED_DEPTH_MAX).
 */
export function buriedSurface(bot: LegBot, cell: { x: number; y: number; z: number }, nearM = BURIED_FAR_M, depthMax = BURIED_DEPTH_MAX): number | null {
  if (!inOverworld(bot)) return null;
  const here = bot.entity.position;
  if (Math.hypot(cell.x + 0.5 - here.x, cell.z + 0.5 - here.z) <= nearM) return null;
  let solid = false;
  for (const dy of [0, 1]) {
    let block: { boundingBox?: string } | null = null;
    try { block = bot.blockAt(new Vec3(cell.x, cell.y + dy, cell.z), false); } catch { return null; }
    if (!block) return null;
    if (block.boundingBox === 'block') solid = true;
  }
  if (!solid) return null;
  const ground = surfaceY(bot, cell.x, cell.z);
  return ground !== null && ground > cell.y && ground - cell.y <= depthMax ? ground : null;
}

/** A far place this many cells or more over the ground under it is in the air (a step or two down is a ledge the walk takes as it is). */
const AIR_DROP_MIN = 4;
/**
 * end1109s02 S9: the body climbed out of a mountain to its top (y 120) and the head gave the next place 196 m off at that height, where the
 * ground was y 89. The walk kept the height and laid a bridge one block wide 30 over the valley (29 placed, a zombie beside it). In the
 * overworld a place more than BURIED_FAR_M off whose feet, head and floor cells are all open, with the ground AIR_DROP_MIN or more below,
 * is walked to on that ground: its height, or null (near, not loaded, not in the air, or no ground in the column).
 */
export function airborneGround(bot: LegBot, cell: { x: number; y: number; z: number }, nearM = BURIED_FAR_M): number | null {
  if (!inOverworld(bot)) return null;
  const here = bot.entity.position;
  if (Math.hypot(cell.x + 0.5 - here.x, cell.z + 0.5 - here.z) <= nearM) return null;
  for (const dy of [-1, 0, 1]) {
    let block: { boundingBox?: string } | null = null;
    try { block = bot.blockAt(new Vec3(cell.x, cell.y + dy, cell.z), false); } catch { return null; }
    if (!block || block.boundingBox === 'block') return null;
  }
  const ground = surfaceY(bot, cell.x, cell.z);
  return ground !== null && cell.y - ground >= AIR_DROP_MIN ? ground : null;
}
