import { Vec3 } from 'vec3';
import { isAngry } from './hostileMobHints.js';
import { BUILDING_BLOCKS } from '../instantSkills/buildAroundSelf.js';
import { isOpenBlock, type BlockReader, type MapBlock } from './localMap.js';
import { solidBetween } from './probeTools.js';

/**
 * Fighting an enderman from a hole it cannot enter (S2, 2026-11-02).
 *
 * The method is aibengineering/mine-ai-mcp's (MIT: src/survival/combat/fight/enderman.ts, src/survival/positioning/combat/planner.ts `endermanRoof` and
 * `requiredEndermanRoof`, src/survival/weapons/aim.ts, src/survival/guards/enderman-gaze.ts), written afresh for this body:
 *  - An enderman is 2.9 tall. Where the space is two blocks high it cannot stand, so a body in a cell with a roof over it and over the eight cells round it
 *    (the 3x3 at feet+2) cannot be reached: the nearest an enderman can stand is the column two blocks off, whose centre is 1.8 from the body's, beyond the
 *    1.43 a blow of its reaches (a mob's attack box is its own, widened by 0.83 each way, against the body's 0.6).
 *  - It is angered by being looked in the eye: the dot of the look and the line to its eyes (2.55 above its feet) above 1 - 0.025 / distance, with the line
 *    clear. The body's own gaze guard (utils/gazeGuard) turns the look off that cone every tick; this hand suspends it while it stares.
 *  - Staring freezes an angry enderman within 16m and can teleport it away within 4m. After a short stare the body aims at its legs.
 *  - A hit by a creature does not make it teleport (a projectile does: a bow is no tool for it).
 *
 * This file holds the plan of the roof (pure: the blocks it needs, in the order they can be laid, each against one already standing), the choice of block, and
 * the readings; the live part is `EndermanCamp` (further down).
 */

export const ENDERMAN_EYE = 2.55;
/** The enderman's body is this tall: where fewer than three cells are free over a floor it cannot stand. */
export const ENDERMAN_HEIGHT = 2.9;
/** Aim below the roof after provoking; the eyes are deliberately not required for a blow. */
export const ENDERMAN_FEET = 1.0;
/** The lower legs, rather than 60% of height (or even 1m, which nearly grazes the eye cone at 48m). */
export const ENDERMAN_LEGS = 0.5;
export const ROOF_CENTRE_TOLERANCE = 0.2;
export const ENDERMAN_STARE_MS = 500;
const HAND_REACH = 4.4;

export type Cell3 = { x: number; y: number; z: number };
export interface RoofWorld {
  /** Whether the cell holds a full block (a collision box that stops a body); null when it is not loaded. */
  solid(x: number, y: number, z: number): boolean | null;
  /** Whether a block can be put into the cell (air, grass and the like; not a fluid). */
  replaceable(x: number, y: number, z: number): boolean;
}
export interface RoofPlan {
  /** The cell the body stands in (its feet). */
  cell: Cell3;
  /** The blocks to lay, in order, each against one standing (or laid before it): floor fills first, then the support column, then the roof. */
  placements: Cell3[];
  /** Temporary supports only (never existing terrain, floor fills or roof caps). Remove these after the caps stand. */
  supports: Cell3[];
  /** How many of them are the 3x3 roof itself (the rest are fills and the supports). */
  caps: number;
  /** What is wrong with the site, in words (empty: the plan stands). */
  problems: string[];
}
const key = (x: number, y: number, z: number) => `${x},${y},${z}`;

/**
 * The plan of the roof over `cell`: the caps over the body and the eight cells round it (a cap is not needed over a column whose two cells at the body's height
 * are both solid), a block in each neighbouring cell at the floor's level that is open and would let an enderman stand lower than the body and reach it, and
 * the support column the first cap is set against. `toward` (the enderman's side) only decides which side the support column goes on (the far one: it blocks
 * the look). Every placement must be within the hand's reach of the eyes and have a standing block to be set against when its turn comes.
 * `completeNine` is the live roof camp's rule. The default retains the older wall-equivalence plan for existing callers.
 */
