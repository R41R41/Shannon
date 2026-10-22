import { Vec3 } from 'vec3';
import { LoopSlicer, SCAN_SLICE_MS, scanLoadedCategories, type ScanCategory, type ScanCellHit, type SlicedScanResult } from './loadedBlockScan.js';
import { lavaSourceInfo, POOL_CAP, type LavaSourceInfo, type PoolWorld } from './lavaPools.js';
import { spawnerKind } from './mapMarks.js';
import { bodyReader, type BlockReader } from './localMap.js';
import { isLlmCentric } from './llmCentric.js';
import { wayWords, type ScanTrigger, type WorldScanState } from './worldScanState.js';

export { wayWords, worldScanView, type ScanTrigger, type WorldScanState } from './worldScanState.js';

/**
 * What the loaded chunks hold (r4 contract 1, `probe` kind `scan`, and the observation's `world.scan`): a code scan of every chunk the
 * server has sent, by the blocks only, no judgment. Arch-check 6 (2026-10-22): run 26 left the Nether exit "with no crafting table" while a
 * crimson stem stood 4 m off; run 27 searched 96 m for logs and found none, and the 160 m scan said the same, so the way out had to be chosen.
 * Each row: what, how many, the nearest, its compass way and distance across, and how far up or down. At most MAX_ROWS rows, and one summary
 * sentence that also says what is not there (no log within the area read).
 */
export const MAX_ROWS = 20;

const LOG_KINDS = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'pale_oak'];
const FORTRESS = ['nether_bricks', 'nether_brick_fence', 'nether_brick_stairs', 'nether_brick_slab', 'cracked_nether_bricks', 'chiseled_nether_bricks'];
const BASTION = ['gilded_blackstone', 'polished_blackstone_bricks', 'cracked_polished_blackstone_bricks', 'chiseled_polished_blackstone'];
const STRONGHOLD = ['stone_bricks', 'mossy_stone_bricks', 'cracked_stone_bricks', 'infested_stone_bricks', 'infested_mossy_stone_bricks', 'infested_cracked_stone_bricks'];
const RAILS = ['rail', 'powered_rail', 'detector_rail', 'activator_rail'];
const WOOD_HULL = /^(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry)_(planks|stairs|slab|fence|trapdoor)$|^stripped_.*_(log|wood)$/u;

interface ScanBody {
  entity?: { position?: Vec3 } | null;
  registry?: any;
  world?: any;
  game?: { dimension?: unknown };
  entities?: Record<string, any>;
  blockAt?(position: Vec3, extraInfos?: boolean): any;
  landmarks?: Array<{ kind: string; position: { x: number; y: number; z: number }; evidence?: string }>;
}

/** The categories counted, by the registry's names (a name the version lacks is left out). */
function categoriesFor(registry: any): ScanCategory[] {
  const has = (name: string) => registry?.blocksByName?.[name] !== undefined;
  const names = (list: string[]) => list.filter(has);
  const beds = Object.keys(registry?.blocksByName ?? {}).filter(name => name.endsWith('_bed'));
  return [
    ...LOG_KINDS.map(kind => ({ key: `log:${kind}`, names: names([`${kind}_log`, `${kind}_wood`]), keep: 4 })),
    { key: 'stem:crimson', names: names(['crimson_stem', 'crimson_hyphae']), keep: 4 },
    { key: 'stem:warped', names: names(['warped_stem', 'warped_hyphae']), keep: 4 },
    { key: 'bell', names: names(['bell']), keep: 4 },
    { key: 'bed', names: beds, keep: 4 },
    { key: 'chest', names: names(['chest', 'trapped_chest', 'barrel']), keep: 12 },
    { key: 'hay', names: names(['hay_block']), keep: 4 },
    { key: 'farm', names: names(['farmland', 'wheat', 'carrots', 'potatoes', 'beetroots']), keep: 4 },
    { key: 'water', names: names(['water']), sourceOnly: true, keep: 4 },
    { key: 'lava', names: names(['lava']), sourceOnly: true, keep: 256 },
    { key: 'fortress', names: names(FORTRESS), keep: 4 },
    { key: 'bastion', names: names(BASTION), keep: 4 },
    { key: 'stronghold', names: names(STRONGHOLD), keep: 4, yMax: 40 },
    { key: 'rail', names: names(RAILS), keep: 4, yMax: 60 },
    { key: 'cobweb', names: names(['cobweb']), keep: 4 },
    { key: 'spawner', names: names(['spawner', 'trial_spawner']), keep: 4 },
    { key: 'nether_portal', names: names(['nether_portal']), keep: 2 },
    { key: 'end_frame', names: names(['end_portal_frame']), keep: 12 },
    { key: 'end_portal', names: names(['end_portal']), keep: 2 },
    { key: 'obsidian', names: names(['obsidian']), keep: 2 },
    { key: 'crying', names: names(['crying_obsidian']), keep: 2 },
  ].filter(category => category.names.length);
}

