import { Vec3 } from 'vec3';
import { isDoorlike, isPortalName, NO_ENTER } from './walkRules.js';

/** Three metres to slow down before a turn, work, a drop or the end of a route. */
const LOOK_AHEAD = 3;
const SAMPLE_M = 0.5;
const profiles = new WeakMap<object, ReadonlySet<string>>();
const NO_SPRINT_FLOOR = new Set(['ice', 'packed_ice', 'blue_ice', 'frosted_ice', 'soul_sand', 'honey_block']);
const WET = new Set(['water', 'lava', 'bubble_column', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass']);

/**
 * walk/go sprint on continuous ground. Keep gap jumps within the walking planner's
 * reach (distance 2), even while the executor is allowed to run elsewhere. Otherwise
 * changing pace near a gap leaves a distance 3/4 parkour move it cannot walk.
 * The existing survivable-gap and door rules still check these walking jumps.
 */
export function installGroundSprint(movements: any, blocked: ReadonlySet<string> = new Set()): void {
  if (!movements || profiles.has(movements) || typeof movements.getMoveParkourForward !== 'function') return;
  profiles.set(movements, blocked);
  const parkour = movements.getMoveParkourForward.bind(movements);
  movements.getMoveParkourForward = (node: any, dir: any, neighbors: any[]) => {
    const permitted = movements.allowSprinting;
    movements.allowSprinting = false;
    try { parkour(node, dir, neighbors); }
    finally { movements.allowSprinting = permitted; }
  };
}

function wet(block: any): boolean {
  if (WET.has(String(block?.name))) return true;
  try { const value = block?.getProperties?.()?.waterlogged; return value === true || value === 'true'; }
  catch { return true; }
}

/** Loaded, dry, full support and clear space; an open door still calls for walking. */
function clearColumn(bot: any, x: number, y: number, z: number): boolean {
  try {
    const floor = bot.blockAt(new Vec3(x, y - 1, z), false);
    if (!floor || wet(floor) || NO_ENTER.has(floor.name) || NO_SPRINT_FLOOR.has(floor.name) || isDoorlike(floor.name)) return false;
    if (!floor.shapes?.some((s: number[]) => s[0] === 0 && s[1] === 0 && s[2] === 0 && s[3] === 1 && s[4] === 1 && s[5] === 1)) return false;
    // Include the space a jump would use: the executor tries sprint jumping before walking.
    for (let dy = 0; dy <= 2; dy++) {
      const block = bot.blockAt(new Vec3(x, y + dy, z), false);
      if (!block || wet(block) || NO_ENTER.has(block.name) || isDoorlike(block.name) || isPortalName(block.name) || block.boundingBox === 'block' || block.shapes?.length) return false;
    }
    return true;
  } catch { return false; }
}

/** A one-cell rim on both sides also keeps narrow bridges and wall corners at walking pace. */
function clearRim(bot: any, x: number, y: number, z: number, blocked: ReadonlySet<string>, checked: Set<string>): boolean {
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    const key = `${x + dx},${y},${z + dz}`;
    if (checked.has(key)) continue;
    if (blocked.has(key) || !clearColumn(bot, x + dx, y, z + dz)) return false;
    checked.add(key);
  }
  return true;
}

/** The executor's remaining points (post-processed positions, not their search hashes). */
function openStretch(bot: any, route: any[], blocked: ReadonlySet<string>): boolean {
  const entity = bot.entity, p = entity?.position;
  if (!p || entity.onGround !== true || entity.isInWater || entity.isInLava || entity.isInWeb || entity.isCollidedHorizontally) return false;
  const y = Math.round(p.y);
  if (Math.abs(p.y - y) > 0.01) return false;
  let x = p.x, z = p.z, covered = 0;
  let direction: { x: number; z: number } | null = null;
  // Overlapping rims share reads within this check only; the next tick rereads the world.
  const checked = new Set<string>();
  if (!clearRim(bot, Math.floor(x), y, Math.floor(z), blocked, checked)) return false;
  for (const point of route) {
    if (!point || ![point.x, point.y, point.z].every(Number.isFinite) || Math.abs(point.y - y) > 0.01 || point.parkour || point.toBreak?.length || point.toPlace?.length) return false;
    const dx = point.x - x, dz = point.z - z, length = Math.hypot(dx, dz);
    if (length < 0.01) continue;
    const next = { x: dx / length, z: dz / length };
    if (direction && direction.x * next.x + direction.z * next.z < 0.98) return false;
    // A shove or a turn can leave momentum across the intended line.
    const velocity = entity.velocity, speed = Math.hypot(velocity?.x ?? 0, velocity?.z ?? 0);
    if (!direction && speed > 0.05 && ((velocity.x * next.x + velocity.z * next.z) / speed < 0.98)) return false;
    direction = next;
    const span = Math.min(length, LOOK_AHEAD - covered);
    const steps = Math.ceil(span / SAMPLE_M);
    for (let i = 1; i <= steps; i++) {
      const d = span * i / steps;
      if (!clearRim(bot, Math.floor(x + next.x * d), y, Math.floor(z + next.z * d), blocked, checked)) return false;
    }
    covered += span;
    if (covered >= LOOK_AHEAD) return true;
    x = point.x; z = point.z;
  }
  // The route ends inside the braking distance, including a partial search's endpoint.
  return false;
}

/**
 * One goWith only. Run BEFORE pathfinder's physicsTick handler: it must choose the
 * walking simulation itself, rather than have a sprint jump shortened after takeoff.
 * path_update is synchronous and precedes the executor taking its new route, so also
 * update there, including the very first route. Never reset the path to change pace.
 */
export function watchGroundSprint(bot: any): { route(points: any[]): void; close(): void } {
  const movements = bot.pathfinder?.movements;
  const blocked = movements && profiles.get(movements);
  if (!blocked) return { route() {}, close() {} };
  const permitted = movements.allowSprinting;
  let route: any[] = [], collision: { x: number; z: number } | null = null, closed = false;
  const update = () => {
    if (closed || bot.pathfinder?.movements !== movements) return;
    const p = bot.entity?.position;
    if (p && bot.entity.isCollidedHorizontally) collision = { x: p.x, z: p.z };
    else if (p && collision && Math.hypot(p.x - collision.x, p.z - collision.z) > LOOK_AHEAD + 1) collision = null;
    // Walk until clear of an actual collision, including one the map cannot see.
    // go's avoided cells keep subsequent attempts slow near that blockage too.
    movements.allowSprinting = permitted && !collision && openStretch(bot, route, blocked);
    // A reset with no new path can make the executor return before it writes controls.
    if (!movements.allowSprinting && bot.controlState?.sprint) {
      try { bot.setControlState?.('sprint', false); } catch { /* the action may already be cancelled */ }
    }
  };
  const listening = typeof bot.prependListener === 'function';
  const reset = () => { route = []; update(); };
  if (listening) bot.prependListener('physicsTick', update);
  bot.on?.('path_reset', reset);
  movements.allowSprinting = false; // no route yet; false from the caller is always an upper bound
  return {
    route(points) { route = points; if (listening && !closed) update(); },
    close() {
      if (closed) return;
      closed = true;
      if (listening) bot.removeListener('physicsTick', update);
      bot.removeListener?.('path_reset', reset);
      movements.allowSprinting = permitted;
      if (bot.pathfinder?.movements === movements) {
        try { bot.setControlState?.('sprint', false); } catch { /* cancellation already released the controls */ }
      }
    },
  };
}
