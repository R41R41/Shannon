import { Vec3 } from 'vec3';
import { equipToHandVerified } from '../equipVerified.js';
import { feetCell, type Cell } from '../localMap.js';
import { blockAt, cellNow, cellText, findItem, guard, inventoryCount, isAirLike, placeText, stopped, StepStopped, wait, waitUntil,
  type StepContext, type StepOutcome } from './common.js';

/**
 * pillarUp n: jump and set a block under the feet, one level at a time (the owner's dragon list, 2026-10-21: the End's pillars, a
 * Nether cliff). Each level is checked (the feet a block higher, the block under them the one laid); it stops at a ceiling (no digging
 * through it), when the block runs out, or when a level does not take, and says which.
 *
 * The block is laid in the feet cell once the feet are PILLAR_FEET_OVER_FLOOR above its floor, on the way up near the top of the jump
 * (see there for the measured jump).
 */
export interface PillarArgs {
  n: number;
  block: string;
  /** The feet's height over the floor of the cell to fill (default PILLAR_FEET_OVER_FLOOR). Not a hand's field: act never passes it; a test sets the old bar of 1.26 to show it never lays. */
  feetOver?: number;
}

const TRY_TICKS = 28;
/**
 * How high the feet must be over the feet cell's floor (the cell about to be filled) before a block is laid in it. A vanilla jump
 * from flat ground takes the feet 0.42, 0.75, 1.00, 1.17, 1.249, 1.252 (the top, tick 6), 1.18, 1.02 up over ticks 1 to 8 and lands on
 * tick 12 (prismarine-physics 1.10, the engine mineflayer moves with; 1.21.1, measured in tests/unit/pillarUpJump.test.ts). The top is
 * 1.2522, so the old bar of 1.26 was never reached: nothing was laid and every level "did not take" (run 39: 9 of 9). The cell is free of
 * the body from 1.0 up; 1.05 leaves a margin for a server one tick behind the client (it is at 1.0013 on the tick before the first
 * reading of 1.166). With the rising speed at 0.14 or less (tick 3 is 1.0013 but still rising at 0.165) the window is ticks 4 to 7 (1.17,
 * 1.249, 1.252, 1.18; tick 8 is 1.02): 200 ms, five or six readings at 35 ms.
 */
export const PILLAR_FEET_OVER_FLOOR = 1.05;
const EMPTY = (block: any) => !block || isAirLike(block) || block.name === 'water' || block.name === 'lava';

/** The top of a block's collision shapes over its own cell (1 for a whole block, 0.75 for a small amethyst bud, 0.5 for a bottom slab). */
export function shapeTop(block: any): number {
  const shapes = Array.isArray(block?.shapes) ? block.shapes as number[][] : [];
  if (!shapes.length) return block?.boundingBox === 'block' ? 1 : 0;
  return Math.max(...shapes.map(shape => Number(shape[4] ?? 0)));
}
/**
 * Run 41 (+1,472 and +1,518, replayed on its own ground): the body stood on a small amethyst bud, whose top is 0.75 up its cell, so its feet
 * were at -34.25 while the feet cell was -34. A jump from there tops out at -33.00, short of the -32.95 the block is laid at: every jump of
 * both climbs fell short and the go said stuck. A floor lower than the feet cell's bottom is said before the jump, with the whole floor beside it.
 */
export function shortFloor(bot: any, feet: Cell): { cell: Cell; name: string; top: number; lowBy: number } | null {
  const y = Number(bot.entity?.position?.y);
  const cell = { x: feet.x, y: feet.y - 1, z: feet.z };
  const floor = blockAt(bot, cell);
  if (!floor || !Number.isFinite(y)) return null;
  const lowBy = feet.y - y;
  if (lowBy <= 0.01) return null;
  return { cell, name: String(floor.name), top: shapeTop(floor), lowBy };
}
/** A cell beside the feet where the body stands on a whole block with room to jump (feet, head and the cell over the head empty), or null. */
export function wholeFloorBeside(bot: any, feet: Cell, unsafe: (cell: Cell) => boolean = () => false): Cell | null {
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const cell = { x: feet.x + dx, y: feet.y, z: feet.z + dz };
    const floor = blockAt(bot, { x: cell.x, y: cell.y - 1, z: cell.z });
    if (!floor || floor.boundingBox !== 'block' || shapeTop(floor) < 0.99) continue;
    if (![0, 1, 2].every(up => EMPTY(blockAt(bot, { x: cell.x, y: cell.y + up, z: cell.z })) && blockAt(bot, { x: cell.x, y: cell.y + up, z: cell.z }))) continue;
    if (unsafe(cell)) continue;
    return cell;
  }
  return null;
}

