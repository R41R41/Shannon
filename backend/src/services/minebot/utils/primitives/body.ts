import { Vec3 } from 'vec3';
import { equipToHandVerified } from '../equipVerified.js';
import { itemFoodPoints } from '../foodPoints.js';
import { facingOfYaw, feetCell, type Cell } from '../localMap.js';
import { cellText, DIRECTIONS, DIRECTION_JA, findItem, guard, inventoryCount, stopped, StepStopped, wait, waitUntil, type StepContext, type StepOutcome } from './common.js';
import { findEntity } from './use.js';

/** The small parts of act (design mb-llm-centric 2.3): look, jump, sneak, equip, eat, drop. Each does what it says and reads back what came of it. */

export interface LookArgs { at?: Cell; entity?: string; yaw?: number; pitch?: number }
export async function look(ctx: StepContext, args: LookArgs): Promise<StepOutcome> {
  const bot = ctx.bot;
  if (args.entity !== undefined) {
    const target = findEntity(bot, args.entity, 64);
    if (!target) return stopped(bot, 'target_not_found', `${args.entity} が 64m 内にいない`);
    await guard(ctx, Promise.resolve(bot.lookAt(target.position.offset(0, (target.height ?? 1.6) * 0.8, 0), true)), 1000);
    return { ok: true, text: `${target.name}（id ${target.id}）を見た` };
  }
  if (args.at) {
    await guard(ctx, Promise.resolve(bot.lookAt(new Vec3(args.at.x + 0.5, args.at.y + 0.5, args.at.z + 0.5), true)), 1000);
    return { ok: true, text: `${cellText(args.at)} を見た` };
  }
  if (typeof args.yaw === 'number' || typeof args.pitch === 'number') {
    // Degrees as a map is read: yaw 0 north, 90 east (the body's own yaw turns the other way, from north to the west).
    const yaw = typeof args.yaw === 'number' ? -args.yaw * Math.PI / 180 : bot.entity.yaw;
    const pitch = typeof args.pitch === 'number' ? Math.max(-90, Math.min(90, args.pitch)) * Math.PI / 180 : bot.entity.pitch;
    await guard(ctx, Promise.resolve(bot.look(yaw, pitch, true)), 1000);
    return { ok: true, text: `方位 ${(((-yaw * 180 / Math.PI) % 360) + 360) % 360}°・仰角 ${(pitch * 180 / Math.PI).toFixed(0)}° を向いた` };
  }
  return stopped(bot, 'invalid_input', 'look には at・entity・yaw/pitch のどれかが要る');
}

export async function jump(ctx: StepContext, args: { n?: number }): Promise<StepOutcome> {
  const bot = ctx.bot;
  const times = Math.max(1, Math.min(10, Math.round(args.n ?? 1)));
  const start = feetCell(bot)!;
  for (let i = 0; i < times; i++) {
    await waitUntil(ctx, () => bot.entity?.onGround === true, 1500);
    bot.setControlState('jump', true);
    await waitUntil(ctx, () => bot.entity?.onGround === false, 500);
    bot.setControlState('jump', false);
    await waitUntil(ctx, () => bot.entity?.onGround === true, 1500);
  }
  const end = feetCell(bot)!;
  return { ok: true, text: `${times}回跳んだ（${cellText(start)}→${cellText(end)}）`, at: end };
}

export async function sneak(ctx: StepContext, args: { on?: boolean; seconds?: number }): Promise<StepOutcome> {
  const bot = ctx.bot;
  const on = args.on !== false;
  bot.setControlState('sneak', on);
  if (on && typeof args.seconds === 'number' && args.seconds > 0) {
    try { await wait(ctx, Math.min(30, args.seconds) * 1000); } finally { bot.setControlState('sneak', false); }
    return { ok: true, text: `${Math.min(30, args.seconds)}秒しゃがんだ` };
  }
  return { ok: true, text: on ? 'しゃがんだ（この act の間）' : 'しゃがむのをやめた' };
}

