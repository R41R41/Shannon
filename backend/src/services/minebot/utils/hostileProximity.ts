import type { CustomBot } from '../types/CustomBot.js';
import { isLikelyHostileMobName } from './hostileMobHints.js';

/** 最も近い敵対 Mob（検知範囲内）。いなければ null */
export function getNearestHostileInfo(
  bot: CustomBot,
  maxRange: number,
): { distance: number; mobType: string } | null {
  if (!bot.entity) return null;

  let best: { distance: number; mobType: string } | null = null;

  for (const entity of Object.values(bot.entities)) {
    if (!entity?.position || entity.id === bot.entity.id) continue;

    const mobName = String((entity as { name?: string }).name || '').toLowerCase();
    if (!isLikelyHostileMobName(mobName)) continue;

    const distance = bot.entity.position.distanceTo(entity.position);
    if (distance > maxRange) continue;

    if (!best || distance < best.distance) {
      best = { distance, mobType: mobName || 'hostile' };
    }
  }

  return best;
}
