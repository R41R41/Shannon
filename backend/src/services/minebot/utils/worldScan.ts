import { Vec3 } from 'vec3';
import { LoopSlicer, scanLoadedCategories, type ScanCategory, type ScanCellHit, type SlicedScanResult } from './loadedBlockScan.js';
import { lavaSourceInfo, POOL_CAP, type PoolWorld } from './lavaPools.js';
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
}

const at =(hit: { x: number; y: number; z: number }) => `(${hit.x},${hit.y},${hit.z})`;

/** The rows and the sentence for one scan's counts (pure but for the few block reads of a lava pool's cover, a chest's hull, a spawner). */
export function summarizeScan(bot: ScanBody, scan: SlicedScanResult, centre: { x: number; y: number; z: number }, read: BlockReader): WorldScanSummary {
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
  const pools = lavaPoolRows(bot, get('lava').hits, centre);
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
    let eyes = 0;
    for (const hit of frames.hits) { try { const p = bot.blockAt?.(new Vec3(hit.x, hit.y, hit.z), false)?.getProperties?.(); if (p?.eye === true || p?.eye === 'true') eyes++; } catch { /* unknown */ } }
    row(4, 'エンドポータルの枠（要塞）', frames.count, frames.hits[0], `アイ入り ${eyes}${frames.count > frames.hits.length ? '（近い 12 のうち）' : ''}`);
    structures.push(`要塞（エンドポータルの枠） ${wayWords(centre, frames.hits[0])}`);
  } else if (stronghold.count >= 24) { row(4, '要塞の石レンガ（y≤40）', stronghold.count, stronghold.hits[0]); structures.push(`要塞らしい石レンガ ${wayWords(centre, stronghold.hits[0])}`); }
  const rails = get('rail');
  if (!nether && !end && rails.count >= 8) { row(4, '廃坑のレール（y≤60）', rails.count, rails.hits[0], get('cobweb').count ? `クモの巣 ×${get('cobweb').count}` : ''); structures.push(`廃坑 ${wayWords(centre, rails.hits[0])}`); }
  const wreck = !nether && !end ? shipwreckChest(read, get('chest').hits) : null;
  if (wreck) { row(4, '難破船らしい箱', '', wreck, '箱の周りに木の板と水'); structures.push(`難破船らしい箱 ${wayWords(centre, wreck)}`); }
  const crying = get('crying');
  if (!nether && crying.count) { row(4, '壊れたポータル（泣く黒曜石）', crying.count, crying.hits[0]); structures.push(`壊れたポータル ${wayWords(centre, crying.hits[0])}`); }
  if (structures.length) facts.push(`構造物：${structures.join('、')}`);
  // Spawners (what they spawn), portals.
  const spawners = get('spawner');
  for (const hit of spawners.hits.slice(0, 2)) {
    let kind = '';
    try { kind = spawnerKind(bot as never, new Vec3(hit.x, hit.y, hit.z)); } catch { kind = ''; }
    row(5, 'スポナー', '', hit, kind || '種類は見えない');
  }
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

/** The nearest three lava pools among the kept sources: each with its size (lavaPools' count of joined sources) and its top. */
function lavaPoolRows(bot: ScanBody, sources: ScanCellHit[], centre: { x: number; y: number; z: number }): Array<{ line: string; way: string; size: string }> {
  if (!sources.length) return [];
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
  const kept = new Map(sources.map(hit => [key(hit.x, hit.y, hit.z), hit]));
  const seen = new Set<string>();
  const out: Array<{ line: string; way: string; size: string }> = [];
  const world = typeof bot.blockAt === 'function' ? bot as unknown as PoolWorld : null;
  const poolCache = new Map<string, number>();
  for (const hit of sources) {
    if (out.length >= 3) break;
    if (seen.has(key(hit.x, hit.y, hit.z))) continue;
    // The kept sources joined to this one (so a pool is listed once).
    const queue = [hit];
    seen.add(key(hit.x, hit.y, hit.z));
    for (let head = 0; head < queue.length; head++) {
      const cell = queue[head];
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        const next = key(cell.x + dx, cell.y + dy, cell.z + dz);
        const other = kept.get(next);
        if (other && !seen.has(next)) { seen.add(next); queue.push(other); }
      }
    }
    let info = null;
    try { info = world ? lavaSourceInfo(world, new Vec3(hit.x, hit.y, hit.z), poolCache) : null; } catch { info = null; }
    const sizeCount = info ? info.poolSize : queue.length;
    const size = `源 ${sizeCount >= POOL_CAP ? `${POOL_CAP} 以上` : sizeCount}`;
    const top = !info ? '' : info.top === 'open' ? '上は空気（覆い無し）' : info.top === 'covered' ? `上は ${blockName(bot, info.cap)} 1 枚（覆い）` : '上は溶岩か水か、掘れない覆い';
    const way = wayWords(centre, hit);
    out.push({ way, size, line: `溶岩の溜まり ${size} 最寄り ${at(hit)} ${way}${top ? ` ${top}` : ''}` });
  }
  return out;
}
function blockName(bot: ScanBody, position: Vec3 | undefined): string {
  if (!position) return '?';
  try { return String(bot.blockAt?.(position, false)?.name ?? '?'); } catch { return '?'; }
}

