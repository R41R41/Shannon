import { Vec3 } from 'vec3';
import { feetCell } from './localMap.js';
import { eyeHeight } from './bodyPose.js';

/**
 * Run 46 (hold 7): the planner's dig of an obsidian block was stopped six times by the swim reflex ("dig stopped 反射: 泳ぎ（呼吸）（手の途中）"): the body stood in a pocket of
 * water the obsidian hand had left, two deep, and a dig under water takes five times as long (more with the feet off the ground), longer than the air lasts; the reflex surfaces the body
 * at half the air, the next dig dives again. The reflex is right. The line the planner reads says why and what to do next.
 */
const SWIM_STOP = /泳ぎ|呼吸|酸素|浮上/u;
const DIGGING = new Set(['dig', 'mine', 'obsidian']);
const counts = new WeakMap<object, Map<string, number>>();

interface WaterBody {
  entity?: { position: { x: number; y: number; z: number }; isInWater?: boolean };
  oxygenLevel?: number;
  blockAt?(position: Vec3): { name?: string } | null | undefined;
}

/**
 * The words for a dig-like hand that the swim reflex stopped while the body was in water, or null (another stop, a hand that does not dig, a body out of the water).
 * The second time at the same place, and later, says so.
 */
export function waterDigWords(bot: WaterBody, handKind: string, stoppedWhy: string | undefined): string | null {
  try { return waterDigWordsOf(bot, handKind, stoppedWhy); } catch { return null; }   // words are a help: they never become the stop
}
function waterDigWordsOf(bot: WaterBody, handKind: string, stoppedWhy: string | undefined): string | null {
  if (!DIGGING.has(handKind) || !stoppedWhy || !SWIM_STOP.test(stoppedWhy)) return null;
  const at = bot.entity?.position;
  if (!at || typeof bot.blockAt !== 'function') return null;
  const wet = (y: number) => String(bot.blockAt!(new Vec3(Math.floor(at.x), Math.floor(y), Math.floor(at.z)))?.name ?? '') === 'water';
  const feetWet = wet(at.y), headWet = wet(at.y + eyeHeight(bot as never));
  if (!feetWet && !headWet && bot.entity?.isInWater !== true) return null;
  const feet = feetCell(bot as never);
  const key = feet ? `${feet.x},${feet.y},${feet.z}` : 'here';
  const table = counts.get(bot as object) ?? new Map<string, number>();
  counts.set(bot as object, table);
  const times = (table.get(key) ?? 0) + 1;
  table.set(key, times);
  const oxygen = Math.max(0, Math.round(bot.oxygenLevel ?? 20));
  return `水の中で掘っている（${headWet ? '頭が水' : feetWet ? '足元が水' : '水の中'}）。水の中の掘りは遅く、息が続かない（息 ${oxygen}/20）。水源を汲むか、ブロックで水を塞ぐか、水の外の立ち位置から掘る${times >= 2 ? `（同じ所で ${times} 回目）` : ''}`;
}
