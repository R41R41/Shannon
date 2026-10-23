import { Vec3 } from 'vec3';

/**
 * What the planner needs to say of a hostile: does it see the body (a line from its eyes), is there a walkable way for it, how far
 * above or below it is, and does it shoot (mb-llmc-cand 5, run 37: "見える（射線の中）／見えない・道はある／壁の向こうで届かない").
 * Facts only; the body does not decide what to do about them. Bounded: a cell budget and a time budget per mob, a count and a time
 * budget per frame, and an answer kept for a moment.
 */

/** Kinds that hurt from a distance (arrows, fireballs, potions, bolts, wind charges, spit). Others come to the body to hurt it. */
export const SHOOTER_KINDS = new Set(['skeleton', 'stray', 'bogged', 'blaze', 'ghast', 'pillager', 'witch', 'breeze', 'shulker', 'wither', 'ender_dragon']);
/** Kinds that fly or hover: a walkable way is not what limits them, an open way through the air is. */
export const FLYING_KINDS = new Set(['blaze', 'ghast', 'phantom', 'vex', 'bat', 'allay', 'breeze', 'wither', 'ender_dragon', 'parrot', 'bee']);

export type PathToMe = 'yes' | 'no' | 'unknown';

/** The farthest a hostile is judged. */
export const REACH_RANGE = 24;
/** At most this many hostiles (the nearest) are judged in one frame. */
export const REACH_MAX_MOBS = 8;
const CELL_BUDGET = 2500;
const MOB_BUDGET_MS = 6;
const FRAME_BUDGET_MS = 24;
const CACHE_MS = 1500;
const CLOCK_EVERY = 32;
const MAX_STEP_DOWN = 3;

interface ReachBot { blockAt?(position: Vec3, extraInfos?: boolean): { boundingBox?: string; name?: string } | null }
interface ReachMob { position?: unknown; height?: number }

const cache = new WeakMap<object, { at: number; target: string; value: PathToMe }>();

/**
 * Whether a mob walking on the ground could get from where it stands to a cell beside the body: a breadth-first search over standable
 * cells (solid floor, room for its height), one step up or up to three down, four ways. A closed door or a gap in a fence is solid here.
 * 'unknown' when the budget ran out or a cell was not loaded around the start (the way is never denied on a guess).
 */
export function walkableWayTo(bot: ReachBot, mobPosition: Vec3, mobHeight: number, bodyFeet: Vec3, budgetMs = MOB_BUDGET_MS): PathToMe {
  if (typeof bot.blockAt !== 'function') return 'unknown';
  const need = Math.min(3, Math.max(1, Math.ceil(mobHeight - 0.01)));
  const read = new Map<string, 'solid' | 'free' | 'unloaded'>();
  const cellKind = (x: number, y: number, z: number): 'solid' | 'free' | 'unloaded' => {
    const id = `${x},${y},${z}`;
    let value = read.get(id);
    if (value === undefined) {
      const block = bot.blockAt!(new Vec3(x, y, z), false);
      value = !block ? 'unloaded' : block.boundingBox === 'block' ? 'solid' : 'free';
      read.set(id, value);
    }
    return value;
  };
  const roomAt = (x: number, y: number, z: number) => { for (let i = 0; i < need; i++) if (cellKind(x, y + i, z) !== 'free') return false; return true; };
  const standable = (x: number, y: number, z: number) => roomAt(x, y, z) && cellKind(x, y - 1, z) === 'solid';
  const start = mobPosition.floored();
  const goal = bodyFeet.floored();
  const nearGoal = (x: number, y: number, z: number) => Math.abs(x - goal.x) <= 1 && Math.abs(z - goal.z) <= 1 && y >= goal.y - 1 && y <= goal.y + 1;
  // A mob in the air (falling, or flying low) is taken to land where the floor is: the cells under it down to the first floor.
  let sy = start.y;
  for (let i = 0; i <= MAX_STEP_DOWN + 2 && cellKind(start.x, sy - 1, start.z) === 'free'; i++) sy--;
  if (!roomAt(start.x, sy, start.z) && !standable(start.x, sy, start.z)) return cellKind(start.x, sy, start.z) === 'unloaded' ? 'unknown' : 'no';
  const radius = Math.ceil(Math.hypot(start.x - goal.x, start.z - goal.z)) + 8;
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
  const seen = new Set<string>([key(start.x, sy, start.z)]);
  const queue: number[][] = [[start.x, sy, start.z]];
  const startedAt = performance.now();
  for (let head = 0; head < queue.length; head++) {
    if (seen.size > CELL_BUDGET) return 'unknown';
    if (head % CLOCK_EVERY === CLOCK_EVERY - 1 && performance.now() - startedAt > budgetMs) return 'unknown';
    const [x, y, z] = queue[head];
    if (nearGoal(x, y, z)) return 'yes';
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx, nz = z + dz;
      if (Math.abs(nx - goal.x) > radius || Math.abs(nz - goal.z) > radius) continue;
      // Level, one up (head room over the cell it leaves), or down up to three.
      const options = [y, y + 1, y - 1, y - 2, y - MAX_STEP_DOWN];
      for (const ny of options) {
        if (ny === y + 1 && cellKind(x, y + need, z) !== 'free') continue;
        const id = key(nx, ny, nz);
        if (seen.has(id)) continue;
        if (!standable(nx, ny, nz)) continue;
        // Going down: the cells it steps through must be open down to where it lands.
        if (ny < y && ![...Array(y - ny).keys()].every(i => roomAt(nx, y - i, nz))) continue;
        seen.add(id);
        queue.push([nx, ny, nz]);
        break;
      }
    }
  }
  return 'no';
}

