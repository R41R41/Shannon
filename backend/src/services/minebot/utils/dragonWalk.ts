import { bodyReader, cellKey, type BlockReader, type Cell } from './localMap.js';
import type { P3 } from './dragonParts.js';

/** Read-only, conservative subset of go: cardinal walking on full blocks, at most one level per step,
 * two air cells, no digging, placing, liquids or parkour. Unknown terrain closes the way. */
export const feetCentre = (p: Cell): P3 => ({ x: p.x + 0.5, y: p.y, z: p.z + 0.5 });
const air = (b: ReturnType<BlockReader>) => !!b && /^(air|cave_air|void_air)$/u.test(b.name);
const FULL_FLOORS = new Set(['end_stone', 'end_stone_bricks', 'obsidian', 'crying_obsidian', 'bedrock', 'cobblestone', 'cobbled_deepslate', 'stone', 'dirt']);
const floor = (b: ReturnType<BlockReader>) => !!b && b.solid === true && (b.top === undefined || b.top === 1) &&
  FULL_FLOORS.has(b.name);
export const standing = (read: BlockReader, p: Cell): boolean =>
  floor(read(p.x, p.y - 1, p.z)) && air(read(p.x, p.y, p.z)) && air(read(p.x, p.y + 1, p.z));

/** A full two-block rim of known support; a lower surface by one block is allowed on slopes. */
export function inland(read: BlockReader, p: Cell): boolean {
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
    if (![0, -1, 1].some(dy => floor(read(p.x + dx, p.y - 1 + dy, p.z + dz)))) return false;
  }
  return true;
}

export interface WalkCell { cell: Cell; walkMeters: number; parent: WalkCell | null }
export interface WalkSearch {
  read: BlockReader; cells: WalkCell[]; examinedCells: number; truncated: boolean;
}
/** The search is bounded in time AND cells even on a fake clock. No I/O or controls are sent. */
export function walkGround(bot: any, options: {
  deadline: number; clock?: () => number; maxCells?: number; radius?: number; safe?: (feet: P3) => boolean;
}): WalkSearch {
  const source = bodyReader(bot), memo = new Map<string, ReturnType<BlockReader>>();
  let examinedCells = 0;
  const read: BlockReader = (x, y, z) => {
    const key = `${x},${y},${z}`;
    if (!memo.has(key)) { memo.set(key, source(x, y, z)); examinedCells++; }
    return memo.get(key)!;
  };
  const clock = options.clock ?? (() => performance.now()), at = bot.entity?.position;
  const cells: WalkCell[] = [], seen = new Set<string>();
  if (!at) return { read, cells, examinedCells, truncated: false };
  const start = { x: Math.floor(at.x), y: Math.floor(at.y + 0.001), z: Math.floor(at.z) };
  if (!standing(read, start)) return { read, cells, examinedCells, truncated: false };
  cells.push({ cell: start, walkMeters: 0, parent: null }); seen.add(cellKey(start));
  const max = options.maxCells ?? 9000, radius = options.radius ?? 80;
  let i = 0;
  for (; i < cells.length && cells.length < max && clock() < options.deadline; i++) {
    const from = cells[i], p = from.cell;
    for (const [dx, dz] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
      if (Math.hypot(p.x + dx - start.x, p.z + dz - start.z) > radius) continue;
      for (const dy of [0, 1, -1]) {
        const to = { x: p.x + dx, y: p.y + dy, z: p.z + dz }, key = cellKey(to);
        if (seen.has(key)) break;
        if (!standing(read, to)) continue;
        // Clearance over the high end of a step, including the old column on ascent.
        if (dy > 0 && !air(read(p.x, p.y + 2, p.z))) continue;
        if (dy < 0 && !air(read(to.x, p.y + 1, to.z))) continue;
        if (options.safe && !options.safe(feetCentre(to))) continue;
        seen.add(key); cells.push({ cell: to, walkMeters: from.walkMeters + Math.hypot(1, dy), parent: from }); break;
      }
    }
  }
  return { read, cells, get examinedCells() { return examinedCells; }, truncated: i < cells.length };
}

export function walkRoute(end: WalkCell): Cell[] {
  const out: Cell[] = [];
  for (let p: WalkCell | null = end; p; p = p.parent) out.push(p.cell);
  return out.reverse();
}
