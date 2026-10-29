import { Vec3 } from 'vec3';
import { symbolFor, isOpenSymbol, platesOfShapes, type BlockReader, type Cell, type MapBlock } from './localMap.js';

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
 * - Lava, fire, cobweb, powder snow, a berry bush, a wither rose, magma and a cactus are not walked into.
 * - A nether portal or an end portal has no box: it is entered when it is the walk's target (the way to change dimension; mb-llmc-cand 4,
 *   run 37: "そのものには立てない（足のマスが nether_portal）"), and is not a cell of a route (a body is carried off in it). It is neither
 *   a wall nor a harm.
 * Exact facts only: no way round is chosen here.
 */

/** Blocks a body does not walk into whatever their box (they hurt, hold, or carry it off). */
export const NO_ENTER = new Set(['lava', 'fire', 'soul_fire', 'cobweb', 'powder_snow', 'sweet_berry_bush',
  'campfire', 'soul_campfire', 'wither_rose', 'magma_block', 'cactus']);
/** A step up is one block; a drop (also into water) is three at most. */
export const MAX_STEP_UP = 1;
export const MAX_FALL = 3;

/**
 * A portal a body walks into (no collision box): a nether portal, an end portal (a body falls through it) or an end gateway (walking into its
 * beam carries it off). An end portal frame is a block, not this. The map's `p` and `e` are these: enterable.
 */
export const isPortalName = (name: string) => { const bare = name.replace(/^minecraft:/u, ''); return bare === 'nether_portal' || bare === 'end_portal' || bare === 'end_gateway'; };
export const isPortal = (block: MapBlock | null) => !!block && isPortalName(block.name);
/** What a portal cell is, in a few words: said where a stop names one. */
export const PORTAL_WORDS = 'ポータル: 壁でも害でもない、的にして walk で入ると次元が変わる、通り道には使わない';

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
 *   portal     a nether portal or an end portal: entered as the walk's target, not a cell of a route (no wall, no harm);
 *   unloaded   nothing known.
 */
export type CellWay = 'open' | 'door' | 'leaves' | 'iron_door' | 'solid' | 'harm' | 'portal' | 'unloaded';