export function planRoof(world: RoofWorld, cell: Cell3, toward?: { x: number; z: number }, target?: Cell3, completeNine = false): RoofPlan {
  const problems: string[] = [];
  const supports: Cell3[] = [];
  const plan = (placements: Cell3[], caps: number): RoofPlan => ({ cell, placements, supports, caps, problems });
  const { x: cx, y: cy, z: cz } = cell;
  const eye = new Vec3(cx + 0.5, cy + 1.62, cz + 0.5);
  const body = new Set([key(cx, cy, cz), key(cx, cy + 1, cz)]);
  // Supports must not fill either working ray. This is only a constraint on this roof, never a new target or site.
  const workingLines = new Set<string>();
  if (target) for (const up of [ENDERMAN_EYE, ENDERMAN_FEET]) {
    const distance = Math.hypot(target.x - eye.x, target.y + up - eye.y, target.z - eye.z);
    const steps = Math.ceil(distance / 0.05);
    for (let i = 1; i < steps; i++) workingLines.add(key(Math.floor(eye.x + (target.x - eye.x) * i / steps),
      Math.floor(eye.y + (target.y + up - eye.y) * i / steps), Math.floor(eye.z + (target.z - eye.z) * i / steps)));
  }
  const solid = (x: number, y: number, z: number) => world.solid(x, y, z);
  for (const check of [[cx, cy - 1, cz, 'floor'], [cx, cy, cz, 'feet'], [cx, cy + 1, cz, 'head']] as const) {
    if (solid(check[0], check[1], check[2]) === null) { problems.push('周りが未ロード'); return plan([], 0); }
  }
  if (solid(cx, cy - 1, cz) !== true) { problems.push('足元に床が無い'); return plan([], 0); }
  if (solid(cx, cy, cz) === true || solid(cx, cy + 1, cz) === true) { problems.push('体のマスが埋まっている'); return plan([], 0); }

  // The caps.
  const caps: Cell3[] = [];
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    const x = cx + dx, z = cz + dz;
    const centre = dx === 0 && dz === 0;
    if (!completeNine && !centre && solid(x, cy, z) === true && solid(x, cy + 1, z) === true) continue;
    const there = solid(x, cy + 2, z);
    if (there === null) { problems.push(`屋根のマス (${x},${cy + 2},${z}) が未ロード`); continue; }
    if (there === true) continue;
    if (!world.replaceable(x, cy + 2, z)) { problems.push(`屋根のマス (${x},${cy + 2},${z}) に置けない物がある`); continue; }
    caps.push({ x, y: cy + 2, z });
  }

  // The world as it will be: the caps are solid. Round the body, can an enderman stand lower than the roof and reach it?
  const planned = new Set(caps.map(c => key(c.x, c.y, c.z)));
  const isSolid = (x: number, y: number, z: number) => planned.has(key(x, y, z)) || solid(x, y, z) === true;
  const standable = (x: number, yn: number, z: number) => !isSolid(x, yn, z) && !isSolid(x, yn + 1, z) && !isSolid(x, yn + 2, z) && isSolid(x, yn - 1, z);
  const fills: Cell3[] = [];
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    if (dx === 0 && dz === 0) continue;
    const x = cx + dx, z = cz + dz;
    // An enderman standing with its feet at cy-2 or higher has its head above the body's feet: it can reach.
    const reachable = () => { for (let yn = cy - 2; yn <= cy + 1; yn++) if (standable(x, yn, z)) return yn; return null; };
    let yn = reachable();
    if (yn === null) continue;
    // A hole at the floor's level: a block in the floor cell (cy-1) makes the floor even, and the cap above leaves two cells.
    if (!isSolid(x, cy - 1, z) && world.replaceable(x, cy - 1, z)) { fills.push({ x, y: cy - 1, z }); planned.add(key(x, cy - 1, z)); yn = reachable(); }
    if (yn !== null) problems.push(`隣 (${x},${z}) にエンダーマンが立てる所がある（高さ ${yn}。穴や段差で、埋められない）`);
  }

  // The order: every placement against a standing block. Fills and caps are targets; when none can be laid yet, the shortest column of free cells from a standing
  // block to a cell beside a target is laid first (the support).
  const targets = new Map<string, Cell3>();
  for (const c of [...fills, ...caps]) targets.set(key(c.x, c.y, c.z), c);
  const laid = new Set<string>();
  const standing = (x: number, y: number, z: number) => laid.has(key(x, y, z)) || solid(x, y, z) === true;
  const near = (x: number, y: number, z: number) => Math.hypot(x + 0.5 - eye.x, y + 0.5 - eye.y, z + 0.5 - eye.z) <= HAND_REACH;
  const FACES: Array<[number, number, number]> = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]];
  const hasSupport = (x: number, y: number, z: number) => FACES.some(([a, b, c]) => standing(x + a, y + b, z + c));
  const order: Cell3[] = [];
  const lay = (c: Cell3) => { order.push(c); laid.add(key(c.x, c.y, c.z)); targets.delete(key(c.x, c.y, c.z)); };
  const priority = (c: Cell3) => (fills.includes(c) ? 0 : 1) * 100 + (c.y - cy) * 10 + Math.hypot(c.x - cx, c.z - cz);
  for (let guard = 0; targets.size && guard < 40; guard++) {
    const ready = [...targets.values()].filter(c => near(c.x, c.y, c.z) && hasSupport(c.x, c.y, c.z)).sort((a, b) => priority(a) - priority(b));
    if (ready.length) { lay(ready[0]); continue; }
    // A column of supports: breadth first over free cells (not the body's), from cells that have a standing block beside them to cells beside a target.
    const free = (x: number, y: number, z: number) => !body.has(key(x, y, z)) && !workingLines.has(key(x, y, z)) && !standing(x, y, z) && solid(x, y, z) === false && world.replaceable(x, y, z)
      && !targets.has(key(x, y, z)) && Math.abs(x - cx) <= 2 && Math.abs(z - cz) <= 2 && y >= cy - 1 && y <= cy + 3 && near(x, y, z);
    const beside = (x: number, y: number, z: number) => FACES.some(([a, b, c]) => targets.has(key(x + a, y + b, z + c)));
    const queue: Array<{ c: Cell3; path: Cell3[] }> = [];
    const seen = new Set<string>();
    const sources: Cell3[] = [];
    for (let x = cx - 2; x <= cx + 2; x++) for (let z = cz - 2; z <= cz + 2; z++) for (let y = cy - 1; y <= cy + 3; y++) if (free(x, y, z) && hasSupport(x, y, z)) sources.push({ x, y, z });
    // The far side from the enderman first (a column on its side blocks the look to it), then the nearer to the body.
    const away = (c: Cell3) => toward ? (c.x - cx) * toward.x + (c.z - cz) * toward.z : 0;
    sources.sort((a, b) => away(a) - away(b) || Math.hypot(a.x - cx, a.z - cz) - Math.hypot(b.x - cx, b.z - cz));
    for (const source of sources) { seen.add(key(source.x, source.y, source.z)); queue.push({ c: source, path: [source] }); }
    let found: Cell3[] | null = null;
    for (let head = 0; head < queue.length && !found; head++) {
      const { c, path } = queue[head];
      if (beside(c.x, c.y, c.z)) { found = path; break; }
      for (const [a, b, d] of FACES) {
        const x = c.x + a, y = c.y + b, z = c.z + d;
        if (seen.has(key(x, y, z)) || !free(x, y, z)) continue;
        seen.add(key(x, y, z));
        queue.push({ c: { x, y, z }, path: [...path, { x, y, z }] });
      }
    }
    if (!found) { problems.push('屋根の最初の1個を当てる足場が作れない（周りに固いブロックが届かない）'); break; }
    for (const c of found) { lay(c); if (c.y >= cy) supports.push(c); }
  }
  if (targets.size) problems.push(`置けない屋根のマスが ${targets.size} ある（手が届かないか、当てる面が無い）`);
  return plan(order, caps.length);
}

