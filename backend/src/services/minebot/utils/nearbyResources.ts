import { Vec3 } from 'vec3';
import { scanLoadedBlocks, type LoadedBlockHit } from './loadedBlockScan.js';
import { woodHits, WOOD_SCAN_HITS, TREE_SCAN_M } from './treeSearch.js';
import { currentMarks } from './mapMarks.js';
import { FOOD_ANIMALS } from './nearbyNeeds.js';
import { feetCell, type Cell } from './localMap.js';

/**
 * What lies near, by what it is for (run 7, 11/11: the planner had a line of trees "oak_log×12" and one cow at 9.5 m, and took the cow and the minimum of wood): one entry
 * per purpose with how many there are, how far the count reaches, and the nearest few places, so a planner can weigh "how much is near" against "how much is needed". The body
 * only lists; it does not say what to take (no sufficiency here: that is the planner's, from the numbers). The places are full coordinates (the planner's hands take them as
 * they are); the planner works out the way and the distance from its feet of the moment.
 *   - wood: the logs within TREE_SCAN_M, grouped into trees (logs touching are one tree), the nearest three trees by their foot;
 *   - food_animal: food animals the body sees (the entities it is told of, within ANIMAL_M), the nearest three;
 *   - food_village: a village's hay (made into wheat, then bread: three to a block) and its fields, within VILLAGE_M of the body;
 *   - ore: ore with a face open to air (the map marks' own), one place per kind; bed and water: the map marks' own;
 *   - lava: the lava pools within LAVA_M at any height (sources only, touching sources one pool), the nearest three pools by their nearest source, each with its sources, how far across
 *     and how far up or down from the feet, and whether a solid block covers it (run 8, 11/13: four pools at y 20, -19, -45 and -55 were in sight and the planner was given only the
 *     nearest source, 27 down across a cave; it took 191 s to reach). Overworld only (the Nether is a lava sea).
 * Read from the same scans as the map's marks and the wood line where it can (one more query: the village's hay and fields), kept CACHE_MS or CACHE_MOVE blocks.
 */
export interface NearbyResource {
  purpose: 'wood' | 'food_animal' | 'food_village' | 'ore' | 'bed' | 'water' | 'lava';
  kind: string;
  count: number;
  /** How far from the body the count reaches (m): what was looked at, so "none" can be told from "not looked". */
  range: number;
  /** For wood: the trees these logs make. */
  trees?: number;
  /** For lava: the pools these sources make. */
  pools?: number;
  sites: Array<{ x: number; y: number; z: number; note?: string }>;
}

export const ANIMAL_M = 48;
export const VILLAGE_M = 128;
export const LAVA_M = 96;
const LAVA_HITS = 2048;
const SITES = 3;
/** Places of one kind closer than this to one already named are the same place (a tree's trunk, a field, a pile of hay). */
const SAME_PLACE_M = 4;
const CACHE_MS = 3000;
const CACHE_MOVE = 4;
const CROPS = ['hay_block', 'wheat', 'carrots', 'potatoes', 'beetroots'];
const CROP_LABEL: Record<string, string> = { hay_block: 'hay_block', wheat: 'wheat', carrots: 'carrots', potatoes: 'potatoes', beetroots: 'beetroots' };
const MATURE_AGE: Record<string, number> = { wheat: 7, carrots: 7, potatoes: 7, beetroots: 3 };
const ORE_MARKS = new Set(['iron', 'coal', 'diamond', 'gold', 'redstone', 'lapis', 'copper', 'emerald', 'quartz', 'ancient_debris']);

interface Body {
  entity?: { position?: Vec3 } | null;
  entities?: Record<string, any>;
  registry?: any;
  world?: any;
  game?: { dimension?: unknown };
  blockAt?(position: Vec3, extraInfos?: boolean): any;
  landmarks?: Array<{ kind: string; position: { x: number; y: number; z: number } }>;
}

const cache = new WeakMap<object, { at: number; from: Cell; dimension: string; list: NearbyResource[] }>();
const cellOf = (position: { x: number; y: number; z: number }) => ({ x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) });
const flat = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);

/** The nearest `SITES` places, a place being skipped when it lies within SAME_PLACE_M of one already named. `hits` come nearest first. */
function nearestSites(hits: LoadedBlockHit[], note?: (hit: LoadedBlockHit) => string | undefined): NearbyResource['sites'] {
  const sites: NearbyResource['sites'] = [];
  for (const hit of hits) {
    if (sites.some(site => Math.hypot(site.x - hit.position.x, site.y - hit.position.y, site.z - hit.position.z) <= SAME_PLACE_M)) continue;
    const text = note?.(hit);
    sites.push({ ...cellOf(hit.position), ...(text ? { note: text } : {}) });
    if (sites.length >= SITES) break;
  }
  return sites;
}

