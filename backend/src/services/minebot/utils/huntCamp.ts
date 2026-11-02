import { hazardAtFeetWith } from './primitives/go.js';

/**
 * Where to stand at a blaze spawner (S2, 2026-11-02).
 *
 * Within three blocks of the spawner (aibengineering/mine-ai-mcp's camp range, MIT: src/actions/hunt-mob/spawner-camp.ts), because the blazes the spawner draws
 * appear within four blocks of it and hover where they appear: one that stays beyond a sword's reach is never struck, one that appears within it is. But the lab
 * (a staged natural world's fortress) showed what the nearest standable cell may be: the spawner room's north opening, a ledge a block wide above a pit three
 * deep; a blow or a blaze's melee pushes the body off it, and the body that has fallen cannot climb back without blocks. So a camp cell is one that is:
 *   - standable (a floor, two open cells over it) and not in or beside fire, lava or magma (the same rule as `go`'s destination check),
 *   - without an edge: each of its four neighbours that is open has a floor at most one cell lower (a push of one block cannot drop the body),
 *   - ranked by how few sides lead to a pit within three cells, then by how many sides are walls (a push is stopped, and fewer sides are open to the blazes),
 *     then by nearness to two blocks from the spawner.
 * This reads the cells only; the way there is `go`'s.
 */

export interface CampCellBlock { name: string; /** A full collision box (the map reader's word); else judged by `boundingBox`. */ solid?: boolean; boundingBox?: string }
export type CampReader = (x: number, y: number, z: number) => CampCellBlock | null | undefined;
export interface CampCell { x: number; y: number; z: number; /** Horizontal distance from the spawner's middle. */ distance: number; /** Of the four sides, those closed by a block at the feet or head. */ walls: number; /** Sides on which, within three cells along an open way, the floor is gone for three or more (a pit). */ pits: number }
export interface CampSite {
  spawner: { x: number; y: number; z: number };
  cells: CampCell[];
  /** Cells within the range that were looked at, and why the rest were left: not standable, in or beside a hazard, or with an edge. */
  considered: number; rejected: { notStanding: number; hazard: number; edge: number; unloaded: number };
  /** Fire blocks within five blocks of the spawner. */
  fire: number;
}