export interface EndermanLine {
  clear: boolean;
  between: Array<{ at: Cell3; name: string }>;
}
export interface EndermanView {
  eyes: EndermanLine;
  /** Diagnostics only: neither the current lower-body ray nor a walking route is required to provoke. */
  feet: EndermanLine;
  approach: { clear: boolean; contact: Cell3 | null; reason: string };
}

/** The same actual block observation used by the camp and the lab; unknown cells block both rays. */
export function endermanLine(read: BlockReader, from: Cell3, target: Cell3, up: number): EndermanLine {
  const between = solidBetween(read, [from.x, from.y + 1.62, from.z], [target.x, target.y + up, target.z]);
  // solidBetween skips endpoint cells for block probes. Here both endpoints are in bodies, so unknown/solid endpoints cannot certify sight.
  for (const p of [{ x: from.x, y: from.y + 1.62, z: from.z }, { x: target.x, y: target.y + up, z: target.z }]) {
    const at = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }, b = read(at.x, at.y, at.z);
    if ((!b || b.solid === true) && !between.some(c => c.x === at.x && c.y === at.y && c.z === at.z)) between.push(at);
  }
  return { clear: !between.length, between: between.map(at => ({ at, name: read(at.x, at.y, at.z)?.name ?? '未ロード' })) };
}

