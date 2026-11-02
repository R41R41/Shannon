import minecraftData from 'minecraft-data';
import { detectVillage } from '../utils/landmarks.js';
import { scanLoadedBlocks } from '../utils/loadedBlockScan.js';
import { FRAME_RING_STEP, FRAME_SEARCH_DEFAULT, FRAME_SEARCH_MAX, framesAround, nextSurveyPoints, ringPoints, surveyOf } from '../utils/huntFrameSearch.js';
import { campSite, campWords } from '../utils/huntCamp.js';
import { bodyReader } from '../utils/localMap.js';
import { WOOL_COLORS } from '../utils/nightGate.js';
import { CustomBot, InstantSkill } from '../types.js';

/**
 * 原子的スキル: 特定の構造物を探す
 */
/** Blocks that only a structure of the kind places, read from the loaded chunks (village: see detectVillage). */
// Plain blackstone lies about the Nether and stone bricks stand in villages and ruins: only blocks the structure alone
// places count, so an explore does not stop (and remember a place) on a false sign.
export const STRUCTURE_MARKERS: Record<string, { blocks: string[]; distance: number }> = {
  fortress: { blocks: ['nether_bricks', 'nether_brick_fence'], distance: 256 },
  bastion: { blocks: ['polished_blackstone_bricks', 'gilded_blackstone'], distance: 256 },
  stronghold: { blocks: ['end_portal_frame', 'infested_stone_bricks', 'infested_mossy_stone_bricks', 'infested_cracked_stone_bricks'], distance: 64 },
  // A bed set down in the world (an igloo's, a village's): one to take, not a structure to enter (explore-for-structure only).
  bed: { blocks: WOOL_COLORS.map(color => `${color}_bed`), distance: 128 },
};

/** The nearest marker of the structure in the loaded chunks, or null. */
export function structureNearby(bot: any, type: string): { name: string; position: { x: number; y: number; z: number } } | null {
  if (type === 'village') { const village = detectVillage(bot); return village ? { name: 'village', position: village.position } : null; }
  const marker = STRUCTURE_MARKERS[type]; if (!marker) return null;
  const scan = scanLoadedBlocks(bot, marker.blocks, { maxHits: 1, maxDistance: marker.distance });
  return scan.hits[0] ? { name: scan.hits[0].name, position: scan.hits[0].position } : null;
}

