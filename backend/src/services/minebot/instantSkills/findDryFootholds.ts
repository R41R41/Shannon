import { Vec3 } from 'vec3';
import { CustomBot, InstantSkill } from '../types.js';
import { holdsWater } from '../utils/waterBlocks.js';

const AIR = new Set(['air', 'cave_air', 'void_air']);
const LIQUID = new Set(['water', 'lava']);
const UNSAFE_SUPPORT = new Set([
  'magma_block', 'cactus', 'campfire', 'soul_campfire', 'powder_snow',
  'sweet_berry_bush', 'fire', 'soul_fire', 'cobweb',
]);

export interface DryFoothold {
  /** Exact center of the two-block-high space for the bot's feet. */
  x: number;
  y: number;
  z: number;
  distance: number;
  horizontalDistance: number;
  verticalDelta: number;
  groundBlock: string;
}

export interface DryFootholdScan {
  origin: { x: number; y: number; z: number };
  candidates: DryFoothold[];
  scannedColumns: number;
  unloadedColumns: number;
}

type TerrainReader = Pick<CustomBot, 'entity' | 'blockAt'>;

function openDrySpace(block: ReturnType<TerrainReader['blockAt']>): boolean {
  // Seagrass and kelp have no collision box but are always under water.
  if (!block || LIQUID.has(block.name) || holdsWater(block) || UNSAFE_SUPPORT.has(block.name)) return false;
  return AIR.has(block.name) || block.boundingBox === 'empty';
}

function safeSupport(block: ReturnType<TerrainReader['blockAt']>): boolean {
  return Boolean(block && !AIR.has(block.name) && !LIQUID.has(block.name)
    && !UNSAFE_SUPPORT.has(block.name) && block.boundingBox !== 'empty');
}

const MAX_RADIUS = 64;
const NEAR_RADIUS = 16;
const FAR_STEP = 2;

/**
 * Read only loaded client chunks. This is geometry, not a path or safety proof:
 * walls, currents, hostile mobs and stale chunks can still prevent arrival.
 */
export function scanDryFootholds(
  bot: TerrainReader,
  options: { radius?: number; maxVertical?: number; maxCandidates?: number;
    /** Every candidate out to the radius, not the nearest few: for a caller that ranks them itself. */ wide?: boolean } = {},
): DryFootholdScan {
  const radius = Math.max(1, Math.min(MAX_RADIUS, Math.floor(options.radius ?? 8)));
  const maxVertical = Math.max(1, Math.min(24, Math.floor(options.maxVertical ?? 12)));
  const maxCandidates = Math.max(1, Math.min(12, Math.floor(options.maxCandidates ?? 8)));
  const position = bot.entity.position;
  const origin = { x: position.x, y: position.y, z: position.z };
  const baseX = Math.floor(position.x);
  const baseY = Math.floor(position.y);
  const baseZ = Math.floor(position.z);
  const candidates: DryFoothold[] = [];
  let scannedColumns = 0;
  let unloadedColumns = 0;

  // Every column nearby; beyond that every other one, and only when the near
  // ring came up short. In open water the shore was further than the old
  // 16-block limit, and a bot that could not see it stayed afloat among
  // drowned until it died (paid run L21).
  const near = Math.min(radius, NEAR_RADIUS);
  const scanColumn = (dx: number, dz: number) => {
    scannedColumns++;
    const x = baseX + dx;
    const z = baseZ + dz;
    let best: DryFoothold | null = null;
    let unloaded = false;
    for (let y = baseY - maxVertical; y <= baseY + maxVertical; y++) {
      const support = bot.blockAt(new Vec3(x, y - 1, z), false);
      const feet = bot.blockAt(new Vec3(x, y, z), false);
      const head = bot.blockAt(new Vec3(x, y + 1, z), false);
      if (!support || !feet || !head) { unloaded = true; continue; }
      if (!safeSupport(support) || !openDrySpace(feet) || !openDrySpace(head)) continue;
      const centerX = x + 0.5;
      const centerZ = z + 0.5;
      const horizontalDistance = Math.hypot(centerX - position.x, centerZ - position.z);
      const verticalDelta = y - position.y;
      const candidate = { x: centerX, y, z: centerZ,
        distance: Math.hypot(horizontalDistance, verticalDelta),
        horizontalDistance, verticalDelta, groundBlock: support.name };
      if (!best || candidate.distance < best.distance) best = candidate;
    }
    if (unloaded) unloadedColumns++;
    if (best) candidates.push(best);
  };
  for (let dx = -near; dx <= near; dx++) {
    for (let dz = -near; dz <= near; dz++) if (dx * dx + dz * dz <= near * near) scanColumn(dx, dz);
  }
  if (radius > near && (options.wide || candidates.length < maxCandidates)) {
    for (let dx = -radius; dx <= radius; dx += FAR_STEP) {
      for (let dz = -radius; dz <= radius; dz += FAR_STEP) {
        const reach = dx * dx + dz * dz;
        if (reach > near * near && reach <= radius * radius) scanColumn(dx, dz);
      }
    }
  }

  candidates.sort((a, b) => a.distance - b.distance
    || a.horizontalDistance - b.horizontalDistance || a.x - b.x || a.z - b.z);
  return { origin, candidates: options.wide ? candidates : candidates.slice(0, maxCandidates), scannedColumns, unloadedColumns };
}

