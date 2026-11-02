import { campSite, campWords, type CampCell } from './huntCamp.js';
import { FRAME_RING_STEP, FRAME_SEARCH_DEFAULT, FRAME_SEARCH_MAX, framesAround, nextSurveyPoints, ringPoints, surveyOf } from './huntFrameSearch.js';
import { bodyReader } from './localMap.js';
import { scanLoadedBlocks } from './loadedBlockScan.js';

/**
 * The two readings of the hunt that are structures (S2, 2026-11-02), as one place so that the skill `find-structure` and the body's `probe` give the same answer:
 *  - the stronghold's portal room: its end portal frames within a radius of a centre, or the next points of the rings to walk (utils/huntFrameSearch);
 *  - the Nether fortress's blaze spawner and the cells within three blocks of it to camp on (utils/huntCamp).
 * The LLM-centric mode calls the body's tools `act` and `probe` and no catalog skill, so what only a skill said was out of its reach; `probe` kinds `frames` and `camp` say it.
 */

/** The blocks that show a stronghold is near without being its portal room (the frames are the portal room). */
export const STRONGHOLD_EVIDENCE_BLOCKS = ['infested_stone_bricks', 'infested_mossy_stone_bricks', 'infested_cracked_stone_bricks'] as const;

export interface FramesReport {
  /** The sentence the planner reads (the same as `find-structure stronghold`). */
  text: string;
  center: { x: number; z: number };
  radius: number;
  /** How far round the body the loaded chunks reach, in metres. */
  reach: number;
  /** The frames in the radius, nearest first (at most 12). */
  found: Array<{ x: number; y: number; z: number; eye: boolean | null }>;
  /** With no frame: the next points of the rings (16 blocks apart) to walk to, those no scan has covered. */
  next: Array<{ x: number; z: number; ring: number }>;
}

const COMPASS = ['北', '北東', '東', '南東', '南', '南西', '西', '北西'];

/**
 * The stronghold's frames: only `end_portal_frame` is the portal room, over the whole height of the loaded chunks, within the radius of the centre; when there is none, the rings
 * of points sixteen blocks apart to walk, those no scan has covered. The nearest frame is remembered as the place of the stronghold.
 */
export function strongholdFramesReport(bot: any, args: { radius?: number | null; x?: number | null; z?: number | null } = {}): FramesReport {
  const body = bot.entity.position;
  const center = Number.isFinite(args.x) && Number.isFinite(args.z) ? { x: Math.floor(args.x as number), z: Math.floor(args.z as number) } : { x: Math.floor(body.x), z: Math.floor(body.z) };
  const limit = Math.max(FRAME_RING_STEP, Math.min(FRAME_SEARCH_MAX, Math.round(Number.isFinite(args.radius) ? args.radius as number : FRAME_SEARCH_DEFAULT)));
  const scan = framesAround(bot, center, limit);
  const survey = surveyOf(bot, center, limit);
  survey.scans.push({ x: body.x, z: body.z, reach: scan.reach });
  if (survey.scans.length > 64) survey.scans.shift();
  const way = (p: { x: number; z: number }) => {
    const dx = p.x - body.x, dz = p.z - body.z, d = Math.round(Math.hypot(dx, dz));
    return `${d}m ${COMPASS[Math.round(((Math.atan2(dx, -dz) * 180 / Math.PI + 360) % 360) / 45) % 8]}`;
  };
  if (scan.frames.length) {
    const eyes = scan.frames.filter(frame => frame.eye === true).length, known = scan.frames.filter(frame => frame.eye !== null).length;
    const nearest = scan.frames[0];
    try { bot.placeMemory?.remember('stronghold', { x: nearest.x, y: nearest.y, z: nearest.z }, { note: 'end_portal_frame' }); } catch { /* memory is optional */ }
    const shown = scan.frames.slice(0, 12);
    const list = shown.map(frame => `(${frame.x}, ${frame.y}, ${frame.z})${frame.eye === true ? '目あり' : frame.eye === false ? '目なし' : ''}`).join(' ');
    return {
      text: `エンドポータルの枠を発見: ${scan.frames.length}個${known ? `（目が入っている ${eyes}/${known}）` : ''}。いちばん近い枠 (${nearest.x}, ${nearest.y}, ${nearest.z})、自分から ${way(nearest)}・高さ ${nearest.y - Math.floor(body.y) >= 0 ? '+' : ''}${nearest.y - Math.floor(body.y)}。枠: ${list}`,
      center, radius: limit, reach: scan.reach, found: shown.map(frame => ({ x: frame.x, y: frame.y, z: frame.z, eye: frame.eye ?? null })), next: [],
    };
  }
  // No frame in the loaded chunks: what shows a stronghold is near (the infested bricks), and what has not been looked at yet.
  const evidence = scanLoadedBlocks(bot, [...STRONGHOLD_EVIDENCE_BLOCKS], { maxHits: 1, maxDistance: limit + 320 }).hits[0];
  const seen = evidence ? `要塞の石レンガ（${evidence.name}）は (${evidence.position.x}, ${evidence.position.y}, ${evidence.position.z}) にある（自分から ${way(evidence.position)}）が、枠はまだ見えない。` : '要塞の痕跡（枠・感染した石レンガ）も見えない。';
  const next = nextSurveyPoints(ringPoints(center, limit, { x: body.x, z: body.z }), survey.scans, { x: body.x, z: body.z });
  const done = ringPoints(center, limit).length;
  const hint = next.length
    ? `輪（${FRAME_RING_STEP}ブロック刻み）の次の点（読み込みが届いていない所。歩いて着いたら、もう一度 stronghold で探す）: ${next.map(point => `(${point.x}, ${point.z}) 輪${point.ring}`).join(' ')}`
    : `半径${limit}まで読み込み済みの範囲で見終わった（${done}点の輪のどれにも届いている）。枠は無い: 中心 (${center.x}, ${center.z}) が要塞から外れている（交点を引き直す）か、半径を広げる`;
  return {
    text: `中心 (${center.x}, ${center.z}) の半径${limit}mの読み込み済みの範囲（自分から約${scan.reach}m、${scan.columns}列）に、エンドポータルの枠はありません。${seen}${hint}。要塞の位置が分からない間は、離れた 2 地点で目玉を投げて（use item=ender_eye）方位の線の交点を探します`,
    center, radius: limit, reach: scan.reach, found: [], next: next.map(point => ({ x: point.x, z: point.z, ring: point.ring })),
  };
}

