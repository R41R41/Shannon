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

/** The camp cells as the planner reads them, in one short line each. */
export function campWords(site: CampSite): string {
  if (!site.cells.length) {
    const r = site.rejected;
    return `湧き場から${CAMP_RANGE}m以内に、縁の無い足場が無い（足場にならない ${r.notStanding}・火や溶岩の中か隣 ${r.hazard}・縁あり ${r.edge}・未ロード ${r.unloaded}）。place で足場を作るか、離れた足場から`;
  }
  return `野営向きの足場（湧き場から${CAMP_RANGE}m以内・縁なし・火なし。壁が多い順）: ${site.cells.map(cell => `(${cell.x}, ${cell.y}, ${cell.z}) ${cell.distance}m・壁${cell.walls}面${cell.pits ? `・3歩先までに深い穴${cell.pits}方向` : ''}`).join(' / ')}`;
}