export interface WorldScanSummary {
  text: string;
  rows: string[];
  chunks: number;
  reach: number;
  ms: number;
  partial?: boolean;
  /** The longest the loop was held and the slices (for the measure; not for the head). */
  longestSliceMs: number;
  /** r7: what the longest hold was doing, the main thread's CPU and the collections in it (for the log; not for the head). */
  longestSliceWords?: string;
}

const at =(hit: { x: number; y: number; z: number }) => `(${hit.x},${hit.y},${hit.z})`;

/**
 * The rows and the sentence for one scan's counts. The block reads (a lava pool's size and cover, the frames' eyes, a chest's hull, a
 * spawner) are `reads`, made beforehand in steps (`readScanSliced`); without them they are made here at once (`readScanNow`).
 */
export function summarizeScan(bot: ScanBody, scan: SlicedScanResult, centre: { x: number; y: number; z: number }, read: BlockReader, reads: ScanReads = readScanNow(bot, scan, read)): WorldScanSummary {
  const dimension = String(bot.game?.dimension ?? 'overworld');
  const nether = dimension.includes('nether'), end = dimension.includes('end');
  const get = (key: string) => scan.found.get(key) ?? { count: 0, hits: [] as ScanCellHit[] };
  const rows: Array<{ order: number; line: string }> = [];
  const facts: string[] = [], absent: string[] = [];
  const row = (order: number, label: string, count: number | string, hit: ScanCellHit, note = '') =>
    rows.push({ order, line: `${label}${count !== '' ? ` ×${count}` : ''} 最寄り ${at(hit)} ${wayWords(centre, hit)}${note ? ` ${note}` : ''}` });
  // Wood: each kind of log (overworld), the stems (Nether).
  const logs = LOG_KINDS.map(kind => ({ kind, ...get(`log:${kind}`) })).filter(entry => entry.count > 0).sort((a, b) => a.hits[0].distance - b.hits[0].distance);
  for (const entry of logs.slice(0, 3)) row(0, `原木 ${entry.kind}`, entry.count, entry.hits[0]);
  if (logs.length) facts.push(`原木は ${logs[0].kind} が ${wayWords(centre, logs[0].hits[0])}`);
  else if (!nether && !end) absent.push('原木');
  const stems = (['crimson', 'warped'] as const).map(kind => ({ kind, ...get(`stem:${kind}`) })).filter(entry => entry.count > 0).sort((a, b) => a.hits[0].distance - b.hits[0].distance);
  for (const entry of stems) row(0, `ネザーの幹 ${entry.kind}`, entry.count, entry.hits[0]);
  if (stems.length) facts.push(`ネザーの幹は ${wayWords(centre, stems[0].hits[0])}`);
  else if (nether) absent.push('ネザーの幹');
  // A village's marks.
  const village: Array<[string, string]> = [['bell', '村の鐘'], ['bed', 'ベッド'], ['chest', '箱・樽'], ['hay', '干し草'], ['farm', '畑・作物']];
  for (const [key, label] of village) { const entry = get(key); if (entry.count) row(1, label, entry.count, entry.hits[0], key === 'bed' ? entry.hits[0].name : ''); }
  if (get('bell').count) facts.push(`村の鐘が ${wayWords(centre, get('bell').hits[0])}`);
  if (get('bed').count) facts.push(`ベッドが ${wayWords(centre, get('bed').hits[0])}`);
  // Water: a source (a bucket fills only there).
  const water = get('water');
  if (water.count) { row(2, '水源', water.count, water.hits[0]); facts.push(`水源は ${wayWords(centre, water.hits[0])}`); }
  else if (!nether) absent.push('水源');
  // Lava: the sources joined into pools (the nearest three pools), each with its size and what lies over it.
  const pools = lavaPoolRows(reads.pools, centre);
  for (const pool of pools) rows.push({ order: 3, line: pool.line });
  if (pools.length) facts.push(`溶岩の溜まり ${pools.length >= 3 ? '3 つ以上' : `${pools.length} つ`}（最寄り ${pools[0].way}・${pools[0].size}）`);
  // Structures, by the blocks only they are built of.
  const structures: string[] = [];
  const fortress = get('fortress');
  if (fortress.count >= 4) { row(4, 'ネザー要塞のレンガ', fortress.count, fortress.hits[0]); structures.push(`ネザー要塞 ${wayWords(centre, fortress.hits[0])}`); }
  else if (nether) absent.push('ネザー要塞のブロック');
  const bastion = get('bastion');
  if (bastion.count >= 8) { row(4, '砦の遺跡（bastion）', bastion.count, bastion.hits[0], bastion.hits.some(hit => hit.name === 'gilded_blackstone') ? '金のブラックストーンあり' : ''); structures.push(`砦の遺跡 ${wayWords(centre, bastion.hits[0])}`); }
  const frames = get('end_frame'), stronghold = get('stronghold');
  if (frames.count) {
    row(4, 'エンドポータルの枠（要塞）', frames.count, frames.hits[0], `アイ入り ${reads.eyes}${frames.count > frames.hits.length ? '（近い 12 のうち）' : ''}`);
    structures.push(`要塞（エンドポータルの枠） ${wayWords(centre, frames.hits[0])}`);
  } else if (stronghold.count >= 24) { row(4, '要塞の石レンガ（y≤40）', stronghold.count, stronghold.hits[0]); structures.push(`要塞らしい石レンガ ${wayWords(centre, stronghold.hits[0])}`); }
  const rails = get('rail');
  if (!nether && !end && rails.count >= 8) { row(4, '廃坑のレール（y≤60）', rails.count, rails.hits[0], get('cobweb').count ? `クモの巣 ×${get('cobweb').count}` : ''); structures.push(`廃坑 ${wayWords(centre, rails.hits[0])}`); }
  const wreck = !nether && !end ? reads.wreck : null;
  if (wreck) { row(4, '難破船らしい箱', '', wreck, '箱の周りに木の板と水'); structures.push(`難破船らしい箱 ${wayWords(centre, wreck)}`); }
  const crying = get('crying');
  if (!nether && crying.count) { row(4, '壊れたポータル（泣く黒曜石）', crying.count, crying.hits[0]); structures.push(`壊れたポータル ${wayWords(centre, crying.hits[0])}`); }
  if (structures.length) facts.push(`構造物：${structures.join('、')}`);
  // Spawners (what they spawn), portals.
  const spawners = get('spawner');
  spawners.hits.slice(0, 2).forEach((hit, index) => row(5, 'スポナー', '', hit, reads.spawnerKinds[index] || '種類は見えない'));
  if (spawners.count) facts.push(`スポナー ${spawners.count}（最寄り ${wayWords(centre, spawners.hits[0])}）`);
  const portal = get('nether_portal');
  if (portal.count) { row(5, 'ネザーポータル', portal.count, portal.hits[0]); facts.push(`ネザーポータルが ${wayWords(centre, portal.hits[0])}`); }
  const endPortal = get('end_portal');
  if (endPortal.count) { row(5, 'エンドポータル', endPortal.count, endPortal.hits[0]); facts.push(`エンドポータルが ${wayWords(centre, endPortal.hits[0])}`); }
  const obsidian = get('obsidian');
  if (obsidian.count) row(6, '黒曜石', obsidian.count, obsidian.hits[0]);
  const lines = rows.sort((a, b) => a.order - b.order).slice(0, MAX_ROWS).map(entry => entry.line);
  const area = `読み込み済みの ${scan.chunks} チャンク（約 ${scan.reachMetres}m 先まで）${scan.partial ? 'の途中まで' : ''}`;
  const text = `${area}を調べた。${facts.length ? `${facts.join('。')}。` : ''}${absent.length ? `${absent.join('・')}は${scan.partial ? '調べた所に' : 'この範囲に'}無い。` : ''}`;
  return { text, rows: lines, chunks: scan.chunks, reach: scan.reachMetres, ms: scan.ms, ...(scan.partial ? { partial: true } : {}), longestSliceMs: scan.longestSliceMs };
}