export async function pillarUp(ctx: StepContext, args: PillarArgs): Promise<StepOutcome> {
  const bot = ctx.bot;
  const feetOver = args.feetOver ?? PILLAR_FEET_OVER_FLOOR;
  const levels = Math.max(1, Math.min(32, Math.round(args.n ?? 1)));
  if (!bot.registry?.blocksByName?.[args.block]) return stopped(bot, 'invalid_block', `${args.block} は置けるブロックの名前ではない`);
  const start = feetCell(bot)!;
  let done = 0;
  try {
    for (let level = 0; level < levels; level++) {
      const feet = feetCell(bot)!;
      if (!findItem(bot, args.block)) return stopped(bot, 'missing_item', `${args.block} が尽きた（${done}段登った、今 ${cellText(feet)}）`, feet);
      const over = { x: feet.x, y: feet.y + 2, z: feet.z };
      if (!EMPTY(blockAt(bot, over))) return stopped(bot, 'ceiling', `頭の上 ${placeText(bot, over)} が ${cellNow(bot, over)} で登れない（${done}段登った）`, over);
      const floor = blockAt(bot, { x: feet.x, y: feet.y - 1, z: feet.z });
      if (!floor || floor.boundingBox !== 'block') return stopped(bot, 'no_floor', `足元 ${cellText({ x: feet.x, y: feet.y - 1, z: feet.z })} が ${floor?.name ?? '未ロード'} で、跳んでも積む土台が無い（${done}段登った）`, feet);
      const short = shortFloor(bot, feet);
      if (short) {
        const aside = wholeFloorBeside(bot, feet);
        return stopped(bot, 'low_floor', `足元 ${cellText(short.cell)} の ${short.name} は高さ ${short.top.toFixed(2)} で、足が ${short.lowBy.toFixed(2)} 低い。跳んでも積む高さに届かない（${done}段登った）。`
          + (aside ? `隣の丸ごとの床 ${cellText(aside)} へずれてから登る` : `${short.name} を掘って下の床から登るか、丸ごとの床の所へ動く`), feet);
      }
      if (bot.heldItem?.name !== args.block) {
        const held = await guard(ctx, equipToHandVerified(bot, findItem(bot, args.block)), 5000);
        if (!held?.value.held) return stopped(bot, 'equip_failed', `${args.block} を手に持てなかった`, feet);
      }
      await guard(ctx, Promise.resolve(bot.look(bot.entity.yaw, -Math.PI / 2, true)), 1000);
      bot.setControlState('jump', true);
      let placed = false, lastError = '', attempts = 0, maxY = bot.entity.position.y, filledBy = '';
      for (let tick = 0; tick < TRY_TICKS && !placed; tick++) {
        await wait(ctx, 35);
        const y = bot.entity.position.y, vy = bot.entity.velocity?.y ?? 0;
        maxY = Math.max(maxY, y);
        if (y < feet.y + feetOver || vy > 0.14 || vy < -0.45) continue;
        if (!EMPTY(blockAt(bot, feet))) { filledBy = cellNow(bot, feet); break; }
        attempts++;
        try {
          await guard(ctx, Promise.resolve(bot.placeBlock(floor, new Vec3(0, 1, 0))), 1500);
          placed = true;
        } catch (error) {
          if (error instanceof StepStopped || /Action interrupted/u.test(String((error as Error)?.message))) throw error;
          lastError = String((error as Error)?.message ?? error).slice(0, 60) || String((error as Error)?.name ?? 'エラー') + '（文なし）';
        }
      }
      bot.setControlState('jump', false);
      await wait(ctx, 250);
      await waitUntil(ctx, () => bot.entity?.onGround !== false, 600);
      const now = feetCell(bot)!;
      const laid = blockAt(bot, feet)?.name === args.block;
      if (!laid || now.y < feet.y + 1) {
        // Say which of the four it was: the jump did not reach the height, the cell filled by something else, the laying was refused, or
        // a block was laid and the feet did not come up on it.
        const what = !placed && !attempts && filledBy
          ? `跳んでいる間に足元が ${filledBy} になった（積む前）`
          : !placed && !attempts
            ? `置ける高さ（足が y=${(feet.y + feetOver).toFixed(2)} 以上、上向きの速さ 0.14 以下）に跳びの最高 y=${maxY.toFixed(2)} で届かず、置く処理に入れなかった`
            : !placed
              ? `置こうとして ${attempts} 回とも断られた（${lastError}）`
              : !laid
                ? `置けたと返ったが足元は ${cellNow(bot, feet)} のまま`
                : `${args.block} は置けたが足がその上に乗らなかった`;
        return stopped(bot, 'not_placed', `${done + 1}段目が積めなかった: ${what}（足元 ${cellText(feet)} は今 ${cellNow(bot, feet)}、足は y=${bot.entity.position.y.toFixed(2)}、跳びの最高 y=${maxY.toFixed(2)}、置こうとした ${attempts} 回）。${done}段登った`, feet);
      }
      done++;
      ctx.progress?.(`${done}/${levels}`);
    }
  } finally { try { bot.setControlState('jump', false); } catch { /* released */ } }
  const end = feetCell(bot)!;
  return { ok: true, text: `${done}段登った（${cellText(start)}→${cellText(end)}、${args.block} 残り${inventoryCount(bot, args.block)}）`, at: end };
}