const SLOTS: Record<string, string> = { hand: 'hand', 'off-hand': 'off-hand', head: 'head', torso: 'torso', legs: 'legs', feet: 'feet' };
export async function equip(ctx: StepContext, args: { item: string; slot?: string }): Promise<StepOutcome> {
  const bot = ctx.bot;
  const slot = SLOTS[args.slot ?? 'hand'];
  if (!slot) return stopped(bot, 'invalid_input', `slot は ${Object.keys(SLOTS).join('・')} のどれか`);
  const item = findItem(bot, args.item);
  if (!item) return stopped(bot, 'missing_item', `${args.item} を持っていない`);
  if (slot === 'hand') {
    const held = await guard(ctx, equipToHandVerified(bot, item), 5000);
    return held?.value.held ? { ok: true, text: `${args.item} を手に持った` } : stopped(bot, 'equip_failed', `${args.item} を手に持てなかった（${held?.value.detail ?? '時間切れ'}）`);
  }
  try { await guard(ctx, Promise.resolve(bot.equip(item, slot)), 3000); }
  catch (error) {
    if (error instanceof StepStopped || /Action interrupted/u.test(String((error as Error)?.message))) throw error;
    return stopped(bot, 'equip_failed', `${args.item} を ${slot} に着けられなかった: ${String((error as Error)?.message ?? error).slice(0, 80)}`);
  }
  return { ok: true, text: `${args.item} を ${slot} に着けた` };
}

const ALWAYS_EDIBLE = new Set(['golden_apple', 'enchanted_golden_apple', 'chorus_fruit', 'potion', 'milk_bucket', 'honey_bottle']);
export async function eat(ctx: StepContext, args: { item: string }): Promise<StepOutcome> {
  const bot = ctx.bot;
  const item = findItem(bot, args.item);
  if (!item) return stopped(bot, 'missing_item', `${args.item} を持っていない`);
  if ((bot.food ?? 0) >= 20 && !ALWAYS_EDIBLE.has(args.item)) return stopped(bot, 'full', `満腹（20/20）なので ${args.item} は食べられない`);
  const before = { count: inventoryCount(bot, args.item), food: bot.food as number, saturation: Number(bot.foodSaturation ?? 0) };
  const held = await guard(ctx, equipToHandVerified(bot, item), 5000);
  if (!held?.value.held) return stopped(bot, 'equip_failed', `${args.item} を手に持てなかった`);
  try { await guard(ctx, Promise.resolve(bot.consume()), 4000); }
  catch (error) { if (error instanceof StepStopped || /Action interrupted/u.test(String((error as Error)?.message))) throw error; }
  const shown = await waitUntil(ctx, () => inventoryCount(bot, args.item) < before.count || bot.food > before.food, 2500, 100);
  if (!shown) return stopped(bot, 'not_eaten', `${args.item} を食べられなかった（満腹度 ${bot.food}/20、残り ${inventoryCount(bot, args.item)}）`);
  return { ok: true, text: `${args.item} を食べた（満腹度 ${before.food}→${bot.food}、隠し値 ${before.saturation.toFixed(1)}→${Number(bot.foodSaturation ?? 0).toFixed(1)}、1個 ${itemFoodPoints(bot, args.item)}点、残り ${inventoryCount(bot, args.item)}）` };
}

export interface DropArgs { items: Array<{ item: string; count?: number }>; toward?: string | Cell }

/** How many cells ahead (at the height of the head, where a thrown item leaves) a throw wants free, and how far it looks. */
const TOSS_WANTS = 4, TOSS_LOOKS = 6;
/** Items nearer than this to the feet are picked up again by a body that stays or walks over them (the pick-up reach is a block; a thrown item waits 2 s). */
const TOSS_AWAY = 3;
const solidAt = (bot: any, x: number, y: number, z: number): boolean => {
  try { return bot.blockAt?.(new Vec3(x, y, z), false)?.boundingBox === 'block'; } catch { return false; }
};

/**
 * The way to throw when none was asked (mb-llmc-cand 3, run 37: eight stops on a full pack, about 150 s: the stones thrown at the feet while she
 * looked down a stair were picked up again by standing there): the one of the four compass ways with the most free cells at the head's height
 * (up to TOSS_LOOKS), the way she faces first among equals. The throw is level, so the items fly several blocks and do not fall at the feet.
 */
function tossWay(bot: any, feet: Cell): { name: string; dx: number; dz: number; free: number } {
  type Way = { name: string; dx: number; dz: number; free: number };
  const facing = facingOfYaw(Number(bot.entity?.yaw ?? 0));
  let best: Way = { name: facing, dx: 0, dz: 0, free: -1 };
  for (const name of ['north', 'east', 'south', 'west']) {
    const [dx, , dz] = DIRECTIONS[name];
    let free = 0;
    for (let i = 1; i <= TOSS_LOOKS; i++) { if (solidAt(bot, feet.x + dx * i, feet.y + 1, feet.z + dz * i)) break; free = i; }
    const score = free + (name === facing ? 0.5 : 0);
    if (best.free < 0 || score > best.free + (best.name === facing ? 0.5 : 0)) best = { name, dx, dz, free };
  }
  return best;
}