/** Per-axis, rather than radial: 1.8 - 0.2 = 1.6m still exceeds the enemy's 1.4283m attack box on at least one axis. */
export function atRoofCentre(position: Cell3, cell: Cell3): boolean {
  return Math.abs(position.x - (cell.x + 0.5)) <= ROOF_CENTRE_TOLERANCE + 1e-6
    && Math.abs(position.z - (cell.z + 0.5)) <= ROOF_CENTRE_TOLERANCE + 1e-6 && Math.abs(position.y - cell.y) <= 0.1;
}

/** A visible point on the legs' AABB, within survival's 3m eye-to-point reach. The head/eye ray is deliberately irrelevant here. */
export function endermanStrikePoint(read: BlockReader, from: Cell3, target: Cell3): Vec3 | null {
  const x = Math.max(target.x - 0.29, Math.min(target.x + 0.29, from.x));
  const z = Math.max(target.z - 0.29, Math.min(target.z + 0.29, from.z));
  const point = new Vec3(x, target.y + ENDERMAN_LEGS, z);
  if (point.distanceTo(new Vec3(from.x, from.y + 1.62, from.z)) > 3) return null;
  return endermanLine(read, from, point, 0).clear ? point : null;
}

const CAMP_HAZARD = /^(lava|water|bubble_column|fire|soul_fire|magma_block|campfire|soul_campfire|cactus|sweet_berry_bush|wither_rose|powder_snow|cobweb|.*_portal|end_gateway)$/u;
const fullFloor = (b: MapBlock | null) => !!b && b.solid === true && (b.top ?? 1) === 1 && !CAMP_HAZARD.test(b.name)
  && !/slab|stairs|fence|wall|leaves/u.test(b.name);
const freeCell = (b: MapBlock | null) => !!b && isOpenBlock(b) && !CAMP_HAZARD.test(b.name);

/** A neighbouring cell is inside only if it has the same protection as the original centre. A bare 3x3 edge is NOT safe. */
export function roofInterior(read: BlockReader, anchor: Cell3, at: Cell3): boolean {
  if (at.y !== anchor.y || Math.abs(at.x - anchor.x) > 1 || Math.abs(at.z - anchor.z) > 1) return false;
  if (!freeCell(read(at.x, at.y, at.z)) || !freeCell(read(at.x, at.y + 1, at.z))) return false;
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    const x = at.x + dx, z = at.z + dz;
    if (!fullFloor(read(x, at.y - 1, z))) return false;
    for (let dy = 0; dy <= 2; dy++) {
      const b = read(x, at.y + dy, z);
      if (!b || CAMP_HAZARD.test(b.name)) return false;
    }
    if (!fullFloor(read(x, at.y + 2, z)) && !(fullFloor(read(x, at.y, z)) && fullFloor(read(x, at.y + 1, z)))) return false;
  }
  return true;
}

/** Only a cardinal, level step within the already standing roof. No excavation, placement, jump or pathfinder detour. */
export function roofInteriorStep(read: BlockReader, anchor: Cell3, from: Cell3, to: Cell3): boolean {
  return from.y === to.y && Math.abs(from.x - to.x) + Math.abs(from.z - to.z) === 1
    && roofInterior(read, anchor, from) && roofInterior(read, anchor, to);
}

/** One straight segment from the centre to the first cell outside the 3x3 roof. Check every swept column, in both directions. */
export function roofExitStep(read: BlockReader, anchor: Cell3, to: Cell3): boolean {
  const dx = to.x - anchor.x, dz = to.z - anchor.z;
  if (to.y !== anchor.y || !((Math.abs(dx) === 2 && dz === 0) || (Math.abs(dz) === 2 && dx === 0))) return false;
  const clear = (b: MapBlock | null) => freeCell(b) && b?.solid === false && !b.top && !b.plates;
  for (let i = 0; i <= 2; i++) {
    const x = anchor.x + dx * i / 2, z = anchor.z + dz * i / 2;
    if (!fullFloor(read(x, anchor.y - 1, z)) || !clear(read(x, anchor.y, z)) || !clear(read(x, anchor.y + 1, z))) return false;
  }
  return clear(read(to.x, to.y + 2, to.z));
}

