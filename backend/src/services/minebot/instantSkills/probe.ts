import { probeWorksite } from '../utils/probeWorksite.js';
import { probeBedsite } from '../utils/probeBedsite.js';
import { endermanDenCandidates } from '../utils/huntEndermanDen.js';
import { endermanRoofSites } from '../utils/huntEndermanCamp.js';
import { z } from 'zod';
import { Vec3 } from 'vec3';
import { CustomBot, InstantSkill } from '../types.js';
import { digMsWithBestTool } from '../utils/bestToolDigTime.js';
import { bodyReader, feetCell, type Cell } from '../utils/localMap.js';
import { eyeOf, probeAround, probeColumn, probePath, probeHistory, probeSight, type AroundEntity, type SightCreature } from '../utils/probeTools.js';
import { handsNear } from '../utils/handHistory.js';
import { planRoute, summarizeRoute } from '../utils/routePlan.js';
import { routeOptionsOf } from '../utils/routeBudget.js';
import { scanWorld } from '../utils/worldScan.js';
import { isThreatEntity, NEUTRAL_UNTIL_STRUCK } from '../utils/hostileMobHints.js';
import { closingSpeed } from '../utils/threatTracker.js';
import { blazeCampReport, blazeLaneReport, strongholdFramesReport } from '../utils/huntStructures.js';
import { laneProbeFields, LANE_PROJECTION_NOTE } from '../utils/huntLane.js';

/**
 * mc.probe (r4 contract 1, 2026-10-22): the body's reading tools. Read only, a fixed computation each, no LLM, no choice; the category is a
 * query, so it holds none of the body and runs beside an act. Kinds:
 *   path    whether `to` is reached without digging or laying a block (the walk's rules), the way's points, or the breaks and where to stand;
 *   sight   whether a block or a creature is seen from the eye, in reach, how far, and the solid cells between;
 *   column  one column as runs of blocks, the dangers first (a drop of more than three, water, lava, sand and gravel);
 *   around  the creatures within a radius (id, where, height, seen, facing her, closing) and the dangerous blocks round her;
 *   history the act's hands and stops at a place (newest first);
 *   scan    what the loaded chunks hold (logs, a village, water, lava pools, structures, stems, a fortress, spawners, portals).
 *   frames  the stronghold's end portal frames within `radius` blocks of (x, z), or the next points of the 16-block rings to walk (S2: the same as find-structure stronghold);
 *   camp    the Nether's blaze spawner, the cells within three blocks of it to stand on (a floor, two open cells, no edge, no fire) and the hideouts (footings no blaze of it can see; to go to when
 *           the health runs low) (S2: the same as find-structure blaze_spawner).
 *   lane    four read-only lane plans: cells, counts, support order, occupants, reach, safe footings and groups of up to six.
 *   route   the way to `to` with walking, cuts (level, stair, shaft) and laid blocks, shortest, nothing dug that a liquid is over or lava beside; the blocks it digs and lays, before the body moves.
 * The answer is JSON: { v: 1, kind, text, ... } with the sentence first, the dangerous facts said as they are.
 */
export const PROBE_KINDS = ['path', 'sight', 'column', 'around', 'history', 'scan', 'worksite', 'frames', 'camp', 'lane', 'den', 'bedsite', 'roofsite', 'route'] as const;
const Pos = z.object({ x: z.number(), y: z.number(), z: z.number() }).strict();

