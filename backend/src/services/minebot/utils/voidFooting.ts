import { floorOf, isClimbable, isLava, isWater, passable } from './walkRules.js';
import type { BlockReader, Cell } from './localMap.js';

/**
 * What the body stands beside (r8, run 32: a bridge one wide over a lava sea, 24 to 30 cells of air on both sides): the cells round the feet
 * that have no floor within a fall that hurts. Exact facts from the blocks, no choice; the melee reflex (floorReflexes `meleeChoice`), the last
 * stand and `probe around` all read it, so the three say the same.
 *
 * A "void" is a neighbouring cell a body can step into (its feet and head cells are open) whose column has no floor within VOID_DROP cells
 * under the feet's level, or whose column ends in lava, or a cell of lava itself beside the feet. A fall into water is not one (it takes no damage), nor is a cell not loaded.
 */
/** A fall of this many cells or more (vanilla fall damage starts above three) from the feet's level. */
export const VOID_DROP = 3;
/** How deep a column is read; a column with no floor in it is "bottomless" (reads as this deep). */
export const FOOTING_DEPTH = 48;

export interface FootingSide { dx: number; dz: number; drop: number; lava: boolean }
export interface Footing {
  /** The cells (of the 8 round the feet) that are voids. */
  sides: FootingSide[];
  count: number;
  /** The deepest fall among them (FOOTING_DEPTH when a column has no floor in reach). */
  deepest: number;
  lava: boolean;
  /** Voids on both sides of the feet along one axis and a floor along the other: a bridge one cell wide (a blow from either side pushes the body off). */
  bridge: boolean;
  /** Voids on both sides along both axes: a pillar one cell wide. */
  pillar: boolean;
}

const RING: ReadonlyArray<readonly [number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

/** The fall from a body standing with its feet at (x, feetY, z), if the floor under it were not there: cells of air until a floor, lava or water. */
export function dropUnder(read: BlockReader, x: number, feetY: number, z: number, depth = FOOTING_DEPTH): { drop: number; lava: boolean; water: boolean; unknown: boolean; bottomless: boolean } {
  for (let n = 0; n < depth; n++) {
    const block = read(x, feetY - 1 - n, z);
    if (!block) return { drop: n, lava: false, water: false, unknown: true, bottomless: false };
    if (isLava(block)) return { drop: n, lava: true, water: false, unknown: false, bottomless: false };
    if (isWater(block)) return { drop: n, lava: false, water: true, unknown: false, bottomless: false };
    if (floorOf(block) || isClimbable(block)) return { drop: n, lava: false, water: false, unknown: false, bottomless: false };
  }
  return { drop: depth, lava: false, water: false, unknown: false, bottomless: true };
}

/** The voids round a body whose feet are in `feet`. */
export function footingAt(read: BlockReader, feet: Cell): Footing {
  const sides: FootingSide[] = [];
  for (const [dx, dz] of RING) {
    const x = feet.x + dx, z = feet.z + dz;
    const here = read(x, feet.y, z), head = read(x, feet.y + 1, z);
    // Lava beside the feet is the worst of falls: a push into it, with nothing to fall through.
    if (here && isLava(here)) { sides.push({ dx, dz, drop: 0, lava: true }); continue; }
    if (!here || !head || !passable(here) || !passable(head)) continue;
    const under = dropUnder(read, x, feet.y, z);
    if (under.unknown || under.water) continue;
    if (under.lava || under.drop >= VOID_DROP) sides.push({ dx, dz, drop: under.drop, lava: under.lava });
  }
  const has = (dx: number, dz: number) => sides.some(side => side.dx === dx && side.dz === dz);
  const across = has(1, 0) && has(-1, 0), along = has(0, 1) && has(0, -1);
  return {
    sides, count: sides.length, deepest: sides.reduce((most, side) => Math.max(most, side.drop), 0), lava: sides.some(side => side.lava),
    bridge: across !== along, pillar: across && along,
  };
}

/** "幅 1 の橋・左右とも空所（落差 28、下は溶岩）" or "周り 8 マスのうち空所 3（落差 12）"; '' when there is no void round the feet. */
export function footingWords(footing: Footing): string {
  if (!footing.count) return '';
  const depth = footing.deepest >= FOOTING_DEPTH ? `${FOOTING_DEPTH} 以上` : String(footing.deepest);
  const shape = footing.bridge ? '幅 1 の橋・左右とも空所' : footing.pillar ? '幅 1 の足場・四方とも空所' : `周り 8 マスのうち空所 ${footing.count}`;
  return `${shape}（${footing.deepest === 0 && footing.lava ? '隣が溶岩' : `落差 ${depth}${footing.lava ? '、下は溶岩' : ''}`}）`;
}
