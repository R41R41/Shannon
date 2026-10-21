import { Vec3 } from 'vec3';
import { scanLoadedBlocks, type LoadedBlockHit } from './loadedBlockScan.js';
import { feetCell, isOpenSymbol, relativeWords, symbolFor, type Cell } from './localMap.js';
import { isAngry } from './hostileMobHints.js';

/**
 * The marks beside the map (design mb-llm-centric 2.2 and 2.6, and the owner's dragon list of 2026-10-21): what lies near but not
 * in the map's few blocks, one line each, nearest first within each kind, at most MAX_LINES:
 *   - the body's working places: furnaces (with when the batch is done), crafting tables, chests and barrels, beds;
 *   - a water source and a lava source (where a bucket fills), obsidian;
 *   - ore with a face open to air (what a person in the cave would see), one line per kind;
 *   - a village's beds, chests, hay and fields (taking them is the planner's choice: these are only where they are);
 *   - in the Nether: the fortress's bricks, spawners, portals; in the End: the crystals, the dragon, the perch (the exit portal's
 *     pillar); anywhere: end portal frames (with how many have an eye), an end portal.
 * Read from the loaded chunks by their palettes (utils/loadedBlockScan), at most every RESCAN_MS or when the body has moved.
 */
const RANGE = 48;
const ORE_RANGE = 24;
const MAX_LINES = 12;
const RESCAN_MS = 3000;
const RESCAN_MOVE = 4;

interface MarkBody {
  entity?: { position?: Vec3; yaw?: number } | null;
  entities?: Record<string, any>;
  registry?: any;
  world?: any;
  game?: { dimension?: unknown };
  blockAt?(position: Vec3, extraInfos?: boolean): any;
  landmarks?: Array<{ kind: string; position: { x: number; y: number; z: number }; evidence?: string }>;
  activeFurnaces?: Array<{ pos: { x: number; y: number; z: number }; item: string; count: number; readyAt: number; startedAt?: number; dimension?: string }>;
}

const LABEL: Record<string, string> = {
  furnace: 'かまど', blast_furnace: '溶鉱炉', smoker: '燻製器', crafting_table: '作業台', chest: '箱', barrel: '樽', trapped_chest: '罠の箱',
  water: '水源', lava: '溶岩源', obsidian: '黒曜石', hay_block: '干し草', farmland: '畑', wheat: '小麦', carrots: 'にんじん', potatoes: 'じゃがいも',
  beetroots: 'ビートルート', bell: '鐘', nether_bricks: 'ネザー要塞のレンガ', spawner: 'スポナー', nether_portal: 'ネザーポータル',
  end_portal_frame: 'エンドポータルの枠', end_portal: 'エンドポータル', bed: 'ベッド',
  iron: '鉄鉱石', coal: '石炭', diamond: 'ダイヤ', gold: '金', redstone: 'レッドストーン', lapis: 'ラピス', copper: '銅', emerald: 'エメラルド',
  quartz: 'クォーツ', ancient_debris: '古代の残骸',
};
const ORE_NAMES = ['iron_ore', 'deepslate_iron_ore', 'coal_ore', 'deepslate_coal_ore', 'diamond_ore', 'deepslate_diamond_ore', 'gold_ore',
  'deepslate_gold_ore', 'nether_gold_ore', 'redstone_ore', 'deepslate_redstone_ore', 'lapis_ore', 'deepslate_lapis_ore', 'copper_ore',
  'deepslate_copper_ore', 'emerald_ore', 'deepslate_emerald_ore', 'nether_quartz_ore', 'ancient_debris'];
const oreKind = (name: string) => name === 'ancient_debris' ? 'ancient_debris' : name.replace(/^(deepslate|nether)_/u, '').replace(/_ore$/u, '');
const FACES: Array<[number, number, number]> = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