/**
 * The block reads the summary needs beyond the counts (r7): each lava pool's size and cover (lavaPools: up to some hundreds of reads a
 * pool), the eyes in the end portal frames, a chest's hull, what a spawner spawns. Read as steps, so that the scan gives the loop back
 * between them (`readsFor` yields after each); the summary itself then reads nothing.
 */
export interface ScanReads {
  pools: Array<{ hit: ScanCellHit; joined: number; info: LavaSourceInfo | null; cap: string }>;
  eyes: number;
  wreck: ScanCellHit | null;
  spawnerKinds: string[];
}

/** The kept lava sources joined into pools (a pool listed once): the nearest three pools' nearest source and how many kept sources it joins. */
function poolHeads(sources: ScanCellHit[]): Array<{ hit: ScanCellHit; joined: number }> {
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
  const kept = new Map(sources.map(hit => [key(hit.x, hit.y, hit.z), hit]));
  const seen = new Set<string>();
  const heads: Array<{ hit: ScanCellHit; joined: number }> = [];
  for (const hit of sources) {
    if (heads.length >= 3) break;
    if (seen.has(key(hit.x, hit.y, hit.z))) continue;
    const queue = [hit];
    seen.add(key(hit.x, hit.y, hit.z));
    for (let head = 0; head < queue.length; head++) {
      const cell = queue[head];
      for (const [dx, dy, dz] of SIX) {
        const next = key(cell.x + dx, cell.y + dy, cell.z + dz);
        const other = kept.get(next);
        if (other && !seen.has(next)) { seen.add(next); queue.push(other); }
      }
    }
    heads.push({ hit, joined: queue.length });
  }
  return heads;
}
const SIX: ReadonlyArray<readonly [number, number, number]> = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

