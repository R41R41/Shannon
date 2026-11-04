import { Vec3 } from 'vec3';
import { eyeHeight } from './bodyPose.js';
import { holdsWater } from './waterBlocks.js';
import { secondsToSurface, secondsToSwimOut, secondsToBreakOut } from './breathingReflex.js';
import type { Cell } from './localMap.js';

export interface BreathingWork {
  allowed: boolean;
  airSeconds: number | null;
  returnSeconds: number | null;
  /** The current cell's remaining dig time; null when it cannot be measured. */
  workSeconds: number | null;
  /** The exact budget used by the decision, with escape excavation counted once. */
  neededSeconds: number | null;
  reason: 'dry' | 'covered' | 'air_unknown' | 'return_unknown' | 'insufficient_air';
  escapeWork: boolean;
}
export const BREATHING_WORK_MARGIN_SECONDS = 3;
/** Reserve time for the work AND a way to breathe. This is a conservative estimate, not a route guarantee.
 * A ceiling dig on the already estimated break-out column counts once, not once as work and again as escape. */
export function assessBreathingWork(bot: any, workSeconds: number, dig?: Cell): BreathingWork {
  const p = bot.entity?.position;
  const base = { airSeconds: null, returnSeconds: null, escapeWork: false,
    workSeconds: Number.isFinite(workSeconds) ? Math.max(0, workSeconds) : null, neededSeconds: null };
  if (!p) return { ...base, allowed: false, reason: 'air_unknown' };
  const head = new Vec3(Math.floor(p.x), Math.floor(p.y + eyeHeight(bot)), Math.floor(p.z));
  let block: any;
  try { block = bot.blockAt(head); } catch { /* unknown */ }
  if (!block) return { ...base, allowed: false, reason: 'air_unknown' };
  if (!holdsWater(block)) return { ...base, allowed: true, reason: 'dry' };
  const oxygen = bot.oxygenLevel;
  if (typeof oxygen !== 'number' || !Number.isFinite(oxygen)) return { ...base, allowed: false, reason: 'air_unknown' };
  const airSeconds = Math.max(0, oxygen) * 0.75;
  let back = Infinity, escapeWork = false;
  try {
    // A possible ceiling excavation is not a currently traversable return route.
    back = Math.min(secondsToSurface(bot), secondsToSwimOut(bot));
    if (dig && dig.x === head.x && dig.z === head.z && dig.y >= head.y) {
      // Only the first solid cell toward a measured breathing space is excavation for that exit.
      const firstSolid = Array.from({ length: Math.min(12, dig.y - head.y + 1) }, (_, n) => head.offset(0, n, 0))
        .find(at => bot.blockAt(at)?.boundingBox === 'block');
      const breakOut = secondsToBreakOut(bot);
      escapeWork = !!firstSolid && firstSolid.y === dig.y && Number.isFinite(breakOut);
      if (escapeWork) {
        const full = Number(bot.digTime?.(bot.blockAt(firstSolid!))) / 1000;
        const completed = Number.isFinite(full) ? Math.max(0, full - workSeconds) : 0;
        back = Math.max(0, breakOut - completed);
      }
    }
  } catch { back = Infinity; }
  if (!Number.isFinite(back)) return { ...base, airSeconds, allowed: false, reason: 'return_unknown' };
  const needed = back + (escapeWork ? 0 : Math.max(0, workSeconds)) + BREATHING_WORK_MARGIN_SECONDS;
  return { ...base, allowed: airSeconds > needed, airSeconds, returnSeconds: back, escapeWork,
    neededSeconds: Number.isFinite(needed) ? needed : null,
    reason: airSeconds > needed ? 'covered' : 'insufficient_air' };
}

/** The dig checks each cell separately. Say that count, not the size of the requested row, and do not promise that even one cell fits. */
export function breathingWorkWords(breath: BreathingWork, remaining = false): string {
  const seconds = (n: number | null) => n === null ? '未確認' : String(Number(n.toFixed(1)));
  const work = `${remaining ? '残り掘削' : '掘削'}${seconds(breath.workSeconds)}秒×1マス`;
  if (breath.airSeconds === null) return `残り息が未確認（${work}）。呼吸を回復し、息と呼吸先を確認して再判定`;
  if (breath.returnSeconds === null) return `呼吸先までの帰還が未確認（${work}、残り息${seconds(breath.airSeconds)}秒）。先に呼吸できる場所を確認`;
  if (breath.neededSeconds === null) return `水中の掘削時間が未確認（帰還${seconds(breath.returnSeconds)}秒＋余裕${BREATHING_WORK_MARGIN_SECONDS}秒、残り息${seconds(breath.airSeconds)}秒）。水の外から掘るか道具を確認`;
  const budget = breath.escapeWork
    ? `脱出掘削込み帰還${seconds(breath.returnSeconds)}秒＋余裕${BREATHING_WORK_MARGIN_SECONDS}秒、${work}は重複計上しない`
    : `${work}＋帰還${seconds(breath.returnSeconds)}秒＋余裕${BREATHING_WORK_MARGIN_SECONDS}秒`;
  const gap = breath.neededSeconds - breath.airSeconds;
  const difference = gap === 0 ? '差0秒（同量では不可）' : gap > 0 ? `不足${seconds(gap)}秒` : `余り${seconds(-gap)}秒`;
  return `必要${seconds(breath.neededSeconds)}秒（${budget}）、残り息${seconds(breath.airSeconds)}秒、${difference}。`
    + '呼吸を回復し1〜2マス単位で再判定（1マスでも不足なら水外から掘る）';
}

/** The same budget for a dig that is under way: the time left is what the block still takes from `startedAt`. A dig time that cannot be read
 * is an unknown time left, which no breath under water covers (in the dry the answer does not depend on it). */
export function assessBreathingDig(bot: any, block: any, dig: Cell, startedAt: number): BreathingWork {
  let totalMs = Infinity;
  try { if (typeof bot.digTime === 'function') totalMs = Number(bot.digTime(block)); } catch { /* unknown: no breath covers it under water */ }
  return assessBreathingWork(bot, Math.max(0, totalMs - (Date.now() - startedAt)) / 1000, dig);
}