interface Mark { kind: string; line: string; distance: number; order: number }
const cache = new WeakMap<object, { at: number; from: Cell; dimension: string; lines: string[] }>();

const at = (cell: Cell) => `(${cell.x},${cell.y},${cell.z})`;
const cellOf = (position: { x: number; y: number; z: number }): Cell => ({ x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) });

function exposed(bot: MarkBody, position: Vec3): boolean {
  for (const [dx, dy, dz] of FACES) {
    let block: any;
    try { block = bot.blockAt?.(position.offset(dx, dy, dz), false); } catch { block = null; }
    if (block && (isOpenSymbol(symbolFor({ name: String(block.name), solid: block.boundingBox === 'block' })) || block.name === 'water')) return true;
  }
  return false;
}
function fluidLevel(bot: MarkBody, position: Vec3): number {
  try {
    const block = bot.blockAt?.(position, false);
    return Number(block?.getProperties?.().level ?? block?.metadata ?? 0);
  } catch { return -1; }
}

/** The marks for a body, as lines; cached for RESCAN_MS unless the body moved RESCAN_MOVE blocks. */
export function mapMarkLines(bot: MarkBody, now = Date.now(), fresh = false): string[] {
  const feet = feetCell(bot as any);
  if (!feet) return [];
  const cached = cache.get(bot as object);
  // The marks are of the dimension the body is in (a portal crossed reads them afresh: run 26 was shown an overworld table in the Nether).
  const dimension = String(bot.game?.dimension ?? '');
  if (!fresh && cached && cached.dimension === dimension && now - cached.at < RESCAN_MS
    && Math.hypot(cached.from.x - feet.x, cached.from.y - feet.y, cached.from.z - feet.z) < RESCAN_MOVE) return cached.lines;
  let lines: string[] = [];
  try { lines = computeMarks(bot, feet, now); } catch { lines = []; }
  cache.set(bot as object, { at: now, from: feet, dimension, lines });
  return lines;
}

/** What a spawner spawns, from its block entity (SpawnData.entity.id), or the kind of mob seen beside it; empty when unknown. */
function spawnerKind(bot: MarkBody, position: Vec3): string {
  try {
    const entity: any = bot.blockAt?.(position, true)?.blockEntity;
    const id = entity?.SpawnData?.entity?.id ?? entity?.SpawnData?.value?.entity?.value?.id?.value ?? entity?.value?.SpawnData?.value?.entity?.value?.id?.value;
    if (typeof id === 'string' && id) return `湧く: ${id.replace(/^minecraft:/u, '')}`;
  } catch { /* by the mobs below */ }
  const near = Object.values(bot.entities ?? {}).filter((entity: any) => entity?.position && entity.position.distanceTo(position) <= 8
    && /^(blaze|zombie|skeleton|spider|cave_spider|silverfish|magma_cube)$/u.test(String(entity.name)));
  return near.length ? `近くに ${[...new Set(near.map((entity: any) => entity.name))].join('・')}` : '';
}