/** The target's nearer edge first. An unknown/unsafe corridor or a blocked eye ray is no candidate; never plan a detour. */
export function roofExitCandidates(read: BlockReader, anchor: Cell3, target: Cell3): Cell3[] {
  const dx = target.x - (anchor.x + 0.5), dz = target.z - (anchor.z + 0.5);
  return [[2, 0], [-2, 0], [0, 2], [0, -2]]
    .sort(([ax, az], [bx, bz]) => (bx - ax) * dx + (bz - az) * dz)
    .map(([x, z]) => ({ x: anchor.x + x, y: anchor.y, z: anchor.z + z }))
    .filter(to => roofExitStep(read, anchor, to) && endermanLine(read, { x: to.x + 0.5, y: to.y, z: to.z + 0.5 }, target, ENDERMAN_EYE).clear);
}

/** Nearby supports/extended caps retain interior recovery. Terrain beyond that footprint may use the same exterior stare. */
export function roofExitForSight(read: BlockReader, anchor: Cell3, target: Cell3, eyes: EndermanLine,
  occupied: (cell: Cell3) => boolean = () => false): Cell3[] {
  const cap = eyes.between.some(({ at }) => at.y === anchor.y + 2
    && Math.abs(at.x - anchor.x) <= 1 && Math.abs(at.z - anchor.z) <= 1);
  const terrain = eyes.between.some(({ at }) => Math.abs(at.x - anchor.x) > 2 || Math.abs(at.z - anchor.z) > 2);
  return !eyes.clear && (cap || terrain) ? roofExitCandidates(read, anchor, target).filter(to => [0, 1, 2].every(i => !occupied({
    x: anchor.x + (to.x - anchor.x) * i / 2, y: anchor.y, z: anchor.z + (to.z - anchor.z) * i / 2,
  }))) : [];
}

/** Same swept-column entity test for the probe's eligibility and the camp's movement rechecks. */
export function roofCellOccupied(entities: any[], bodyId: number, to: Cell3): boolean {
  return entities.some(e => e && e.id !== bodyId && e.isValid !== false && e.position
    && !['item', 'experience_orb'].includes(String(e.name))
    && Math.abs(e.position.x - (to.x + 0.5)) < 0.3 + (e.width ?? 0.6) / 2
    && Math.abs(e.position.z - (to.z + 0.5)) < 0.3 + (e.width ?? 0.6) / 2
    && e.position.y < to.y + 1.8 && e.position.y + (e.height ?? 1.8) > to.y);
}

/**
 * Can this same enderman walk through known, dry three-high columns to a visible lower-body contact point?
 * A bounded local search observes the route only: the body never walks it. One-block steps need headroom over both columns.
 * These readings are kept for the probe, not as permission to provoke or hold: an angry enderman can teleport past a blocked route.
 */
export function endermanView(reader: BlockReader, from: Cell3, target: Cell3): EndermanView {
  const cache = new Map<string, MapBlock | null>();
  const read: BlockReader = (x, y, z) => {
    const k = key(x, y, z);
    if (!cache.has(k)) cache.set(k, reader(x, y, z));
    return cache.get(k)!;
  };
  const eyes = endermanLine(read, from, target, ENDERMAN_EYE), feet = endermanLine(read, from, target, ENDERMAN_FEET);
  const centre = (c: Cell3) => ({ x: c.x + 0.5, y: c.y, z: c.z + 0.5 });
  const contact = (p: Cell3) => Math.hypot(Math.max(0, Math.abs(p.x - from.x) - 0.3),
    p.y + ENDERMAN_FEET - (from.y + 1.62), Math.max(0, Math.abs(p.z - from.z) - 0.3)) <= 3
    && endermanLine(read, from, p, ENDERMAN_FEET).clear;
  if (contact(target)) return { eyes, feet, approach: { clear: true, contact: { ...target }, reason: '' } };
  const start = { x: Math.floor(target.x), y: Math.floor(target.y), z: Math.floor(target.z) };
  const fits = (c: Cell3) => fullFloor(read(c.x, c.y - 1, c.z)) && [0, 1, 2].every(dy => freeCell(read(c.x, c.y + dy, c.z)));
  const queue: Cell3[] = fits(start) ? [start] : [], seen = new Set(queue.map(c => key(c.x, c.y, c.z)));
  const minX = Math.min(start.x, Math.floor(from.x)) - 3, maxX = Math.max(start.x, Math.floor(from.x)) + 3;
  const minZ = Math.min(start.z, Math.floor(from.z)) - 3, maxZ = Math.max(start.z, Math.floor(from.z)) + 3;
  const minY = Math.min(start.y, Math.floor(from.y)) - 2, maxY = Math.max(start.y, Math.floor(from.y)) + 2;
  for (let head = 0; head < queue.length && head < 1024; head++) {
    const c = queue[head];
    if (contact(centre(c))) return { eyes, feet, approach: { clear: true, contact: centre(c), reason: '' } };
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const dy of [0, 1, -1]) {
      const p = { x: c.x + dx, y: c.y + dy, z: c.z + dz }, k = key(p.x, p.y, p.z);
      if (seen.has(k) || p.x < minX || p.x > maxX || p.z < minZ || p.z > maxZ || p.y < minY || p.y > maxY) continue;
      if (!fits(p)) continue;
      if (dy && ![c, p].every(q => freeCell(read(q.x, Math.max(c.y, p.y) + 2, q.z)))) continue;
      if (queue.length < 1024) { seen.add(k); queue.push(p); }
    }
  }
  return { eyes, feet, approach: { clear: false, contact: null, reason: '既知の床と3マスの高さで打撃位置まで通る道を確認できない（局所1024マスまで）' } };
}