class FindStructure extends InstantSkill {
  private mcData: any;

  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'find-structure';
    this.description = '指定した構造物（要塞、村、ネザー要塞など）を、読み込み済みの範囲から探します。村は観測のlandmarksにも自動で出ます。'
      // Only the loaded chunks are searched: not found means not here yet, not nowhere.
      + '見つからなければ、まだ行っていない方角へ100〜200ブロック移動してから、もう一度探してください（ネザー要塞はネザーの中だけ）。'
      + 'stronghold はエンドポータルの枠だけを探し（高さは問わない）、中心 x・z と半径 radius（最大128）を指定できます。枠が無い時は、16ブロック刻みの輪の次の点を返します。'
      + 'blaze_spawner はネザー要塞のブレイズの湧き場と、その3m以内の野営向きの足場（縁・火の無い所）を返します';
    this.mcData = minecraftData(this.bot.version);
    this.params = [
      {
        name: 'structureType',
        type: 'string',
        description:
          '構造物の種類（fortress=ネザー要塞, village=村, stronghold=要塞, blaze_spawner=ブレイズの湧き場など）',
        required: true,
      },
      { name: 'radius', type: 'number', description: 'stronghold だけ: 枠を探す半径（中心から水平に。既定64、最大128）' },
      { name: 'x', type: 'number', description: 'stronghold だけ: 探す中心の x（既定は今いる所）。z と一緒に' },
      { name: 'z', type: 'number', description: 'stronghold だけ: 探す中心の z' },
    ];
  }

  /**
   * stronghold: the portal room's frames (only `end_portal_frame` is the portal room), over the whole height of the loaded chunks, within the
   * radius of the centre; when there is none, the rings of points sixteen blocks apart to walk (utils/huntFrameSearch), those no scan has covered.
   */
  private strongholdFrames(radius?: number, x?: number, z?: number) {
    const body = this.bot.entity.position;
    const center = Number.isFinite(x) && Number.isFinite(z) ? { x: Math.floor(x as number), z: Math.floor(z as number) } : { x: Math.floor(body.x), z: Math.floor(body.z) };
    const limit = Math.max(FRAME_RING_STEP, Math.min(FRAME_SEARCH_MAX, Math.round(Number.isFinite(radius) ? radius as number : FRAME_SEARCH_DEFAULT)));
    const scan = framesAround(this.bot as any, center, limit);
    const survey = surveyOf(this.bot as any, center, limit);
    survey.scans.push({ x: body.x, z: body.z, reach: scan.reach });
    if (survey.scans.length > 64) survey.scans.shift();
    const way = (p: { x: number; z: number }) => {
      const dx = p.x - body.x, dz = p.z - body.z, d = Math.round(Math.hypot(dx, dz));
      return `${d}m ${['北', '北東', '東', '南東', '南', '南西', '西', '北西'][Math.round(((Math.atan2(dx, -dz) * 180 / Math.PI + 360) % 360) / 45) % 8]}`;
    };
    if (scan.frames.length) {
      const eyes = scan.frames.filter(frame => frame.eye === true).length, known = scan.frames.filter(frame => frame.eye !== null).length;
      const nearest = scan.frames[0];
      try { (this.bot as any).placeMemory?.remember('stronghold', { x: nearest.x, y: nearest.y, z: nearest.z }, { note: 'end_portal_frame' }); } catch { /* memory is optional */ }
      const list = scan.frames.slice(0, 12).map(frame => `(${frame.x}, ${frame.y}, ${frame.z})${frame.eye === true ? '目あり' : frame.eye === false ? '目なし' : ''}`).join(' ');
      return { success: true, result: `エンドポータルの枠を発見: ${scan.frames.length}個${known ? `（目が入っている ${eyes}/${known}）` : ''}。いちばん近い枠 (${nearest.x}, ${nearest.y}, ${nearest.z})、自分から ${way(nearest)}・高さ ${nearest.y - Math.floor(body.y) >= 0 ? '+' : ''}${nearest.y - Math.floor(body.y)}。枠: ${list}` };
    }
    // No frame in the loaded chunks: what shows a stronghold is near (the infested bricks), and what has not been looked at yet.
    const evidence = scanLoadedBlocks(this.bot as any, STRUCTURE_MARKERS.stronghold.blocks.filter(name => name !== 'end_portal_frame'), { maxHits: 1, maxDistance: limit + 320 }).hits[0];
    const seen = evidence ? `要塞の石レンガ（${evidence.name}）は (${evidence.position.x}, ${evidence.position.y}, ${evidence.position.z}) にある（自分から ${way(evidence.position)}）が、枠はまだ見えない。` : '要塞の痕跡（枠・感染した石レンガ）も見えない。';
    const next = nextSurveyPoints(ringPoints(center, limit, { x: body.x, z: body.z }), survey.scans, { x: body.x, z: body.z });
    const done = ringPoints(center, limit).length;
    const hint = next.length
      ? `輪（${FRAME_RING_STEP}ブロック刻み）の次の点（読み込みが届いていない所。歩いて着いたら、もう一度 stronghold で探す）: ${next.map(point => `(${point.x}, ${point.z}) 輪${point.ring}`).join(' ')}`
      : `半径${limit}まで読み込み済みの範囲で見終わった（${done}点の輪のどれにも届いている）。枠は無い: 中心 (${center.x}, ${center.z}) が要塞から外れている（交点を引き直す）か、半径を広げる`;
    return { success: true, result: `中心 (${center.x}, ${center.z}) の半径${limit}mの読み込み済みの範囲（自分から約${scan.reach}m、${scan.columns}列）に、エンドポータルの枠はありません。${seen}${hint}。要塞の位置が分からない間は、離れた 2 地点で目玉を投げて（use item=ender_eye）方位の線の交点を探します` };
  }

  /**
   * blaze_spawner: the spawner blocks in the loaded chunks of the Nether (every spawner there is a fortress's blaze spawner), and for the nearest one the cells within three
   * blocks to camp on (utils/huntCamp: floor, two open cells, no edge, no fire), so that the planner goes to a cell that a push does not drop the body from.
   */
  private blazeSpawner() {
    const bot = this.bot as any;
    const dimension = String(bot.game?.dimension ?? '').replace(/^minecraft:/u, '');
    if (dimension && dimension !== 'the_nether') return { success: true, result: `ブレイズの湧き場はネザー要塞の中にある（ここは ${dimension}）` };
    const scan = scanLoadedBlocks(bot, ['spawner'], { maxHits: 4, maxDistance: 128 });
    if (!scan.hits.length) {
      let known = '';
      try {
        const remembered = bot.placeMemory?.recall('blaze_spawner', 1)?.[0];
        known = remembered ? `以前に見た湧き場: (${remembered.position.x}, ${remembered.position.y}, ${remembered.position.z}) ${remembered.distance}m ${remembered.direction}。` : '';
      } catch { known = ''; }
      return { success: true, result: `読み込み済みの範囲（約${Math.min(scan.reachMetres, 128)}m）に湧き場はありません。${known}ネザー要塞（find-structure fortress）の通路を進んで、もう一度探してください` };
    }
    const nearest = scan.hits[0];
    try { bot.placeMemory?.remember('blaze_spawner', nearest.position, { note: 'spawner' }); } catch { /* memory is optional */ }
    const site = campSite(bodyReader(bot), nearest.position, 4);
    const others = scan.hits.slice(1).map((hit: any) => `(${hit.position.x}, ${hit.position.y}, ${hit.position.z}) ${Math.floor(hit.distance)}m`).join(' ');
    return { success: true, result: `ブレイズの湧き場を発見: (${nearest.position.x}, ${nearest.position.y}, ${nearest.position.z})、距離${Math.floor(nearest.distance)}m${others ? `（ほかに ${others}）` : ''}。`
      + `${campWords(site)}${site.fire ? `。湧き場の5m以内に火が${site.fire}個（火の中と隣へは go が行かない）` : ''}。`
      + 'そこへ go で着いてから attack hold か fight（盾は左手。盾は火の玉1つで6すり減る＝予備を持つ）' };
  }

  async runImpl(structureType: string, radius?: number, x?: number, z?: number) {
    try {
      // 構造物の種類を正規化
      const normalizedType = structureType.toLowerCase();
      if (normalizedType === 'stronghold') return this.strongholdFrames(radius, x, z);
      if (normalizedType === 'blaze_spawner' || normalizedType === 'spawner') return this.blazeSpawner();

      // サポートされている構造物
      const supportedStructures = [
        'fortress', // ネザー要塞
        'village', // 村
        'stronghold', // エンドポータル要塞
        'monument', // 海底神殿
        'mansion', // 森の洋館
        'temple', // ジャングル/砂漠の寺院
        'mineshaft', // 廃坑
        'bastion', // 砦の遺跡（ネザー）
      ];

      if (!supportedStructures.includes(normalizedType)) {
        return {
          success: false,
          result: `サポートされていない構造物です。対応: ${supportedStructures.join(
            ', '
          )}`,
        };
      }

      // 構造物に特徴的なブロックを探す
      let searchBlocks: string[] = [];
      let searchDistance = 128;

      // The same markers the explore stops on: stone bricks stand in villages and ruins, plain blackstone in the
      // basalt deltas, so neither says a stronghold or a bastion is here.
      switch (normalizedType) {
        case 'fortress':
        case 'bastion':
        case 'stronghold':
          searchBlocks = STRUCTURE_MARKERS[normalizedType].blocks;
          searchDistance = STRUCTURE_MARKERS[normalizedType].distance;
          break;
        case 'village':
          searchBlocks = ['bell', 'hay_block'];
          searchDistance = 128;
          break;
        default:
          return {
            success: false,
            result: `${structureType}の検索方法が未実装です`,
          };
      }

      // Only what the server has sent can be read: the loaded chunks around the body.
      if (normalizedType === 'village') {
        const reach = scanLoadedBlocks(this.bot as any, ['bell']).reachMetres;
        const village = detectVillage(this.bot as any);
        return { success: true, result: village
          ? `村を発見: ${village.direction}へ約${village.distance}m、座標(${village.position.x}, ${village.position.y}, ${village.position.z})。根拠: ${village.evidence}`
          : `読み込み済みの範囲（約${reach}m）に村の目印（鐘、干し草、職業ブロック、ベッドの集まり、村人）はありません。別の方向へ移動すると新しい範囲が読み込まれます` };
      }
      const scan = scanLoadedBlocks(this.bot as any, searchBlocks, { maxHits: 10, maxDistance: searchDistance });
      if (scan.hits.length === 0) {
        // Not in sight now: what was seen before, and which way has not been looked at yet.
        let known = '';
        try {
          const memory = (this.bot as any).placeMemory;
          const remembered = memory?.recall(normalizedType, 1)?.[0];
          known = remembered
            ? `以前に見た場所を覚えています: (${remembered.position.x}, ${remembered.position.y}, ${remembered.position.z}) ${remembered.distance}m ${remembered.direction}。`
            : memory ? `まだ見ていない方角: ${memory.unseen()}。` : '';
        } catch { known = ''; }
        // A stronghold lies underground, often thousands of blocks off: the eye of ender is what points to it.
        if (normalizedType === 'stronghold') known += 'エンダーアイを離れた2地点で投げると（use-item ender_eye）、方位から要塞の位置を絞れます。';
        return {
          success: true,
          result: `読み込み済みの範囲（約${Math.min(scan.reachMetres, searchDistance)}m）に${structureType}の痕跡が見つかりませんでした。${known}移動してから再度探索してください`,
        };
      }
      const nearest = scan.hits[0];
      // Found once, known from then on (also after the body has died and come back).
      try { (this.bot as any).placeMemory?.remember(normalizedType, nearest.position, { note: nearest.name }); } catch { /* memory is optional */ }
      return {
        success: true,
        result: `${structureType}の痕跡（${nearest.name}）を発見: 座標(${nearest.position.x}, ${nearest.position.y}, ${nearest.position.z}), 距離${Math.floor(nearest.distance)}m`,
      };
    } catch (error: any) {
      return {
        success: false,
        result: `構造物探索エラー: ${error.message}`,
      };
    }
  }
}

export default FindStructure;
