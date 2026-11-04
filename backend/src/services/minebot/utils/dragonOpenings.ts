import { Vec3 } from 'vec3';
import { aimPitch, arrowBlockedAt, CRYSTAL_SHOT_MAX } from './primitives/shoot.js';
import { CRYSTAL_SAFE_SHOT } from './crystalBlast.js';
import { feetCentre, inland, walkGround } from './dragonWalk.js';
import { endDragonOf, dragonPhaseOf, type CrystalView } from './dragonState.js';
import { isPerched, type P3 } from './dragonParts.js';
import { cloudReaches, lyingCloudZones } from './dragonDanger.js';
import { perchClearance } from './dragonApproach.js';

/** Ideas learned from mine-ai-mcp (MIT, aibengineering, https://github.com/aibengineering/mine-ai-mcp):
 * bound terrain/trajectory work and report route hints separately from executing a shot. Written for Shannon; no copied code. */
export interface ShotOpening extends P3 { distance: number; pitchDeg: number; flightTicks: number }
export interface ShotBlock extends P3 { name: string }
export interface CrystalOpenings {
  id: number; caged: boolean | null; positions: ShotOpening[]; blockedBy?: ShotBlock;
  /** Hypothetical only: removing this crystal's bars does not remove the pillar or other obstacles. */
  afterCageRemoved?: ShotOpening[];
}
export interface CrystalShooting {
  openings: CrystalOpenings[];
  shootSets: Array<{ at: P3; crystals: number[]; walkMeters: number }>;
  stats: { ms: number; examinedCells: number; gridStep: number; truncated: boolean };
}
export const OPENINGS_CACHE_MS = 1500;
export const OPENINGS_BUDGET_MS = 30;
const kept = new WeakMap<object, { at: P3; time: number; count: number; value: CrystalShooting; grid: number }>();
export function clearCrystalOpenings(bot: object): void { kept.delete(bot); }

/** A read-only adapter for the existing shot check: unread cells obstruct; only this cage's iron bars may be imagined removed.
 * Do not inherit the real world's state-id cache: that would bypass the hypothetical blockAt. */
function shotWorld(read: (p: Vec3) => any, crystal: CrystalView, removeBars: boolean): any {
  return { blockAt: (p: Vec3) => {
    const b = read(p);
    if (!b) return { name: 'unloaded', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] };
    if (removeBars && b.name === 'iron_bars' && Math.abs(p.x - Math.floor(crystal.x)) <= 2 &&
      Math.abs(p.z - Math.floor(crystal.z)) <= 2 && p.y >= Math.floor(crystal.y) && p.y <= Math.floor(crystal.y) + 3) {
      return { name: 'air', boundingBox: 'empty', shapes: [] };
    }
    return b;
  } };
}

