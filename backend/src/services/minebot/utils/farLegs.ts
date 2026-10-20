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
  const rock = space > UNDERGROUND_LEG_M * 1.5 && rockShare(bot, here, probe) >= ROCK_SHARE;
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
  return { goal: new goals.GoalNearXZ(Math.round(via.x), Math.round(via.z), LEG_REACH_M) as unknown as Goal, final: false,
    via: { x: Math.round(via.x), z: Math.round(via.z) }, rock: false };
}

/** MINEBOT_FAR_LEG_M: the leg length (m); 0 plans every walk as one goal (the way before run 20, for a comparison or a rollback). */
export function configuredLegM(env: NodeJS.ProcessEnv = process.env): number {
  const value = env.MINEBOT_FAR_LEG_M;
  const parsed = Number(value);
  return value !== undefined && value !== '' && Number.isFinite(parsed) && parsed >= 0 ? parsed : FAR_LEG_M;
}

/** How many different legs are tried at one place before the walk gives up with the path search's own answer. */
export const LEG_ATTEMPTS = TURNS.length;
