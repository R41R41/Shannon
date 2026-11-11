import { bestMeleeWeapon } from '../floorReflexes.js';
import { equipToHandVerified } from '../equipVerified.js';
import { guard, StepStopped, type StepContext } from './common.js';

/**
 * A blow struck with an empty hand (or a bow, a pickaxe) is one point of a blaze's twenty, swung every quarter second: when the hand holds
 * no sword or axe, the best one carried goes into it first (one already held stays). end1108h12 S7 (11/8): after the bow, the chasing
 * attack hit blaze 531 with the bow in hand — 23 swings, 12 landed, 5.6 s for 7 points — while an iron sword was in the pack.
 */
export async function takeUpMeleeWeapon(ctx: StepContext): Promise<{ weapon: string; takenUp: string }> {
  const bot = ctx.bot;
  let weapon = String(bot.heldItem?.name ?? ''), takenUp = '';
  if (/_(sword|axe)$/u.test(weapon)) return { weapon, takenUp };
  const best = bestMeleeWeapon(bot.inventory?.items?.() ?? []);
  if (!best || !/_(sword|axe)$/u.test(String(best.name))) return { weapon, takenUp };
  try { const held = await guard(ctx, equipToHandVerified(bot, best as { name: string; type: number; slot?: number }), 5000); if (held?.value.held) { weapon = String(best.name); takenUp = weapon; } }
  catch (error) { if (error instanceof StepStopped || /Action interrupted/u.test(String((error as Error)?.message))) throw error; }
  return { weapon, takenUp };
}

/** A sword or axe of stone or better in the pack (the held one counts): a hunt of an animal needs one, bare hands and a wooden sword take about ten blows for a cow. Null when none is carried. */
export function stoneOrBetterMelee(items: Array<{ name: string }>): string | null {
  const ranks = ['stone', 'iron', 'diamond', 'netherite'];
  let best: string | null = null, bestRank = -1;
  for (const item of items) {
    const found = /^(stone|iron|diamond|netherite)_(sword|axe)$/u.exec(String(item?.name ?? ''));
    if (!found) continue;
    const rank = ranks.indexOf(found[1]) * 2 + (found[2] === 'sword' ? 1 : 0);
    if (rank > bestRank) { bestRank = rank; best = found[0]; }
  }
  return best;
}