function computeMarks(bot: MarkBody, feet: Cell, now: number): string[] {
  const dimension = String(bot.game?.dimension ?? 'overworld');
  const marks: Mark[] = [];
  /** One line in the contract's form: `記号 名前 (x,y,z) 方角距離・上下 注記`. */
  const add = (kind: string, cell: Cell, symbol: string, name: string, note: string, order: number) => {
    const distance = Math.hypot(cell.x - feet.x, cell.y - feet.y, cell.z - feet.z);
    marks.push({ kind, distance, order, line: `${symbol} ${name} ${at(cell)} ${relativeWords(feet, cell)}${note ? ` ${note}` : ''}` });
  };
  const scan = (names: string[], range = RANGE, maxHits = 64): LoadedBlockHit[] => {
    if (!bot.registry || !bot.world) return [];
    return scanLoadedBlocks(bot as never, names, { maxDistance: range, maxHits }).hits;
  };
  const village = dimension.includes('overworld')
    ? (bot.landmarks ?? []).find(mark => mark.kind === 'village' && Math.hypot(mark.position.x - feet.x, mark.position.z - feet.z) <= 160) : undefined;
  /** A bed, chest or field within the village's reach is the village's (said so: taking it is the planner's choice). */
  const villages = (cell: Cell) => !!village && Math.hypot(cell.x - village.position.x, cell.z - village.position.z) <= 64;
  // Working places, two or three of each kind; a furnace with its batch.
  const kept = new Map<string, number>();
  const keep = (kind: string, most: number) => { const n = kept.get(kind) ?? 0; if (n >= most) return false; kept.set(kind, n + 1); return true; };
  const beds = bot.registry?.blocksByName ? Object.keys(bot.registry.blocksByName).filter(name => name.endsWith('_bed')) : [];
  for (const hit of scan(['furnace', 'blast_furnace', 'smoker', 'crafting_table', 'chest', 'barrel', 'trapped_chest', ...beds])) {
    const kind = hit.name.endsWith('_bed') ? 'bed' : hit.name;
    if (!keep(kind, kind === 'bed' || kind === 'chest' ? 3 : 2)) continue;
    const cell = cellOf(hit.position);
    let note = '';
    if (kind === 'furnace' || kind === 'blast_furnace' || kind === 'smoker') {
      const job = (bot.activeFurnaces ?? []).find(f => f.pos.x === cell.x && f.pos.y === cell.y && f.pos.z === cell.z && (!f.dimension || f.dimension === dimension));
      if (job) {
        const left = Math.max(0, Math.round((job.readyAt - now) / 1000));
        note = left > 0 ? `${job.item}×${job.count} 焼き上がり ${left}秒後` : `${job.item}×${job.count} 焼き上がり済みの見込み（取り出して確かめる）`;
      }
    }
    if (kind === 'bed') note = hit.name;
    add(kind, cell, symbolFor({ name: hit.name }), `${villages(cell) && (kind === 'bed' || kind === 'chest' || kind === 'barrel') ? '村の' : ''}${LABEL[kind] ?? kind}`, note, 0);
  }
  // A source of water and of lava, the nearest of each (a bucket fills only at a source), with how many sources lie round it.
  for (const fluid of ['water', 'lava']) {
    const hits = scan([fluid], RANGE, 64);
    const sources = hits.filter(hit => fluidLevel(bot, hit.position) === 0);
    if (sources.length) add(fluid, cellOf(sources[0].position), fluid === 'water' ? 'w' : 'L', LABEL[fluid], fluid === 'lava' ? `溜まりの源 ${sources.length}` : '', 1);
  }
  const obsidian = scan(['obsidian', 'crying_obsidian'], RANGE, 32);
  if (obsidian.length) add('obsidian', cellOf(obsidian[0].position), 'O', '黒曜石', `×${obsidian.length}`, 2);
  // Ore that shows, nearest of each kind with how many are seen.
  const ores = new Map<string, { hit: LoadedBlockHit; n: number }>();
  for (const hit of scan(ORE_NAMES, ORE_RANGE, 128)) {
    if (!exposed(bot, hit.position)) continue;
    const kind = oreKind(hit.name);
    const entry = ores.get(kind);
    if (entry) entry.n++; else ores.set(kind, { hit, n: 1 });
  }
  for (const [kind, { hit, n }] of ores) add(kind, cellOf(hit.position), symbolFor({ name: hit.name }), LABEL[kind] ?? kind, `×${n} 見えている`, 3);
  // A village near: the village, and its hay and fields.
  if (village) {
    add('village', cellOf(village.position), 'B', '村', village.evidence ?? '', 4);
    const crops = scan(['hay_block', 'wheat', 'carrots', 'potatoes', 'beetroots'], 96, 128);
    const byKind = new Map<string, { hit: LoadedBlockHit; n: number }>();
    for (const hit of crops) { const entry = byKind.get(hit.name); if (entry) entry.n++; else byKind.set(hit.name, { hit, n: 1 }); }
    for (const [name, { hit, n }] of byKind) add(name, cellOf(hit.position), symbolFor({ name }), `村の${LABEL[name] ?? name}`, `×${n}`, 4);
  }
  // The Nether and the End, and a stronghold anywhere.
  if (dimension.includes('nether')) {
    const bricks = scan(['nether_bricks', 'nether_brick_fence'], 96, 16);
    if (bricks.length) add('fortress', cellOf(bricks[0].position), 'N', 'ネザー要塞', `レンガ×${bricks.length}`, 1);
    const bastion = scan(['gilded_blackstone', 'polished_blackstone_bricks', 'cracked_polished_blackstone_bricks', 'chiseled_polished_blackstone'], 96, 16);
    if (bastion.length) add('bastion', cellOf(bastion[0].position), '#', '砦の遺跡（bastion）', bastion.some(hit => hit.name === 'gilded_blackstone') ? '金のブラックストーンあり' : '', 1);
  }
  for (const hit of scan(['spawner'], 96, 4)) add('spawner', cellOf(hit.position), 'S', LABEL.spawner, spawnerKind(bot, hit.position), 1);
  for (const name of ['nether_portal', 'end_portal']) {
    const hits = scan([name], 96, 8);
    if (hits.length) add(name, cellOf(hits[0].position), symbolFor({ name }), LABEL[name], '', 1);
  }
  const frames = scan(['end_portal_frame'], 64, 12);
  if (frames.length) {
    let eyes = 0;
    for (const frame of frames) { try { const p = bot.blockAt?.(frame.position, false)?.getProperties?.(); if (p?.eye === true || p?.eye === 'true') eyes++; } catch { /* unknown */ } }
    add('end_portal_frame', cellOf(frames[0].position), 'Q', LABEL.end_portal_frame, `×${frames.length} アイ入り ${eyes}`, 1);
  }
  if (dimension.includes('end')) {
    for (const entity of Object.values(bot.entities ?? {})) {
      if (!entity?.position) continue;
      if (entity.name === 'end_crystal') add('crystal', cellOf(entity.position), '!', 'エンドクリスタル', `id ${entity.id}`, 0);
      if (entity.name === 'ender_dragon') {
        const health = entityHealth(bot, entity);
        add('dragon', cellOf(entity.position), '!', 'エンダードラゴン', `id ${entity.id}${health !== null ? ` 体力 ${health}/200` : ''}`, 0);
      }
    }
    // The perch: the exit portal's bedrock pillar at x 0, z 0 (the dragon lands on it).
    for (let y = 100; y >= 40; y--) {
      let block: any;
      try { block = bot.blockAt?.(new Vec3(0, y, 0), false); } catch { block = null; }
      if (block?.name === 'bedrock') { add('perch', { x: 0, y: y + 1, z: 0 }, 'X', '止まり木', '出口ポータルの柱の上', 0); break; }
    }
  }
  // Crystals are many: the four nearest are enough.
  const crystals = marks.filter(mark => mark.kind === 'crystal').sort((a, b) => a.distance - b.distance);
  const drop = new Set(crystals.slice(4));
  return marks.filter(mark => !drop.has(mark)).sort((a, b) => a.order - b.order || a.distance - b.distance).slice(0, MAX_LINES).map(mark => mark.line);
}
/**
 * The structure the body is in or right beside (the contract's `inside`, from run 26): a Nether fortress, a bastion, a stronghold, a
 * village, an end city, by the blocks only they are built of round the body. Null when none. Read with the marks' cache period.
 */
