import { symbolFor, isOpenSymbol, type BlockReader, type Cell, type MapBlock } from './localMap.js';

/**
 * The walk's one rule for the cells a body walks through (r5, 2026-10-22). The walk (its route search's movements, utils/primitives/walk)
 * and probe path (utils/probeTools) both read cells through these functions, so the two never disagree on what is walked: in run 28 probe
 * path said "歩いて行ける・43 マス" and the walk stopped at the sixth point on a spruce door, leaves at head height and a trapdoor, which
 * probe counted as open and the walk as walls.
 *
 * - A step up of one with room over the head, a drop of three at most, swimming, a ladder.
 * - A wooden door, fence gate or trapdoor that is shut is opened on the way (Lai, 2026-10-22: "歩きの中で通る"). An iron one is not
 *   opened by a hand: a closed iron door is a wall, said as one.
 * - Leaves in the feet or head cell of the way are broken on the way. Leaves under the feet are a floor (never broken to go down).
 * - Lava, fire, cobweb, powder snow, a portal, a berry bush, a wither rose, magma and a cactus are not walked into.
 * Exact facts only: no way round is chosen here.
 */

/** Blocks a body does not walk into whatever their box (they hurt, hold, or carry it off). */
export const NO_ENTER = new Set(['lava', 'fire', 'soul_fire', 'cobweb', 'powder_snow', 'nether_portal', 'end_portal', 'end_gateway', 'sweet_berry_bush',
  'campfire', 'soul_campfire', 'wither_rose', 'magma_block', 'cactus']);
/** A step up is one block; a drop (also into water) is three at most. */
export const MAX_STEP_UP = 1;
export const MAX_FALL = 3;

const DOORLIKE = /(_door|_fence_gate|_trapdoor)$/u;
const IRON = /^iron_(door|trapdoor)$/u;
const LEAVES = /_leaves$/u;
/** A door, a fence gate or a trapdoor (wooden or iron). */
export const isDoorlike = (name: string) => DOORLIKE.test(name.replace(/^minecraft:/u, ''));
/** Leaves of a tree (azalea leaves too). */
export const isLeaves = (name: string) => LEAVES.test(name.replace(/^minecraft:/u, ''));
export const isWater = (block: MapBlock | null) => !!block && (block.name === 'water' || symbolFor(block) === 'w' || symbolFor(block) === '-');
export const isLava = (block: MapBlock | null) => !!block && block.name === 'lava';
export const isClimbable = (block: MapBlock | null) => !!block && symbolFor(block) === 'h';
const solidOf = (block: MapBlock) => block.solid ?? !isOpenSymbol(symbolFor(block));

/**
 * r7 (runs 30, 31: walks in the fortress stopped "一歩ではない" 45-50 s a run; lab, the route search against probe path): the heights the
 * route search (mineflayer-pathfinder's movements) reads, and the rules had not.
 * - A block taller than a full one (a fence, a wall; top 1.5) is no floor and no step: the search never stands on one nor climbs it (its
 *   `fences`), and the rules took it for a block to step up on.
 * - A block under a tenth of a block (a carpet) is walked through and stood on (its `carpets`); the rules took it for a wall.
 * - A climb is at most 1.2 from the floor stood on (its "too high to jump"): from a slab (0.5) a full block a cell up is 1.5, no climb.
 * The heights come from the block's collision box (MapBlock.top); a reader that does not give them is read by the name.
 */
const TALL_NAME = /(_fence|_wall)$/u;
const THIN_NAME = /_carpet$/u;
/** The top of a solid block's box in its cell (1 when not known: a full block). 0 for a block a body walks through. */
export function topOf(block: MapBlock | null): number {
  if (!block || !solidOf(block)) return 0;
  if (typeof block.top === 'number') return block.top;
  const name = block.name.replace(/^minecraft:/u, '');
  return TALL_NAME.test(name) ? 1.5 : THIN_NAME.test(name) ? 0.0625 : 1;
}
/** A fence or a wall (taller than a full block): no floor, no step. */
export const isTall = (block: MapBlock | null) => !!block && !isDoorlike(block.name) && solidOf(block) && topOf(block) > 1;
/** A carpet (under a tenth of a block): walked through, and a floor. */
export const isThin = (block: MapBlock | null) => !!block && solidOf(block) && topOf(block) < 0.1;
/** The most the feet rise in one climb (mineflayer-pathfinder: "too high to jump" over 1.2). */
export const MAX_CLIMB = 1.2;
/**
 * How far the feet rise to stand in (x, fromY + 1, z) from the cell (fromX, fromY, fromZ): from the top of the floor stood on to the top of
 * the block climbed. In water or on a ladder the floor is the feet's own level.
 */
