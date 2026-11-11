import { Vec3 } from 'vec3';
import { scanLoadedBlocks, type LoadedBlockHit } from './loadedBlockScan.js';

/**
 * What a player would notice on the horizon. The body has no eyes: it has the
 * chunks the server sent. A village shows in them as blocks that only a
 * village (or the body itself, one at a time) puts there, and as villagers.
 * The old search called oak planks and cobblestone "traces of a village" and
 * reported the bot's own cobblestone one block away (paid run L21).
 */
export interface Landmark {
  kind: 'village';
  distance: number;
  /** Compass direction from the body, e.g. 北東. */
  direction: string;
  position: { x: number; y: number; z: number };
  evidence: string;
}

const JOB_SITES = ['composter', 'lectern', 'smithing_table', 'blast_furnace', 'smoker', 'grindstone', 'fletching_table',
  'cartography_table', 'loom', 'barrel', 'stonecutter', 'brewing_stand', 'cauldron'];
const CLUSTER_RADIUS = 48;
/** Once a village is found, its beds, hay and chests are counted this far from the seed (a village is wider than the cluster that proves it: run 6 saw 3 beds in 48 m of 9, and hay 104 m off). */
const VILLAGE_SPAN = 72;
/** A chest counts as the village's within this many cells of height of the seed (a chest 58 down is a mineshaft's). */
const VILLAGE_CHEST_DY = 12;
/** A bed costs about this many seconds on a round of the village (run 4: 6 beds and 12 bread in 146 s), plus a fixed part; a guide, said as one. */
const SECONDS_PER_BED = 15, ROUND_FIXED_SECONDS = 30, ROUND_MAX_SECONDS = 180;
/** Work sites that only villages put down in numbers (not the barrel or cauldron of a ship or a hut). */
const STRONG_JOB_SITES = new Set(JOB_SITES.filter(name => name !== 'barrel' && name !== 'cauldron'));
/** Villages stand on the surface: markers below this are a ruin, a mineshaft's or a cave's, not a village. */
const VILLAGE_MIN_Y = 40;
const LANDMARK_SAMPLE_TICKS = 100;

interface LandmarkBot {
  entity?: { position: Vec3 };
  entities?: Record<string, { name?: string; position?: Vec3 } | undefined>;
  registry: { blocksByName: Record<string, { minStateId?: number; maxStateId?: number } | undefined> };
  world: { getColumns?(): Array<{ chunkX: number | string; chunkZ: number | string; column: any }> };
  landmarks?: Landmark[];
  on?(event: 'physicsTick', listener: () => void): unknown;
}

export function compassDirection(from: { x: number; z: number }, to: { x: number; z: number }): string {
  const names = ['東', '南東', '南', '南西', '西', '北西', '北', '北東'];
  const angle = Math.atan2(to.z - from.z, to.x - from.x); // +x east, +z south
  return names[((Math.round(angle / (Math.PI / 4)) % 8) + 8) % 8];
}

/**
 * A village within the loaded chunks, or null. One kind of marker alone is
 * not enough (the body carries its own bed and barrel): a bell, villagers
 * beside a marker, two kinds of marker together, or three beds together.
 */
