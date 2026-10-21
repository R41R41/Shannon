/**
 * Looking for trees, and telling the mind where wood is.
 *
 * Run 24 (a world with no tree within 128 m of the start): the first order asked for logs, the body had no way to go and look for any --
 * explore-for-structure knew villages, beds and animals -- and it went looking for a village to the east for 91 s, over 215 m of desert and
 * into the sea, then north (stuck in the water), then west. 419 seconds, no wood. A shipwreck stood 149 m to the south the whole time (its
 * hull is oak and spruce, ten to fifty logs and the planks), and the map did not say it was wood.
 *   - `treesInSight`: the logs among the chunks the server has sent;
 *   - `treeHeading`: which way to look when nothing is in sight (the nearest biome that grows trees in the memory of the biomes seen, else
 *     away from the nearest sea or desert);
 *   - `overWater`: a leg that would take the body out onto the sea is not walked;
 *   - `woodLine`: one line for the map the mind plans a route from -- where the trees are, or that there are none in sight, and where wood
 *     lies otherwise (a shipwreck, a village's houses, planks of an old mine).
 */
import { Vec3 } from 'vec3';
import { scanLoadedBlocks, type LoadedBlockHit } from './loadedBlockScan.js';
import { biomesAround, compassDirection, type PlaceMemoryState } from '../../../modules/minecraftLearning/places.js';
import type { Heading } from './explore.js';
import { exploreHeading } from './explore.js';

export const LOG_NAMES = ['oak_log', 'spruce_log', 'birch_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log', 'pale_oak_log'];
export const PLANK_NAMES = ['oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'mangrove_planks', 'cherry_planks', 'pale_oak_planks'];
/** How far the loaded chunks are read for logs. */
export const TREE_SCAN_M = 128;

/** Biomes that grow trees, by how many (the weight is the thickness of the wood). */
const TREE_WEIGHT: Array<[RegExp, number]> = [
  [/^(forest|flower_forest|birch_forest|old_growth_birch_forest|dark_forest|old_growth_pine_taiga|old_growth_spruce_taiga|taiga|jungle|bamboo_jungle|mangrove_swamp|cherry_grove|pale_garden)$/, 3],
  [/^(snowy_taiga|sparse_jungle|windswept_forest|grove|swamp|wooded_badlands)$/, 2],
  [/^(savanna|savanna_plateau|windswept_savanna|windswept_hills|meadow)$/, 1],
  [/^(plains|sunflower_plains)$/, 0.4],
];
/** Biomes with no trees to speak of, and the sea (a walk there is slow, and ends in the water). */
const NO_TREES = /^(desert|badlands|eroded_badlands|snowy_plains|ice_spikes|.*ocean|river|frozen_river|beach|snowy_beach|stony_shore|mushroom_fields|stony_peaks|jagged_peaks|frozen_peaks|snowy_slopes)$/;
const WATER_BIOME = /^(.*ocean|river|frozen_river|beach|snowy_beach)$/;

export function treeWeight(biome: string): number {
  for (const [pattern, weight] of TREE_WEIGHT) if (pattern.test(biome)) return weight;
  return 0;
}

interface TreeBody {
  entity?: { position: Vec3; yaw?: number };
  registry: { blocksByName: Record<string, { minStateId?: number; maxStateId?: number } | undefined> };
  world: { getColumns?(): Array<{ chunkX: number | string; chunkZ: number | string; column: any }> };
  blockAt?(position: Vec3, extraInfos?: boolean): { name?: string; boundingBox?: string } | null;
  placeMemory?: { state?: PlaceMemoryState; recall?(kind?: string, limit?: number): Array<{ distance: number; direction: string; position: { x: number; y: number; z: number }; note?: string; count?: number }> };
  game?: { dimension?: unknown };
}

export interface TreesSeen { count: number; nearest: LoadedBlockHit | null; hits: LoadedBlockHit[] }

/** The logs among the loaded chunks within `range`: how many were counted (up to 64), the nearest, and the hits. */
export function treesInSight(bot: TreeBody, range = TREE_SCAN_M): TreesSeen {
  try {
    const scan = scanLoadedBlocks(bot as never, LOG_NAMES, { maxDistance: range, maxHits: 64 });
    return { count: scan.hits.length, nearest: scan.hits[0] ?? null, hits: scan.hits };
  } catch { return { count: 0, nearest: null, hits: [] }; }
}

/** The cardinal heading nearest a compass direction of the memory ("北東" counts as north or east, by which axis the offset is longer). */
function cardinalOf(from: { x: number; z: number }, to: { x: number; z: number }): Heading {
  const dx = to.x - from.x, dz = to.z - from.z;
  const name = Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? 'east' : 'west') : (dz > 0 ? 'south' : 'north');
  return exploreHeading(name, 0)!;
}

