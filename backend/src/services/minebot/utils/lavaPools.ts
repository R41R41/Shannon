/**
 * Lava the body can make obsidian of, seen the same way by the search (find-blocks) and by the tool that pours (use-item-on-block).
 *
 * Run 24: find-blocks said "a lava source, can be scooped with a bucket" for a pool 29 m off, the body walked there for 64 s, and
 * use-item-on-block answered in no time "no lava with air over it" -- twice, at the same pool, 140 s with nothing made. The pool lay under
 * a roof of rock: the pourer only took a source with air over it, the search listed every source. They now say the same thing:
 *   - `open`: air over the source -- water is poured at once;
 *   - `covered`: rock over it (one cell, diggable, with no lava beside it) and a cell beside the rock the body can stand in -- the cover is
 *     dug from there and the water poured into the opening;
 *   - `buried`: lava or water over it, or a cover that cannot be dug from any side -- not poured on.
 * The size of the pool (the sources joined to it) and the work to open it decide which pool to take: ten obsidian are looked for in a pool
 * of ten or more sources before a small one (a small one is used up with the count still short and the walk to the next one begins).
 */
import { Vec3 } from 'vec3';
import { digRefusal, floorDrop } from './tunnelWalk.js';
import { getWaterLevel } from './waterLevel.js';
import { PROTECTED_UTILITY_BLOCKS } from '../constants.js';

interface BlockLike { name?: string; boundingBox?: string }
export interface PoolWorld {
  blockAt(position: Vec3, extraInfos?: boolean): (BlockLike & { position?: Vec3 }) | null;
  entity?: { position: Vec3 };
  inventory?: { items(): any[] };
}

export type LavaTop = 'open' | 'covered' | 'buried';
export interface LavaSourceInfo {
  at: Vec3;
  top: LavaTop;
  /** `covered`: the rock cell over the source, and the cell beside it to dig it from. */
  cap?: Vec3;
  stand?: Vec3;
  /** Sources joined to this one through lava (it included), at most POOL_CAP. */
  poolSize: number;
  /** Lava cells beside it at its level (a source at the rim of a pool has fewer). */
  lavaNeighbours: number;
}

export const POOL_CAP = 60;
const HORIZONTAL: Array<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const SIX: Array<[number, number, number]> = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const key = (at: { x: number; y: number; z: number }) => `${at.x},${at.y},${at.z}`;

function read(world: PoolWorld, at: Vec3): (BlockLike & { position?: Vec3 }) | null {
  try { return world.blockAt(at, false); } catch { return null; }
}
const isLava = (block: BlockLike | null) => block?.name === 'lava';
/** A lava source: a cell of lava at level 0 (flowing lava is 1-7, falling lava 8 and up). */
export function isLavaSource(block: BlockLike | null): boolean {
  if (!isLava(block)) return false;
  try { return getWaterLevel(block as never) === 0; } catch { return false; }
}

/** How many sources are joined to the one at `at` through lava, counting it; a flood fill bounded by POOL_CAP. */
export function poolSizeOf(world: PoolWorld, at: Vec3, cache?: Map<string, number>): number {
  const cached = cache?.get(key(at));
  if (cached !== undefined) return cached;
  const seen = new Set<string>([key(at)]);
  const queue: Vec3[] = [at];
  const sources: string[] = [];
  for (let head = 0; head < queue.length && sources.length < POOL_CAP && seen.size < 600; head++) {
    const cell = queue[head];
    const block = read(world, cell);
    if (!isLava(block)) continue;
    if (isLavaSource(block)) sources.push(key(cell));
    for (const [dx, dy, dz] of SIX) {
      const next = cell.offset(dx, dy, dz);
      if (seen.has(key(next))) continue;
      seen.add(key(next));
      queue.push(next);
    }
  }
  for (const source of sources) cache?.set(source, sources.length);
  return sources.length;
}

/** Blocks that fall into the opening of a cap, and what is never dug. */
const FALLING = /^(gravel|sand|red_sand|suspicious_sand|suspicious_gravel|.*_concrete_powder)$/;
const NEVER_DUG = (name: string) => name === 'bedrock' || PROTECTED_UTILITY_BLOCKS.has(name);

/**
 * Why the rock over a source may not be dug, or null. Lava under it is the point (it is not a reason); lava or water over it or beside it
 * would run into the opening, and a block that falls would fill it.
 */