/** Logs grouped into trees (touching by a side, an edge or a corner), each with its foot (the lowest log), its log count and its nearest log's distance. */
export function treesOf(hits: LoadedBlockHit[]): Array<{ foot: Cell; logs: number; distance: number; kind: string }> {
  const parent = hits.map((_, index) => index);
  const find = (index: number): number => { while (parent[index] !== index) { parent[index] = parent[parent[index]]; index = parent[index]; } return index; };
  const byCell = new Map<string, number>();
  hits.forEach((hit, index) => byCell.set(`${hit.position.x},${hit.position.y},${hit.position.z}`, index));
  hits.forEach((hit, index) => {
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      if (!dx && !dy && !dz) continue;
      const other = byCell.get(`${hit.position.x + dx},${hit.position.y + dy},${hit.position.z + dz}`);
      if (other !== undefined) parent[find(index)] = find(other);
    }
  });
  const groups = new Map<number, LoadedBlockHit[]>();
  hits.forEach((hit, index) => { const root = find(index); (groups.get(root) ?? groups.set(root, []).get(root)!).push(hit); });
  return [...groups.values()].map(group => {
    const foot = group.reduce((low, hit) => (hit.position.y < low.position.y ? hit : low), group[0]);
    return { foot: cellOf(foot.position), logs: group.length, distance: Math.min(...group.map(hit => hit.distance)), kind: group[0].name };
  }).sort((a, b) => a.distance - b.distance);
}

/** Lava sources grouped into pools (touching by a side, an edge or a corner), each with its nearest source, its count, and that source's distance; nearest pool first. */
export function lavaPoolsOf(hits: LoadedBlockHit[]): Array<{ nearest: Cell; sources: number; distance: number }> {
  const parent = hits.map((_, index) => index);
  const find = (index: number): number => { while (parent[index] !== index) { parent[index] = parent[parent[index]]; index = parent[index]; } return index; };
  const byCell = new Map<string, number>();
  hits.forEach((hit, index) => byCell.set(`${hit.position.x},${hit.position.y},${hit.position.z}`, index));
  hits.forEach((hit, index) => {
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const other = (dx || dy || dz) ? byCell.get(`${hit.position.x + dx},${hit.position.y + dy},${hit.position.z + dz}`) : undefined;
      if (other !== undefined) parent[find(index)] = find(other);
    }
  });
  const groups = new Map<number, LoadedBlockHit[]>();
  hits.forEach((hit, index) => { const root = find(index); (groups.get(root) ?? groups.set(root, []).get(root)!).push(hit); });
  return [...groups.values()].map(group => {
    const near = group.reduce((best, hit) => (hit.distance < best.distance ? hit : best), group[0]);
    return { nearest: cellOf(near.position), sources: group.length, distance: near.distance };
  }).sort((a, b) => a.distance - b.distance);
}