export function cellWay(block: MapBlock | null): CellWay {
  if (!block) return 'unloaded';
  if (isPortal(block)) return 'portal';
  if (NO_ENTER.has(block.name)) return 'harm';
  // The route search (mineflayer-pathfinder) finds no way through scaffolding (the lab of mb-llmc-cand: noPath with it in the feet or head
  // cell, where probe path said "歩いて行ける"): a wall for the walk, as for the search.
  if (block.name === 'scaffolding') return 'solid';
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
  if (way === 'portal') return `${at(cell)} は ${block!.name}（${PORTAL_WORDS}）`;
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
    if (way === 'portal') return { text: `足のマスが ${feet.name}（${PORTAL_WORDS}）`, solidFeet: false };
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

/**
 * A target cell a body walks into to change dimension: the feet cell is a portal and the head cell is a portal or passable (a nether portal's
 * column is three cells; an end portal is a sheet a body falls through, over lava in a stronghold: no floor is asked of it). Gives the
 * portal's name, else null. Entered only as the last point of a walk.
 */
export function portalEntry(read: BlockReader, cell: Cell): string | null {
  const feet = read(cell.x, cell.y, cell.z);
  if (!feet || !isPortal(feet)) return null;
  const head = read(cell.x, cell.y + 1, cell.z);
  return head && (isPortal(head) || passable(head)) ? feet.name : null;
}

/**
 * What a walk's target that is a portal cell comes to (mb-llmc-cand 4, review): enter (the cell to aim at: the bottom cell of the portal's
 * column, where the feet go: the cell the walk is pointed at when it is a middle one), or refuse with the words (the top row of a frame:
 * the head meets the obsidian). null: the cell is no portal.
 */
export type PortalAim = { kind: 'enter'; name: string; cell: Cell; redirected: boolean } | { kind: 'refuse'; name: string; text: string };
export function portalAim(read: BlockReader, cell: Cell): PortalAim | null {
  const feet = read(cell.x, cell.y, cell.z);
  if (!feet || !isPortal(feet)) return null;
  const head = read(cell.x, cell.y + 1, cell.z);
  const under = read(cell.x, cell.y - 1, cell.z);
  if (head && !isPortal(head) && !passable(head)) {
    return { kind: 'refuse', name: feet.name, text: isPortal(under)
      ? `${at(cell)} は ${feet.name} の最上段: 頭が ${head.name}（枠）に当たって入れない。1 段下のポータルのマス ${at({ ...cell, y: cell.y - 1 })} へ`
      : `${at(cell)} は ${feet.name} だが頭の高さ ${at({ ...cell, y: cell.y + 1 })} が ${head.name} で入れない` };
  }
  let bottom = cell;
  for (let n = 0; n < 8 && isPortal(read(bottom.x, bottom.y - 1, bottom.z)); n++) bottom = { ...bottom, y: bottom.y - 1 };
  return { kind: 'enter', name: feet.name, cell: bottom, redirected: bottom.y !== cell.y };
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
  installDoorRules(movements);
  movements.canDig = true;
  movements.exclusionAreasBreak.push((block: any) => (block?.name && isLeaves(String(block.name)) ? 0 : 100));
  const getNeighbors = movements.getNeighbors.bind(movements);
  movements.getNeighbors = (node: any) => (getNeighbors(node) as any[]).filter(move => !(move.toBreak ?? []).some((cell: any) => cell.y < node.y));
}

/**
 * Only the door rules of the above (go uses these and digs by its own rules): a door, gate or trapdoor is open ground to the search, a
 * shut iron one is neither ground nor floor, and a jump over a gap never passes a shut door.
 */
export function installDoorRules(movements: any): void {
  if (!movements || movements.__doorRules) return;
  movements.__doorRules = true;
  movements.canOpenDoors = false;
  keepDoorPointsLow(movements.bot);
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
  const getNeighbors = movements.getNeighbors.bind(movements);
  movements.getNeighbors = (node: any) => (getNeighbors(node) as any[]).filter(move => {
    // Run 47 (hold 1): an open trapdoor at the head of the next cell stands as a wall on one edge of its cell; the search took it as open ground and the body stood 3 s against it.
    if (!move.parkour && !throughBlockers(movements, node, move)) return false;
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

/**
 * Whether the plate of an open door-like block (an open trapdoor stands on one edge of its cell, a whole block high; an open door on the side of its frame) stands on the
 * edge of `cell` that faces `side` (the edge the body crosses): a thin box (half a block or less) that spans the edge. Pure, from the block's collision boxes.
 */
export function plateOnEdge(shapes: ReadonlyArray<ReadonlyArray<number>> | undefined, side: 'west' | 'east' | 'north' | 'south'): boolean {
  return (shapes ?? []).some(box => {
    const [x0 = 0, , z0 = 0, x1 = 0, , z1 = 0] = box;
    if (side === 'west') return x0 <= 0.01 && x1 - x0 <= 0.5 && z1 - z0 >= 0.9;
    if (side === 'east') return x1 >= 0.99 && x1 - x0 <= 0.5 && z1 - z0 >= 0.9;
    if (side === 'north') return z0 <= 0.01 && z1 - z0 <= 0.5 && x1 - x0 >= 0.9;
    return z1 >= 0.99 && z1 - z0 <= 0.5 && x1 - x0 >= 0.9;
  });
}
const OPPOSITE_SIDE = { west: 'east', east: 'west', north: 'south', south: 'north' } as const;
/**
 * Whether a straight step of a move crosses the plate of an open door-like block at the height of the body: the cells of the next column that the body passes at the source level
 * (feet and head; for a climb, those of the level it climbs to as well) with their plate on the edge facing the source, and the source column's cells with theirs on the edge
 * facing the next. The move is not one the body can make (run 47, hold 1).
 */
function platesAcross(movements: any, node: any, move: any): any[] {
  const dx = move.x - node.x, dz = move.z - node.z;
  if (Math.abs(dx) + Math.abs(dz) !== 1) return [];
  const toward = dx < 0 ? 'west' : dx > 0 ? 'east' : dz < 0 ? 'north' : 'south';
  const from = OPPOSITE_SIDE[toward];
  const levels = new Set<number>([node.y, node.y + 1]);
  if (move.y > node.y) { levels.add(move.y); levels.add(move.y + 1); }
  const found: any[] = [];
  for (const y of levels) {
    const ahead = movements.getBlock(node, dx, y - node.y, dz), here = movements.getBlock(node, 0, y - node.y, 0);
    for (const [block, side] of [[ahead, from], [here, toward]] as const) {
      if (block?.name && isDoorlike(String(block.name)) && cellWay(mapBlockOf(block)) === 'open' && plateOnEdge(block.shapes, side)) found.push(block);
    }
  }
  return found;
}

const BODY_HALF = 0.3, BODY_HEIGHT = 1.8, SWEEP_STEPS = 20;
/** Whether a collision box is not a whole cell wide on both horizontal axes (a plate, a pane, a post, a bar). */
const thinShapes = (shapes: ReadonlyArray<ReadonlyArray<number>>) => shapes.every(box => (box[3] ?? 1) - (box[0] ?? 0) < 0.99 || (box[5] ?? 1) - (box[2] ?? 0) < 0.99);
/**
 * Where the feet stand on a node: the top of the block under the cell when it has a box (a slab, soul sand), else the cell's floor.
 */
function feetOf(movements: any, at: { x: number; y: number; z: number }): number {
  const under = movements.getBlock(at, 0, -1, 0);
  const top = Number(under?.height);
  return under?.shapes?.length && Number.isFinite(top) && top > at.y - 1.01 && top < at.y + 0.01 ? top : at.y;
}
/**
 * Run 47 (hold 2): a diagonal step passes the corner of the cells beside it, and the route search only asks that one of the two be free (as cells). The body is 0.6 wide: swept along the
 * line from the middle of the cell to the middle of the next, it meets the thin boxes of the cells round the corner at the height of its feet and head (an open trapdoor's or door's plate,
 * which the door rules made "free", and the thin boxes of a pane, a fence, a bar at a corner: whole blocks at a corner are slid along). Those blocks are returned; one the body stands against at
 * the start is not (it is not in the way of the step).
 */
function sweepBlockers(movements: any, node: any, move: any): any[] {
  const dx = move.x - node.x, dz = move.z - node.z;
  if (move.parkour || Math.abs(dx) !== 1 || Math.abs(dz) !== 1) return [];
  const y0 = Math.min(feetOf(movements, node), feetOf(movements, move)) + 0.02, y1 = Math.max(feetOf(movements, node), feetOf(movements, move)) + BODY_HEIGHT;
  const found = new Map<string, any>();
  for (let cy = Math.floor(y0); cy <= Math.floor(y1 - 1e-6); cy++) {
    for (const [ox, oz] of [[0, 0], [dx, 0], [0, dz], [dx, dz]] as const) {
      const block = movements.getBlock(node, ox, cy - node.y, oz);
      if (!block?.name || !Array.isArray(block.shapes) || !block.shapes.length) continue;
      const corner = (ox === 0) !== (oz === 0);
      const plate = isDoorlike(String(block.name)) && cellWay(mapBlockOf(block)) === 'open';
      if (!plate && !(corner && block.physical && thinShapes(block.shapes))) continue;
      const at = block.position;
      const hits = (t: number): boolean => {
        const px = node.x + 0.5 + dx * t, pz = node.z + 0.5 + dz * t;
        return block.shapes.some((box: number[]) =>
          px - BODY_HALF < at.x + (box[3] ?? 1) - 1e-3 && px + BODY_HALF > at.x + (box[0] ?? 0) + 1e-3 &&
          pz - BODY_HALF < at.z + (box[5] ?? 1) - 1e-3 && pz + BODY_HALF > at.z + (box[2] ?? 0) + 1e-3 &&
          y1 > at.y + (box[1] ?? 0) + 1e-3 && y0 < at.y + (box[4] ?? 1) - 1e-3);
      };
      if (hits(0)) continue;
      for (let i = 1; i <= SWEEP_STEPS; i++) if (hits(i / SWEEP_STEPS)) { found.set(`${at.x},${at.y},${at.z}`, block); break; }
    }
  }
  return [...found.values()];
}

/**
 * The blocks in the way of a move that the body's shape meets: the plates (straight steps) and, for a diagonal, what the swept body meets. They are dug when the walk may dig them
 * (the move's cost grows by the labour, as the search's own breaking does), else the move is not one the search takes (false).
 */
function throughBlockers(movements: any, node: any, move: any): boolean {
  const blockers = [...platesAcross(movements, node, move), ...sweepBlockers(movements, node, move)];
  if (!blockers.length) return true;
  const toBreak: any[] = Array.isArray(move.toBreak) ? move.toBreak : (move.toBreak = []);
  for (const block of blockers) {
    if (toBreak.some(position => position.x === block.position.x && position.y === block.position.y && position.z === block.position.z)) continue;
    if (!movements.canDig || typeof movements.safeOrBreak !== 'function') return false;
    const proxy = Object.create(block); proxy.safe = false; proxy.physical = false;
    const cost = movements.safeOrBreak(proxy, toBreak);
    if (!(cost < 100)) return false;
    move.cost += cost;
  }
  return true;
}

/**
 * The cell of a route search's point: the node it was found as (its `hash`, "x,y,z"), not the point the pathfinder then put on the top of the
 * block there (run 44, hold 1: a node standing on farmland is (216,65,206); its point is at y 64.94, whose floor is the cell 64, inside the
 * farmland: a goal there is never reached, and its search ran 5 s). A point without a hash (a test's) is read as before.
 */
export function nodeCell(point: { x: number; y: number; z: number; hash?: unknown }): Cell {
  if (typeof point.hash === 'string') {
    const [x, y, z] = point.hash.split(',').map(Number);
    if ([x, y, z].every(n => Number.isInteger(n))) return { x: x!, y: y!, z: z! };
  }
  return { x: Math.floor(point.x), y: Math.floor(point.y), z: Math.floor(point.z) };
}

/**
 * Run 44 (hold 1, a taiga village's field fenced with open spruce trapdoors): the door rules let the search go through a door, gate or trapdoor
 * cell, but the pathfinder then puts each point of its path on the top of the block in that cell (`postProcessPath`): an open trapdoor's panel is
 * a box a whole block high, so the point went a cell up, onto the panel's edge. The body walked into the cell, stood beside the panel and jumped
 * for it 5 s (the point is 0.19 away across and 1 up: never reached). The points of such cells are put back down on their own floor as the path
 * comes (`path_update` comes before the executor takes the path, and its points are the executor's own). Only while the movements in use have
 * the door rules.
 */
export function keepDoorPointsLow(bot: any): void {
  if (!bot || typeof bot.on !== 'function' || bot.__doorPointsLow) return;
  bot.__doorPointsLow = true;
  bot.on('path_update', (result: any) => {
    if (!bot.pathfinder?.movements?.__doorRules) return;
    lowerDoorPoints(bot, Array.isArray(result?.path) ? result.path : []);
  });
}
/** The points of `path` (the pathfinder's moves, after its post-processing) in a door, gate or trapdoor cell, put on that cell's floor. */
export function lowerDoorPoints(bot: any, path: any[]): number {
  let lowered = 0;
  for (const point of path) {
    // The pathfinder lifts nothing after a move that digs or lays (it stops there): neither is lowered.
    if ((point?.toBreak?.length ?? 0) > 0 || (point?.toPlace?.length ?? 0) > 0) break;
    if (typeof point?.hash !== 'string') continue;
    const cell = nodeCell(point);
    if (point.y < cell.y + 0.5) continue;
    let block: any = null;
    try { block = bot.blockAt?.(new Vec3(cell.x, cell.y, cell.z), false); } catch { block = null; }
    if (!block?.name || !isDoorlike(String(block.name))) continue;
    let floor: any = null;
    try { floor = bot.blockAt?.(new Vec3(cell.x, cell.y - 1, cell.z), false); } catch { floor = null; }
    const shapes: number[][] = Array.isArray(floor?.shapes) ? floor.shapes : [];
    const top = shapes.length && !isDoorlike(String(floor?.name ?? '')) ? Math.max(...shapes.map(shape => Number(shape[4] ?? 0))) : 1;
    point.x = cell.x + 0.5; point.y = cell.y - 1 + Math.min(1, top); point.z = cell.z + 0.5;
    lowered++;
  }
  return lowered;
}

/** A prismarine block as the rules read it (its name, its box, and for a door, gate or trapdoor whether it is open). */
export function mapBlockOf(block: any): MapBlock {
  const out: MapBlock = { name: String(block.name), solid: block.boundingBox === 'block' };
  if (out.solid && Array.isArray(block.shapes) && block.shapes.length) {
    const top = Math.max(...block.shapes.map((shape: number[]) => shape[4]));
    if (Number.isFinite(top) && top !== 1) out.top = top;
  }
  if (isDoorlike(out.name)) {
    out.open = doorOpen(block);
    if (out.open) { const plates = platesOfShapes(block.shapes); if (plates) out.plates = plates; }
  }
  return out;
}
export function doorOpen(block: any): boolean {
  try { const open = block.getProperties?.()?.open; return open === true || open === 'true'; } catch { return false; }
}
