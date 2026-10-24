import { PerformanceObserver } from 'node:perf_hooks';
import { Vec3 } from 'vec3';

/**
 * Find rare blocks in everything the server has sent, without stopping the
 * body. mineflayer's findBlocks builds a Block object for every palette entry
 * of every section it visits and walks its search volume whether chunks are
 * loaded there or not: a search that finds nothing took 2.2s at 96 blocks and
 * 9.9s at 256 (measured), with physics and keep-alive stopped meanwhile. A
 * chunk section lists the block states it contains (its palette); a section
 * whose palette has none of the wanted states is skipped on that comparison
 * alone, so the cost is the loaded chunks, not the radius asked for.
 */
export interface LoadedBlockHit { name: string; position: Vec3; distance: number }
export interface LoadedBlockScan {
  hits: LoadedBlockHit[];
  /** Chunk columns the server has sent, and how far the furthest one reaches from the body. */
  columns: number;
  reachMetres: number;
  sectionsScanned: number;
}

interface ScanBot {
  entity?: { position: Vec3 };
  registry: { blocksByName: Record<string, { minStateId?: number; maxStateId?: number } | undefined> };
  world: { getColumns?(): Array<{ chunkX: number | string; chunkZ: number | string; column: any }> };
}

const SECTION_VOLUME = 4096;

export function scanLoadedBlocks(bot: ScanBot, names: Iterable<string>,
  options: { maxHits?: number; maxDistance?: number } = {}): LoadedBlockScan {
  return scanLoadedBlocksMany(bot, [{ names, ...options }])[0];
}

/** One search of `scanLoadedBlocksMany`: the names, and its own radius and number of hits. */
export interface LoadedBlockQuery { names: Iterable<string>; maxHits?: number; maxDistance?: number }

/**
 * Several searches in one walk over the loaded chunks (the map's marks ask for ten kinds of block at three radii every few blocks the body
 * moves: run 27 collected garbage 110-685 times a minute). Each query gets exactly what `scanLoadedBlocks` would give it alone: its hits
 * nearest first (the earlier found first among equal distances), at most its maxHits, within its maxDistance. The columns are listed and
 * sorted once; a section is read when its palette holds a state any query wants; a cell's position object is made only for a hit that is
 * kept (a lake read for water made one per water cell, thousands).
 */