function computeList(bot: Body, feet: Cell, now: number): NearbyResource[] {
  const list: NearbyResource[] = [];
  const dimension = String(bot.game?.dimension ?? 'overworld');
  // Wood: from the wood line's own scan (overworld only; the line says nothing elsewhere).
  if (dimension.includes('overworld') && typeof bot.world?.getColumns === 'function' && bot.registry?.blocksByName) {
    const hits = woodHits(bot as never, now);
    const trees = treesOf(hits);
    const kinds = [...new Set(hits.map(hit => hit.name))];
    list.push({ purpose: 'wood', kind: kinds.length === 1 ? kinds[0] : 'log', count: hits.length, range: TREE_SCAN_M, trees: trees.length,
      sites: trees.slice(0, SITES).map(tree => ({ ...tree.foot, note: `${tree.kind} 幹 ${tree.logs} 本` })) });
    if (hits.length >= WOOD_SCAN_HITS) list[list.length - 1].range = Math.ceil(hits[hits.length - 1].distance);   // the count stopped at the cap: it reaches only as far as the farthest log counted
  }
  // Food animals the body is told of (entities within the tracking range; adults and babies alike are animals, a baby is marked).
  const here = bot.entity?.position;
  if (here) {
    const kinds = new Map<string, Array<{ entity: any; distance: number }>>();
    for (const entity of Object.values(bot.entities ?? {}) as any[]) {
      const name = String(entity?.name ?? '').toLowerCase();
      if (!entity?.position || !FOOD_ANIMALS.has(name)) continue;
      const distance = entity.position.distanceTo(here);
      if (distance > ANIMAL_M) continue;
      (kinds.get(name) ?? kinds.set(name, []).get(name)!).push({ entity, distance });
    }
    const all = [...kinds.entries()].sort((a, b) => Math.min(...a[1].map(x => x.distance)) - Math.min(...b[1].map(x => x.distance)));
    for (const [name, group] of all) {
      group.sort((a, b) => a.distance - b.distance);
      list.push({ purpose: 'food_animal', kind: name, count: group.length, range: ANIMAL_M,
        sites: group.slice(0, SITES).map(({ entity }) => ({ ...cellOf(entity.position), note: `#${entity.id}` })) });
    }
  }
  // A village's hay and fields: the scan the marks make reaches 96 m; this one 128 m. Only where a village is known (the marks' own condition).
  const village = dimension.includes('overworld') ? (bot.landmarks ?? []).find(mark => mark.kind === 'village' && flat(mark.position, feet) <= 160) : undefined;
  if (village && bot.registry && bot.world) {
    try {
      const hits = scanLoadedBlocks(bot as never, CROPS, { maxDistance: VILLAGE_M, maxHits: 256 }).hits;
      for (const name of CROPS) {
        const kindHits = hits.filter(hit => hit.name === name);
        if (!kindHits.length) continue;
        const age = MATURE_AGE[name];
        let grown = 0;
        const grownNote = (hit: LoadedBlockHit): string | undefined => {
          if (age === undefined) return undefined;
          try { return Number(bot.blockAt?.(hit.position, false)?.getProperties?.().age) >= age ? '育った' : '育ち中'; } catch { return undefined; }
        };
        if (age !== undefined) for (const hit of kindHits.slice(0, 64)) if (grownNote(hit) === '育った') grown++;
        list.push({ purpose: 'food_village', kind: CROP_LABEL[name] ?? name, count: kindHits.length, range: VILLAGE_M,
          sites: nearestSites(kindHits, hit => name === 'hay_block' ? `作れば最大パン ${kindHits.length * 3}` : age !== undefined ? `${grownNote(hit) ?? ''}（育った ${grown}/${Math.min(kindHits.length, 64)}）` : undefined) });
      }
    } catch { /* a village's food is only a list: none read, none said */ }
  }
  // Ore, beds and water: the map marks' own (one place per kind of ore, up to three beds, the nearest water source).
  for (const mark of currentMarks(bot as never, now)) {
    const count = Number(/×(\d+)/u.exec(mark.note)?.[1] ?? 1);
    if (ORE_MARKS.has(mark.kind)) list.push({ purpose: 'ore', kind: mark.name, count, range: 24, sites: [{ ...mark.cell }] });
    else if (mark.kind === 'bed') {
      const was = list.find(entry => entry.purpose === 'bed');
      if (was) { was.count++; if (was.sites.length < SITES) was.sites.push({ ...mark.cell }); } else list.push({ purpose: 'bed', kind: 'bed', count: 1, range: 48, sites: [{ ...mark.cell }] });
    } else if (mark.kind === 'water') list.push({ purpose: 'water', kind: 'water', count: 1, range: 48, sites: [{ ...mark.cell }] });
  }
  // Lava pools: one scan of the loaded chunks for sources (flows are not counted, so a lake's flows do not crowd out the pools beyond it), at any height.
  if (dimension.includes('overworld') && bot.registry?.blocksByName && typeof bot.world?.getColumns === 'function') {
    try {
      const scan = scanLoadedBlocks(bot as never, ['lava'], { maxDistance: LAVA_M, maxHits: LAVA_HITS, sourceOnly: true });
      const pools = lavaPoolsOf(scan.hits);
      if (pools.length) {
        const covered = (cell: Cell): string => {
          try { return bot.blockAt?.(new Vec3(cell.x, cell.y + 1, cell.z), false)?.boundingBox === 'block' ? '○' : '×'; } catch { return '?'; }
        };
        list.push({ purpose: 'lava', kind: 'lava', count: scan.hits.length, range: scan.hits.length >= LAVA_HITS ? Math.ceil(scan.hits[scan.hits.length - 1].distance) : LAVA_M, pools: pools.length,
          sites: pools.slice(0, SITES).map(pool => {
            const dy = pool.nearest.y - feet.y;
            return { ...pool.nearest, note: `源 ${pool.sources}・足から 水平 ${Math.round(flat(pool.nearest, feet))}m・高さ ${dy > 0 ? '+' : ''}${dy}・覆い ${covered(pool.nearest)}` };
          }) });
      }
    } catch { /* lava is only a list: none read, none said */ }
  }
  return list;
}

/** What lies near by purpose (see NearbyResource), for the frame. Never throws; empty when nothing was read. */
export function nearbyResources(bot: Body, now = Date.now()): NearbyResource[] {
  try {
    const feet = feetCell(bot as never);
    if (!feet) return [];
    const dimension = String(bot.game?.dimension ?? '');
    const cached = cache.get(bot as object);
    if (cached && cached.dimension === dimension && now - cached.at < CACHE_MS && Math.hypot(cached.from.x - feet.x, cached.from.y - feet.y, cached.from.z - feet.z) < CACHE_MOVE) return cached.list;
    const list = computeList(bot, feet, now);
    cache.set(bot as object, { at: now, from: feet, dimension, list });
    return list;
  } catch { return []; }
}