/** The summary's reads, one step at a time (a `yield` after each pool, each frame batch, each chest, each spawner). */
function* readsFor(bot: ScanBody, scan: SlicedScanResult, read: BlockReader, out: ScanReads): Generator<void, void, void> {
  const dimension = String(bot.game?.dimension ?? 'overworld');
  const nether = dimension.includes('nether'), end = dimension.includes('end');
  const get = (key: string) => scan.found.get(key) ?? { count: 0, hits: [] as ScanCellHit[] };
  const world = typeof bot.blockAt === 'function' ? bot as unknown as PoolWorld : null;
  const poolCache = new Map<string, number>();
  for (const head of poolHeads(get('lava').hits)) {
    let info: LavaSourceInfo | null = null;
    try { info = world ? lavaSourceInfo(world, new Vec3(head.hit.x, head.hit.y, head.hit.z), poolCache) : null; } catch { info = null; }
    out.pools.push({ ...head, info, cap: info?.top === 'covered' ? blockName(bot, info.cap) : '' });
    yield;
  }
  const frames = get('end_frame');
  for (const hit of frames.hits) { try { const p = bot.blockAt?.(new Vec3(hit.x, hit.y, hit.z), false)?.getProperties?.(); if (p?.eye === true || p?.eye === 'true') out.eyes++; } catch { /* unknown */ } }
  if (frames.hits.length) yield;
  if (!nether && !end) {
    for (const chest of get('chest').hits.slice(0, 8)) {
      if (chest.name !== 'chest' || chest.y < 30 || chest.y > 75) continue;
      const hull = hullAround(read, chest);
      yield;
      if (hull) { out.wreck = chest; break; }
    }
  }
  for (const hit of get('spawner').hits.slice(0, 2)) {
    let kind = '';
    try { kind = spawnerKind(bot as never, new Vec3(hit.x, hit.y, hit.z)); } catch { kind = ''; }
    out.spawnerKinds.push(kind);
    yield;
  }
}
const noReads = (): ScanReads => ({ pools: [], eyes: 0, wreck: null, spawnerKinds: [] });
/** The summary's reads in one go (no loop to give back: a test, a caller that is not sliced). */
export function readScanNow(bot: ScanBody, scan: SlicedScanResult, read: BlockReader): ScanReads {
  const out = noReads();
  for (const _step of readsFor(bot, scan, read, out)) { /* every step at once */ }
  return out;
}
/** The summary's reads with the loop given back between steps (the slice's clock decides when). */
export async function readScanSliced(bot: ScanBody, scan: SlicedScanResult, read: BlockReader, slicer: LoopSlicer): Promise<ScanReads> {
  const out = noReads();
  for (const _step of readsFor(bot, scan, read, out)) if (slicer.due()) await slicer.pause();
  return out;
}