const DESCRIPTION = '調べる（読むだけ・決まった計算）。kind: path（to へ掘らず置かずに歩いて行けるか。行けるなら道の点、行けないなら切れ目と立てる所）/ '
  + 'sight（target のブロックか生き物 #id が目から見えるか・届くか・間のブロック）/ column（x,z の縦の列。yFrom・yTo。落差・水・溶岩・砂利）/ '
  + 'around（radius 内の生き物と危ないブロック）/ history（at の radius 内の最近の手と止まり）/ scan（読み込み済みの範囲の目印。radius はチャンク）。'
  + 'worksite（target: 目的物、to: 作業位置、retreat: 帰還先。接近・呼吸・取得・逆向きの道を別々に確認）/ '
  + 'frames（要塞のエンドポータルの枠。x・z=探す中心（既定は足）、radius=ブロック16〜128（既定64）。枠が無ければ16ブロック刻みの輪の次に歩く点）/ '
  + 'route（to への最短の道を掘る数・置く数つきで見積る。動く前の見積り）/ camp（ネザーのブレイズの湧き場と、その3m以内で縁・火の無い野営向きの足場と、湧き場から見えない隠れ場所）。'
  + 'lane（' + LANE_PROJECTION_NOTE + 'spawner の四方向のレーン計画。省略時は近い湧き場。丸石・建築順・支え・生き物・待ち場からの距離と危険。build の standAtCell は cells の足マス参照、group は同じ立ち位置で最大6マス、末尾の walk は from（既定は足）からの歩数、立ち位置なしは全て null。facts 末尾の standFact は standFacts の参照で noStand・blockedByCreature・fireNear。目から4.3以内で視線が通り、火・液体・マグマ・縁を避ける。計画のマスを避け、先行設置が成功した地形も含め四方向・上下1段までを2000マス探索し、歩数・従来順位の順に立ち位置を選ぶ。着けない場合は noStand: unreachable。実地形を確認して go で立ち位置へ→同じ group の place、占有マスは組の末尾で再確認。fireNear は立ち位置なしなら null、安全なら false。読むだけ）。'
  + 'bedsite（target:#id。エンドの現在phase2進入から、実在庫かつ黒曜石12個以内のベッド配置候補・施工セル・立場を読む。初回はpacket_history_pending。施工や起爆はしない）。'
  + 'roofsite（radius既定16内の（見える目が 0 なら体が半径 24 まで広げて読む）、3×3完成屋根の中心・既屋根外注視位置から目が見える見込みのエンダーマン（8〜48m）が多い順に5件。必要ブロック数・距離つき。予測なので go 後に fight target=enderman が再確認）。'
  + '結果は JSON（text が先頭。危ない事実をそのまま書く）。';

const cellOf = (value: { x: number; y: number; z: number }): Cell => ({ x: Math.floor(value.x), y: Math.floor(value.y), z: Math.floor(value.z) });
const bad = (text: string) => ({ success: false, result: text, failureType: 'invalid_input' });

class Probe extends InstantSkill {
  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'probe';
    this.description = DESCRIPTION;
    this.maxDurationMs = 30_000;
    this.params = [
      { name: 'kind', type: 'json', schema: z.enum(PROBE_KINDS), description: 'path・sight・column・around・history・scan・worksite・frames・camp・lane・den・bedsite・roofsite・route', required: true },
      { name: 'to', type: 'json', schema: Pos, description: 'path: 行きたいマス' },
      { name: 'from', type: 'json', schema: Pos, description: 'path・route・sight・lane: 出発・目の位置の足のマス（既定は足）' },
      { name: 'target', type: 'json', schema: z.union([Pos, z.string().max(64), z.number()]), description: 'sight: ブロック {x,y,z} か生き物 "#id"' },
      { name: 'x', type: 'number', description: 'column: 列の x（既定は足）/ frames: 探す中心の x' },
      { name: 'z', type: 'number', description: 'column: 列の z（既定は足）/ frames: 探す中心の z' },
      { name: 'yFrom', type: 'number', description: 'column: 下端の y（既定 足−16）' },
      { name: 'yTo', type: 'number', description: 'column: 上端の y（既定 足+16）' },
      { name: 'radius', type: 'number', description: 'around: m（1〜16、既定 8）/ history: m（1〜32、既定 4）/ scan: チャンク（1〜16、既定は読み込み済みの全部）/ frames: ブロック（16〜128、既定 64）' },
      { name: 'at', type: 'json', schema: Pos, description: 'history: 場所（既定は足）' },
      { name: 'retreat', type: 'json', schema: Pos, description: 'worksite: 帰還先（逆向きの道を別に調べる）' },
      { name: 'spawner', type: 'json', schema: Pos, description: 'lane: 湧き場のマス（省略時はネザーの読み込み済みの範囲の近い湧き場）' },
      { name: 'range', type: 'number', description: 'route: to にどこまで近づけばよいか（m、既定 0）' },
    ];
  }

  async runImpl(kind: string, to?: { x: number; y: number; z: number } | null, from?: { x: number; y: number; z: number } | null,
    target?: { x: number; y: number; z: number } | string | number | null, x?: number | null, z?: number | null, yFrom?: number | null, yTo?: number | null,
    radius?: number | null, at?: { x: number; y: number; z: number } | null, retreat?: { x: number; y: number; z: number } | null,
    spawner?: { x: number; y: number; z: number } | null, range?: number | null) {
    const result = await runProbe(this.bot as any, { kind, to, from, target, x, z, yFrom, yTo, radius, at, retreat, spawner, range });
    return result;
  }
}

