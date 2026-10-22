/**
 * Which biomes a dimension has (mb-llmc-cand). The world answers a biome by a number, and a section of the chunk the server did not
 * send answers 0, which is `badlands` (utils/placeMemory knew it for the columns it reads): the decisions were told "badlands" in the
 * Nether (4 of the 45 scenes the replay rig checked). A name the dimension cannot have is no answer, and no answer is not said.
 */
const NETHER = new Set(['nether_wastes', 'soul_sand_valley', 'crimson_forest', 'warped_forest', 'basalt_deltas']);
const END = new Set(['the_end', 'end_highlands', 'end_midlands', 'small_end_islands', 'end_barrens']);

/** The dimension a name belongs to when it is one of the Nether's or the End's own; null for the rest (the overworld's, or unknown). */
function dimensionOfBiome(name: string): 'nether' | 'end' | null {
  return NETHER.has(name) ? 'nether' : END.has(name) ? 'end' : null;
}

/** Whether a biome name can be the one of a place in this dimension. An unknown dimension (a mod's) is not judged. */
export function biomeFitsDimension(dimension: unknown, name: string | null | undefined): name is string {
  if (typeof name !== 'string' || !/^[a-z0-9_:]+$/.test(name)) return false;
  const where = String(dimension ?? '').replace(/^minecraft:/u, '').toLowerCase();
  const own = dimensionOfBiome(name);
  if (where.includes('nether')) return own === 'nether';
  if (where === 'the_end' || where.endsWith('_end') || where === 'end') return own === 'end';
  if (where.includes('overworld')) return own === null && name !== 'the_void';
  return true;
}
