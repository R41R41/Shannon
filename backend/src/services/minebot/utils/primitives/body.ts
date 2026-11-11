import { Vec3 } from 'vec3';
import { equipToHandVerified } from '../equipVerified.js';
import { itemFoodPoints } from '../foodPoints.js';
import { feetCell, type Cell } from '../localMap.js';
import { cellText, findItem, guard, inventoryCount, stopped, StepStopped, wait, waitUntil, type StepContext, type StepOutcome } from './common.js';
import { findEntity } from './use.js';
import { holdShieldForDraw } from '../shieldBlock.js';
import { noteSelfDropped } from '../selfDropped.js';
import { chooseCap, closeDropPit, openDropPit, pitLookPoint, PIT_DEPTH, walkClear, type OpenedPit } from './dropPit.js';

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
/** The inventory window's slot of each place an item is worn in (armour 5 to 8, the off hand 45). */
const EQUIP_SLOT_INDEX: Record<string, number> = { head: 5, torso: 6, legs: 7, feet: 8, 'off-hand': 45 };
/** The slot an armour piece is worn in (run 48: an equip with no slot for a chestplate held it in the hand and said so), or null for anything else. */
export function armourSlotOf(name: string): string | null {
  if (/_helmet$/u.test(name)) return 'head';
  if (/_chestplate$|^elytra$/u.test(name)) return 'torso';
  if (/_leggings$/u.test(name)) return 'legs';
  if (/_boots$/u.test(name)) return 'feet';
  return null;
}
export async function equip(ctx: StepContext, args: { item: string; slot?: string }): Promise<StepOutcome> {
  const bot = ctx.bot;
  const slot = SLOTS[args.slot ?? armourSlotOf(args.item) ?? 'hand'];
  if (!slot) return stopped(bot, 'invalid_input', `slot は ${Object.keys(SLOTS).join('・')} のどれか`);
  // Continue contracts (1): the item is already where it was to be put (in the hand, or in the armour or off-hand slot asked): the aim held when the hand began.
  // This is asked before the pack is searched: a piece that is worn is not in the pack (the auto-wear habit puts a piece on within a second of its being picked up,
  // and the planner's equip then found "not held" for gold boots that were on its feet).
  const nowThere = slot === 'hand' ? bot.heldItem : bot.inventory?.slots?.[EQUIP_SLOT_INDEX[slot] ?? -1];
  if (nowThere?.name === args.item) return { ok: true, goal: 'already', code: 'already_equipped', text: `${args.item} は既に${slot === 'hand' ? '手に持っている' : ` ${slot} に着けている`}（既に済）` };
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
  // Read back from the window (a piece of gold armour is what makes the piglins trade instead of fight, and a click the server did not take shows nowhere else).
  const index = EQUIP_SLOT_INDEX[slot];
  if (index !== undefined && !(await waitUntil(ctx, () => bot.inventory?.slots?.[index]?.name === args.item, 1500, 50))) {
    return stopped(bot, 'equip_failed', `${args.item} を ${slot} に着けたはずだが、そこは ${bot.inventory?.slots?.[index]?.name ?? '空'} のまま`);
  }
  return { ok: true, text: `${args.item} を ${slot} に着けた` };
}

