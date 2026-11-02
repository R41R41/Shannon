import { Vec3 } from 'vec3';
import { eyeHeight } from './bodyPose.js';
import { holdsWater } from './waterBlocks.js';
import { secondsToSurface, secondsToSwimOut, secondsToBreakOut } from './breathingReflex.js';
import type { Cell } from './localMap.js';

export interface BreathingWork {
  allowed: boolean;
  airSeconds: number | null;
  returnSeconds: number | null;
  reason: 'dry' | 'covered' | 'air_unknown' | 'return_unknown' | 'insufficient_air';
  escapeWork: boolean;
}
/** Reserve time for the work AND a way to breathe. This is a conservative estimate, not a route guarantee.
 * A ceiling dig on the already estimated break-out column counts once, not once as work and again as escape. */
export function assessBreathingWork(bot: any, workSeconds: number, dig?: Cell): BreathingWork {
  const p = bot.entity?.position;
  const base = { airSeconds: null, returnSeconds: null, escapeWork: false };
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
  const needed = back + (escapeWork ? 0 : Math.max(0, workSeconds)) + 3;
  return { allowed: airSeconds > needed, airSeconds, returnSeconds: back, escapeWork,
    reason: airSeconds > needed ? 'covered' : 'insufficient_air' };
}