/** The blocks from the spawner within which a camp is made. */
export const CAMP_RANGE = 3;
const FIRE = new Set(['fire', 'soul_fire']);
const NOT_A_FLOOR = new Set(['magma_block', 'lava', 'water', 'soul_sand', 'soul_soil', 'cobweb']);
const SIDES: ReadonlyArray<readonly [number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const solid = (block: CampCellBlock | null | undefined): boolean => !!block && (block.solid ?? block.boundingBox === 'block');
const open = (block: CampCellBlock | null | undefined): boolean => !!block && !solid(block) && !['lava', 'water', 'fire', 'soul_fire'].includes(block.name);

export function campSite(read: CampReader, spawner: { x: number; y: number; z: number }, limit = 4): CampSite {
  const names = (x: number, y: number, z: number): string | null => read(x, y, z)?.name ?? null;
  const rejected = { notStanding: 0, hazard: 0, edge: 0, unloaded: 0 };
  const cells: CampCell[] = [];
  let considered = 0;
  for (let dx = -CAMP_RANGE; dx <= CAMP_RANGE; dx++) for (let dz = -CAMP_RANGE; dz <= CAMP_RANGE; dz++) {
    const distance = Math.hypot(dx, dz);
    if (distance > CAMP_RANGE + 1e-6 || distance < 1) continue;
    for (let dy = -1; dy <= 1; dy++) {
      const x = spawner.x + dx, y = spawner.y + dy, z = spawner.z + dz;
      const feet = read(x, y, z), head = read(x, y + 1, z), floor = read(x, y - 1, z);
      if (!feet || !head || !floor) { rejected.unloaded++; continue; }
      considered++;
      if (!open(feet) || !open(head) || !solid(floor) || NOT_A_FLOOR.has(floor.name)) { rejected.notStanding++; continue; }
      if (hazardAtFeetWith(names, x, y, z)) { rejected.hazard++; continue; }
      let walls = 0, edge = false, pits = 0;
      for (const [ux, uz] of SIDES) {
        if (solid(read(x + ux, y, z + uz)) || solid(read(x + ux, y + 1, z + uz))) { walls++; continue; }
        // An open side: the body pushed one block onto it must still have a floor within one cell below the feet.
        if (!solid(read(x + ux, y - 1, z + uz)) && !solid(read(x + ux, y - 2, z + uz))) { edge = true; break; }
        // Further along that side, up to three cells while the way is open: a cell with no floor within three under the feet is a pit a push or a flight from fire may end in.
        for (let k = 1; k <= 3; k++) {
          if (solid(read(x + k * ux, y, z + k * uz)) || solid(read(x + k * ux, y + 1, z + k * uz))) break;
          if ([1, 2, 3].every(down => !solid(read(x + k * ux, y - down, z + k * uz)))) { pits++; break; }
        }
      }
      if (edge) { rejected.edge++; continue; }
      cells.push({ x, y, z, distance: Math.round(distance * 10) / 10, walls, pits });
    }
  }
  cells.sort((a, b) => a.pits - b.pits || b.walls - a.walls || Math.abs(a.distance - 2) - Math.abs(b.distance - 2));
  let fire = 0;
  for (let dx = -5; dx <= 5; dx++) for (let dz = -5; dz <= 5; dz++) for (let dy = -3; dy <= 3; dy++) if (FIRE.has(names(spawner.x + dx, spawner.y + dy, spawner.z + dz) ?? '')) fire++;
  return { spawner, cells: cells.slice(0, limit), considered, rejected, fire };
}

// ---- where to go when the health runs low: a footing no blaze of the spawner can see ---------------------------------------------------------

export interface Hideout { x: number; y: number; z: number; /** Steps of the walk from the camp cell (a step is one cell across, up or down one). */ steps: number }
/** How far (steps of the walk) a hideout is looked for. */
export const HIDEOUT_STEPS = 40;
/** Where the blazes of a spawner may be (feet): the spawn box is four blocks round it, one up or down, and they hover up to three higher. */
const SHOOTER_SPOTS: ReadonlyArray<readonly [number, number, number]> = (() => {
  const spots: Array<readonly [number, number, number]> = [];
  for (const dx of [-4, -2, 0, 2, 4]) for (const dz of [-4, -2, 0, 2, 4]) for (const dy of [-1, 0, 2, 3]) spots.push([dx, dy, dz]);
  return spots;
})();
/** The eye of a blaze (1.8 high, 0.85 of it) and a body's eye and chest, as `threatExposure` reads a line. */
const BLAZE_EYE = 1.53, BODY_EYE = 1.62, BODY_CHEST = 0.9;

/** Blocks with a collision box that a line still passes: a fence's post is a quarter wide, the half of a stair or a slab is open (so a footing behind one is not hidden). */
const SEE_THROUGH = /fence|bars|pane|_wall$|stairs|slab|chain|ladder|sign|vine|web/u;
const blocksSight = (block: CampCellBlock | null | undefined): boolean => solid(block) && !SEE_THROUGH.test(block!.name);

/** Whether a straight line between two points passes through no solid cell (the cells at the two ends are not asked). */
function openLine(solidAt: (x: number, y: number, z: number) => boolean, from: [number, number, number], to: [number, number, number]): boolean {
  const length = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
  const steps = Math.max(1, Math.ceil(length / 0.25));
  const cellOf = (p: number[]) => [Math.floor(p[0]), Math.floor(p[1]), Math.floor(p[2])];
  const a = cellOf(from), b = cellOf(to);
  let lastKey = '';
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const x = Math.floor(from[0] + (to[0] - from[0]) * t), y = Math.floor(from[1] + (to[1] - from[1]) * t), z = Math.floor(from[2] + (to[2] - from[2]) * t);
    const key = `${x},${y},${z}`;
    if (key === lastKey) continue;
    lastKey = key;
    if ((x === a[0] && y === a[1] && z === a[2]) || (x === b[0] && y === b[1] && z === b[2])) continue;
    if (solidAt(x, y, z)) return false;
  }
  return true;
}

/** Whether a blaze of the spawner (anywhere it may hover, see SHOOTER_SPOTS) has a clear line to the eye or the chest of a body standing at the cell. */
export function seenFromSpawner(read: CampReader, spawner: { x: number; y: number; z: number }, cell: { x: number; y: number; z: number }): boolean {
  return exposureFromSpawner(read, spawner, cell, true) > 0;
}

/**
 * The share (0 to 1) of the places a blaze of the spawner may hover (SHOOTER_SPOTS that are open air) from which a body standing at the cell is in sight. `any`: stops at the first (the answer is only whether it is above 0).
 */
export function exposureFromSpawner(read: CampReader, spawner: { x: number; y: number; z: number }, cell: { x: number; y: number; z: number }, any = false): number {
  const solidAt = (x: number, y: number, z: number) => blocksSight(read(x, y, z));
  let spots = 0, seeing = 0;
  for (const [dx, dy, dz] of SHOOTER_SPOTS) {
    // A blaze hovers in open air: a spot in rock (or not loaded) is nowhere a shot can come from.
    if (!open(read(spawner.x + dx, spawner.y + dy, spawner.z + dz)) || !open(read(spawner.x + dx, spawner.y + dy + 1, spawner.z + dz))) continue;
    spots++;
    const eye: [number, number, number] = [spawner.x + 0.5 + dx, spawner.y + dy + BLAZE_EYE, spawner.z + 0.5 + dz];
    if (openLine(solidAt, eye, [cell.x + 0.5, cell.y + BODY_EYE, cell.z + 0.5]) || openLine(solidAt, eye, [cell.x + 0.5, cell.y + BODY_CHEST, cell.z + 0.5])) { seeing++; if (any) return 1; }
  }
  return spots ? seeing / spots : 0;
}