/**
 * Which way to look for trees. The nearest biome that grows them in the memory of the biomes seen (thicker woods count for more than a
 * short way); with none known, away from the sea and the sand (the cardinal with the least water and desert in the memory); with nothing
 * known at all, the way the body faces.
 */
export function treeHeading(bot: TreeBody, columns?: Record<string, string>): { heading: Heading; why: string } {
  const here = bot.entity?.position ?? new Vec3(0, 64, 0);
  const dimension = String(bot.game?.dimension ?? 'overworld');
  const facing = exploreHeading(undefined, bot.entity?.yaw ?? 0)!;
  const biomes = columns ?? bot.placeMemory?.state?.biomes?.[dimension];
  if (!biomes) return { heading: facing, why: 'バイオームの記憶が無いので向いている方角' };
  // The nearest column that grows trees (a thick wood counts as nearer than a thin one: its distance is divided by its weight), and the
  // sea and sand beside the body, by side, for when none is known.
  let target: { x: number; z: number; biome: string; distance: number; cost: number } | null = null;
  const wet: Record<string, number> = { north: 0, south: 0, east: 0, west: 0 };
  const barren: Record<string, number> = { north: 0, south: 0, east: 0, west: 0 };
  for (const [key, biome] of Object.entries(biomes)) {
    const [chunkX, chunkZ] = key.split(',').map(Number);
    const x = chunkX * 16 + 8, z = chunkZ * 16 + 8;
    const distance = Math.hypot(x - here.x, z - here.z);
    if (distance < 16) continue;
    const weight = treeWeight(biome);
    if (weight > 0) {
      const cost = distance / weight;
      if (!target || cost < target.cost) target = { x, z, biome, distance, cost };
    } else if (NO_TREES.test(biome)) {
      const side = cardinalOf(here, { x, z }).name;
      const near = 1 / (1 + distance / 48);
      barren[side] += near;
      if (WATER_BIOME.test(biome)) wet[side] += near;
    }
  }
  if (target) {
    const heading = cardinalOf(here, target);
    return { heading, why: `${target.biome} が${SIDE_WORD[heading.name]}に約${Math.round(target.distance)}m（記憶）` };
  }
  // No wood known: the side with the least sea, then the least sand and rock.
  const sides = ['north', 'south', 'east', 'west'];
  const driest = sides.slice().sort((a, b) => wet[a] - wet[b] || barren[a] - barren[b])[0];
  return { heading: exploreHeading(driest, 0)!, why: '木の生えるバイオームは記憶に無いので、海から遠い方角' };
}

const SIDE_WORD: Record<string, string> = { north: '北', south: '南', east: '東', west: '西' };
/** What the surface of the column (x, z) is near the body's level: 'water', 'land', or 'unknown' (not loaded). */
export function surfaceKind(bot: Pick<TreeBody, 'blockAt'>, x: number, z: number, aroundY: number): 'water' | 'land' | 'unknown' {
  for (let y = Math.floor(aroundY) + 14; y >= Math.floor(aroundY) - 24; y--) {
    let block: { name?: string; boundingBox?: string } | null = null;
    try { block = bot.blockAt?.(new Vec3(x, y, z), false) ?? null; } catch { block = null; }
    if (!block) return 'unknown';
    if (block.name === 'water' || block.name === 'kelp' || block.name === 'seagrass' || block.name === 'tall_seagrass') return 'water';
    if (block.boundingBox === 'block') return 'land';
  }
  return 'unknown';
}