export function scanLoadedBlocksMany(bot: ScanBot, queries: LoadedBlockQuery[]): LoadedBlockScan[] {
  type Search = { names: Set<string>; maxDistance: number; maxHits: number; result: LoadedBlockScan; furthestKept: number; threshold: number; done: boolean };
  const searches: Search[] = queries.map(query => ({ names: new Set(query.names), maxDistance: query.maxDistance ?? Infinity, maxHits: query.maxHits ?? Infinity,
    result: { hits: [], columns: 0, reachMetres: 0, sectionsScanned: 0 }, furthestKept: Infinity, threshold: Infinity, done: false }));
  // Every state wanted, and which searches want it.
  const wanted = new Map<number, { name: string; by: Search[] }>();
  for (const search of searches) {
    for (const name of search.names) {
      const block = bot.registry.blocksByName[name];
      if (block?.minStateId === undefined || block.maxStateId === undefined) continue;
      for (let state = block.minStateId; state <= block.maxStateId; state++) {
        const entry = wanted.get(state);
        if (!entry) wanted.set(state, { name, by: [search] });
        else if (!entry.by.includes(search)) entry.by.push(search);
      }
    }
    if (search.maxHits <= 0 || ![...search.names].some(name => bot.registry.blocksByName[name]?.minStateId !== undefined && bot.registry.blocksByName[name]?.maxStateId !== undefined)) search.done = true;
  }
  if (!wanted.size) return searches.map(search => search.result);
  const origin = bot.entity?.position ?? new Vec3(0, 0, 0);
  const ox = origin.x, oy = origin.y, oz = origin.z;
  // Nearest columns first: once enough hits are in hand, no column whose
  // nearest edge lies beyond the furthest of them can improve the answer. A
  // search for a common block (stone) ends after the body's own chunk.
  const columns = (bot.world.getColumns?.() ?? []).filter(entry => entry.column?.sections).map(entry => {
    const baseX = Number(entry.chunkX) * 16, baseZ = Number(entry.chunkZ) * 16;
    const dx = Math.max(baseX - ox, 0, ox - (baseX + 16)), dz = Math.max(baseZ - oz, 0, oz - (baseZ + 16));
    return { column: entry.column, baseX, baseZ, edge: Math.hypot(dx, dz), centre: Math.hypot(baseX + 8 - ox, baseZ + 8 - oz) };
  }).sort((a, b) => a.edge - b.edge);
  const reachMetres = Math.round(columns.reduce((reach, entry) => Math.max(reach, entry.centre), 0));
  for (const search of searches) if (!search.done) { search.result.columns = columns.length; search.result.reachMetres = reachMetres; }
  /** Sorted, cut to maxHits, and what a later hit must be nearer than to count. */
  const trim = (search: Search) => {
    const hits = search.result.hits;
    hits.sort((a, b) => a.distance - b.distance);
    if (hits.length > search.maxHits) hits.length = search.maxHits;
    if (hits.length >= search.maxHits) search.threshold = hits[search.maxHits - 1].distance;
  };
  for (const { column, baseX, baseZ, edge } of columns) {
    let open = false;
    for (const search of searches) {
      if (search.done) continue;
      if (edge > search.maxDistance || edge > search.furthestKept) search.done = true;
      else open = true;
    }
    if (!open) break;
    const minY = typeof column.minY === 'number' ? column.minY : 0;
    for (let index = 0; index < column.sections.length; index++) {
      const data = column.sections[index]?.data;
      if (!data) continue;
      const palette: number[] | undefined = data.palette;
      // The searches this section can give hits to (none: skipped on its palette alone, as before).
      let reading: Set<Search> | null = null;
      if (palette) {
        for (const state of palette) {
          const entry = wanted.get(state);
          if (!entry) continue;
          for (const search of entry.by) if (!search.done) (reading ??= new Set()).add(search);
        }
      } else if (typeof data.value === 'number') {
        const entry = wanted.get(data.value);
        if (entry) for (const search of entry.by) if (!search.done) (reading ??= new Set()).add(search);
      } else {
        for (const search of searches) if (!search.done) (reading ??= new Set()).add(search);
      }
      if (!reading) continue;
      for (const search of reading) search.result.sectionsScanned++;
      const sectionY = minY + index * 16;
      for (let cell = 0; cell < SECTION_VOLUME; cell++) {
        const entry = wanted.get(data.get(cell));
        if (!entry) continue;
        const x = baseX + (cell & 15), y = sectionY + (cell >> 8), z = baseZ + ((cell >> 4) & 15);
        const dx = ox - x, dy = oy - y, dz = oz - z;
        const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
        for (const search of entry.by) {
          if (!reading.has(search) || distance > search.maxDistance || distance >= search.threshold) continue;
          search.result.hits.push({ name: entry.name, position: new Vec3(x, y, z), distance });
          // Kept bounded while the section is read: a lake read for water no longer holds every water cell until the column ends.
          if (search.result.hits.length >= 2 * search.maxHits) trim(search);
        }
      }
    }
    for (const search of searches) {
      if (search.done || search.result.hits.length < search.maxHits) continue;
      trim(search);
      search.furthestKept = search.result.hits[search.maxHits - 1].distance;
    }
  }
  for (const search of searches) trim(search);
  return searches.map(search => search.result);
}

/**
 * A slice of work that gives the event loop back (r4: the spawn's scan and the probe's searches must never stop the body's physics and
 * keep-alive for long). `check()` is cheap; once `sliceMs` have passed since the slice began it waits one setImmediate. `longest` is the
 * longest stretch the loop was held, `slices` how many there were.
 */
export class LoopSlicer {
  private began = performance.now();
  private cpuBegan = threadCpuMs();
  longest = 0;
  slices = 1;
  /**
   * r7 (runs 30, 31: one hold of 19.4 and 27.6 ms in production, 4 ms in every lab world, the heavy one too): what the longest slice was
   * doing (`phase`, set by the caller), its window on the clock (for the garbage collections inside it, `gcWithin`) and the main thread's
   * own CPU time in it. A slice whose wall time is far above its CPU time was not the scan's work: the thread was off the CPU or collecting.
   */
  phase = '';
  longestPhase = '';
  longestCpuMs: number | null = null;
  longestStart = 0;
  longestEnd = 0;
  constructor(private readonly sliceMs = 8, private readonly yieldNow: () => Promise<void> = () => new Promise(resolve => setImmediate(resolve))) {}
  /** True when the slice is spent (the caller then awaits `pause()`). */
  due(): boolean { return performance.now() - this.began >= this.sliceMs; }
  private close(): void {
    const now = performance.now(), wall = now - this.began;
    if (wall <= this.longest) return;
    this.longest = wall; this.longestStart = this.began; this.longestEnd = now; this.longestPhase = this.phase;
    const cpu = threadCpuMs();
    this.longestCpuMs = cpu !== null && this.cpuBegan !== null ? cpu - this.cpuBegan : null;
  }
  async pause(): Promise<void> {
    this.close();
    await this.yieldNow();
    this.slices++;
    this.began = performance.now();
    this.cpuBegan = threadCpuMs();
  }
  /** The slice that ends with the work (counted in `longest`). */
  end(): void { this.close(); }
  /** The longest slice in words for the log: its phase, the main thread's CPU in it and the collections inside it (r7). */
  longestWords(): string {
    const gc = gcWithin(this.longestStart, this.longestEnd);
    const cpu = this.longestCpuMs === null ? '' : `CPU ${round1(this.longestCpuMs)} ms`;
    return [this.longestPhase || '?', cpu, gc.count ? `GC ${gc.count} 回 ${round1(gc.ms)} ms` : 'GC 0'].filter(Boolean).join('・');
  }
}

