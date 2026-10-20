/**
 * Where a bed can lie when the cells round the body will not take one as they are. Run 21: sleep-in-bed failed with "ベッドを設置できる適切な場所が見つかりませんでした"
 * in a rock passage one block wide, and the night was not skipped. Two things are added to the plain search (sleepInBed.findPlaceForBed,
 * three blocks round): a wider search over cells the body can walk to in a few steps (`walkableCells`), and, when nothing is
 * there at all, a plan for making a spot by digging rock out and filling a hole in the floor (`planBedSpot`).
 *
 * A bed is two cells long (foot and head) and one wide, on a floor under both, with a clear cell above each (the plan clears two high).
 * Pure over a `blockAt`: the doing (digging, placing) is the skill's.
 */
import { Vec3 } from 'vec3';
import { PROTECTED_UTILITY_BLOCKS } from '../constants.js';

export interface BedWorld { blockAt(position: Vec3): any }

export interface BedSpotPlan {
  /** The foot cell (the one the bed is placed on, from the floor under it) and the head cell beyond it. */
  pos: Vec3;
  head: Vec3;
  /** Rock cells to dig out, the cells over the bed first. */
  dig: Vec3[];
  /** Floor cells (under the bed) to fill, because they are air. */
  fill: Vec3[];
}

export interface BedSpotOptions {
  isFree: (block: any) => boolean;
  /** A pickaxe is carried (rock may be dug). */
  hasPickaxe: boolean;
  /** Blocks carried that can fill a hole in the floor. */
  fillers: number;
  /** Cells round the body to search (default 3). */
  radius?: number;
  /** The farthest a cell of the plan may be from the eyes (a dig or a placement is within reach). */
  reach?: number;
  /** Cells the body fills: not part of the plan. */
  body: Vec3[];
}

const LIQUIDS = new Set(['lava', 'water', 'flowing_lava', 'flowing_water', 'bubble_column']);
const HURTS = new Set(['fire', 'soul_fire', 'magma_block', 'cactus', 'sweet_berry_bush', 'powder_snow', 'campfire', 'soul_campfire', 'wither_rose']);
const FALLS = (name: string) => name === 'sand' || name === 'red_sand' || name === 'gravel' || name.endsWith('_concrete_powder') || name.endsWith('anvil') || name === 'suspicious_sand' || name === 'suspicious_gravel';
/** Never dug for a bed spot: too slow, or something somebody made. */
const KEEP_BLOCKS = new Set(['obsidian', 'crying_obsidian', 'bedrock', 'reinforced_deepslate', 'spawner', 'trial_spawner', 'vault', 'end_portal_frame', 'end_portal', 'nether_portal',
  'respawn_anchor', 'beacon', 'conduit', 'budding_amethyst']);
const SIDES: Array<[number, number, number]> = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]];
const DIRECTIONS: Array<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];

const isLiquid = (block: any) => !!block && LIQUIDS.has(String(block.name));
const hurts = (block: any) => !!block && (HURTS.has(String(block.name)) || isLiquid(block));
const isSolid = (block: any) => !!block && block.boundingBox === 'block';
const at = (world: BedWorld, cell: Vec3) => { try { return world.blockAt(cell) ?? null; } catch { return null; } };

type Kind = 'free' | 'rock' | 'bad';
function classify(world: BedWorld, cell: Vec3, isFree: BedSpotOptions['isFree']): Kind {
  const block = at(world, cell);
  if (!block) return 'bad';
  if (isFree(block)) return 'free';
  if (hurts(block)) return 'bad';
  const name = String(block.name);
  if (!isSolid(block) || block.diggable === false || PROTECTED_UTILITY_BLOCKS.has(name) || KEEP_BLOCKS.has(name) || name.endsWith('_bed')) return 'bad';
  return 'rock';
}

/** Whether digging this rock cell is safe: no liquid or fire beside, over or under it, and no sand or gravel over it that would fall in. */
function safeToDig(world: BedWorld, cell: Vec3): boolean {
  for (const [dx, dy, dz] of SIDES) {
    const neighbour = at(world, cell.offset(dx, dy, dz));
    if (hurts(neighbour)) return false;
    if (dy === 1 && neighbour && FALLS(String(neighbour.name))) return false;
  }
  return true;
}

/**
 * The cheapest bed spot that can be made within reach: foot and head cells (two cells in line) with the cell above each cleared (rock
 * dug out) and a floor under each (air filled with a carried block). Not where lava, water or fire is beside a cell to dig, not through
 * stored goods, workstations or obsidian, and not in the cells the body fills. The foot is the nearer of the two to the body, so the bed
 * lies away from it as it does when the body places it. Null when nothing fits.
 */