/** Said of a hostile: the facts the planner turns into "in the line of fire / not seen but a way / walled off". */
export interface ThreatReach {
  /** Metres above (positive) or below (negative) the body's feet, to 0.1. */
  dy: number;
  /** Whether this kind hurts from a distance. */
  shooter: boolean;
  /** Whether a mob of this kind can get to the body: 'yes' (a walkable way, or for a flyer an open way through the air), 'no', 'unknown' (budget). */
  pathToMe: PathToMe;
}

export interface ThreatReachRequest {
  bot: ReachBot & { entity?: { position: Vec3 } };
  entity: ReachMob & { id?: number; name?: string };
  kind: string;
  /** The air-connectivity answer of threatExposure ('sealed' says no open way through the air either), when known. */
  exposure: 'seen' | 'reachable' | 'sealed' | null;
  /** Remaining frame time in ms (shared across mobs); the caller spends it down by the returned `spentMs`. */
  budgetMs: number;
  now?: number;
}

/** The new facts for one hostile, and the time spent. */
export function threatReachOf(request: ThreatReachRequest): { reach: ThreatReach | null; spentMs: number } {
  const { bot, entity, kind, exposure } = request;
  const self = bot.entity?.position;
  const position = entity.position as Vec3 | undefined;
  if (!self || !position || typeof position.floored !== 'function' || typeof self.floored !== 'function') return { reach: null, spentMs: 0 };
  const dy = Math.round((position.y - self.y) * 10) / 10;
  const shooter = SHOOTER_KINDS.has(kind) || SHOOTER_KINDS.has(String(entity.name ?? ''));
  const name = String(entity.name ?? kind);
  const flies = FLYING_KINDS.has(name);
  const startedAt = performance.now();
  let pathToMe: PathToMe;
  if (flies) pathToMe = exposure === 'sealed' ? 'no' : 'yes';
  else if (exposure === 'sealed') pathToMe = 'no';
  else {
    const now = request.now ?? Date.now();
    const target = `${Math.floor(self.x)},${Math.floor(self.y)},${Math.floor(self.z)}`;
    const cached = cache.get(entity as object);
    if (cached && cached.target === target && now - cached.at < CACHE_MS) pathToMe = cached.value;
    else if (request.budgetMs <= 0) pathToMe = cached && cached.target === target ? cached.value : 'unknown';
    else {
      pathToMe = walkableWayTo(bot, position, entity.height ?? 1.8, self, Math.min(MOB_BUDGET_MS, request.budgetMs));
      cache.set(entity as object, { at: now, target, value: pathToMe });
    }
  }
  return { reach: { dy, shooter, pathToMe }, spentMs: performance.now() - startedAt };
}

export const reachBudgets = { frameMs: FRAME_BUDGET_MS };
