import { Vec3 } from 'vec3';
import { holdsWater } from './waterBlocks.js';

interface RouteWorld { blockAt(position: Vec3): any }

/**
 * How far from the body the search looks, in cells each way, and how many cells it may visit. In a shaft or a
 * tunnel few cells lead a long way (a body carried ten cells up a flooded shaft has its air ten cells down);
 * in open water the count of cells is what ends the search.
 */
const REACH = 16;
const MAX_CELLS = 3000;
const STEPS: Array<[number, number, number]> = [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]];

const passable = (block: any) => !!block && block.boundingBox !== 'block';

/**
 * The way from where the body is to a place it can breathe, as the cells its
 * feet pass through, or null when the water around it leads to no air within
 * reach. A body is two cells tall and does not bend: it goes where both its
 * cells are free, one cell at a time, and it breathes where its head cell
 * holds no water.
 *
 * "Open water nearby" used to be a column, somewhere within four blocks, with
 * air above it and nothing solid at head height. Nothing asked whether the
 * body could get there. Under a stone roof, beside a shelf of shallow water it
 * could not climb onto without the headroom the roof took, a body swam at
 * that column for three seconds and then started on fourteen seconds of stone
 * with four seconds of air (paid run L54 drowned).
 */
export function routeToAir(world: RouteWorld, position: Vec3): Vec3[] | null {
  const start = new Vec3(Math.floor(position.x), Math.floor(position.y + 0.2), Math.floor(position.z));
  const at = (cell: Vec3) => world.blockAt(cell);
  const fits = (feet: Vec3) => passable(at(feet)) && passable(at(feet.offset(0, 1, 0)));
  const breathes = (feet: Vec3) => { const head = at(feet.offset(0, 1, 0)); return passable(head) && !holdsWater(head); };
  if (!passable(at(start))) return null;
  const key = (cell: Vec3) => `${cell.x},${cell.y},${cell.z}`;
  const cameFrom = new Map<string, Vec3 | null>([[key(start), null]]);
  const queue: Vec3[] = [start];
  for (let head = 0; head < queue.length && cameFrom.size <= MAX_CELLS; head++) {
    const cell = queue[head];
    if (breathes(cell)) {
      const route: Vec3[] = [];
      for (let step: Vec3 | null = cell; step && step !== start; step = cameFrom.get(key(step)) ?? null) route.unshift(step.offset(0.5, 0, 0.5));
      return route;
    }
    for (const [dx, dy, dz] of STEPS) {
      const next = cell.offset(dx, dy, dz);
      if (Math.abs(next.x - start.x) > REACH || Math.abs(next.y - start.y) > REACH || Math.abs(next.z - start.z) > REACH) continue;
      if (cameFrom.has(key(next))) continue;
      let free = false;
      try { free = fits(next); } catch { free = false; }
      if (!free) continue;
      cameFrom.set(key(next), cell);
      queue.push(next);
    }
  }
  return null;
}

const cache = new WeakMap<object, { at: number; x: number; y: number; z: number; route: Vec3[] | null }>();
const CACHE_MS = 400;

/** The same search, remembered for a moment while the body stays in its cell (the reflexes ask every tick). */
export function cachedRouteToAir(world: RouteWorld & object, position: Vec3, now = Date.now()): Vec3[] | null {
  const x = Math.floor(position.x), y = Math.floor(position.y + 0.2), z = Math.floor(position.z);
  const held = cache.get(world);
  if (held && now - held.at < CACHE_MS && held.x === x && held.y === y && held.z === z) return held.route;
  let route: Vec3[] | null = null;
  try { route = routeToAir(world, position); } catch { route = null; }
  cache.set(world, { at: now, x, y, z, route });
  return route;
}