export function climbRise(read: BlockReader, fromX: number, fromY: number, fromZ: number, x: number, z: number): number {
  const feet = read(fromX, fromY, fromZ);
  const floor = read(fromX, fromY - 1, fromZ);
  const base = isWater(feet) || isClimbable(feet) || !floorOf(floor) ? fromY : fromY - 1 + topOf(floor);
  return fromY + topOf(read(x, fromY, z)) - base;
}

/**
 * What a walking body meets in a feet or head cell:
 *   open       walked through as it is (air, a plant, water, a ladder, a torch, a rail, a crop, an open door, gate or trapdoor);
 *   door       a shut wooden door, fence gate or trapdoor: opened on the way;
 *   leaves     broken on the way;
 *   iron_door  a shut iron door or trapdoor: a hand does not open it;
 *   solid      a wall;
 *   harm       lava, fire and the like: not walked into;
 *   unloaded   nothing known.
 */
export type CellWay = 'open' | 'door' | 'leaves' | 'iron_door' | 'solid' | 'harm' | 'unloaded';

export function cellWay(block: MapBlock | null): CellWay {
  if (!block) return 'unloaded';
  if (NO_ENTER.has(block.name)) return 'harm';
  if (isDoorlike(block.name)) {
    if (block.open === true) return 'open';
    return IRON.test(block.name) ? 'iron_door' : 'door';
  }
  if (isLeaves(block.name)) return 'leaves';
  const symbol = symbolFor(block);
  if (symbol === 'h' || symbol === 't' || symbol === '=' || symbol === 'k' || isWater(block)) return 'open';
  if (isThin(block)) return 'open';
  return solidOf(block) ? 'solid' : 'open';
}

/** The walk goes through this feet or head cell: open now, or opened or broken on the way. */
export function passable(block: MapBlock | null): boolean {
  const way = cellWay(block);
  return way === 'open' || way === 'door' || way === 'leaves';
}
/** Open as it is: a fall goes through it, and nothing has to be opened or broken. */
export function enterable(block: MapBlock | null): boolean { return cellWay(block) === 'open'; }
/** Something to stand on: a box, not lava or a hurting block, not a door, gate or trapdoor, not a fence or a wall (r7). Leaves are a floor. */
export function floorOf(block: MapBlock | null): boolean { return !!block && !NO_ENTER.has(block.name) && solidOf(block) && !isDoorlike(block.name) && !isTall(block); }
/** A body can be in this cell: feet and head passable, and under the feet a floor, or the feet in water or on a ladder. */
export function standable(read: BlockReader, x: number, y: number, z: number): boolean {
  const feet = read(x, y, z);
  if (!passable(feet) || !passable(read(x, y + 1, z))) return false;
  return isWater(feet) || isClimbable(feet) || floorOf(read(x, y - 1, z));
}

const at = (cell: Cell) => `(${cell.x},${cell.y},${cell.z})`;

/** The words for a feet or head cell the walk does not go through (null: it does). */
export function blockedWords(block: MapBlock | null, cell: Cell): string | null {
  const way = cellWay(block);
  if (way === 'unloaded') return `${at(cell)} は未ロード`;
  if (way === 'iron_door') return `${at(cell)} は ${block!.name}（閉じた鉄の扉は手では開かない）`;
  if (way === 'harm') return `${at(cell)} は ${block!.name}（入らない）`;
  if (way === 'solid') return `${at(cell)} は ${block!.name}`;
  return null;
}

/**
 * Why a body cannot stand in `cell` (the fact, short): its feet cell taken, its head cell taken, or no floor under it (how many cells of air);
 * null when it can, or when the cells are not loaded (nothing known). `solidFeet` is true when the feet cell itself is the trouble.
 */
