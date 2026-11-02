import { Vec3 } from 'vec3';
import { isAngry } from './hostileMobHints.js';
import { BUILDING_BLOCKS } from '../instantSkills/buildAroundSelf.js';

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
 *  - An angry enderman within four blocks teleports away when it is looked in the eye, so once it is angry the body looks at its waist.
 *  - A hit by a creature does not make it teleport (a projectile does: a bow is no tool for it).
 *
 * This file holds the plan of the roof (pure: the blocks it needs, in the order they can be laid, each against one already standing), the choice of block, and
 * the readings; the live part is `EndermanCamp` (further down).
 */

export const ENDERMAN_EYE = 2.55;
/** The enderman's body is this tall: where fewer than three cells are free over a floor it cannot stand. */
export const ENDERMAN_HEIGHT = 2.9;
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
 */
export function planRoof(world: RoofWorld, cell: Cell3, toward?: { x: number; z: number }): RoofPlan {
  const problems: string[] = [];
  const plan = (placements: Cell3[], caps: number): RoofPlan => ({ cell, placements, caps, problems });
  const { x: cx, y: cy, z: cz } = cell;
  const eye = new Vec3(cx + 0.5, cy + 1.62, cz + 0.5);
  const body = new Set([key(cx, cy, cz), key(cx, cy + 1, cz)]);
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
    if (!centre && solid(x, cy, z) === true && solid(x, cy + 1, z) === true) continue;
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
    const free = (x: number, y: number, z: number) => !body.has(key(x, y, z)) && !standing(x, y, z) && solid(x, y, z) === false && world.replaceable(x, y, z)
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
    for (const c of found) lay(c);
  }
  if (targets.size) problems.push(`置けない屋根のマスが ${targets.size} ある（手が届かないか、当てる面が無い）`);
  return plan(order, caps.length);
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
 * The block to build with: the first kind in the order the body spends them that it carries enough of, else the kind it carries most of (told short).
 * Gravity blocks and the like are not in the list.
 */
export function roofBlockFor(bot: { inventory?: { items?: () => Array<{ name: string; count: number }> } }, need: number): { name: string; count: number } | null {
  const have = new Map<string, number>();
  for (const item of bot.inventory?.items?.() ?? []) if (BUILDING_BLOCKS.includes(item.name)) have.set(item.name, (have.get(item.name) ?? 0) + item.count);
  for (const name of BUILDING_BLOCKS) if ((have.get(name) ?? 0) >= need) return { name, count: have.get(name)! };
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