/** Cache is held at least 1.5 s; time alone never starts a rescan. Callers recheck terrain and shot safety when acting. */
export function crystalOpenings(bot: any, crystals: readonly CrystalView[], now = Date.now(), clock = () => performance.now()): CrystalShooting {
  const at = bot.entity?.position;
  const old = kept.get(bot);
  if (old && (now - old.time < OPENINGS_CACHE_MS ||
    (crystals.length === old.count && at && Math.hypot(at.x - old.at.x, at.y - old.at.y, at.z - old.at.z) < 3))) return old.value;
  const started = clock(), deadline = started + OPENINGS_BUDGET_MS;
  // Reserve most of the budget for the comparatively costly aimPitch / arrowBlockedAt calls.
  const clouds = lyingCloudZones(bot);
  const dragon = endDragonOf(bot), clearPerch = dragon && isPerched(dragonPhaseOf(bot, dragon)) ? perchClearance(bot, dragon) : null;
  const ground = walkGround(bot, { deadline: crystals.length ? started + 10 : started, clock,
    safe: p => (!clearPerch || clearPerch(p)) && !clouds.some(z => cloudReaches(z.centre, z.radius, p, 0.5)) });
  let grid = old?.grid ?? 2, truncated = ground.truncated;
  const openings = crystals.slice(0, 10).map(c => ({ id: c.id, caged: c.caged, positions: [],
    ...(c.caged === true ? { afterCageRemoved: [] } : {}) } as CrystalOpenings));
  const sets: CrystalShooting['shootSets'] = [];
  const shotCells = new Map<string, any>();
  const readShot = (p: Vec3) => {
    const key = `${p.x},${p.y},${p.z}`;
    if (!shotCells.has(key)) shotCells.set(key, bot.blockAt(p));
    return shotCells.get(key);
  };
  const worlds = crystals.slice(0, 10).map(c => ({ live: shotWorld(readShot, c, false), removed: shotWorld(readShot, c, true) }));
  // BFS distances are walk distances; order positions by distance from the present body, independent of crystal distance.
  const candidates = ground.cells.sort((a, b) => {
    const p = feetCentre(a.cell), q = feetCentre(b.cell);
    return Math.hypot(p.x - at.x, p.y - at.y, p.z - at.z) - Math.hypot(q.x - at.x, q.y - at.y, q.z - at.z);
  });
  outer: for (const node of candidates) {
    if (clock() >= deadline) { truncated = true; break; }
    if (clock() - started > 20) grid = Math.max(grid, 4);
    const p = node.cell;
    if ((p.x % grid !== 0 || p.z % grid !== 0) && node.parent) continue;
    if (!inland(ground.read, p)) continue;
    const feet = feetCentre(p), eyes = new Vec3(feet.x, feet.y + 1.52, feet.z), shootable: number[] = [];
    for (let i = 0; i < openings.length; i++) {
      if (clock() >= deadline) { truncated = true; break outer; }
      const c = crystals[i], entry = openings[i];
      const distance = Math.hypot(c.x - feet.x, c.y - feet.y, c.z - feet.z);
      if (distance < CRYSTAL_SAFE_SHOT || distance > CRYSTAL_SHOT_MAX) continue;
      const goal = new Vec3(c.x, c.y + 1, c.z);
      const aim = aimPitch(3, Math.hypot(goal.x - eyes.x, goal.z - eyes.z), goal.y - eyes.y);
      if (!aim) continue;
      const yaw = Math.atan2(-(goal.x - eyes.x), -(goal.z - eyes.z));
      const blocked = arrowBlockedAt(worlds[i].live, eyes, yaw, aim.pitch, 3, aim.ticks + 2, goal);
      const shot = { ...feet, distance, pitchDeg: aim.pitch * 180 / Math.PI, flightTicks: aim.ticks };
      if (!blocked && c.caged !== true) {
        if (entry.positions.length < 3) entry.positions.push(shot);
        shootable.push(c.id);
      } else if (c.caged === true) {
        if (blocked?.name === 'iron_bars' && !entry.blockedBy) entry.blockedBy = blocked;
        if (entry.afterCageRemoved!.length < 3 && !arrowBlockedAt(worlds[i].removed, eyes, yaw, aim.pitch, 3, aim.ticks + 2, goal)) {
          entry.afterCageRemoved!.push(shot);
        }
      }
    }
    if (shootable.length >= 2) sets.push({ at: feet, crystals: shootable, walkMeters: node.walkMeters });
    if (openings.every(e => (e.caged === true ? e.afterCageRemoved!.length : e.positions.length) >= 3) &&
      (sets.length >= 3 || crystals.filter(c => c.caged !== true).length < 2)) break;
  }
  const value = { openings, shootSets: sets.sort((a, b) => a.walkMeters - b.walkMeters).slice(0, 3),
    stats: { ms: clock() - started, examinedCells: ground.examinedCells + shotCells.size, gridStep: grid, truncated } };
  if (at) kept.set(bot, { at: { x: at.x, y: at.y, z: at.z }, time: now, count: crystals.length, value,
    grid: value.stats.ms >= OPENINGS_BUDGET_MS ? Math.min(8, grid * 2) : grid });
  return value;
}