export interface ProbeInput {
  kind: string; to?: { x: number; y: number; z: number } | null; from?: { x: number; y: number; z: number } | null;
  target?: { x: number; y: number; z: number } | string | number | null; x?: number | null; z?: number | null; yFrom?: number | null; yTo?: number | null;
  retreat?: { x: number; y: number; z: number } | null;
  radius?: number | null; at?: { x: number; y: number; z: number } | null;
  spawner?: { x: number; y: number; z: number } | null;
  range?: number | null;
}

/** A creature named as the contract does: "#12", "12" or 12 (an id), else the nearest of that name. */
function creatureOf(bot: any, target: string | number): any | null {
  const text = String(target).trim();
  const id = /^#?\d+$/u.test(text) ? Number(text.replace('#', '')) : null;
  const entities = Object.values(bot.entities ?? {}) as any[];
  if (id !== null) return bot.entities?.[id] ?? entities.find(entity => entity?.id === id) ?? null;
  const name = text.replace(/^minecraft:/u, '').toLowerCase();
  const here = bot.entity?.position;
  return entities.filter(entity => entity?.position && entity !== bot.entity && String(entity.name ?? entity.username ?? '').toLowerCase() === name)
    .sort((a, b) => (here ? a.position.distanceTo(here) - b.position.distanceTo(here) : 0))[0] ?? null;
}

/** The creatures round the body as the probe reads them (no items, no experience orbs, not herself). */
function aroundEntities(bot: any): AroundEntity[] {
  const out: AroundEntity[] = [];
  for (const entity of Object.values(bot.entities ?? {}) as any[]) {
    if (!entity?.position || entity === bot.entity || entity.name === 'item' || entity.name === 'experience_orb' || entity.name === 'arrow') continue;
    const name = String(entity.username ?? entity.name ?? 'unknown');
    const type = String(bot.registry?.entitiesByName?.[entity.name ?? '']?.type ?? entity.type ?? '');
    let closing: number | null = null;
    try { closing = closingSpeed(bot, entity.id); } catch { closing = null; }
      // Rig end1109f02: the scan said an unprovoked enderman or zombified piglin was （敵） by the game's category; the body's one rule (isThreatEntity) says
      // they leave her alone until struck (a piglin: while she wears gold). Said as neutral, as the frame does (worldFrame).
    out.push({ id: Number(entity.id), name, position: entity.position, yaw: entity.yaw, headYaw: entity.headYaw, height: entity.height,
      hostile: entity.type !== 'player' && isThreatEntity(entity, type, Date.now(), bot),
      neutral: entity.type !== 'player' && NEUTRAL_UNTIL_STRUCK.includes(String(entity.name ?? '').toLowerCase()) && !isThreatEntity(entity, type, Date.now(), bot), closing });
  }
  return out;
}