/** The nearest few footholds that are not bunched on one ledge: places worth asking the navigator about. */
export function spreadFootholds(candidates: DryFoothold[], limit: number, separation: number): DryFoothold[] {
  const picked: DryFoothold[] = [];
  for (const site of [...candidates].sort((a, b) => a.distance - b.distance)) {
    if (picked.length >= limit) break;
    if (picked.every(other => Math.hypot(other.x - site.x, other.z - site.z) >= separation)) picked.push(site);
  }
  return picked;
}

class FindDryFootholds extends InstantSkill {
  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'find-dry-footholds';
    this.description = 'ロード済み周辺ブロックから、固い足場と足・頭の乾いた空間を持つ立地点を検索する読み取り専用スキル。水中脱出や崖・洞窟で足場を探すときに使う。候補座標は経路到達性や敵の安全を保証しない。';
    this.maxDurationMs = 10_000;
    this.params = [
      { name: 'radius', type: 'number', description: '水平検索半径。既定8、最大64ブロック（16を超える範囲は、近くに候補が足りない時だけ1列おきに調べる。広い水域で岸を探す時に使う）。', default: 8 },
      { name: 'maxVertical', type: 'number', description: '現在高度から上下への検索幅。既定12、最大24ブロック。', default: 12 },
      { name: 'maxCandidates', type: 'number', description: '表示する候補数。既定8、最大12。', default: 8 },
    ];
  }

  async runImpl(radius = 8, maxVertical = 12, maxCandidates = 8) {
    if (![radius, maxVertical, maxCandidates].every(value => Number.isFinite(value) && value >= 1)) {
      return { success: false, result: '検索半径・上下幅・候補数は正の有限値が必要です',
        failureType: 'invalid_input', recoverable: true };
    }
    const scan = scanDryFootholds(this.bot, { radius, maxVertical, maxCandidates });
    if (!scan.candidates.length) return { success: true,
      result: `周囲${Math.min(MAX_RADIUS, Math.floor(radius))}ブロックのロード済み領域には乾いた立地点が見つかりませんでした（${scan.unloadedColumns}/${scan.scannedColumns}列に未ロード区間）。探索範囲外・未ロード領域は不明です。` };
    const entries = scan.candidates.map(site =>
      `(${site.x.toFixed(1)}, ${site.y}, ${site.z.toFixed(1)}) 距離${site.distance.toFixed(1)}m`+
      `（水平${site.horizontalDistance.toFixed(1)}m、高低差${site.verticalDelta >= 0 ? '+' : ''}${site.verticalDelta.toFixed(1)}m、足場${site.groundBlock}）`);
    return { success: true,
      result: `乾いた立地点候補: ${entries.join('; ')}。${scan.unloadedColumns}/${scan.scannedColumns}列に未ロード区間。`+
        'これはブロック形状の観測であり経路到達性・水流・敵の安全は未検証です。移動後は実際の水中状態と呼吸を再確認してください。' };
  }
}

export default FindDryFootholds;