const round1 = (value: number) => Math.round(value * 10) / 10;

/** The main thread's own CPU time (ms), or null where the runtime cannot say (process.threadCpuUsage: Node 23.9 and later). */
function threadCpuMs(): number | null {
  try {
    const usage = (process as unknown as { threadCpuUsage?: () => { user: number; system: number } }).threadCpuUsage?.();
    return usage ? (usage.user + usage.system) / 1000 : null;
  } catch { return null; }
}

/**
 * The garbage collections of the last minute (start and duration, ms on performance.now()'s clock), kept by one observer started the first
 * time a scan asks (r7: to tell the scan's own work from a collection that lands inside a slice).
 */
const gcSeen: Array<{ start: number; ms: number }> = [];
let gcObserving = false;
export function watchGc(): void {
  if (gcObserving) return;
  gcObserving = true;
  try {
    const observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) gcSeen.push({ start: entry.startTime, ms: entry.duration });
      const cut = performance.now() - 60_000;
      while (gcSeen.length && (gcSeen[0].start < cut || gcSeen.length > 2000)) gcSeen.shift();
    });
    observer.observe({ entryTypes: ['gc'] });
    (observer as unknown as { unref?: () => void }).unref?.();
  } catch { gcObserving = false; }
}
/** How many collections overlapped [start, end], and their time inside it. */
export function gcWithin(start: number, end: number): { count: number; ms: number } {
  let count = 0, ms = 0;
  for (const gc of gcSeen) {
    const overlap = Math.min(end, gc.start + gc.ms) - Math.max(start, gc.start);
    if (overlap > 0) { count++; ms += overlap; }
  }
  return { count, ms };
}

/** One kind of block a sliced scan counts: its states, the nearest `keep` hits, and a height band. */
export interface ScanCategory {
  key: string;
  names: Iterable<string>;
  /** Only these states of the names (a fluid's source is its first state: level 0). Default: every state. */
  sourceOnly?: boolean;
  /** How many of the nearest hits to keep (the count is of all). Default 16. */
  keep?: number;
  /** Only cells with yMin <= y <= yMax. */
  yMin?: number; yMax?: number;
}
export interface ScanCellHit { name: string; x: number; y: number; z: number; distance: number }
export interface SlicedScanResult {
  /** Per category key: every cell counted, and the nearest kept. */
  found: Map<string, { count: number; hits: ScanCellHit[] }>;
  /** Columns read, and how far the furthest one's centre lies (m, across). */
  chunks: number; reachMetres: number;
  ms: number;
  /** The longest the event loop was held, and how many slices. */
  longestSliceMs: number; slices: number;
  /** Stopped at `maxMs` (or by `stop`) before every column was read. */
  partial: boolean;
}

/**
 * Counts the categories' blocks in the loaded chunks within `radiusChunks` (chunk columns, square, from the body's), nearest columns first,
 * giving the loop back every `sliceMs` (r4 contract 1: the scan at a spawn, about a second for 441 chunks). The same walk as
 * `scanLoadedBlocksMany` (a section is read only when its palette holds a wanted state; a cell's object is made only for a hit kept),
 * with a state-to-category table instead of a map and the palette's index read directly when the section has one.
 */
/**
 * The slice of the scan (r6, run 29: 353 Nether chunks held the loop 48.7 ms at once with a slice of 8 ms looked at only between sections and
 * columns). The clock is now also looked at inside a section, every CELLS_PER_LOOK cells.
 */