export function whyNotStand(read: BlockReader, cell: Cell): { text: string; solidFeet: boolean } | null {
  const feet = read(cell.x, cell.y, cell.z), head = read(cell.x, cell.y + 1, cell.z);
  if (!feet || !head) return null;
  if (!passable(feet)) {
    const way = cellWay(feet);
    return { text: way === 'iron_door' ? `足のマスが ${feet.name}（閉じた鉄の扉は手では開かない）` : way === 'harm' ? `足のマスが ${feet.name}` : `足のマスが ${feet.name} で埋まっている`, solidFeet: true };
  }
  if (!passable(head)) return { text: `頭の高さ ${at({ ...cell, y: cell.y + 1 })} が ${head.name}`, solidFeet: false };
  if (isWater(feet) || isClimbable(feet)) return null;
  const under = read(cell.x, cell.y - 1, cell.z);
  if (!under) return null;
  if (floorOf(under)) return null;
  if (isLava(under)) return { text: `下 ${at({ ...cell, y: cell.y - 1 })} が溶岩`, solidFeet: false };
  let air = 0;
  for (; air < 8; air++) {
    const below = read(cell.x, cell.y - 1 - air, cell.z);
    if (!below || !enterable(below) || isWater(below)) break;
  }
  if (air === 0) return { text: `下 ${at({ ...cell, y: cell.y - 1 })} が ${under.name}（立つ床にならない）`, solidFeet: false };
  return { text: `下 ${air >= 8 ? '8 以上' : air} マスが空気（立つ床が無い）`, solidFeet: false };
}

/** The cells round a target a body stands in "beside it" (above, the four sides, below, and those a step up or down), in this order. */
export const BESIDE: ReadonlyArray<readonly [number, number, number]> = [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -2, 0], [1, 1, 0], [-1, 1, 0],
  [0, 1, 1], [0, 1, -1], [1, -1, 0], [-1, -1, 0], [0, -1, 1], [0, -1, -1]];

/** The cells beside `cell` a body can stand in (at most `most`), in BESIDE's order. */
export function standableBeside(read: BlockReader, cell: Cell, most = 3): Cell[] {
  const out: Cell[] = [];
  for (const [dx, dy, dz] of BESIDE) {
    if (out.length >= most) break;
    if (standable(read, cell.x + dx, cell.y + dy, cell.z + dz)) out.push({ x: cell.x + dx, y: cell.y + dy, z: cell.z + dz });
  }
  return out;
}

/**
 * The route search's movements (mineflayer-pathfinder) made to walk by these rules: a door, gate or trapdoor is open ground to the search
 * (the walk opens a shut one as it comes to it), a shut iron one is neither ground nor floor, only leaves may be broken, and never under
 * the feet (no move whose blocks to break lie below the cell it starts from). The pathfinder's own door opening stays off: it opened only
 * a fence gate at the feet, and took the door's upper half as a wall (run 28: "壁: spruce_door").
 */
export function installWalkRules(movements: any): void {
  if (!movements || movements.__walkRules) return;
  movements.__walkRules = true;
  movements.canOpenDoors = false;
  const getBlock = movements.getBlock.bind(movements);
  movements.getBlock = (pos: any, dx: number, dy: number, dz: number) => {
    const block = getBlock(pos, dx, dy, dz);
    if (!block?.name || !isDoorlike(String(block.name))) return block;
    const way = cellWay(mapBlockOf(block));
    block.openable = false;
    if (way === 'open' || way === 'door') { block.safe = true; block.physical = false; block.replaceable = false; }
    else { block.safe = false; block.physical = false; }
    return block;
  };
  movements.canDig = true;
  movements.exclusionAreasBreak.push((block: any) => (block?.name && isLeaves(String(block.name)) ? 0 : 100));
  const getNeighbors = movements.getNeighbors.bind(movements);
  movements.getNeighbors = (node: any) => (getNeighbors(node) as any[]).filter(move => {
    if ((move.toBreak ?? []).some((cell: any) => cell.y < node.y)) return false;
    // A jump over a gap passes cells that are not nodes: a shut door there would not be opened.
    if (move.parkour) {
      const sx = Math.sign(move.x - node.x), sz = Math.sign(move.z - node.z);
      const span = Math.max(Math.abs(move.x - node.x), Math.abs(move.z - node.z));
      for (let d = 1; d < span; d++) for (let h = 0; h <= 2; h++) {
        const cell = movements.getBlock(node, sx * d, h, sz * d);
        if (cell?.name && isDoorlike(String(cell.name)) && cellWay(mapBlockOf(cell)) !== 'open') return false;
      }
    }
    return true;
  });
}

/** A prismarine block as the rules read it (its name, its box, and for a door, gate or trapdoor whether it is open). */
export function mapBlockOf(block: any): MapBlock {
  const out: MapBlock = { name: String(block.name), solid: block.boundingBox === 'block' };
  if (out.solid && Array.isArray(block.shapes) && block.shapes.length) {
    const top = Math.max(...block.shapes.map((shape: number[]) => shape[4]));
    if (Number.isFinite(top) && top !== 1) out.top = top;
  }
  if (isDoorlike(out.name)) out.open = doorOpen(block);
  return out;
}
export function doorOpen(block: any): boolean {
  try { const open = block.getProperties?.()?.open; return open === true || open === 'true'; } catch { return false; }
}
