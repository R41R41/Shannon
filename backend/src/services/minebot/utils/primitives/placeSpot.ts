import { feetCell, type Cell } from '../localMap.js';
import { blockAt, cellText, eyeDistance, USE_REACH, stopped, type StepContext, type StepOutcome } from './common.js';
import { bodyCells, place } from './place.js';

/**
 * A cell near the body to put a work block in (a crafting table the hand carries, a furnace to smelt in): make and smelt put the block
 * down themselves when the planner gave no cell for it. Only the nearby ground is read: an air cell within the hand's reach, the floor
 * under it solid and safe, the air over it free, not one of the body's own cells, a little off the body (not its feet), nearest first.
 * Nothing is dug and no other block is laid to make room.
 */
const AIR = new Set(['air', 'cave_air', 'void_air']);
const BAD_FLOOR = /^(?:lava|water|magma_block|cactus|campfire|soul_campfire|fire|soul_fire|powder_snow|sweet_berry_bush|wither_rose|bubble_column)$/u;

export function placeSpots(bot: any, avoid: readonly Cell[] = [], max = 6): Cell[] {
  const at = bot.entity?.position;
  const feet = feetCell(bot);
  if (!at || !feet) return [];
  const own = bodyCells(at);
  const found: Array<{ cell: Cell; score: number }> = [];
  const span = Math.ceil(USE_REACH);
  for (let x = feet.x - span; x <= feet.x + span; x++) for (let y = feet.y - 2; y <= feet.y + 2; y++) for (let z = feet.z - span; z <= feet.z + span; z++) {
    const cell = { x, y, z };
    if (eyeDistance(bot, cell) > USE_REACH - 0.4) continue;
    if (avoid.some(other => other.x === x && other.y === y && other.z === z) || own.some(other => other.x === x && other.y === y && other.z === z)) continue;
    const here = blockAt(bot, cell);
    if (!here || !AIR.has(here.name)) continue;
    const floor = blockAt(bot, { x, y: y - 1, z }), over = blockAt(bot, { x, y: y + 1, z });
    if (!floor || floor.boundingBox !== 'block' || BAD_FLOOR.test(String(floor.name)) || !over || !AIR.has(over.name)) continue;
    const across = Math.hypot(x + 0.5 - at.x, z + 0.5 - at.z);
    // On the level of the feet, two metres off: in reach, out of the way of the body's own steps.
    const score = Math.abs(y - feet.y) * 3 + Math.abs(across - 2) + (across < 1.4 ? 2 : 0) + (cell.y === feet.y ? 0 : 1);
    found.push({ cell, score });
  }
  return found.sort((a, b) => a.score - b.score || a.cell.x - b.cell.x || a.cell.z - b.cell.z || a.cell.y - b.cell.y).slice(0, max).map(entry => entry.cell);
}

/** Puts `block` (a name the pack holds) down at the best nearby spot; the next one when a spot is refused. Tries four. */
export async function placeNearby(ctx: StepContext, block: string, avoid: readonly Cell[] = []): Promise<{ cell: Cell } | { fail: StepOutcome }> {
  const spots = placeSpots(ctx.bot, avoid, 4);
  if (!spots.length) return { fail: stopped(ctx.bot, 'no_floor', `${block} を置ける所が近くに無い（手の届く所に、床が固くて上が空いた空気のマスが無い）`) };
  const reasons: string[] = [];
  for (const cell of spots) {
    const outcome = await place(ctx, { block, at: [cell] });
    if (outcome.ok) return { cell };
    reasons.push(`${cellText(cell)}: ${outcome.reason ?? '?'}`);
  }
  return { fail: stopped(ctx.bot, 'not_placed', `${block} を置けなかった（${reasons.join('、')}）`) };
}
