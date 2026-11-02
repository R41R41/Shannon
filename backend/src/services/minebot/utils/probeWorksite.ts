import { Vec3 } from 'vec3';
import { bodyReader, type Cell } from './localMap.js';
import { eyeOf, probePath, probeSight, standable, type PathAnswer } from './probeTools.js';
import { holdsWater } from './waterBlocks.js';
import { digMsWithBestTool } from './bestToolDigTime.js';
import { lifeOf } from './life.js';

const same = (a: Cell | undefined, b: Cell) => !!a && a.x === b.x && a.y === b.y && a.z === b.z;
function route(path: PathAnswer, exact?: Cell) {
  const status = path.reachable && (!exact || same(path.goal, exact)) ? 'verified_segment'
    : path.limited || path.breaks?.some(b => b.reason === 'unloaded') ? 'unknown' : 'blocked';
  return { status, text: path.text, fromObservationOnly: true, points: path.points, goal: path.goal,
    breaks: path.breaks, swim: path.swim, maxDrop: path.maxDrop, ms: path.ms };
}

/** Compose the existing walk/sight rules. Forward reachability never certifies the reverse route or breathing. */
export async function probeWorksite(bot: any, feet: Cell, target: Cell, requestedStand?: Cell, retreat?: Cell) {
  const started = Date.now(), read = bodyReader(bot);
  const lifeNow = () => lifeOf(bot)?.number ?? null, dimensionNow = () => bot.game?.dimension ?? null;
  const began = { life: lifeNow(), dimension: dimensionNow() };
  const blockAt = (at: Cell) => bot.blockAt(new Vec3(at.x, at.y, at.z), false);
  const here = probeSight(read, eyeOf(bot.entity.position), { block: target });
  const useHere = !requestedStand && here.visible && here.reach && standable(read, feet.x, feet.y, feet.z);
  const path = await probePath(read, feet, useHere ? feet : requestedStand ?? target, { limits: { ms: 500, cells: 20000 } });
  const stand = path.reachable ? path.goal : undefined;
  const sight = stand ? probeSight(read, eyeOf(stand, true), { block: target }) : null;
  const back = stand && retreat ? await probePath(read, stand, retreat, { limits: { ms: 500, cells: 20000 } }) : null;
  // The searches above wait: a death, a portal or a respawn meanwhile makes every position of the answer another life's or another world's.
  const stale = lifeNow() !== began.life || dimensionNow() !== began.dimension;
  const block = blockAt(target), head = stand ? blockAt({ ...stand, y: stand.y + 1 }) : null;
  const breathing = !head ? 'unknown' : holdsWater(head) ? 'submerged' : head.boundingBox === 'empty' && head.name !== 'lava' ? 'observed_air' : 'unknown';
  const digMs = block ? digMsWithBestTool(bot, block) : 0;
  const tools = bot.inventory?.items() ?? [];
  const harvest = block && typeof block.canHarvest === 'function'
    ? [null, ...tools.map((tool: any) => tool.type)].some(tool => block.canHarvest(tool)) : null;
  const unknowns = ['施工後の水流・支持・往復経路は実行直前と施工後に再確認'];
  if (!block) unknowns.push('目的物は未ロード');
  if (!retreat) unknowns.push('帰還先が未指定');
  if (breathing !== 'observed_air') unknowns.push('作業位置での呼吸は未確認または水中');
  const approach = route(path, requestedStand);
  if (!standable(read, feet.x, feet.y, feet.z)) {
    approach.status = 'unknown';
    unknowns.push('出発位置の足場が未確認。着地後に接近経路を再確認');
  }
  const returning = back ? route(back, retreat) : { status: 'unknown', text: '帰還先または作業位置が未確認' };
  const reaches = !block ? '目的物は未ロード' : String(sight?.reach === true && sight.visible);
  const text = stale ? '作業場: 調べている間に命か次元が変わった。この結果の座標は使えない。もう一度調べる。'
    : `作業場: 接近=${approach.status}・対象に届く=${reaches}・呼吸=${breathing}・帰路=${returning.status}。掘れたことと取得・帰還は別。`;
  return { v: 1 as const, kind: 'worksite', text, ...(stale ? { stale: true } : {}),
    target: { at: target, block: block?.name ?? null },
    standCandidates: stale ? [] : stand ? [{ at: stand, reach: sight?.reach, visible: sight?.visible, breathing }] : path.stands ?? [],
    approach: stale ? { ...approach, status: 'unknown' } : approach, work: { harvest, digMs: digMs > 0 ? digMs : null, unknowns },
    retreat: { to: retreat ?? null, ...(stale ? { ...returning, status: 'unknown' } : returning) },
    evidence: { life: began.life, dimension: began.dimension, observedAt: new Date(started).toISOString(),
      expiresOn: 'world_change_or_life_or_dimension_change' }, ms: Date.now() - started };
}
