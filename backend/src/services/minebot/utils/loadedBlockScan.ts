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
  const wanted = new Map<number, string>();
  for (const name of names) {
    const block = bot.registry.blocksByName[name];
    if (block?.minStateId === undefined || block.maxStateId === undefined) continue;
    for (let state = block.minStateId; state <= block.maxStateId; state++) wanted.set(state, name);
  }
  const origin = bot.entity?.position ?? new Vec3(0, 0, 0);
  const result: LoadedBlockScan = { hits: [], columns: 0, reachMetres: 0, sectionsScanned: 0 };
  if (!wanted.size) return result;
  const maxDistance = options.maxDistance ?? Infinity;
  const maxHits = options.maxHits ?? Infinity;
  // Nearest columns first: once enough hits are in hand, no column whose
  // nearest edge lies beyond the furthest of them can improve the answer. A
  // search for a common block (stone) ends after the body's own chunk.
  const columns = (bot.world.getColumns?.() ?? []).filter(entry => entry.column?.sections).map(entry => {
    const baseX = Number(entry.chunkX) * 16, baseZ = Number(entry.chunkZ) * 16;
    const dx = Math.max(baseX - origin.x, 0, origin.x - (baseX + 16)), dz = Math.max(baseZ - origin.z, 0, origin.z - (baseZ + 16));
    return { column: entry.column, baseX, baseZ, edge: Math.hypot(dx, dz), centre: Math.hypot(baseX + 8 - origin.x, baseZ + 8 - origin.z) };
  }).sort((a, b) => a.edge - b.edge);
  result.columns = columns.length;
  result.reachMetres = Math.round(columns.reduce((reach, entry) => Math.max(reach, entry.centre), 0));
  let furthestKept = Infinity;
  for (const { column, baseX, baseZ, edge } of columns) {
    if (edge > maxDistance || edge > furthestKept) break;
    const minY = typeof column.minY === 'number' ? column.minY : 0;
    for (let index = 0; index < column.sections.length; index++) {
      const data = column.sections[index]?.data;
      if (!data) continue;
      const palette: number[] | undefined = data.palette;
      if (palette ? !palette.some(state => wanted.has(state)) : typeof data.value === 'number' && !wanted.has(data.value)) continue;
      result.sectionsScanned++;
      for (let cell = 0; cell < SECTION_VOLUME; cell++) {
        const name = wanted.get(data.get(cell));
        if (!name) continue;
        const position = new Vec3(baseX + (cell & 15), minY + index * 16 + (cell >> 8), baseZ + ((cell >> 4) & 15));
        const distance = position.distanceTo(origin);
        if (distance <= maxDistance) result.hits.push({ name, position, distance });
      }
    }
    if (result.hits.length >= maxHits) {
      result.hits.sort((a, b) => a.distance - b.distance);
      result.hits.length = maxHits;
      furthestKept = result.hits[maxHits - 1].distance;
    }
  }
  result.hits.sort((a, b) => a.distance - b.distance);
  if (result.hits.length > maxHits) result.hits.length = maxHits;
  return result;
}

/** Nearest-first positions of the named blocks within the loaded chunks: the role of bot.findBlocks by id. */
export function findLoadedBlocks(bot: ScanBot, names: Iterable<string>, maxDistance: number, count: number): Vec3[] {
  return scanLoadedBlocks(bot, names, { maxDistance, maxHits: count }).hits.map(hit => hit.position);
}