const insideCache = new WeakMap<object, { at: number; from: Cell; dimension: string; text: string | null }>();
export function insideStructure(bot: MarkBody, now = Date.now()): string | null {
  const feet = feetCell(bot as any);
  if (!feet || !bot.registry || !bot.world) return null;
  const dimension = String(bot.game?.dimension ?? '');
  const cached = insideCache.get(bot as object);
  if (cached && cached.dimension === dimension && now - cached.at < RESCAN_MS && Math.hypot(cached.from.x - feet.x, cached.from.y - feet.y, cached.from.z - feet.z) < RESCAN_MOVE) return cached.text;
  const count = (names: string[], range: number) => {
    try { return scanLoadedBlocks(bot as never, names, { maxDistance: range, maxHits: 64 }).hits.length; } catch { return 0; }
  };
  let text: string | null = null;
  try {
    if (dimension.includes('nether')) {
      const bricks = ['nether_bricks', 'nether_brick_fence', 'nether_brick_stairs', 'nether_brick_slab', 'chiseled_nether_bricks', 'cracked_nether_bricks'];
      const bastion = ['polished_blackstone_bricks', 'cracked_polished_blackstone_bricks', 'gilded_blackstone', 'chiseled_polished_blackstone'];
      if (count(bricks, 6) >= 8) text = 'ネザー要塞の中';
      else if (count(bastion, 6) >= 8) text = '砦の遺跡（bastion）の中';
      else if (count(bricks, 16) >= 4) text = 'ネザー要塞の脇';
      else if (count(bastion, 16) >= 4) text = '砦の遺跡（bastion）の脇';
    } else if (dimension.includes('end')) {
      if (count(['purpur_block', 'purpur_pillar', 'end_stone_bricks', 'purpur_stairs'], 12) >= 8) text = 'エンドシティ';
    } else {
      if (count(['end_portal_frame'], 16) > 0 || (feet.y < 50 && count(['stone_bricks', 'mossy_stone_bricks', 'cracked_stone_bricks', 'infested_stone_bricks'], 8) >= 12)) text = 'ストロングホールドの中';
      else if ((bot.landmarks ?? []).some(mark => mark.kind === 'village' && Math.hypot(mark.position.x - feet.x, mark.position.z - feet.z) <= 48)) text = '村の中';
    }
  } catch { text = null; }
  insideCache.set(bot as object, { at: now, from: feet, dimension, text });
  return text;
}

