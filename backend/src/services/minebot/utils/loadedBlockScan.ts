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

/** Ores worth mining while something else waits (a furnace, the night). */
const ORES_WORTH_A_WAIT = ['iron_ore', 'deepslate_iron_ore', 'coal_ore', 'deepslate_coal_ore'];

/**
 * The nearest iron and coal ore in the loaded chunks, one of each kind (deepslate counted as the same kind), as
 * "iron_ore (8, 60, 3) 約9m": what start-smelting and a refused wait offer the planner to do instead of standing still. `floor`
 * leaves out what lies below it (the night gate's floor).
 */
export function nearestOres(bot: ScanBot, range = 24, floor = -Infinity): string[] {
  return nearestOreHits(bot, range, floor).map(({ kind, hit }) => `${kind} (${hit.position.x}, ${hit.position.y}, ${hit.position.z}) 約${Math.round(hit.distance)}m`);
}

/** The same ores as `nearestOres`, as the hits themselves (kind without "deepslate_", and where): for a suggestion a caller can act on. */
export function nearestOreHits(bot: ScanBot, range = 24, floor = -Infinity): Array<{ kind: string; hit: LoadedBlockHit }> {
  try {
    const kinds = new Map<string, LoadedBlockHit>();
    // Enough hits that a coal seam does not hide the iron, and that what lies below the floor is not all there is.
    for (const hit of scanLoadedBlocks(bot, ORES_WORTH_A_WAIT, { maxDistance: range, maxHits: 64 }).hits) {
      if (hit.position.y < floor) continue;
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