/**
 * Whether the leg from `from` along `heading` for `length` metres goes mostly out over water (more than `share` of the columns sampled
 * every four blocks, those loaded).
 */
export function overWater(bot: Pick<TreeBody, 'blockAt'>, from: { x: number; y: number; z: number }, heading: { dx: number; dz: number }, length: number, share = 0.4): boolean {
  let water = 0, known = 0;
  for (let along = 8; along <= length; along += 4) {
    const kind = surfaceKind(bot, Math.round(from.x + heading.dx * along), Math.round(from.z + heading.dz * along), from.y);
    if (kind === 'unknown') continue;
    known++;
    if (kind === 'water') water++;
  }
  return known >= 3 && water / known > share;
}

const compass = (from: Vec3, to: { x: number; z: number }) => compassDirection(from, to);
const where = (from: Vec3, at: { x: number; y: number; z: number }) => `${Math.round(Math.hypot(at.x - from.x, at.z - from.z))}m ${compass(from, at)} (${at.x},${at.y},${at.z})`;

const cached = new WeakMap<object, { at: number; line: string }>();
const WOOD_LINE_TTL_MS = 8_000;

/**
 * One line about wood for the map the route is planned from (empty when the body is not in the overworld or has nothing to say): the
 * nearest tree and how many are in sight, or that there are none within TREE_SCAN_M; the wood a structure holds (a shipwreck's hull, a
 * village's houses, the planks of an old mine) is named after it, nearest first.
 */
export function woodLine(bot: TreeBody, now = Date.now()): string {
  if (!bot.entity?.position || !String(bot.game?.dimension ?? 'overworld').includes('overworld')) return '';
  // A body that cannot read the chunks it has been sent (a probe, a test double) has nothing to say about trees.
  if (typeof bot.world?.getColumns !== 'function' || !bot.registry?.blocksByName) return '';
  const hit = cached.get(bot);
  if (hit && now - hit.at < WOOD_LINE_TTL_MS) return hit.line;
  const here = bot.entity.position;
  let line = '';
  try {
    const trees = treesInSight(bot);
    const parts: string[] = [];
    if (trees.nearest) {
      const at = trees.nearest.position.floored();
      // "112m 北 (x,y,z) oak_log×12": the nearest log and the logs standing within ten blocks of it (a tree is five to ten, a wood many more).
      const stand = trees.hits.filter(hit => hit.position.distanceTo(trees.nearest!.position) <= 10).length;
      parts.push(`${where(here, at)} ${trees.nearest.name}×${stand}（${TREE_SCAN_M}m以内に原木${trees.count >= 64 ? '64本以上' : `${trees.count}本`}見える）`);
    } else {
      const { heading, why } = treeHeading(bot);
      parts.push(`原木が${TREE_SCAN_M}m以内の読み込み済みの範囲に1本も見えません（砂漠・荒野・海・川には木がほぼ無い。村を探しに行っても木は無い）。`
        + `木を探すなら explore-for-structure structureType=tree（${heading.name}へ。${why}）`);
    }
    // Wood that is not a tree: the hull of a shipwreck, the houses of a village, planks of a mine or a hut.
    const sources: string[] = [];
    const recalled = (kind: string, note: string, limit: number) => {
      try { for (const place of bot.placeMemory?.recall?.(kind, limit) ?? []) sources.push(`${note} ${place.distance}m ${place.direction} (${place.position.x},${place.position.y},${place.position.z})`); } catch { /* the memory is optional */ }
    };
    recalled('shipwreck', '難破船（船体は原木・板材、十数〜数十本。箱つき）', 1);
    recalled('village', '村（家は板材・原木）', 1);
    const planks = scanLoadedBlocks(bot as never, PLANK_NAMES, { maxDistance: TREE_SCAN_M, maxHits: 1 }).hits[0];
    if (planks && planks.distance > 4) sources.push(`板材の建物（廃坑・小屋・家）${where(here, planks.position.floored())}`);
    if (sources.length) parts.push(`木材の出どころ: ${sources.join('、')}`);
    line = `木: ${parts.join('。')}`;
  } catch { line = ''; }
  cached.set(bot, { at: now, line });
  return line;
}