export function planBedSpot(world: BedWorld, position: { x: number; y: number; z: number }, options: BedSpotOptions): BedSpotPlan | null {
  const feet = new Vec3(Math.floor(position.x), Math.floor(position.y), Math.floor(position.z));
  const eyes = new Vec3(position.x, position.y + 1.62, position.z);
  const radius = options.radius ?? 3, reach = options.reach ?? 4.4;
  const within = (cell: Vec3) => cell.offset(0.5, 0.5, 0.5).distanceTo(eyes) <= reach;
  const inBody = (cell: Vec3) => options.body.some(other => other.equals(cell));
  let best: { plan: BedSpotPlan; cost: number; distance: number } | null = null;
  for (let x = -radius; x <= radius; x++) for (let z = -radius; z <= radius; z++) for (const y of [0, -1]) {
    const pos = feet.offset(x, y, z);
    for (const [dx, dz] of DIRECTIONS) {
      // The head lies beyond the foot, away from the body.
      if (dx * (pos.x + 0.5 - position.x) + dz * (pos.z + 0.5 - position.z) <= 0) continue;
      const head = pos.offset(dx, 0, dz);
      const cells = [pos.offset(0, 1, 0), head.offset(0, 1, 0), pos, head];
      if (cells.some(cell => inBody(cell) || !within(cell))) continue;
      const dig: Vec3[] = [];
      let ok = true;
      for (const cell of cells) {
        const kind = classify(world, cell, options.isFree);
        if (kind === 'bad') { ok = false; break; }
        if (kind === 'rock') { if (!safeToDig(world, cell)) { ok = false; break; } dig.push(cell); }
      }
      if (!ok || (dig.length && !options.hasPickaxe)) continue;
      const fill: Vec3[] = [];
      for (const cell of [pos, head]) {
        const floor = cell.offset(0, -1, 0);
        const block = at(world, floor);
        if (isSolid(block) && !hurts(block)) continue;
        // A hole in the floor: one cell is filled, if there is ground under it and the filler can be put on it.
        const below = at(world, floor.offset(0, -1, 0));
        if (!block || !options.isFree(block) || !isSolid(below) || hurts(below) || !within(floor)) { ok = false; break; }
        fill.push(floor);
      }
      if (!ok || fill.length > options.fillers) continue;
      const cost = dig.length + 2 * fill.length;
      const distance = pos.offset(0.5, 0.5, 0.5).distanceTo(eyes);
      if (!best || cost < best.cost || (cost === best.cost && distance < best.distance)) {
        best = { plan: { pos, head, dig, fill }, cost, distance };
      }
    }
  }
  return best?.plan ?? null;
}

/**
 * Cells the body can walk to from where it stands in at most `steps` steps (one block up or down at a time), by feet cell. A cheap
 * stand-in for asking the path planner: "within a short walk" for the wider bed search.
 */
export function walkableCells(world: BedWorld, position: { x: number; y: number; z: number }, steps: number, limit = 900): Map<string, number> {
  const start = new Vec3(Math.floor(position.x), Math.floor(position.y), Math.floor(position.z));
  const key = (cell: Vec3) => `${cell.x},${cell.y},${cell.z}`;
  const standable = (cell: Vec3) => {
    const feet = at(world, cell), head = at(world, cell.offset(0, 1, 0)), floor = at(world, cell.offset(0, -1, 0));
    return !!feet && !!head && !!floor && !isSolid(feet) && !isSolid(head) && !hurts(feet) && !hurts(head) && isSolid(floor) && !hurts(floor);
  };
  const seen = new Map<string, number>([[key(start), 0]]);
  let frontier = [start];
  for (let step = 1; step <= steps && frontier.length && seen.size < limit; step++) {
    const next: Vec3[] = [];
    for (const cell of frontier) {
      for (const [dx, dz] of DIRECTIONS) {
        for (const dy of [0, 1, -1, -2]) {
          const to = cell.offset(dx, dy, dz);
          if (seen.has(key(to)) || !standable(to)) continue;
          // A step up needs the cell over the one it leaves to be open; a drop needs the cell it falls through to be.
          const over = at(world, cell.offset(0, 2, 0));
          if (dy === 1 && (!over || isSolid(over))) continue;
          if (dy < 0 && isSolid(at(world, cell.offset(dx, 1, dz)))) continue;
          seen.set(key(to), step);
          next.push(to);
        }
      }
    }
    frontier = next;
  }
  return seen;
}
