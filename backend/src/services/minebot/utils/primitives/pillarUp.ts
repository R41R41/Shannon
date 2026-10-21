import { Vec3 } from 'vec3';
import { equipToHandVerified } from '../equipVerified.js';
import { feetCell } from '../localMap.js';
import { blockAt, cellNow, cellText, findItem, guard, inventoryCount, isAirLike, placeText, stopped, StepStopped, wait,
  type StepContext, type StepOutcome } from './common.js';

/**
 * pillarUp n: jump and set a block under the feet, one level at a time (the owner's dragon list, 2026-10-21: the End's pillars, a
 * Nether cliff). Each level is checked (the feet a block higher, the block under them the one laid); it stops at a ceiling (no digging
 * through it), when the block runs out, or when a level does not take, and says which.
 */
export interface PillarArgs { n: number; block: string }

const TRY_TICKS = 28;
const EMPTY = (block: any) => !block || isAirLike(block) || block.name === 'water' || block.name === 'lava';

export async function pillarUp(ctx: StepContext, args: PillarArgs): Promise<StepOutcome> {
  const bot = ctx.bot;
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
      if (bot.heldItem?.name !== args.block) {
        const held = await guard(ctx, equipToHandVerified(bot, findItem(bot, args.block)), 5000);
        if (!held?.value.held) return stopped(bot, 'equip_failed', `${args.block} を手に持てなかった`, feet);
      }
      await guard(ctx, Promise.resolve(bot.look(bot.entity.yaw, -Math.PI / 2, true)), 1000);
      bot.setControlState('jump', true);
      let placed = false, lastError = '';
      for (let tick = 0; tick < TRY_TICKS && !placed; tick++) {
        await wait(ctx, 35);
        const y = bot.entity.position.y, vy = bot.entity.velocity?.y ?? 0;
        if (y < feet.y + 1.26 || vy > 0.14 || vy < -0.45) continue;
        if (!EMPTY(blockAt(bot, feet))) break;
        try {
          await guard(ctx, Promise.resolve(bot.placeBlock(floor, new Vec3(0, 1, 0))), 1500);
          placed = true;
        } catch (error) {
          if (error instanceof StepStopped || /Action interrupted/u.test(String((error as Error)?.message))) throw error;
          lastError = String((error as Error)?.message ?? error).slice(0, 60);
        }
      }
      bot.setControlState('jump', false);
      await wait(ctx, 250);
      const now = feetCell(bot)!;
      const laid = blockAt(bot, feet)?.name === args.block;
      if (!laid || now.y < feet.y + 1) {
        return stopped(bot, 'not_placed', `${done + 1}段目が積めなかった（足元 ${cellText(feet)} は今 ${cellNow(bot, feet)}、足は y=${bot.entity.position.y.toFixed(2)}${lastError ? `、${lastError}` : ''}）。${done}段登った`, feet);
      }
      done++;
      ctx.progress?.(`${done}/${levels}`);
    }
  } finally { try { bot.setControlState('jump', false); } catch { /* released */ } }
  const end = feetCell(bot)!;
  return { ok: true, text: `${done}段登った（${cellText(start)}→${cellText(end)}、${args.block} 残り${inventoryCount(bot, args.block)}）`, at: end };
}
