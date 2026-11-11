import { bodyReader, type Cell } from '../localMap.js';
import { floorOf, passable, standable } from '../walkRules.js';

/**
 * A body in a hole: the cells it can walk to on its level are few (at most HOLE_CELLS), none of them has a way out sideways (a flat step, a
 * one-block jump up, a one-block drop), and the way out is straight up: air or water, or rock and earth of at most HOLE_ROOF_DIGS blocks.
 * It is a reading of the blocks around the feet (no search, no waiting). A cave or a side tunnel that goes on past HOLE_CELLS is not a hole.
 */
export const HOLE_CELLS = 8;
export const HOLE_MAX_LEVELS = 10;
export const HOLE_ROOF_DIGS = 3;
/** What the climb out of a hole may dig through above the head, with no dig list: rock and earth only, never an ore, a chest, a door or a bed. */
export const HOLE_ROCK = /^(?:stone|dirt|coarse_dirt|grass_block|gravel|andesite|diorite|granite|tuff|deepslate|cobblestone|cobbled_deepslate|sand|netherrack)$/u;

export interface HoleReading {
  /** The level the feet climb to (the first height with a way off sideways). */
  toY: number;
  /** How many levels up from the feet. */
  levels: number;
  /** The rock and earth blocks over the head to dig on the way up. */
  roofDigs: number;
}

const SIDES: ReadonlyArray<readonly [number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];

export function inHole(bot: any): HoleReading | null {
  const feet = bot?.entity?.position;
  if (!feet) return null;
  const read = bodyReader(bot);
  const start: Cell = { x: Math.floor(feet.x), y: Math.floor(feet.y), z: Math.floor(feet.z) };
  if (!standable(read, start.x, start.y, start.z)) return null;
  // The cells walked to on this level, at most HOLE_CELLS; a way out sideways (flat, one up, one down) ends it: not a hole.
  const seen = new Set<string>([`${start.x},${start.z}`]);
  const queue: Cell[] = [start];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const [dx, dz] of SIDES) {
      const x = cur.x + dx, z = cur.z + dz;
      if (seen.has(`${x},${z}`)) continue;
      if (standable(read, x, cur.y, z)) {
        seen.add(`${x},${z}`);
        if (seen.size > HOLE_CELLS) return null;
        queue.push({ x, y: cur.y, z });
        continue;
      }
      if (standable(read, x, cur.y + 1, z) && passable(read(cur.x, cur.y + 2, cur.z))) return null;
      if (standable(read, x, cur.y - 1, z)) return null;
    }
  }
  // Straight up from the feet: every cell on the way is air or water, or a few blocks of rock and earth to dig; the first level with a floor beside it is the top.
  let roofDigs = 0, checked = start.y + 1;
  for (let y = start.y + 1; y <= start.y + HOLE_MAX_LEVELS; y++) {
    for (; checked <= y + 1; checked++) {
      if (checked <= start.y + 1) continue;
      const block = read(start.x, checked, start.z);
      if (!block) return null;
      if (passable(block) || block.name === 'water') continue;
      if (!HOLE_ROCK.test(block.name) || ++roofDigs > HOLE_ROOF_DIGS) return null;
    }
    const open = SIDES.some(([dx, dz]) => {
      const x = start.x + dx, z = start.z + dz;
      return passable(read(x, y, z)) && passable(read(x, y + 1, z)) && floorOf(read(x, y - 1, z));
    });
    if (open) return { toY: y, levels: y - start.y, roofDigs };
  }
  return null;
}
