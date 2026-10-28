import { scanLoadedBlocks } from './loadedBlockScan.js';
import type { Utilities } from '../integration/commonFca/continueContract.js';

/**
 * The work benches, furnaces, chests and beds near the body, with the proof of how it knows (continue contracts, 3): the head's `near` condition
 * ("a crafting table within 8 m") was never judgeable (it had nothing to read). The body adds `state.world.utilities`: the radius, the dimension, the
 * observation it was read for, whether the scan really covered loaded ground (`scanned`), and what was found (nearest first, 12 at most). The head
 * judges `near` only when `scanned` is true and the condition's radius is within `radius`; otherwise it says it cannot tell.
 */
export const UTILITY_RADIUS = 8;
const COLOURS = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'];
export const UTILITY_BLOCKS: readonly string[] = ['crafting_table', 'furnace', 'blast_furnace', 'smoker', 'chest', 'trapped_chest', 'barrel', ...COLOURS.map(colour => `${colour}_bed`)];
const FOUND_MAX = 12;
/** The scan is read again after this long or after the body moved this far (it walks the loaded chunks' palettes: cheap, but not for every 100 ms). */
const REUSE_MS = 1500;
const REUSE_MOVE = 1.5;

interface Cached { at: number; x: number; y: number; z: number; dim: string; found: Utilities['found']; scanned: boolean }
const cache = new WeakMap<object, Cached>();

export function utilitiesOf(bot: any, obsSeq: number, now: number = Date.now()): Utilities | null {
  const position = bot?.entity?.position;
  if (!position || !bot.world || !bot.registry?.blocksByName) return null;
  const dim = String(bot.game?.dimension ?? '').replace(/^minecraft:/u, '');
  let kept = cache.get(bot);
  const moved = kept ? Math.hypot(position.x - kept.x, position.y - kept.y, position.z - kept.z) : Infinity;
  if (!kept || kept.dim !== dim || now - kept.at > REUSE_MS || moved > REUSE_MOVE) {
    let scan: ReturnType<typeof scanLoadedBlocks> | null = null;
    try { scan = scanLoadedBlocks(bot, UTILITY_BLOCKS, { maxDistance: UTILITY_RADIUS, maxHits: 64 }); } catch { scan = null; }
    kept = { at: now, x: position.x, y: position.y, z: position.z, dim, scanned: !!scan && scan.columns > 0,
      found: (scan?.hits ?? []).slice().sort((a, b) => a.distance - b.distance).slice(0, FOUND_MAX)
        .map(hit => ({ block: hit.name, at: { x: hit.position.x, y: hit.position.y, z: hit.position.z }, distance: Math.round(hit.distance * 10) / 10 })) };
    cache.set(bot, kept);
  }
  return { radius: UTILITY_RADIUS, dim, obsSeq, scanned: kept.scanned, found: kept.found };
}