/** The nearest chest with a hull round it: ten or more wooden hull blocks and ten or more water cells within 3 (a shipwreck's). */
function shipwreckChest(read: BlockReader, chests: ScanCellHit[]): ScanCellHit | null {
  for (const chest of chests.slice(0, 8)) {
    if (chest.name !== 'chest' || chest.y < 30 || chest.y > 75) continue;
    let wood = 0, water = 0;
    for (let dx = -3; dx <= 3; dx++) for (let dy = -3; dy <= 3; dy++) for (let dz = -3; dz <= 3; dz++) {
      const block = read(chest.x + dx, chest.y + dy, chest.z + dz);
      if (!block) continue;
      if (WOOD_HULL.test(block.name)) wood++;
      else if (block.name === 'water') water++;
    }
    if (wood >= 10 && water >= 10) return chest;
  }
  return null;
}

/** One scan of the loaded chunks round the body (sliced), summed up. */
export async function scanWorld(bot: ScanBody, options: { radiusChunks?: number; sliceMs?: number; maxMs?: number; stop?: () => boolean; slicer?: LoopSlicer } = {}): Promise<WorldScanSummary | null> {
  const position = bot.entity?.position;
  if (!position || !bot.registry?.blocksByName || typeof bot.world?.getColumns !== 'function') return null;
  const centre = { x: position.x, y: position.y, z: position.z };
  const scan = await scanLoadedCategories(bot as never, categoriesFor(bot.registry), options);
  return summarizeScan(bot, scan, centre, bodyReader(bot as never));
}

// ===== The scan at a spawn (world.scan) =====

interface SpawnScanBody extends ScanBody {
  on(event: string, listener: (...args: any[]) => void): unknown;
  removeListener?(event: string, listener: (...args: any[]) => void): unknown;
  arrival?: { kind: ScanTrigger; at: number };
  worldScan?: WorldScanState;
  /** The time of the last scan's slices, for the log and the measure. */
  worldScanCost?: { ms: number; longestSliceMs: number };
}

/**
 * After every spawn (a login, a reconnect, a portal, a respawn after a death), while the LLM-centric mode is on: wait until the chunks
 * stop arriving (the count of loaded columns unchanged for `settleMs`, at least `minWaitMs` after the spawn, at most `maxWaitMs`), then
 * scan once and keep it as `bot.worldScan` for the observation. A newer spawn cancels the scan of the one before. Mode off: nothing.
 */
export function installSpawnScan(bot: SpawnScanBody, options: { minWaitMs?: number; settleMs?: number; maxWaitMs?: number; pollMs?: number; sliceMs?: number; now?: () => number;
  log?: (line: string) => void } = {}): () => void {
  const minWait = options.minWaitMs ?? 2000, settle = options.settleMs ?? 1000, maxWait = options.maxWaitMs ?? 15_000, poll = options.pollMs ?? 250;
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
      let count = 0;
      try { count = bot.world?.getColumns?.()?.length ?? 0; } catch { count = 0; }
      const t = now();
      if (count !== lastCount) { lastCount = count; steadySince = t; }
      const ready = count > 0 && t - began >= minWait && t - steadySince >= settle;
      if (!ready && t - began < maxWait) { timer = setTimeout(tick, poll); return; }
      void run(mine);
    };
    timer = setTimeout(tick, poll);
  };
  const run = async (mine: number) => {
    const trigger: ScanTrigger = bot.arrival?.kind ?? 'login';
    const dimension = String(bot.game?.dimension ?? '');
    const position = bot.entity?.position;
    if (!position) return;
    const center = { x: Math.floor(position.x), y: Math.floor(position.y + 1e-3), z: Math.floor(position.z) };
    try {
      const summary = await scanWorld(bot, { sliceMs: options.sliceMs, stop: () => mine !== generation });
      if (!summary || mine !== generation) return;
      const { longestSliceMs, ...kept } = summary;
      bot.worldScan = { ...kept, trigger, at: new Date(now()).toISOString(), dimension, center };
      bot.worldScanCost = { ms: summary.ms, longestSliceMs };
      options.log?.(`world scan (${trigger}) ${summary.chunks} chunks ${summary.ms} ms, longest slice ${longestSliceMs} ms, ${summary.rows.length} rows`);
    } catch (error) {
      options.log?.(`world scan failed: ${String((error as Error)?.message ?? error).slice(0, 120)}`);
    }
  };
  const onEnd = () => { generation++; if (timer) clearTimeout(timer); timer = null; };
  bot.on('spawn', onSpawn);
  bot.on('end', onEnd);
  return () => { onEnd(); bot.removeListener?.('spawn', onSpawn); bot.removeListener?.('end', onEnd); };
}