/** A living entity's health from its data (the "health" entry of its metadata), or null when it cannot be read. */
export function entityHealth(bot: { registry?: any }, entity: { name?: string; metadata?: unknown[]; health?: number }): number | null {
  if (typeof entity.health === 'number' && Number.isFinite(entity.health)) return Math.round(entity.health * 10) / 10;
  if (!Array.isArray(entity.metadata)) return null;
  const keys: string[] | undefined = bot.registry?.entitiesByName?.[String(entity.name ?? '')]?.metadataKeys;
  const index = keys?.indexOf('health') ?? -1;
  const value = entity.metadata[index >= 0 ? index : 9];
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
}

/** Kinds whose health and mood the planner reads in the creature rows (the owner's dragon list, 2026-10-21). */
export const WATCHED_KINDS = new Set(['blaze', 'ghast', 'piglin', 'piglin_brute', 'zombified_piglin', 'enderman', 'ender_dragon', 'wither_skeleton',
  'hoglin', 'magma_cube', 'shulker', 'end_crystal']);

/** What a creature row adds for a watched kind: its health, and for an enderman whether it is angry. */
export function watchedEntityFacts(bot: { registry?: any }, entity: { name?: string; metadata?: unknown[]; health?: number }): { health?: number; angry?: boolean } {
  const name = String(entity.name ?? '');
  if (!WATCHED_KINDS.has(name)) return {};
  const health = name === 'end_crystal' ? null : entityHealth(bot, entity);
  return { ...(health !== null ? { health } : {}), ...(name === 'enderman' || name === 'zombified_piglin' ? { angry: isAngry(entity, bot.registry) } : {}) };
}