const clampRadius = (value: number | null | undefined, low: number, high: number, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(low, Math.min(high, Math.round(value))) : fallback;

/**
 * Where the endermen within 64 m are, for a roofsite read that found no eyes: the way most of them lie (of eight) and the nearest three with
 * distance, way and height against the feet. Empty when there is none.
 */
export function endermenWay(bot: any): string {
  const at = bot.entity?.position;
  if (!at) return '';
  const all = (Object.values(bot.entities ?? {}) as any[]).filter(e => e?.name === 'enderman' && e.position && e.isValid !== false && e.position.distanceTo(at) <= 64)
    .sort((a, b) => a.position.distanceTo(at) - b.position.distanceTo(at));
  if (!all.length) return '';
  const names = ['北', '北東', '東', '南東', '南', '南西', '西', '北西'];
  const wayOf = (e: any) => names[Math.round(((Math.atan2(e.position.x - at.x, -(e.position.z - at.z)) * 180 / Math.PI + 360) % 360) / 45) % 8];
  const count = new Map<string, number>();
  for (const e of all) count.set(wayOf(e), (count.get(wayOf(e)) ?? 0) + 1);
  const [most, many] = [...count].sort((a, b) => b[1] - a[1])[0];
  const dy = (e: any) => { const d = Math.floor(e.position.y) - Math.floor(at.y); return d === 0 ? '同じ高さ' : d > 0 ? `${d} 上` : `${-d} 下`; };
  const near = all.slice(0, 3).map(e => `#${e.id} ${e.position.distanceTo(at).toFixed(0)}m ${wayOf(e)}・${dy(e)}`).join('、');
  return `64m 内の ${all.length} 体のうち ${many} 体が${most}（近い順: ${near}）。`;
}

/** One probe on a live body (also from tests): the skill's result, its text the contract's JSON. */
export async function runProbe(bot: any, input: ProbeInput): Promise<{ success: boolean; result: string; failureType?: string }> {
  const feet = feetCell(bot);
  if (!feet) return { success: false, result: '体が無い（接続が切れた）', failureType: 'disconnected' };
  const read = bodyReader(bot);
  // The sentence first (the contract), then the fields. Large four-direction lane plans with footings
  // can exceed the caller's 16,000-character receipt; never silently omit their required build columns here.
  const answer = (value: { v: 1; kind: string; text: string }) => {
    const { v, kind, text, ...rest } = value;
    return { success: true, result: JSON.stringify({ v, kind, text, ...rest }) };
  };
  switch (input.kind) {
    case 'den': {
      // The enderman den candidates (huntEndermanDen.ts): read only, nearest and best first, at most 8. The body does not choose or dig one; the head picks an entrance and passes it as the fight hand's den.
      const found = endermanDenCandidates(bot as any, { limit: 8 });
      const lines = found.map(c => `入口 (${c.entrance.x},${c.entrance.y},${c.entrance.z}) 向き ${c.direction}・見通し ${c.sightDistance}m・未掘削 ${c.remaining}/4${c.penalties.length ? '（' + c.penalties.join('、') + '）' : ''}`);
      return answer({ v: 1, kind: 'den', text: found.length ? `横穴の候補 ${found.length} 件: ${lines.join(' / ')}` : '横穴を掘れる壁の候補は見つからない（半径内に、4 マスを掘れて溶岩・空洞に開かず入口から外が見える壁が無い）', candidates: found.map(c => ({ entrance: c.entrance, direction: c.direction, dig: c.dig, wait: c.wait, outside: c.outside, sightDistance: c.sightDistance, distance: c.distance, remaining: c.remaining, score: c.score, penalties: c.penalties })) } as any);
    }
    case 'bedsite': return answer(await probeBedsite(bot, input.target));
    case 'roofsite': {
      const radius = clampRadius(input.radius, 4, 24, 16);
      const blind = (r: ReturnType<typeof endermanRoofSites>) => !r.sites.length || (r.sites[0].seen === 0 && r.sites[0].open < 30);
      let report = endermanRoofSites(bot, radius);
      // end1109p07b: in a walled pocket every radius-16 read said "no eyes" (9, 5, 8 endermen within 64 m) for about 20 minutes; the one read at 24
      // found sites with 4 in sight 23 m off. A blind answer at a smaller radius reads the widest one itself before saying so.
      let widened = false;
      if (blind(report) && radius < 24) { const wide = endermanRoofSites(bot, 24); if (!blind(wide)) { report = wide; widened = true; } }
      const lines = report.sites.map(s => `(${s.cell.x},${s.cell.y},${s.cell.z}) 完成屋根から目が見える見込み ${s.seen} 体・見通し ${s.open}%${s.above >= 3 ? `・エンダーマンの立つ高さより ${s.above} 上（歩いて登れないと来ない）` : ''}・ブロック ${s.blocks}・${s.distance}m`);
      // Where the endermen are, when no site here sees them: the old words "move somewhere open or high, or wait" kept p07b waiting and probing in place.
      const way = endermenWay(bot);
      const toward = `${way}そちらへ go で歩いて（囲まれた所からは maxDig 40〜60・maxPlace 24〜30、canDig に足元の周りの石も入れる）、着いてから probe kind=roofsite で読み直す`;
      const text = !report.sites.length ? `半径 24 内に完成屋根を計画できる所を確認できない（エンダーマン ${report.endermen} 体が 64m 内に見えている）。${toward}`
        : blind(report) ? `半径 24 までの候補では完成屋根から 8〜48m に見える目を確認できない（64m 内に ${report.endermen} 体）。${toward}。今の候補: ${lines.slice(0, 3).join(' / ')}`
          : `屋根の場所の候補（${widened ? `半径 ${radius} では見える目が 0 だったので半径 24 で読んだ。` : ''}今見える目と見通しの良い順。見通しは 12・24m 先の目の高さへの線が通る割合で、開けた所ほど後から来る個体も見える。実fightで再確認）: ${lines.join(' / ')}`;
      return answer({ v: 1, kind: 'roofsite', text, endermen: report.endermen, sites: report.sites, ...(widened ? { radius: 24 } : {}) } as any);
    }
    case 'worksite': {
      if (!input.target || typeof input.target !== 'object') return bad('worksite には target のブロック座標が要る');
      // A coordinate that is not a finite number (called directly, not through the schema) would turn into null in the JSON answer.
      const points = [input.target, input.to, input.retreat].filter((point): point is { x: number; y: number; z: number } => !!point && typeof point === 'object');
      if (!points.every(point => [point.x, point.y, point.z].every(value => Number.isFinite(value)))) return bad('worksite の座標は有限の数で書く');
      return answer(await probeWorksite(bot, feet, cellOf(input.target), input.to ? cellOf(input.to) : undefined, input.retreat ? cellOf(input.retreat) : undefined));
    }
    case 'path': {
      if (!input.to) return bad('path には to {x,y,z} が要る');
      return answer(await probePath(read, input.from ? cellOf(input.from) : feet, cellOf(input.to)));
    }
    case 'route': {
      if (!input.to) return bad('route には to {x,y,z} が要る');
      const goal = cellOf(input.to);
      if (![goal.x, goal.y, goal.z].every(Number.isFinite)) return bad('route の座標は有限の数で書く');
      const plan = planRoute(read, input.from ? cellOf(input.from) : feet, [goal], routeOptionsOf(bot, { range: typeof input.range === 'number' && input.range > 0 ? Math.min(32, input.range) : 0 }));
      const t = plan.totals;
      return answer({ v: 1, kind: 'route', text: summarizeRoute(plan, `(${goal.x},${goal.y},${goal.z})`), status: plan.status, steps: t.steps, walk: t.walk, up: t.up, down: t.down, dig: t.dig, place: t.place, seconds: t.seconds,
        digs: plan.digsByName, wet: plan.wet.length, ...(plan.frontier ? { frontier: plan.frontier } : {}), ...(plan.over ? { over: plan.over } : {}), ...(plan.alt ? { alt: plan.alt } : {}),
        points: plan.steps.filter((_, i) => i % Math.max(1, Math.ceil(plan.steps.length / 12)) === 0 || i === plan.steps.length - 1).map(step => step.to), ms: plan.ms } as any);
    }
    case 'sight': {
      if (input.target === undefined || input.target === null) return bad('sight には target（{x,y,z} か "#id"）が要る');
      const eye = input.from ? eyeOf(cellOf(input.from), true) : eyeOf(bot.entity.position);
      if (typeof input.target === 'object') return answer(probeSight(read, eye, { block: cellOf(input.target) }));
      const entity = creatureOf(bot, input.target);
      if (!entity) return { success: false, result: `生き物 ${String(input.target)} は見えている範囲にいない`, failureType: 'not_found' };
      const creature: SightCreature = { id: Number(entity.id), name: String(entity.username ?? entity.name ?? 'unknown'), position: entity.position,
        height: entity.height, width: entity.width };
      return answer(probeSight(read, eye, { creature }));
    }
    case 'column': {
      const cx = typeof input.x === 'number' ? Math.floor(input.x) : feet.x, cz = typeof input.z === 'number' ? Math.floor(input.z) : feet.z;
      const low = typeof input.yFrom === 'number' ? Math.floor(input.yFrom) : feet.y - 16, high = typeof input.yTo === 'number' ? Math.floor(input.yTo) : feet.y + 16;
      // r8: the seconds one block over her head takes with the best tool she carries (a bare hand is 7.7 s for stone), read from the block itself.
      const digMs = (x: number, y: number, z: number) => { const block = bot.blockAt?.(new Vec3(x, y, z), false); return block ? digMsWithBestTool(bot, block) : null; };
      return answer(probeColumn(read, cx, cz, low, high, feet, digMs));
    }
    case 'around':
      return answer(probeAround(read, bot.entity.position, aroundEntities(bot), clampRadius(input.radius, 1, 16, 8)));
    case 'history': {
      const place = input.at ? cellOf(input.at) : feet;
      const radius = clampRadius(input.radius, 1, 32, 4);
      return answer(probeHistory(handsNear(bot, place, radius, 10), place, radius));
    }
    case 'scan': {
      const radiusChunks = typeof input.radius === 'number' ? clampRadius(input.radius, 1, 16, 16) : undefined;
      const summary = await scanWorld(bot, { radiusChunks });
      if (!summary) return { success: false, result: '読み込み済みのチャンクを読めない（体が無いか、世界がまだ無い）', failureType: 'unavailable' };
      const { longestSliceMs: _longest, longestSliceWords: _words, ...rest } = summary;
      return answer({ v: 1, kind: 'scan', ...rest });
    }
    case 'frames': {
      const report = strongholdFramesReport(bot, { radius: typeof input.radius === 'number' ? input.radius : null, x: input.x, z: input.z });
      const said = { v: 1 as const, kind: 'frames', text: report.text, center: report.center, radius: report.radius, reachM: report.reach, found: report.found, next: report.next };
      return answer(said);
    }
    case 'camp': {
      const report = blazeCampReport(bot);
      const said = { v: 1 as const, kind: 'camp', text: report.text, found: report.found, ...(report.spawner ? { spawner: report.spawner } : {}), others: report.others, cells: report.cells, fire: report.fire, hideouts: report.hideouts };
      return answer(said);
    }
    case 'lane': {
      if (![input.spawner, input.from].every(p => !p || [p.x, p.y, p.z].every(Number.isFinite))) return bad('lane の座標は有限の数で書く');
      const report = blazeLaneReport(bot, input.spawner ? cellOf(input.spawner) : undefined, input.from ? cellOf(input.from) : feet);
      return answer({ v: 1, kind: 'lane', ...(report.found ? { found: true, ...laneProbeFields(report) } : report) });
    }
    default:
      return bad(`kind は ${PROBE_KINDS.join('・')} のどれか`);
  }
}

export default Probe;