export interface RoofSite { cell: Cell3; /** Blocks the plan lays. */ blocks: number; /** Horizontal distance from where the body stands. */ distance: number }

/**
 * The cells round `around` (within `radius` blocks, two levels up or down) where the roof's plan stands: the floor is there, two cells are free over it, and
 * `planRoof` finds nothing wrong (no step beside it that cannot be filled, no cap that cannot be laid). Fewest blocks first, then nearest. Uneven ground, the
 * warped forest's floor with its plants and steps, has such cells a few blocks off where the one the body stands on has none.
 */
export function roofSites(world: RoofWorld, around: Cell3, radius = 7, toward?: { x: number; z: number }, limit = 5): RoofSite[] {
  const sites: RoofSite[] = [];
  for (let dx = -radius; dx <= radius; dx++) for (let dz = -radius; dz <= radius; dz++) {
    const distance = Math.hypot(dx, dz);
    if (distance > radius) continue;
    for (let dy = -2; dy <= 2; dy++) {
      const cell = { x: around.x + dx, y: around.y + dy, z: around.z + dz };
      if (world.solid(cell.x, cell.y - 1, cell.z) !== true || world.solid(cell.x, cell.y, cell.z) !== false || world.solid(cell.x, cell.y + 1, cell.z) !== false) continue;
      const plan = planRoof(world, cell, toward);
      if (plan.problems.length) continue;
      sites.push({ cell, blocks: plan.placements.length, distance: Math.round(distance * 10) / 10 });
    }
  }
  return sites.sort((a, b) => a.blocks - b.blocks || a.distance - b.distance).slice(0, limit);
}

/**
 * The roof's blocks: any building block but obsidian (kept for the gate and the dragon), the first kind with enough, else the kind there is most of. The head says
 * "丸石・土・ネザーラック等 11 個"; the site walk (moveToRoofSite) and the camp ask this one rule (Codex's pre-deploy review 6, 11/5: the camp took cobblestone only).
 */
const ROOF_BLOCKS = BUILDING_BLOCKS.filter(name => name !== 'obsidian');
export function roofBlockFor(bot: { inventory?: { items?: () => Array<{ name: string; count: number }> } }, need: number): { name: string; count: number } | null {
  const have = new Map<string, number>();
  for (const item of bot.inventory?.items?.() ?? []) if (ROOF_BLOCKS.includes(item.name)) have.set(item.name, (have.get(item.name) ?? 0) + item.count);
  for (const name of ROOF_BLOCKS) if ((have.get(name) ?? 0) >= need) return { name, count: have.get(name)! };
  const most = [...have].sort((a, b) => b[1] - a[1])[0];
  return most ? { name: most[0], count: most[1] } : null;
}

/** Whether an enderman is angry at someone now (the `creepy` flag of its entity data), or false when it cannot be read. */
export function endermanAngry(registry: Parameters<typeof isAngry>[1], entity: any): boolean {
  return isAngry(entity, registry);
}

/** Whether the look (yaw, pitch as the body holds them) falls on the enderman's eyes the way the server measures it, from eyes at `from`. */
export function looksAtEyes(from: Vec3, yaw: number, pitch: number, enderman: { x: number; y: number; z: number }): boolean {
  const eyes = new Vec3(enderman.x, enderman.y + ENDERMAN_EYE, enderman.z);
  const line = eyes.minus(from), distance = line.norm();
  if (distance < 1e-6) return true;
  const look = new Vec3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
  return look.dot(line.scaled(1 / distance)) > 1 - 0.025 / distance;
}