export interface CampReport {
  text: string;
  /** Whether the answer is a spawner found (false: not in the Nether, or none in the loaded chunks). */
  found: boolean;
  spawner?: { x: number; y: number; z: number; distance: number };
  others: Array<{ x: number; y: number; z: number; distance: number }>;
  cells: CampCell[];
  /** Fire blocks within five blocks of the spawner. */
  fire: number;
}

/**
 * The blaze spawner and where to camp (see utils/huntCamp): the nearest spawner block in the loaded chunks of the Nether (every spawner there is a fortress's), and for it the
 * cells within three blocks that have a floor, two open cells, no edge and no fire.
 */
export function blazeCampReport(bot: any): CampReport {
  const dimension = String(bot.game?.dimension ?? '').replace(/^minecraft:/u, '');
  if (dimension && dimension !== 'the_nether') return { text: `ブレイズの湧き場はネザー要塞の中にある（ここは ${dimension}）`, found: false, others: [], cells: [], fire: 0 };
  const scan = scanLoadedBlocks(bot, ['spawner'], { maxHits: 4, maxDistance: 128 });
  if (!scan.hits.length) {
    let known = '';
    try {
      const remembered = bot.placeMemory?.recall('blaze_spawner', 1)?.[0];
      known = remembered ? `以前に見た湧き場: (${remembered.position.x}, ${remembered.position.y}, ${remembered.position.z}) ${remembered.distance}m ${remembered.direction}。` : '';
    } catch { known = ''; }
    return { text: `読み込み済みの範囲（約${Math.min(scan.reachMetres, 128)}m）に湧き場はありません。${known}ネザー要塞（probe kind=scan が「ネザー要塞」の向きを言う）へ近づいて、もう一度探してください`, found: false, others: [], cells: [], fire: 0 };
  }
  const nearest = scan.hits[0];
  try { bot.placeMemory?.remember('blaze_spawner', nearest.position, { note: 'spawner' }); } catch { /* memory is optional */ }
  const site = campSite(bodyReader(bot), nearest.position, 4);
  const others = scan.hits.slice(1).map((hit: any) => ({ x: hit.position.x, y: hit.position.y, z: hit.position.z, distance: Math.floor(hit.distance) }));
  const text = `ブレイズの湧き場を発見: (${nearest.position.x}, ${nearest.position.y}, ${nearest.position.z})、距離${Math.floor(nearest.distance)}m`
    + `${others.length ? `（ほかに ${others.map(other => `(${other.x}, ${other.y}, ${other.z}) ${other.distance}m`).join(' ')}）` : ''}。`
    + `${campWords(site)}${site.fire ? `。湧き場の5m以内に火が${site.fire}個（火の中と隣へは go が行かない）` : ''}。`
    + 'そこへ go で着いてから attack hold か fight（盾は左手。盾は火の玉1つで6すり減る＝予備を持つ）';
  return { text, found: true, spawner: { x: nearest.position.x, y: nearest.position.y, z: nearest.position.z, distance: Math.floor(nearest.distance) }, others, cells: site.cells, fire: site.fire };
}
