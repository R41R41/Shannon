import { z } from 'zod';
import { Vec3 } from 'vec3';
import { CustomBot, InstantSkill } from '../types.js';
import { digMsWithBestTool } from '../utils/bestToolDigTime.js';
import { bodyReader, feetCell, type Cell } from '../utils/localMap.js';
import { eyeOf, probeAround, probeColumn, probePath, probeHistory, probeSight, type AroundEntity, type SightCreature } from '../utils/probeTools.js';
import { handsNear } from '../utils/handHistory.js';
import { scanWorld } from '../utils/worldScan.js';
import { isLikelyHostileMobName } from '../utils/hostileMobHints.js';
import { closingSpeed } from '../utils/threatTracker.js';

/**
 * mc.probe (r4 contract 1, 2026-10-22): the body's reading tools. Read only, a fixed computation each, no LLM, no choice; the category is a
 * query, so it holds none of the body and runs beside an act. Kinds:
 *   path    whether `to` is reached without digging or laying a block (the walk's rules), the way's points, or the breaks and where to stand;
 *   sight   whether a block or a creature is seen from the eye, in reach, how far, and the solid cells between;
 *   column  one column as runs of blocks, the dangers first (a drop of more than three, water, lava, sand and gravel);
 *   around  the creatures within a radius (id, where, height, seen, facing her, closing) and the dangerous blocks round her;
 *   history the act's hands and stops at a place (newest first);
 *   scan    what the loaded chunks hold (logs, a village, water, lava pools, structures, stems, a fortress, spawners, portals).
 * The answer is JSON: { v: 1, kind, text, ... } with the sentence first, the dangerous facts said as they are.
 */
export const PROBE_KINDS = ['path', 'sight', 'column', 'around', 'history', 'scan'] as const;
const Pos = z.object({ x: z.number(), y: z.number(), z: z.number() }).strict();

const DESCRIPTION = '調べる（読むだけ・決まった計算）。kind: path（to へ掘らず置かずに歩いて行けるか。行けるなら道の点、行けないなら切れ目と立てる所）/ '
  + 'sight（target のブロックか生き物 #id が目から見えるか・届くか・間のブロック）/ column（x,z の縦の列。yFrom・yTo。落差・水・溶岩・砂利）/ '
  + 'around（radius 内の生き物と危ないブロック）/ history（at の radius 内の最近の手と止まり）/ scan（読み込み済みの範囲の目印。radius はチャンク）。'
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
      { name: 'kind', type: 'json', schema: z.enum(PROBE_KINDS), description: 'path・sight・column・around・history・scan', required: true },
      { name: 'to', type: 'json', schema: Pos, description: 'path: 行きたいマス' },
      { name: 'from', type: 'json', schema: Pos, description: 'path・sight: 出発・目の位置の足のマス（既定は足）' },
      { name: 'target', type: 'json', schema: z.union([Pos, z.string().max(64), z.number()]), description: 'sight: ブロック {x,y,z} か生き物 "#id"' },
      { name: 'x', type: 'number', description: 'column: 列の x（既定は足）' },
      { name: 'z', type: 'number', description: 'column: 列の z（既定は足）' },
      { name: 'yFrom', type: 'number', description: 'column: 下端の y（既定 足−16）' },
      { name: 'yTo', type: 'number', description: 'column: 上端の y（既定 足+16）' },
      { name: 'radius', type: 'number', description: 'around: m（1〜16、既定 8）/ history: m（1〜32、既定 4）/ scan: チャンク（1〜16、既定は読み込み済みの全部）' },
      { name: 'at', type: 'json', schema: Pos, description: 'history: 場所（既定は足）' },
    ];
  }

  async runImpl(kind: string, to?: { x: number; y: number; z: number } | null, from?: { x: number; y: number; z: number } | null,
    target?: { x: number; y: number; z: number } | string | number | null, x?: number | null, z?: number | null, yFrom?: number | null, yTo?: number | null,
    radius?: number | null, at?: { x: number; y: number; z: number } | null) {
    const result = await runProbe(this.bot as any, { kind, to, from, target, x, z, yFrom, yTo, radius, at });
    return result;
  }
}

export interface ProbeInput {
  kind: string; to?: { x: number; y: number; z: number } | null; from?: { x: number; y: number; z: number } | null;
  target?: { x: number; y: number; z: number } | string | number | null; x?: number | null; z?: number | null; yFrom?: number | null; yTo?: number | null;
  radius?: number | null; at?: { x: number; y: number; z: number } | null;
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
    out.push({ id: Number(entity.id), name, position: entity.position, yaw: entity.yaw, headYaw: entity.headYaw, height: entity.height,
      hostile: type === 'hostile' || (entity.type !== 'player' && isLikelyHostileMobName(String(entity.name ?? ''))), closing });
  }
  return out;
}

const clampRadius = (value: number | null | undefined, low: number, high: number, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(low, Math.min(high, Math.round(value))) : fallback;

/** One probe on a live body (also from tests): the skill's result, its text the contract's JSON. */
export async function runProbe(bot: any, input: ProbeInput): Promise<{ success: boolean; result: string; failureType?: string }> {
  const feet = feetCell(bot);
  if (!feet) return { success: false, result: '体が無い（接続が切れた）', failureType: 'disconnected' };
  const read = bodyReader(bot);
  // The sentence first (the contract), then the fields; every kind's fields are bounded far under the receipt's 16,000 characters.
  const answer = (value: { v: 1; kind: string; text: string }) => {
    const { v, kind, text, ...rest } = value;
    return { success: true, result: JSON.stringify({ v, kind, text, ...rest }) };
  };
  switch (input.kind) {
    case 'path': {
      if (!input.to) return bad('path には to {x,y,z} が要る');
      return answer(await probePath(read, input.from ? cellOf(input.from) : feet, cellOf(input.to)));
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
    default:
      return bad(`kind は ${PROBE_KINDS.join('・')} のどれか`);
  }
}

export default Probe;