/** The pools' rows from the reads: each with its size (lavaPools' count of joined sources) and its top. */
function lavaPoolRows(pools: ScanReads['pools'], centre: { x: number; y: number; z: number }): Array<{ line: string; way: string; size: string }> {
  return pools.map(({ hit, joined, info, cap }) => {
    const sizeCount = info ? info.poolSize : joined;
    const size = `源 ${sizeCount >= POOL_CAP ? `${POOL_CAP} 以上` : sizeCount}`;
    const top = !info ? '' : info.top === 'open' ? '上は空気（覆い無し）' : info.top === 'covered' ? `上は ${cap} 1 枚（覆い）` : '上は溶岩か水か、掘れない覆い';
    const way = wayWords(centre, hit);
    return { way, size, line: `溶岩の溜まり ${size} 最寄り ${at(hit)} ${way}${top ? ` ${top}` : ''}` };
  });
}
function blockName(bot: ScanBody, position: Vec3 | undefined): string {
  if (!position) return '?';
  try { return String(bot.blockAt?.(position, false)?.name ?? '?'); } catch { return '?'; }
}

/** A chest with a hull round it: ten or more wooden hull blocks and ten or more water cells within 3 (a shipwreck's). */
function hullAround(read: BlockReader, chest: ScanCellHit): boolean {
  let wood = 0, water = 0;
  for (let dx = -3; dx <= 3; dx++) for (let dy = -3; dy <= 3; dy++) for (let dz = -3; dz <= 3; dz++) {
    const block = read(chest.x + dx, chest.y + dy, chest.z + dz);
    if (!block) continue;
    if (WOOD_HULL.test(block.name)) wood++;
    else if (block.name === 'water') water++;
  }
  return wood >= 10 && water >= 10;
}