export function detectVillage(bot: LandmarkBot): Landmark | null {
  const origin = bot.entity?.position;
  if (!origin || typeof bot.world?.getColumns !== 'function') return null;
  const beds = Object.keys(bot.registry.blocksByName).filter(name => name.endsWith('_bed'));
  const hits = scanLoadedBlocks(bot, ['bell', 'hay_block', 'chest', ...JOB_SITES, ...beds], { maxHits: 512 }).hits;
  const villagers = Object.values(bot.entities ?? {}).filter(entity => entity?.name === 'villager' && entity.position) as Array<{ position: Vec3 }>;
  const kindOf = (hit: LoadedBlockHit) => hit.name.endsWith('_bed') ? 'bed' : hit.name;
  const tried: LoadedBlockHit[] = [];
  for (const seed of hits) {
    if (seed.name === 'chest') continue;
    if (tried.some(other => other.position.distanceTo(seed.position) <= CLUSTER_RADIUS)) continue;
    tried.push(seed);
    if (tried.length > 6) break;
    // A chest is not a village marker (the body carries and places its own): it is counted in the evidence only.
    const cluster = hits.filter(hit => hit.name !== 'chest' && hit.position.distanceTo(seed.position) <= CLUSTER_RADIUS);
    const counts = new Map<string, number>();
    for (const hit of cluster) counts.set(kindOf(hit), (counts.get(kindOf(hit)) ?? 0) + 1);
    const near = villagers.filter(villager => villager.position.distanceTo(seed.position) <= CLUSTER_RADIUS).length;
    // Near the surface, with a bell or a work site that villages alone put down: eight barrels and four beds at y -13 were taken for a
    // village from the first decision of run 17 to the last (barrels and cauldrons stand in shipwrecks, huts and ruins too).
    const strongSite = [...counts.keys()].some(kind => STRONG_JOB_SITES.has(kind));
    const isVillage = seed.position.y >= VILLAGE_MIN_Y && (counts.has('bell') || (strongSite && (counts.size >= 2 || near > 0)));
    if (!isVillage) continue;
    // The whole village's counts, from the seed out to VILLAGE_SPAN: beds (two halves a bed), hay, chests at the village's height; the villagers; then up to two other markers.
    const wide = hits.filter(hit => hit.position.distanceTo(seed.position) <= VILLAGE_SPAN);
    const beds2 = Math.ceil(wide.filter(hit => hit.name.endsWith('_bed')).length / 2);
    const hay = wide.filter(hit => hit.name === 'hay_block').length;
    const chests = wide.filter(hit => hit.name === 'chest' && Math.abs(hit.position.y - seed.position.y) <= VILLAGE_CHEST_DY).length;
    const folk = villagers.filter(villager => villager.position.distanceTo(seed.position) <= VILLAGE_SPAN).length;
    const evidence: string[] = [];
    if (beds2) evidence.push(`ベッド${beds2}台`);
    if (hay) evidence.push(`干し草${hay}（パン${hay * 3}）`);
    if (chests) evidence.push(`箱${chests}`);
    if (folk) evidence.push(`村人${folk}人`);
    const others = [...counts.entries()].filter(([name]) => name !== 'bed' && name !== 'hay_block').sort((a, b) => b[1] - a[1]).slice(0, 2).map(([name, count]) => `${name}×${count}`);
    evidence.push(...others);
    if (beds2) evidence.push(`一周 約${Math.floor(Math.min(ROUND_MAX_SECONDS, beds2 * SECONDS_PER_BED + ROUND_FIXED_SECONDS) / 10) * 10}秒（目安）`);
    evidence.push('取り方: 家の外へ go range=3 → dig takeOk（箱は chest takeAll）');
    return { kind: 'village', distance: Math.round(seed.distance), direction: compassDirection(origin, seed.position),
      position: { x: seed.position.x, y: seed.position.y, z: seed.position.z }, evidence: evidence.slice(0, -1).join('、') + `。${evidence[evidence.length - 1]}` };
  }
  return null;
}

/** Keep `bot.landmarks` current: what is in view changes only as chunks load, so a look every few seconds is enough. */
export function installLandmarkWatcher(bot: LandmarkBot): void {
  if (bot.landmarks || typeof bot.on !== 'function') return;
  bot.landmarks = [];
  let tick = 0;
  bot.on('physicsTick', () => {
    if (++tick % LANDMARK_SAMPLE_TICKS !== 0) return;
    try { const village = detectVillage(bot); bot.landmarks = village ? [village] : []; } catch { /* perception must not stop the body */ }
  });
}

export function landmarkWatcherPlugin(bot: unknown): void { installLandmarkWatcher(bot as LandmarkBot); }