export const SCAN_SLICE_MS = 4;
const CELLS_PER_LOOK = 512;

export async function scanLoadedCategories(bot: ScanBot, categories: ScanCategory[], options: { radiusChunks?: number; sliceMs?: number; maxMs?: number;
  stop?: () => boolean; slicer?: LoopSlicer } = {}): Promise<SlicedScanResult> {
  const started = performance.now();
  watchGc();
  const slicer = options.slicer ?? new LoopSlicer(options.sliceMs ?? SCAN_SLICE_MS);
  slicer.phase = '状態の表とチャンクの一覧';
  const maxMs = options.maxMs ?? 5000;
  const found = new Map(categories.map(category => [category.key, { count: 0, hits: [] as ScanCellHit[] }]));
  const result: SlicedScanResult = { found, chunks: 0, reachMetres: 0, ms: 0, longestSliceMs: 0, slices: 1, partial: false };
  const registry = bot.registry as { blocksByName: Record<string, { minStateId?: number; maxStateId?: number } | undefined>; blocksByStateId?: Record<number, { name?: string }> };
  // The table of states: the category's index for each wanted state, -1 for the rest.
  let top = 0;
  for (const category of categories) for (const name of category.names) top = Math.max(top, registry.blocksByName[name]?.maxStateId ?? 0);
  const table = new Int16Array(top + 1).fill(-1);
  const stateName: string[] = [];
  categories.forEach((category, index) => {
    for (const name of category.names) {
      const block = registry.blocksByName[name];
      if (block?.minStateId === undefined || block.maxStateId === undefined) continue;
      const last = category.sourceOnly ? block.minStateId : block.maxStateId;
      for (let state = block.minStateId; state <= last; state++) { table[state] = index; stateName[state] = name; }
    }
  });
  const keep = categories.map(category => Math.max(1, category.keep ?? 16));
  const bands = categories.map(category => [category.yMin ?? -Infinity, category.yMax ?? Infinity] as const);
  const lists = categories.map(category => found.get(category.key)!);
  /** What a later hit of the category must be nearer than to be kept (the keep-th nearest so far). */
  const threshold = categories.map(() => Infinity);
  const trim = (index: number) => {
    const hits = lists[index].hits;
    hits.sort((a, b) => a.distance - b.distance);
    if (hits.length > keep[index]) hits.length = keep[index];
    if (hits.length >= keep[index]) threshold[index] = hits[keep[index] - 1].distance;
  };
  const origin = bot.entity?.position ?? new Vec3(0, 0, 0);
  const ox = origin.x, oy = origin.y, oz = origin.z;
  const cx0 = Math.floor(ox / 16), cz0 = Math.floor(oz / 16);
  const radius = options.radiusChunks ?? Infinity;
  const columns = (bot.world.getColumns?.() ?? []).filter(entry => entry.column?.sections
    && Math.max(Math.abs(Number(entry.chunkX) - cx0), Math.abs(Number(entry.chunkZ) - cz0)) <= radius).map(entry => {
    const baseX = Number(entry.chunkX) * 16, baseZ = Number(entry.chunkZ) * 16;
    return { column: entry.column, baseX, baseZ, centre: Math.hypot(baseX + 8 - ox, baseZ + 8 - oz) };
  }).sort((a, b) => a.centre - b.centre);
  const count = (index: number, name: string, x: number, y: number, z: number) => {
    const band = bands[index];
    if (y < band[0] || y > band[1]) return;
    lists[index].count++;
    const dx = ox - x - 0.5, dy = oy - y, dz = oz - z - 0.5;
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (distance >= threshold[index]) return;
    lists[index].hits.push({ name, x, y, z, distance });
    if (lists[index].hits.length >= 2 * keep[index]) trim(index);
  };
  if (slicer.due()) await slicer.pause();
  slicer.phase = 'ブロック読み';
  let byIndex = new Int16Array(256);
  for (const { column, baseX, baseZ, centre } of columns) {
    if (options.stop?.() || performance.now() - started > maxMs) { result.partial = true; break; }
    const minY = typeof column.minY === 'number' ? column.minY : 0;
    for (let index = 0; index < column.sections.length; index++) {
      const data = column.sections[index]?.data;
      if (!data) continue;
      const sectionY = minY + index * 16;
      if (typeof data.value === 'number' && !data.palette) {
        // One state for the whole section (a deep ocean's water).
        const category = data.value < table.length ? table[data.value] : -1;
        if (category < 0) continue;
        for (let cell = 0; cell < SECTION_VOLUME; cell++) {
          count(category, stateName[data.value], baseX + (cell & 15), sectionY + (cell >> 8), baseZ + ((cell >> 4) & 15));
          if ((cell & (CELLS_PER_LOOK - 1)) === CELLS_PER_LOOK - 1 && slicer.due()) await slicer.pause();
        }
        continue;
      }
      const palette: number[] | undefined = data.palette;
      if (palette) {
        // The category of each palette entry; nothing wanted, nothing read (as before). One table for the whole scan (r7: nothing made
        // in the loop, so no collection is started from inside a slice; a section's palette is 256 entries at most).
        let any = false;
        if (byIndex.length < palette.length) byIndex = new Int16Array(palette.length);
        for (let entry = 0; entry < palette.length; entry++) {
          const state = palette[entry];
          byIndex[entry] = state < table.length ? table[state] : -1;
          if (byIndex[entry] >= 0) any = true;
        }
        if (!any) continue;
        const bits = data.data;
        const direct = bits && typeof bits.get === 'function';
        for (let cell = 0; cell < SECTION_VOLUME; cell++) {
          if ((cell & (CELLS_PER_LOOK - 1)) === CELLS_PER_LOOK - 1 && slicer.due()) await slicer.pause();
          const entry = direct ? bits.get(cell) : palette.indexOf(data.get(cell));
          const category = byIndex[entry];
          if (category === undefined || category < 0) continue;
          count(category, stateName[palette[entry]], baseX + (cell & 15), sectionY + (cell >> 8), baseZ + ((cell >> 4) & 15));
        }
      } else {
        // The global palette (no list to skip by): every cell.
        for (let cell = 0; cell < SECTION_VOLUME; cell++) {
          if ((cell & (CELLS_PER_LOOK - 1)) === CELLS_PER_LOOK - 1 && slicer.due()) await slicer.pause();
          const state = data.get(cell);
          const category = state < table.length ? table[state] : -1;
          if (category < 0) continue;
          count(category, stateName[state], baseX + (cell & 15), sectionY + (cell >> 8), baseZ + ((cell >> 4) & 15));
        }
      }
      if (slicer.due()) await slicer.pause();
    }
    result.chunks++;
    result.reachMetres = Math.max(result.reachMetres, Math.round(centre));
    if (slicer.due()) await slicer.pause();
  }
  categories.forEach((_category, index) => trim(index));
  slicer.end();
  result.ms = Math.round(performance.now() - started);
  result.longestSliceMs = Math.round(slicer.longest * 10) / 10;
  result.slices = slicer.slices;
  return result;
}