/** One scan of the loaded chunks round the body (sliced), summed up. */
export async function scanWorld(bot: ScanBody, options: { radiusChunks?: number; sliceMs?: number; maxMs?: number; stop?: () => boolean; slicer?: LoopSlicer } = {}): Promise<WorldScanSummary | null> {
  const position = bot.entity?.position;
  if (!position || !bot.registry?.blocksByName || typeof bot.world?.getColumns !== 'function') return null;
  const centre = { x: position.x, y: position.y, z: position.z };
  const slicer = options.slicer ?? new LoopSlicer(options.sliceMs ?? SCAN_SLICE_MS);
  const scan = await scanLoadedCategories(bot as never, categoriesFor(bot.registry), { ...options, slicer });
  // The summary's block reads (lava pools, frames, a hull, spawners) in steps with the loop given back between them (r7: runs 30 and 31 held
  // the loop 19.4 and 27.6 ms once, and the reads were one hold); the rows and the sentence after them read nothing.
  await slicer.pause();
  slicer.phase = '要約の読み';
  const read = bodyReader(bot as never);
  const reads = await readScanSliced(bot, scan, read, slicer);
  if (slicer.due()) await slicer.pause();
  slicer.phase = '要約の文';
  const summary = summarizeScan(bot, scan, centre, read, reads);
  slicer.end();
  // The collections of the last slices are told to the observer after the work: one turn of the loop before the words are read.
  await new Promise(resolve => setImmediate(resolve));
  return { ...summary, longestSliceMs: Math.round(slicer.longest * 10) / 10, longestSliceWords: slicer.longestWords() };
}

// ===== The scan at a spawn (world.scan) =====

interface SpawnScanBody extends ScanBody {
  on(event: string, listener: (...args: any[]) => void): unknown;
  removeListener?(event: string, listener: (...args: any[]) => void): unknown;
  arrival?: { kind: ScanTrigger; at: number };
  worldScan?: WorldScanState;
  /** The time of the last scan's slices, for the log and the measure. */
  worldScanCost?: { ms: number; longestSliceMs: number; longestSliceWords?: string };
}

/** mineflayer's view distance words (settings.viewDistance) in chunks. */
const VIEW_WORDS: Record<string, number> = { far: 12, normal: 10, short: 6, tiny: 2 };

/** The view distance in chunks the server sends: its own (from the login), no more than the body asked for; null when the server's is unknown. */
export function viewDistanceOf(bot: { game?: any; settings?: any }): number | null {
  const server = Number(bot.game?.serverViewDistance);
  if (!Number.isFinite(server) || server <= 0) return null;
  const setting = bot.settings?.viewDistance;
  const client = typeof setting === 'number' && setting > 0 ? setting : typeof setting === 'string' ? VIEW_WORDS[setting] : undefined;
  return client ? Math.min(server, client) : server;
}

/** The loaded columns round the body: how many, and the furthest ring (chunks, square) from its own column. */
export function loadedRing(bot: { world?: any; entity?: { position?: { x: number; z: number } } | null }): { count: number; radius: number } {
  let columns: any[] = [];
  try { columns = bot.world?.getColumns?.() ?? []; } catch { columns = []; }
  const position = bot.entity?.position;
  if (!position) return { count: columns.length, radius: 0 };
  const cx = Math.floor(position.x / 16), cz = Math.floor(position.z / 16);
  let radius = 0;
  for (const entry of columns) {
    const x = Number(entry?.chunkX), z = Number(entry?.chunkZ);
    if (Number.isFinite(x) && Number.isFinite(z)) radius = Math.max(radius, Math.abs(x - cx), Math.abs(z - cz));
  }
  return { count: columns.length, radius };
}

/** The share of the view distance's chunks loaded before the scan at a spawn runs (run 28: it ran at 25 of 441, 2.6 s after the login). */
export const SPAWN_SCAN_SHARE = 0.8;

/**
 * After every spawn (a login, a reconnect, a portal, a respawn after a death), while the LLM-centric mode is on: wait until most of the
 * chunks have come (SPAWN_SCAN_SHARE of the view distance's square, at least `minWaitMs` after the spawn, at most `maxWaitMs`), then scan
 * once and keep it as `bot.worldScan` for the observation. When the server's view distance is not known, until the count of loaded columns
 * has not changed for `settleMs`. Run 28: a count steady for one second came at 25 chunks of 441 (the server sends them in bursts). The
 * scan says how many chunks were loaded, out to which ring, and how long it waited. A newer spawn cancels the scan of the one before.
 * Mode off: nothing.
 */