/**
 * drop: throw these from the pack the way the body faces, or toward a creature (a piglin, to trade gold) or a cell first. Only
 * thrown: what lands where is the game's; a trade's goods are taken up with pickup. With no way asked, the throw is level toward the freest
 * of the four ways (`tossWay`), and the line says where the items lay (read from the item entities) and whether they are far enough not to be
 * picked up again.
 */
export async function drop(ctx: StepContext, args: DropArgs): Promise<StepOutcome> {
  const bot = ctx.bot;
  if (!args.items?.length) return stopped(bot, 'invalid_input', 'drop には items（物と数の列）が要る');
  // A cell given as the text "229,-52,194" is the cell, not the name of a creature.
  const cellText3 = typeof args.toward === 'string' ? /^\s*\(?(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\)?\s*$/u.exec(args.toward) : null;
  if (cellText3) args = { ...args, toward: { x: Number(cellText3[1]), y: Number(cellText3[2]), z: Number(cellText3[3]) } };
  const feet = feetCell(bot);
  let way: ReturnType<typeof tossWay> | null = null;
  if (args.toward === undefined && feet && bot.entity?.position) {
    way = tossWay(bot, feet);
    const eyeY = bot.entity.position.y + 1.62;
    try { await guard(ctx, Promise.resolve(bot.lookAt(new Vec3(feet.x + 0.5 + way.dx * 8, eyeY, feet.z + 0.5 + way.dz * 8), true)), 1000); } catch (error) { if (error instanceof StepStopped) throw error; }
  }
  const itemIds = () => new Set(Object.values(bot.entities ?? {}).filter((e: any) => e?.name === 'item').map((e: any) => e.id));
  const before = itemIds();
  if (args.toward !== undefined) {
    if (typeof args.toward === 'object') await guard(ctx, Promise.resolve(bot.lookAt(new Vec3(args.toward.x + 0.5, args.toward.y + 0.5, args.toward.z + 0.5), true)), 1000);
    else {
      const target = findEntity(bot, args.toward, 16);
      if (!target) return stopped(bot, 'target_not_found', `${args.toward} が 16m 内にいない`);
      await guard(ctx, Promise.resolve(bot.lookAt(target.position.offset(0, 0.5, 0), true)), 1000);
    }
  }
  const done: string[] = [];
  for (const want of args.items) {
    const have = inventoryCount(bot, want.item);
    if (!have) { done.push(`${want.item} を持っていない`); continue; }
    const count = Math.min(have, Math.max(1, Math.round(want.count ?? have)));
    const item = findItem(bot, want.item);
    try { await guard(ctx, Promise.resolve(bot.toss(item.type, null, count)), 3000); }
    catch (error) { if (error instanceof StepStopped || /Action interrupted/u.test(String((error as Error)?.message))) throw error; }
    done.push(`${want.item}×${have - inventoryCount(bot, want.item)} を投げた（残り${inventoryCount(bot, want.item)}）`);
  }
  // Where the items lay: the item entities that were not there before, read after a moment (the server spawns them a tick on).
  let where = '';
  if (bot.entity?.position) {
    try {
      await wait(ctx, 350);
      const origin = bot.entity.position;
      const landed = Object.values(bot.entities ?? {}).filter((e: any) => e?.name === 'item' && e.position && !before.has(e.id) && origin.distanceTo(e.position) <= 16)
        .map((e: any) => ({ at: { x: Math.floor(e.position.x), y: Math.floor(e.position.y), z: Math.floor(e.position.z) }, d: Math.hypot(e.position.x - origin.x, e.position.z - origin.z) }))
        .sort((a, b) => a.d - b.d);
      const aim = way ? `${DIRECTION_JA[way.name]}へ水平に投げた（その向きの空きは頭の高さで ${way.free >= TOSS_LOOKS ? `${TOSS_LOOKS} マス以上` : `${way.free} マス`}）。` : '';
      if (landed.length) {
        const near = landed[0];
        where = `。${aim}落ちた先 ${cellText(near.at)}（足から横 ${near.d.toFixed(1)}m）`
          + (near.d >= TOSS_AWAY ? `。${TOSS_AWAY}m 以上離れたので、そこへ歩いて戻らない限り拾い直さない` : `。近い（${TOSS_AWAY}m 未満）: ここに立ち続ける・近くを歩くと拾い直す。離れてから続ける`);
      } else if (aim) where = `。${aim.replace(/。$/u, '')}（落ちた先は読めなかった）`;
    } catch (error) { if (error instanceof StepStopped) throw error; }
  }
  return { ok: true, text: `${done.join('、')}${where}` };
}