export function capRefusal(world: PoolWorld, cap: Vec3): string | null {
  const block = read(world, cap);
  if (!block) return 'unloaded';
  if (NEVER_DUG(block.name ?? '') || (block as { diggable?: boolean }).diggable === false) return `undiggable:${block.name}`;
  // Obsidian over lava is the crust of a pool already turned: it is dug with water on top (dig-block-at keeps its drop), not opened as a cover.
  if (block.name === 'obsidian') return 'obsidian_crust';
  for (const [dx, dy, dz] of [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) {
    const next = read(world, cap.offset(dx, dy, dz));
    if (!next) return 'unloaded';
    if (next.name === 'lava' || next.name === 'water') return `${next.name}_beside`;
    if (dy === 1 && FALLING.test(next.name ?? '')) return `falling_above:${next.name}`;
  }
  return null;
}
/** The cell beside `cap` to dig it from: standable (solid floor, no lava in or beside), and the way to it not lava-bound; null when none. */
export function standBeside(world: PoolWorld, cap: Vec3): Vec3 | null {
  const bot = world as never;
  let best: { cell: Vec3; open: boolean } | null = null;
  for (const [dx, dz] of HORIZONTAL) {
    const stand = cap.offset(dx, 0, dz), head = stand.offset(0, 1, 0);
    const feet = read(world, stand), above = read(world, head);
    if (!feet || !above) continue;
    if (feet.boundingBox === 'empty' && (feet.name === 'water' || feet.name === 'lava')) continue;
    if (digRefusal(bot, stand, []) || digRefusal(bot, head, [])) continue;
    if (floorDrop(bot, stand.offset(0, -1, 0), false) !== 0) continue;
    const open = feet.boundingBox === 'empty' && above.boundingBox === 'empty';
    if (!best || (open && !best.open)) best = { cell: stand, open };
  }
  return best?.cell ?? null;
}

/** What the source at `at` is, for pouring on: null when it is not a lava source at all. */
export function lavaSourceInfo(world: PoolWorld, at: Vec3, poolCache?: Map<string, number>): LavaSourceInfo | null {
  const block = read(world, at);
  if (!isLavaSource(block)) return null;
  const over = read(world, at.offset(0, 1, 0));
  const lavaNeighbours = HORIZONTAL.filter(([dx, dz]) => isLava(read(world, at.offset(dx, 0, dz)))).length;
  const base = { at, poolSize: poolSizeOf(world, at, poolCache), lavaNeighbours };
  if (!over) return { ...base, top: 'buried' };
  if (over.name === 'lava' || over.name === 'water') return { ...base, top: 'buried' };
  if (over.boundingBox === 'empty') return { ...base, top: 'open' };
  // Rock over it: one cell dug, from beside it.
  const cap = at.offset(0, 1, 0);
  if (capRefusal(world, cap)) return { ...base, top: 'buried' };
  const stand = standBeside(world, cap);
  return stand ? { ...base, top: 'covered', cap, stand } : { ...base, top: 'buried' };
}

/** What the work of opening a pool is worth (seconds): nothing for an open top, a dig and the way to the cell beside it for a covered one. */
export const COVER_SECONDS = 6;
/** Pools of at least this many sources are preferred to a small one for the count asked. */
export function wantedPoolSize(count: number): number { return Math.max(1, Math.min(12, Math.ceil(count * 0.6))); }

/**
 * Which source to pour on next, best first: a source whose pool is as big as the count needs (up to the size asked), then the work
 * (distance to it, and the cover to open), a source at the rim of the pool (fewer lava cells beside it) before one in the middle, since
 * its obsidian has no lava beside it to burn what is dug. `refused`: sources poured on without success are not offered again.
 */
export function rankLavaSources(infos: LavaSourceInfo[], here: Vec3, count: number, refused: Map<string, number> = new Map()): LavaSourceInfo[] {
  const want = wantedPoolSize(count);
  const score = (info: LavaSourceInfo) => {
    const walk = Math.hypot(info.at.x - here.x, info.at.y - here.y, info.at.z - here.z) * 0.4;
    const cover = info.top === 'covered' ? COVER_SECONDS : 0;
    const pool = info.poolSize >= want ? 0 : (want - info.poolSize) * 6;
    return walk + cover + pool + info.lavaNeighbours * 0.8;
  };
  return infos
    .filter(info => info.top !== 'buried' && (refused.get(key(info.at)) ?? 0) < 2)
    .sort((a, b) => score(a) - score(b));
}

/** The words for the search's list: the pool and how its top is opened. */
export function describeLavaSource(info: LavaSourceInfo): string {
  // "（水源12個・岩に覆われている）": the mind reads the size ("水源N個") and the cover ("覆われている／覆われていない") from this.
  const size = `水源${info.poolSize >= POOL_CAP ? `${POOL_CAP}個以上` : `${info.poolSize}個`}`;
  if (info.top === 'open') return `（${size}・岩に覆われていない）［すぐ水をかけられる］`;
  if (info.top === 'covered') return `（${size}・岩に覆われている）［覆い1枚を横の(${info.stand!.x},${info.stand!.y},${info.stand!.z})から掘って開けてから水をかける。use-item-on-block が自分で掘る］`;
  return `（${size}・岩に覆われている）［上が溶岩か水で、水をかけられない（同じ溜まりの上の層を先に使う）］`;
}
