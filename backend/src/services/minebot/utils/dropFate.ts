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
  for (let down = 1; down <= MAX_FALL; down++) {
    const cell = target.offset(0, -down, 0);
    const block = at(cell);
    if (burns(block)) return cell;
    if (holds(block)) return null;
  }
  return null;
}

/** Lava the opening would let in from the side or from above (what water over the block has to reach first). */
export function lavaBesideOrOver(world: DropWorld, target: Vec3): Vec3 | null {
  for (const [dx, dy, dz] of [[0, 1, 0], ...SIDES] as Array<[number, number, number]>) {
    const cell = target.offset(dx, dy, dz);
    try { if (isLava(world.blockAt(cell))) return cell; } catch { /* unloaded: nothing known to run in */ }
  }
  return null;
}
