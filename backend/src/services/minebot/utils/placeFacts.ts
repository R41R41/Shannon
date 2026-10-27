import { blockAt, cellText } from './primitives/common.js';
import type { Cell } from './localMap.js';

/**
 * Run 43 (+1,765.6 q115: 「置いたブロックが世界に現れない（サーバーが置きを断った。1 回）」 in a 1×1 shaft, pillaring up; runs 41 and 42 had the same
 * stop four times, each at a pillar's level, and the lab once at y=11): what the place met, said with the stop so that the cause can be told apart:
 * the cell it was laid in, the feet and the top of the jump, how much of the body's box was in that cell, and the cell over the head.
 */
const HALF_WIDTH = 0.3, HEIGHT = 1.8;
export function bodyOverlap(position: { x: number; y: number; z: number }, cell: Cell): number {
  const across = (from: number, size: number) => Math.max(0, Math.min(from + size, cell.x + 1) - Math.max(from, cell.x));
  const x = across(position.x - HALF_WIDTH, 2 * HALF_WIDTH);
  const z = Math.max(0, Math.min(position.z + HALF_WIDTH, cell.z + 1) - Math.max(position.z - HALF_WIDTH, cell.z));
  const y = Math.max(0, Math.min(position.y + HEIGHT, cell.y + 1) - Math.max(position.y, cell.y));
  return x > 0 && z > 0 ? y : 0;
}
export function placeFacts(bot: any, cell: Cell, top: number | null, at?: { x: number; y: number; z: number }): string {
  const p = at ?? bot.entity?.position;
  if (!p) return `置こうとしたマス ${cellText(cell)}`;
  // Two over the cell laid in: for a pillar's level (the feet cell) the cell over the head, where a jump meets a ceiling.
  const over = { x: cell.x, y: cell.y + 2, z: cell.z };
  let name = '未ロード';
  try { name = String(blockAt(bot, over)?.name ?? '未ロード'); } catch { /* unread */ }
  const overlap = bodyOverlap(p, cell);
  // Short (a go's stop line is 160 characters with its counts): the cell, the feet, the top of the jump, the body in the cell, over the head.
  return `置くマス ${cellText(cell)}・足 y=${p.y.toFixed(2)}${top !== null ? `・跳び最高 ${top.toFixed(2)}` : ''}`
    + `・体と重なり ${overlap > 0 ? overlap.toFixed(2) : '無し'}・頭の上 ${cellText(over)} ${name}`;
}
