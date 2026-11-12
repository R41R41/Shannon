import { Vec3 } from 'vec3';
import { holdsWater } from './waterBlocks.js';

interface DropWorld { blockAt(position: Vec3): any }

const isLava = (block: any) => !!block && block.name === 'lava';
const burns = (block: any) => isLava(block) || block?.name === 'fire' || block?.name === 'soul_fire';
const holds = (block: any) => !block || block.boundingBox === 'block' || holdsWater(block);
const SIDES: Array<[number, number, number]> = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];
const MAX_FALL = 24;

/**
 * Where what a block drops would burn, or null when the drop can be picked up.
 *
 * A broken block leaves its drop in the cell it stood in, and the drop falls until something holds it. Lava
 * under that cell takes it; lava over or beside the cell runs into the opening and takes it there. Whether a
 * dig is safe for the body (`lavaReleasedBy`) says nothing of this: the crust over a lava lake is safe to
 * break from beside it, and every piece of it falls into the lake. A lake three deep, turned to obsidian on
 * top with a bucket of water, gave nothing for ten blocks mined (lab, 2026-10-02: natural lava is seldom one
 * block deep, and the same holds for ore in the floor over a lava lake).
 */
export function dropBurnsIn(world: DropWorld, target: Vec3): Vec3 | null {
  const at = (cell: Vec3) => { try { return world.blockAt(cell); } catch { return null; } };
  for (const [dx, dy, dz] of [[0, 1, 0], ...SIDES] as Array<[number, number, number]>) {
    const cell = target.offset(dx, dy, dz);
    if (isLava(at(cell))) return cell;
  }
  return lavaBelowDrop(world, target);
}

/** Where the drop of the block would burn in its fall straight down (lava or fire before something holds it), or null. */
export function lavaBelowDrop(world: DropWorld, target: Vec3): Vec3 | null {
  const at = (cell: Vec3) => { try { return world.blockAt(cell); } catch { return null; } };
  for (let down = 1; down <= MAX_FALL; down++) {
    const cell = target.offset(0, -down, 0);
    const block = at(cell);
    if (burns(block)) return cell;
    if (holds(block)) return null;
  }
  return null;
}

/** How many of the cells over the block and at its four sides are lava (what a person puts out with a block before breaking it). */
export function lavaAroundCount(world: DropWorld, target: Vec3): number {
  let count = 0;
  for (const [dx, dy, dz] of [[0, 1, 0], ...SIDES] as Array<[number, number, number]>) {
    try { if (isLava(world.blockAt(target.offset(dx, dy, dz)))) count++; } catch { /* unloaded: not counted */ }
  }
  return count;
}

/** Lava the opening would let in from the side or from above (what water over the block has to reach first). */
export function lavaBesideOrOver(world: DropWorld, target: Vec3): Vec3 | null {
  for (const [dx, dy, dz] of [[0, 1, 0], ...SIDES] as Array<[number, number, number]>) {
    const cell = target.offset(dx, dy, dz);
    try { if (isLava(world.blockAt(cell))) return cell; } catch { /* unloaded: nothing known to run in */ }
  }
  return null;
}

/**
 * What would burn the drop of `target`, split by what puts it out (run 8, 11/13: six obsidian lost, one with lava beside it, five with a lava source right under it):
 * `around` the lava over the block and at its four sides (a block laid in each shuts it out); `under` 'direct' when lava (or fire) lies right under it (nothing
 * can be laid there from the body's side: water over the block is what saves the drop), 'fall' when the drop would fall through air into it (a block laid in the
 * cell under the block holds the drop), null when nothing under it burns.
 */
export interface DropRisk { around: Vec3[]; under: 'direct' | 'fall' | null; below: Vec3 | null }
export function dropRisk(world: DropWorld, target: Vec3): DropRisk {
  const around: Vec3[] = [];
  for (const [dx, dy, dz] of [[0, 1, 0], ...SIDES] as Array<[number, number, number]>) {
    const cell = target.offset(dx, dy, dz);
    try { if (isLava(world.blockAt(cell))) around.push(cell); } catch { /* unloaded: nothing known to run in */ }
  }
  const below = lavaBelowDrop(world, target);
  return { around, under: !below ? null : below.y === target.y - 1 ? 'direct' : 'fall', below };
}
/** True when anything in the risk burns the drop. */
export const dropBurns = (risk: DropRisk): boolean => risk.around.length > 0 || risk.under !== null;