export function installSpawnScan(bot: SpawnScanBody, options: { minWaitMs?: number; settleMs?: number; maxWaitMs?: number; pollMs?: number; sliceMs?: number; now?: () => number;
  share?: number; log?: (line: string) => void } = {}): () => void {
  const minWait = options.minWaitMs ?? 2000, settle = options.settleMs ?? 3000, maxWait = options.maxWaitMs ?? 15_000, poll = options.pollMs ?? 250;
  const share = options.share ?? SPAWN_SCAN_SHARE;
  const now = options.now ?? Date.now;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const onSpawn = () => {
    if (!isLlmCentric(bot)) return;
    const mine = ++generation;
    if (timer) clearTimeout(timer);
    const began = now();
    let lastCount = -1, steadySince = began;
    const tick = () => {
      timer = null;
      if (mine !== generation) return;
      const { count } = loadedRing(bot);
      const t = now();
      if (count !== lastCount) { lastCount = count; steadySince = t; }
      const view = viewDistanceOf(bot as never);
      const enough = view !== null ? count >= Math.ceil(share * (2 * view + 1) ** 2) : count > 0 && t - steadySince >= settle;
      const ready = t - began >= minWait && enough;
      if (!ready && t - began < maxWait) { timer = setTimeout(tick, poll); return; }
      void run(mine, t - began, view);
    };
    timer = setTimeout(tick, poll);
  };
  const run = async (mine: number, waitedMs: number, view: number | null) => {
    const trigger: ScanTrigger = bot.arrival?.kind ?? 'login';
    const dimension = String(bot.game?.dimension ?? '');
    const position = bot.entity?.position;
    if (!position) return;
    const center = { x: Math.floor(position.x), y: Math.floor(position.y + 1e-3), z: Math.floor(position.z) };
    try {
      const ring = loadedRing(bot);
      const summary = await scanWorld(bot, { sliceMs: options.sliceMs, stop: () => mine !== generation });
      if (!summary || mine !== generation) return;
      const { longestSliceMs, longestSliceWords, ...kept } = summary;
      const expected = view !== null ? (2 * view + 1) ** 2 : null;
      const loaded = `読み込み ${summary.chunks} チャンク・半径 ${ring.radius} チャンク（約 ${summary.reach}m）${expected ? `・描画の距離 ${view}（${expected} チャンクの ${Math.round((100 * summary.chunks) / expected)}%）` : '・描画の距離は不明'}・待ち ${(waitedMs / 1000).toFixed(1)} 秒`;
      bot.worldScan = { ...kept, text: `${kept.text}（${loaded}）`, rows: [`範囲 ${loaded}`, ...kept.rows].slice(0, MAX_ROWS), radiusChunks: ring.radius,
        ...(view !== null ? { viewDistance: view } : {}), waitedMs: Math.round(waitedMs), trigger, at: new Date(now()).toISOString(), dimension, center };
      bot.worldScanCost = { ms: summary.ms, longestSliceMs, ...(longestSliceWords ? { longestSliceWords } : {}) };
      options.log?.(`world scan (${trigger}) ${summary.chunks} chunks radius ${ring.radius} view ${view ?? '?'} waited ${Math.round(waitedMs)} ms, ${summary.ms} ms, longest slice ${longestSliceMs} ms (${longestSliceWords ?? '?'}), ${summary.rows.length} rows`);
    } catch (error) {
      options.log?.(`world scan failed: ${String((error as Error)?.message ?? error).slice(0, 120)}`);
    }
  };
  const onEnd = () => { generation++; if (timer) clearTimeout(timer); timer = null; };
  bot.on('spawn', onSpawn);
  bot.on('end', onEnd);
  return () => { onEnd(); bot.removeListener?.('spawn', onSpawn); bot.removeListener?.('end', onEnd); };
}