const ALWAYS_EDIBLE = new Set(['golden_apple', 'enchanted_golden_apple', 'chorus_fruit', 'potion', 'milk_bucket', 'honey_bottle']);
export async function eat(ctx: StepContext, args: { item: string }): Promise<StepOutcome> {
  const bot = ctx.bot;
  const item = findItem(bot, args.item);
  if (!item) return stopped(bot, 'missing_item', `${args.item} を持っていない`);
  // Continue contracts (1): a fed body that cannot eat holds the aim already (nothing is changed): ok, goal 'already', code food_full (a reflex that ate first makes this the usual case).
  if ((bot.food ?? 0) >= 20 && !ALWAYS_EDIBLE.has(args.item)) return { ok: true, goal: 'already', code: 'food_full', text: `満腹（20/20）なので ${args.item} は食べられない（既に済）` };
  const before = { count: inventoryCount(bot, args.item), food: bot.food as number, saturation: Number(bot.foodSaturation ?? 0) };
  const held = await guard(ctx, equipToHandVerified(bot, item), 5000);
  if (!held?.value.held) return stopped(bot, 'equip_failed', `${args.item} を手に持てなかった`);
  // A raised shield keeps the server from starting the meal at all (S1 lab 11/8: two meals at 17/20 among blazes and wither skeletons ate nothing,
  // as the bow's draw did, 5d516dc9): it comes down first, and the reflex keeps off the hands until the meal is down.
  const shield = holdShieldForDraw(bot, 4000);
  let shown = false;
  try {
    if (shield.lowered) await wait(ctx, 100);
    try { await guard(ctx, Promise.resolve(bot.consume()), 4000); }
    catch (error) { if (error instanceof StepStopped || /Action interrupted/u.test(String((error as Error)?.message))) throw error; }
    shown = await waitUntil(ctx, () => inventoryCount(bot, args.item) < before.count || bot.food > before.food, 2500, 100);
  } finally { shield.release(); }
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

/** The eight ways a throw may go: the four compass ways and the four between them. */
const TOSS_WAYS: Array<{ name: string; ja: string; dx: number; dz: number }> = [
  { name: 'north', ja: '北', dx: 0, dz: -1 }, { name: 'northeast', ja: '北東', dx: 1, dz: -1 }, { name: 'east', ja: '東', dx: 1, dz: 0 },
  { name: 'southeast', ja: '南東', dx: 1, dz: 1 }, { name: 'south', ja: '南', dx: 0, dz: 1 }, { name: 'southwest', ja: '南西', dx: -1, dz: 1 },
  { name: 'west', ja: '西', dx: -1, dz: 0 }, { name: 'northwest', ja: '北西', dx: -1, dz: -1 },
];

/**
 * The way to throw when none was asked (mb-llmc-cand 3, run 37: eight stops on a full pack, about 150 s: the stones thrown at the feet while she
 * looked down a stair were picked up again by standing there): the one of the eight ways with the most free room at the head's height
 * (up to TOSS_LOOKS cells), the way behind her first among equals. The throw is level, so the items fly several blocks and do not fall at the feet.
 * end1109s02 S9 (11/9): in a tunnel dug on the slant through a mountain each compass way was free for one cell, the stones fell 1 m off, and the
 * next go walked over them: four throws of 89, 136, 200 and 251 each left 128-139, the rest picked up again. A slanted tunnel is open along its
 * slant, so the ways between are looked at too; and the way behind (where she came from) is preferred to the way she faces (where she goes next).
 */
function tossWay(bot: any, feet: Cell): { name: string; ja: string; dx: number; dz: number; free: number } {
  type Way = { name: string; ja: string; dx: number; dz: number; free: number; score: number };
  const yaw = Number(bot.entity?.yaw ?? 0);
  // Facing is (-sin yaw, -cos yaw); behind is the other way.
  const behindX = Math.sin(yaw), behindZ = Math.cos(yaw);
  let best: Way | null = null;
  for (const way of TOSS_WAYS) {
    const slant = way.dx !== 0 && way.dz !== 0;
    let free = 0;
    for (let i = 1; i <= TOSS_LOOKS; i++) {
      const x = feet.x + way.dx * i, y = feet.y + 1, z = feet.z + way.dz * i;
      if (solidAt(bot, x, y, z)) break;
      // On the slant an item passes a corner only where one of the two cells beside the corner is open.
      if (slant && solidAt(bot, x - way.dx, y, z) && solidAt(bot, x, y, z - way.dz)) break;
      free = i;
    }
    const length = slant ? Math.SQRT2 : 1;
    const toward = (way.dx * behindX + way.dz * behindZ) / length;
    const score = Math.min(free * length, TOSS_LOOKS) + 0.5 * toward;
    if (!best || score > best.score) best = { ...way, free, score };
  }
  return best!;
}

/** How long a drop waits for the thrown items to be seen where they lay (the server tells an item's moves about once a second). */
const TOSS_SETTLE_MS = 1500;

/**
 * The last pickaxe of each kind is never thrown (run 62, 1,756 s: the two spare stone pickaxes were thrown for room, the iron one broke at
 * 2,403 s, and she climbed from y 39 to 67 bare-handed). Asked for all of a kind, the drop throws all but one and says why.
 */
const KEEP_LAST = /_pickaxe$/u;

/** Throws `count` of the kind; tools (one to a slot) go the most worn first, so the one kept is the best (bot.toss takes slot order). */
async function tossWorstFirst(bot: any, name: string, count: number): Promise<void> {
  const entries = (bot.inventory?.items?.() ?? []).filter((item: any) => item.name === name);
  if (typeof bot.tossStack === 'function' && entries.length > count && entries.every((item: any) => item.count === 1)) {
    const left = (item: any) => item.maxDurability > 0 ? item.maxDurability - (item.durabilityUsed ?? 0) : Infinity;
    for (const item of [...entries].sort((a, b) => left(a) - left(b)).slice(0, count)) await bot.tossStack(item);
    return;
  }
  await bot.toss(entries[0].type, null, count);
}

/**
 * drop: put these away, or throw them toward a creature (a piglin, to trade gold) or a cell. With neither asked, the body digs a hole two cells deep beside it, throws into it and covers it (dropPit.ts);
 * where no hole can be dug the throw is level toward the freest of the eight ways (`tossWay`) and the body walks off from the heap itself. The line says where the items lay (read from the item entities).
 * A throw at a creature or a cell is only thrown: what lands where is the game's, and a trade's goods are taken up with pickup.
 */
export async function drop(ctx: StepContext, args: DropArgs): Promise<StepOutcome> {
  const bot = ctx.bot;
  if (!args.items?.length) return stopped(bot, 'invalid_input', 'drop には items（物と数の列）が要る');
  // A cell given as the text "229,-52,194" is the cell, not the name of a creature.
  const cellText3 = typeof args.toward === 'string' ? /^\s*\(?(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\)?\s*$/u.exec(args.toward) : null;
  if (cellText3) args = { ...args, toward: { x: Number(cellText3[1]), y: Number(cellText3[2]), z: Number(cellText3[3]) } };
  const feet = feetCell(bot);
  // What is thrown, kind by kind: how many are held, how many are asked, how many go (the last pickaxe of a kind stays).
  const kept: string[] = [];
  const done: string[] = [];
  const plan: Array<{ item: string; have: number; wanted: number; count: number; keepOne: boolean }> = [];
  for (const want of args.items) {
    const have = inventoryCount(bot, want.item);
    if (!have) { done.push(`${want.item} を持っていない`); continue; }
    const wanted = Math.max(1, Math.round(want.count ?? have));
    const keepOne = KEEP_LAST.test(want.item);
    const count = Math.min(have - (keepOne ? 1 : 0), wanted);
    if (keepOne && count < wanted) kept.push(`${want.item} の最後の 1 本は投げない（ツルハシは種類ごとに 1 本残す。今の 1 本が壊れた時の予備で、無いと素手で掘ることになる。空きが要るなら丸石・土・砂利など別の物を投げる）`);
    if (count <= 0) continue;
    plan.push({ item: want.item, have, wanted, count, keepOne });
  }
  // With no creature or cell asked for, the things go into a hole beside the body, two cells deep, covered after (a throw level cannot promise a distance: run 7's 33 of 36 landed within 3 m).
  // The level throw below is for a creature or a cell (a piglin's gold), and for where no hole can be dug (said, with why).
  let opened: OpenedPit | null = null;
  let cap: ReturnType<typeof chooseCap> = null;
  let pitWhy = '';
  if (args.toward === undefined && feet && bot.entity?.position && plan.length) {
    const result = await openDropPit(ctx);
    if ('plan' in result) {
      opened = result;
      cap = result.plan.cap ? chooseCap(bot, new Map(plan.map(entry => [entry.item, entry.count]))) : null;
      if (cap?.reserve) {
        const reserved = cap.block;
        const entry = plan.find(candidate => candidate.item === reserved);
        if (entry) entry.count -= 1;
      }
    } else if (result.threat) {
      return stopped(bot, 'threat_exposed', 'drop 止まった threat_exposed: 敵が近い（捨てるのは後で。足元に投げると拾い直すので、穴は掘らず捨てなかった）');
    } else pitWhy = result.reason;
  }
  let way: ReturnType<typeof tossWay> | null = null;
  if (opened) {
    const eyeY = bot.entity.position.y + 1.62;
    try { await guard(ctx, Promise.resolve(bot.lookAt(pitLookPoint(opened.plan, eyeY), true)), 1000); } catch (error) { if (error instanceof StepStopped) throw error; }
  } else if (args.toward === undefined && feet && bot.entity?.position) {
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
  let thrown = 0, asked = 0;
  const thrownKinds: string[] = [];
  for (const entry of plan) {
    asked += entry.keepOne ? entry.count : entry.wanted;
    if (entry.count > 0) {
      try { await guard(ctx, Promise.resolve(tossWorstFirst(bot, entry.item, entry.count)), 3000); }
      catch (error) { if (error instanceof StepStopped || /Action interrupted/u.test(String((error as Error)?.message))) throw error; }
    }
    const went = Math.max(0, entry.have - inventoryCount(bot, entry.item));
    thrown += went;
    if (went > 0) thrownKinds.push(entry.item);
    done.push(`${entry.item}×${went} を投げた（残り${inventoryCount(bot, entry.item)}）`);
  }
  if (cap?.reserve) asked += 1;
  if (kept.length && !done.length) return stopped(bot, 'last_pickaxe_kept', kept.join('。'));
  const progress = () => ({ unit: 'item' as const, done: thrown, left: Math.max(0, asked - thrown) });
  // The hole: the stacks are let fall, the cover goes on, and what lies where is read (the items are the body's own from then on: no pick-up of its own looks at them).
  let where = '';
  if (opened) {
    const closed = await closeDropPit(ctx, opened, cap);
    where = `。横の穴（深さ ${PIT_DEPTH}）に投げ入れた: ${closed.words}`;
    if (closed.outside > 0) {
      const lying = closed.entities.filter((entity: any) => entity?.position).map((entity: any) => ({ x: Math.floor(entity.position.x), y: Math.floor(entity.position.y), z: Math.floor(entity.position.z) }));
      const away = await walkClear(ctx, lying);
      if (away.words) where += `。穴から跳ねた分は ${away.words}`;
    } else where += '。拾い直さない';
    return { ok: true, text: `${done.join('、')}${where}${kept.length ? `。${kept.join('。')}` : ''}`, progress: progress() };
  }
  // Where the items lay: the item entities that were not there before. mineflayer keeps a thrown item where it was spawned (at the hand) until
  // the server tells its moves, about once a second (end1109s02: read at 0.35 s, a throw with six free cells was said to lie "0.0m" off): the
  // line waits until each new item has been seen to move, or TOSS_SETTLE_MS.
  if (bot.entity?.position && thrown > 0) {
    try {
      const firstSeen = new Map<number, { x: number; y: number; z: number }>();
      const settled = () => {
        let fresh = 0, moved = 0;
        for (const e of Object.values(bot.entities ?? {}) as any[]) {
          if (e?.name !== 'item' || !e.position || before.has(e.id)) continue;
          fresh++;
          const seen = firstSeen.get(e.id);
          if (!seen) firstSeen.set(e.id, { x: e.position.x, y: e.position.y, z: e.position.z });
          else if (Math.hypot(e.position.x - seen.x, e.position.y - seen.y, e.position.z - seen.z) > 0.2) moved++;
        }
        return fresh > 0 && moved === fresh;
      };
      await wait(ctx, 150);
      await waitUntil(ctx, settled, TOSS_SETTLE_MS, 100);
      const origin = bot.entity.position;
      const fresh = Object.values(bot.entities ?? {}).filter((e: any) => e?.name === 'item' && e.position && !before.has(e.id));
      // A throw at a creature or a cell (a trade's gold) is picked up on purpose; a throw to be rid of things is the body's own and no pick-up of its own looks at it.
      if (args.toward === undefined) for (const kind of thrownKinds) noteSelfDropped(bot, kind, fresh.filter((e: any) => droppedName(e) === kind || droppedName(e) === null) as any[], Date.now(), true);
      const landed = fresh.filter((e: any) => origin.distanceTo(e.position) <= 16)
        .map((e: any) => ({ at: { x: Math.floor(e.position.x), y: Math.floor(e.position.y), z: Math.floor(e.position.z) }, d: Math.hypot(e.position.x - origin.x, e.position.z - origin.z) }))
        .sort((a, b) => a.d - b.d);
      const aim = way ? `${pitWhy ? `穴は使えなかった: ${pitWhy}。` : ''}${way.ja}へ水平に投げた（その向きの空きは頭の高さで ${way.free >= TOSS_LOOKS ? `${TOSS_LOOKS} マス以上` : `${way.free} マス`}）。` : '';
      if (landed.length) {
        const near = landed[0];
        where = `。${aim}落ちた先 ${cellText(near.at)}（足から横 ${near.d.toFixed(1)}m）`;
        if (near.d >= TOSS_AWAY) where += `。${TOSS_AWAY}m 以上離れたので、そこへ歩いて戻らない限り拾い直さない`;
        else if (args.toward === undefined) {
          // Near: the body walks off itself (a short go, nothing dug or laid) instead of telling the planner to.
          const away = await walkClear(ctx, landed.map(item => item.at));
          where += `。近い（${TOSS_AWAY}m 未満）ので${away.words || '離れた'}`;
        } else where += `。近い（${TOSS_AWAY}m 未満）: 拾い直すなら歩いて拾う`;
      } else if (aim) where = `。${aim.replace(/。$/u, '')}（落ちた先は読めなかった）`;
    } catch (error) { if (error instanceof StepStopped) throw error; }
  }
  // Continue contracts (1): the items thrown (counted from the pack), of the items asked (a kept last pickaxe is not asked).
  return { ok: true, text: `${done.join('、')}${where}${kept.length ? `。${kept.join('。')}` : ''}`, progress: progress() };
}

const droppedName = (entity: any): string | null => { try { return entity?.getDroppedItem?.()?.name ?? null; } catch { return null; } };