/** Ores worth mining while something else waits (a furnace, the night). */
const ORES_WORTH_A_WAIT = ['iron_ore', 'deepslate_iron_ore', 'coal_ore', 'deepslate_coal_ore'];

/**
 * The nearest iron and coal ore in the loaded chunks, one of each kind (deepslate counted as the same kind), as
 * "iron_ore (8, 60, 3) 約9m": what start-smelting and a refused wait offer the planner to do instead of standing still.
 */
export function nearestOres(bot: ScanBot, range = 24): string[] {
  return nearestOreHits(bot, range).map(({ kind, hit }) => `${kind} (${hit.position.x}, ${hit.position.y}, ${hit.position.z}) 約${Math.round(hit.distance)}m`);
}

/** The same ores as `nearestOres`, as the hits themselves (kind without "deepslate_", and where): for a suggestion a caller can act on. */
export function nearestOreHits(bot: ScanBot, range = 24): Array<{ kind: string; hit: LoadedBlockHit }> {
  try {
    const kinds = new Map<string, LoadedBlockHit>();
    // Enough hits that a coal seam does not hide the iron.
    for (const hit of scanLoadedBlocks(bot, ORES_WORTH_A_WAIT, { maxDistance: range, maxHits: 64 }).hits) {
      const kind = hit.name.replace(/^deepslate_/, '');
      if (!kinds.has(kind)) kinds.set(kind, hit);
    }
    return [...kinds.entries()].map(([kind, hit]) => ({ kind, hit }));
  } catch { return []; }
}

/** Nearest-first positions of the named blocks within the loaded chunks: the role of bot.findBlocks by id. */
export function findLoadedBlocks(bot: ScanBot, names: Iterable<string>, maxDistance: number, count: number): Vec3[] {
  return scanLoadedBlocks(bot, names, { maxDistance, maxHits: count }).hits.map(hit => hit.position);
}