/**
 * Footings that no blaze of the spawner can see (S2, 2026-11-02, S4's c1 trials: the camp's health ran down faster than a head's turn, and the floor's own ways out found
 * "no way out"): walkable cells within `maxSteps` of `from` (a breadth-first walk over standable cells, one across and at most one up or down a step) from which none of the places a
 * blaze of the spawner may be (the spawn box, hovering) has a line to the body's eye or chest. Nearest first. This reads the cells only; the way there is `go`'s.
 */
export function hideoutsFrom(read: CampReader, spawner: { x: number; y: number; z: number }, from: { x: number; y: number; z: number }, limit = 3, maxSteps = HIDEOUT_STEPS): Hideout[] {
  const names = (x: number, y: number, z: number): string | null => read(x, y, z)?.name ?? null;
  const standable = (x: number, y: number, z: number): boolean => {
    const feet = read(x, y, z), head = read(x, y + 1, z), floor = read(x, y - 1, z);
    return !!feet && !!head && !!floor && open(feet) && open(head) && solid(floor) && !NOT_A_FLOOR.has(floor.name) && !hazardAtFeetWith(names, x, y, z);
  };
  const hidden = (x: number, y: number, z: number): boolean => !seenFromSpawner(read, spawner, { x, y, z });
  const seen = new Map<string, number>([[`${from.x},${from.y},${from.z}`, 0]]);
  const queue: Array<{ x: number; y: number; z: number }> = [{ x: from.x, y: from.y, z: from.z }];
  const found: Hideout[] = [];
  for (let head = 0; head < queue.length && queue.length < 2500; head++) {
    const cell = queue[head]!;
    const steps = seen.get(`${cell.x},${cell.y},${cell.z}`)!;
    if (steps > 0 && hidden(cell.x, cell.y, cell.z)) { found.push({ ...cell, steps }); if (found.length >= limit * 3) break; }
    if (steps >= maxSteps) continue;
    for (const [ux, uz] of SIDES) for (const dy of [0, 1, -1]) {
      const x = cell.x + ux, y = cell.y + dy, z = cell.z + uz;
      const key = `${x},${y},${z}`;
      if (seen.has(key)) continue;
      if (dy === 1 && !open(read(cell.x, cell.y + 2, cell.z))) continue;
      if (dy === -1 && !(open(read(x, cell.y, z)) && open(read(x, cell.y + 1, z)))) continue;
      if (!standable(x, y, z)) continue;
      seen.set(key, steps + 1);
      queue.push({ x, y, z });
    }
  }
  // Nearest first; of equal steps, the one farther from the spawner.
  return found.sort((a, b) => a.steps - b.steps || Math.hypot(b.x - spawner.x, b.z - spawner.z) - Math.hypot(a.x - spawner.x, a.z - spawner.z)).slice(0, limit);
}

/** The hideouts as the planner reads them. */
export function hideoutWords(list: Hideout[], within = HIDEOUT_STEPS): string {
  if (!list.length) return `隠れ場所（湧き場のどこからも見えない足場）は ${within} 歩内に無い。体力が減ったら go で湧き場から遠ざかって食べる`;
  return `隠れ場所（湧き場のどこからも見えない足場。野営マスから歩数）: ${list.map(h => `(${h.x}, ${h.y}, ${h.z}) ${h.steps}歩`).join(' / ')}。体力が12を切ったらそこへ go して食べ、体力が戻ってから野営マスへ戻る`;
}

/** The camp cells as the planner reads them, in one short line each. */
export function campWords(site: CampSite): string {
  if (!site.cells.length) {
    const r = site.rejected;
    return `湧き場から${CAMP_RANGE}m以内に、縁の無い足場が無い（足場にならない ${r.notStanding}・火や溶岩の中か隣 ${r.hazard}・縁あり ${r.edge}・未ロード ${r.unloaded}）。place で足場を作るか、離れた足場から`;
  }
  return `野営向きの足場（湧き場から${CAMP_RANGE}m以内・縁なし・火なし。壁が多い順）: ${site.cells.map(cell => `(${cell.x}, ${cell.y}, ${cell.z}) ${cell.distance}m・壁${cell.walls}面${cell.pits ? `・3歩先までに深い穴${cell.pits}方向` : ''}`).join(' / ')}`;
}
