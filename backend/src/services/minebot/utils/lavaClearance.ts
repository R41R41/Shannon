import { Vec3 } from 'vec3';

/**
 * Path cost of a step into a cell with lava beside it.
 *
 * The route planner keeps the body out of lava cells and nothing more: a route ran along a lava fall with the
 * flow in the next cell, a corner of the turn brushed it, and in the Nether, where no water can be poured,
 * the fire that follows two seconds in lava is the end of the body (paid run L77b, twelve minutes after it had
 * entered the Nether). A person gives lava room in proportion to what touching it costs. A cost, not a ban:
 * a shore of the lava sea is sometimes the only way, and then it is walked.
 */
export const LAVA_BESIDE_COST = 8;
const NEIGHBOURS: Array<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const CACHE_MS = 2000;

interface ClearanceBot {
  registry?: { blocksByName?: Record<string, { minStateId?: number; maxStateId?: number } | undefined> };
  world?: { getBlockStateId?(position: Vec3): number };
}

/** Whether lava lies in any of the eight cells around (x, y, z) at that level or the one above (where the head is). */
export function lavaBeside(bot: ClearanceBot, x: number, y: number, z: number): boolean {
  const lava = bot.registry?.blocksByName?.lava;
  const read = bot.world?.getBlockStateId;
  if (lava?.minStateId === undefined || lava.maxStateId === undefined || typeof read !== 'function') return false;
  const at = new Vec3(0, 0, 0);
  for (const dy of [0, 1]) {
    for (const [dx, dz] of NEIGHBOURS) {
      at.x = x + dx; at.y = y + dy; at.z = z + dz;
      let state = -1;
      try { state = read.call(bot.world, at); } catch { state = -1; }
      if (state >= lava.minStateId && state <= lava.maxStateId) return true;
    }
  }
  return false;
}

/** For the navigator. Answers are kept for two seconds: a search asks about the same cells many times over, and lava moves slowly. */
export function lavaBesideStepCost(bot: ClearanceBot): (block: { position?: { x: number; y: number; z: number } }) => number {
  const cache = new Map<string, number>();
  let cachedAt = 0;
  return block => {
    const p = block?.position;
    if (!p) return 0;
    const now = Date.now();
    if (now - cachedAt > CACHE_MS) { cache.clear(); cachedAt = now; }
    const key = `${p.x},${p.y},${p.z}`;
    let cost = cache.get(key);
    if (cost === undefined) { cost = lavaBeside(bot, p.x, p.y, p.z) ? LAVA_BESIDE_COST : 0; cache.set(key, cost); }
    return cost;
  };
}
