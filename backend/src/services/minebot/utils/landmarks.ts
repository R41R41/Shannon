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
  const hits = scanLoadedBlocks(bot, ['bell', 'hay_block', ...JOB_SITES, ...beds], { maxHits: 512 }).hits;
  const villagers = Object.values(bot.entities ?? {}).filter(entity => entity?.name === 'villager' && entity.position) as Array<{ position: Vec3 }>;
  const kindOf = (hit: LoadedBlockHit) => hit.name.endsWith('_bed') ? 'bed' : hit.name;
  const tried: LoadedBlockHit[] = [];
  for (const seed of hits) {
    if (tried.some(other => other.position.distanceTo(seed.position) <= CLUSTER_RADIUS)) continue;
    tried.push(seed);
    if (tried.length > 6) break;
    const cluster = hits.filter(hit => hit.position.distanceTo(seed.position) <= CLUSTER_RADIUS);
    const counts = new Map<string, number>();
    for (const hit of cluster) counts.set(kindOf(hit), (counts.get(kindOf(hit)) ?? 0) + 1);
    const near = villagers.filter(villager => villager.position.distanceTo(seed.position) <= CLUSTER_RADIUS).length;
    // A bed is two blocks: three beds are six bed blocks.
    const isVillage = counts.has('bell') || (near > 0 && counts.size > 0) || counts.size >= 2 || (counts.get('bed') ?? 0) >= 6;
    if (!isVillage) continue;
    const evidence = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([name, count]) => name === 'bed' ? `ベッド${Math.ceil(count / 2)}台` : `${name}×${count}`);
    if (near) evidence.push(`村人${near}人`);
    return { kind: 'village', distance: Math.round(seed.distance), direction: compassDirection(origin, seed.position),
      position: { x: seed.position.x, y: seed.position.y, z: seed.position.z }, evidence: evidence.join('、') };
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
