import { Vec3 } from 'vec3';
import { activateItemFacing } from '../activateItemFacing.js';
import { bedHalves, isBedName } from '../bedRules.js';
import { equipToHandVerified } from '../equipVerified.js';
import { feetCell, type Cell } from '../localMap.js';
import { noteSpawnBed } from '../ownedBlocks.js';
import { blockAt, cellNow, cellText, DIRECTION_JA, DIRECTIONS, eyeDistance, findItem, guard, inventoryCount, isAirLike, placeText, stopped,
  StepStopped, USE_REACH, wait, waitUntil, type StepContext, type StepOutcome } from './common.js';
import { BED_HALF_WAIT_MS } from './place.js';

/**
 * use: the right hand on a block, a creature, or the air (design mb-llm-centric 2.3 and the owner's dragon list, 2026-10-21).
 *   - a bucket on a source of water or lava fills it (only a source: a flowing cell is said, with its level);
 *   - a water or lava bucket empties into the cell given (set against its first solid neighbour, or `against`);
 *   - flint and steel lights the cell given (a portal frame's inside, a block's top);
 *   - a bed sleeps (what stops it is the game's: not night, monsters near);
 *   - a door, gate, trapdoor, lever or button is worked;
 *   - an eye of ender in the air is thrown, and where it flew is measured (bearing, how far); on an end portal frame it is set in, and
 *     the frames filled are counted;
 *   - seeds, bone meal and the like on the block given; anything else on a creature (`entity`), or in the air.
 * The item is the one asked for (`item`), else what the hand holds. What came of it is read back from the world.
 */
export interface UseArgs { item?: string; at?: Cell; against?: string; entity?: string }

const BEDS = /_bed$/u;
const WORKED = /(_door|_trapdoor|_fence_gate|^lever|_button)$/u;

async function hold(ctx: StepContext, name: string): Promise<StepOutcome | null> {
  const bot = ctx.bot;
  if (bot.heldItem?.name === name) return null;
  const item = findItem(bot, name);
  if (!item) return stopped(bot, 'missing_item', `${name} を持っていない`);
  const held = await guard(ctx, equipToHandVerified(bot, item), 5000);
  return held?.value.held ? null : stopped(bot, 'equip_failed', `${name} を手に持てなかった（${held?.value.detail ?? '時間切れ'}）`);
}

/** The solid neighbour of `cell` to aim at (the face between them is clicked), or null. */
function neighbourFor(bot: any, cell: Cell, against?: string): { block: any; side: string } | null {
  for (const side of against ? [against] : ['down', 'north', 'south', 'west', 'east', 'up']) {
    const offset = DIRECTIONS[side];
    if (!offset) continue;
    const block = blockAt(bot, { x: cell.x + offset[0], y: cell.y + offset[1], z: cell.z + offset[2] });
    if (block && block.boundingBox === 'block') return { block, side };
  }
  return null;
}
const faceCentre = (cell: Cell, side: string) => {
  const [dx, dy, dz] = DIRECTIONS[side];
  return new Vec3(cell.x + 0.5 + dx * 0.5, cell.y + 0.5 + dy * 0.5, cell.z + 0.5 + dz * 0.5);
};

function liquidLevel(block: any): number {
  try { return Number(block?.getProperties?.().level ?? block?.metadata ?? 0); } catch { return -1; }
}

/** The eye's flight, read until it falls or breaks (about three seconds): its bearing and how far it went (the owner's list). */
async function throwEye(ctx: StepContext): Promise<StepOutcome> {
  const bot = ctx.bot;
  const eyes = () => Object.values(bot.entities ?? {}).filter((entity: any) => entity?.name === 'eye_of_ender' && entity.position?.distanceTo(bot.entity.position) < 8) as any[];
  const before = new Set(eyes().map(entity => entity.id));
  const from = feetCell(bot)!;
  const throwFrom = bot.entity.position.clone();
  const left = inventoryCount(bot, 'ender_eye');
  bot.activateItem();
  let eye: any = null;
  await waitUntil(ctx, () => !!(eye = eyes().find(entity => !before.has(entity.id))), 2000);
  try { bot.deactivateItem(); } catch { /* released */ }
  if (!eye) return stopped(bot, 'eye_not_thrown', 'エンダーアイは飛ばなかった（要塞の無い次元か、エンドポータルの枠を見ている）', from);
  const start = eye.position.clone();
  let end = start.clone(), last = Date.now();
  const id = eye.id;
  for (const until = Date.now() + 4000; Date.now() < until;) {
    await wait(ctx, 100);
    const now = bot.entities?.[id];
    if (!now) break;
    if (now.position.distanceTo(end) > 0.02) last = Date.now();
    end = now.position.clone();
    if (Date.now() - last > 600) break;
  }
  const dx = end.x - throwFrom.x, dz = end.z - throwFrom.z, flat = Math.hypot(dx, dz);
  const kept = inventoryCount(bot, 'ender_eye');
  const broke = !bot.entities?.[id] && kept < left;
  if (flat < 0.5) return { ok: true, text: `エンダーアイを ${cellText(from)} で投げたが、横にほとんど動かなかった（要塞はほぼ真下）。残り${kept}`, at: from };
  const bearing = (Math.atan2(dx, -dz) * 180 / Math.PI + 360) % 360;
  const compass = ['北', '北東', '東', '南東', '南', '南西', '西', '北西'][Math.round(bearing / 45) % 8];
  const to = { x: Math.floor(end.x), y: Math.floor(end.y), z: Math.floor(end.z) };
  const flight = { from, bearingDeg: Math.round(bearing * 10) / 10, flew: Math.round(flat * 10) / 10, to, broke };
  return { ok: true, at: from, data: { eye: flight }, text: `エンダーアイを ${cellText(from)} で投げた: 方位 ${bearing.toFixed(1)}°（北0°・東90°、${compass}）、水平に ${flat.toFixed(1)} ブロック先まで飛んだ`
    + `（向き x=${(dx / flat).toFixed(3)} z=${(dz / flat).toFixed(3)}）。${broke ? '目玉は割れた' : bot.entities?.[id] ? '目玉は落ちて残っている（拾える）' : '目玉は消えた'}。残り${kept}` };
}

/** Frames of the portal round `cell` (within 4), and how many have their eye. */
function framesAround(bot: any, cell: Cell): { frames: number; eyes: number } {
  let frames = 0, eyes = 0;
  for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) {
    const block = blockAt(bot, { x: cell.x + dx, y: cell.y, z: cell.z + dz });
    if (block?.name !== 'end_portal_frame') continue;
    frames++;
    try { const eye = block.getProperties?.().eye; if (eye === true || eye === 'true') eyes++; } catch { /* unknown */ }
  }
  return { frames, eyes };
}

/**
 * A bed at `cell`: slept in. r8 (runs 28 and 32, "there's only half bed" after a bed was placed, 4 seconds of a night lost each time and
 * 110 seconds of waiting for the morning): the server sends a placed bed's foot at once and its head in the next block update, and
 * mineflayer's sleep reads the foot's partner at the moment it is called. So the other half is waited for (the same 1.5 s as `place`), the
 * HEAD is what is clicked (mineflayer's half-bed check is only for the foot), and when a half is really missing the line says which cell
 * is missing and what it holds. The held item does not matter (a planner that wrote item:"black_bed" was told it did not have one).
 */
async function sleepInBed(ctx: StepContext, cell: Cell, asked: any): Promise<StepOutcome> {
  const bot = ctx.bot;
  let block = asked;
  const halves = bedHalves(asked, cell);
  const where = halves ? `足 ${cellText(halves.foot)}・頭 ${cellText(halves.head)}` : cellText(cell);
  let late = 0;
  if (halves) {
    const waitedFrom = Date.now();
    const ready = await waitUntil(ctx, () => isBedName(blockAt(bot, halves.other)?.name), BED_HALF_WAIT_MS);
    late = Date.now() - waitedFrom;
    if (!ready) {
      return stopped(bot, 'not_slept', `${placeText(bot, cell)} のベッドで寝られなかった: ベッドの${halves.part === 'foot' ? '頭' : '足'}のマス ${cellText(halves.other)} が`
        + ` ${cellNow(bot, halves.other)}（半分しか無い。向き ${halves.facing}）。ベッドは壊して置き直す`, cell);
    }
    block = blockAt(bot, halves.head) ?? asked;
  }
  try {
    const slept = await guard(ctx, Promise.resolve(bot.sleep(block)), 4000);
    if (!slept) return stopped(bot, 'not_slept', `${placeText(bot, cell)} のベッドで寝られなかった（時間切れ。${where}）`, cell);
  } catch (error) {
    if (error instanceof StepStopped || /Action interrupted/u.test(String((error as Error)?.message))) throw error;
    return stopped(bot, 'not_slept', `${placeText(bot, cell)} のベッドで寝られなかった: ${String((error as Error)?.message ?? error).slice(0, 80)}（${where}。ベッドはリスポーン地点にはなる）`, cell);
  }
  try { noteSpawnBed(bot, halves ? [halves.foot, halves.head] : [cell], String(asked.name)); } catch { /* the ledger is a help */ }
  const woke = await waitUntil(ctx, () => !bot.isSleeping, 15_000, 200);
  if (!woke) { try { await bot.wake(); } catch { /* up */ } }
  return { ok: true, text: `${cellText(cell)} のベッドで寝た${woke ? '（朝になって起きた）' : '（15秒で起きた。夜はまだ）'}。リスポーン地点はこのベッド${late >= 20 ? `（頭のブロックが来るまで ${late}ms 待った）` : ''}`, at: cell };
}

export async function use(ctx: StepContext, args: UseArgs): Promise<StepOutcome> {
  const bot = ctx.bot;
  const name = args.item ?? bot.heldItem?.name ?? null;
  // A bed at `at` needs no item in the hand (its branch is below); every other use takes the item asked for.
  const aimed = args.at && !args.entity ? blockAt(bot, args.at) : null;
  if (args.item && !(aimed && BEDS.test(aimed.name))) { const fail = await hold(ctx, args.item); if (fail) return fail; }
  // A creature.
  if (args.entity) {
    const target = findEntity(bot, args.entity);
    if (!target) return stopped(bot, 'target_not_found', `${args.entity} が近く（16m）にいない`);
    if (target.position.distanceTo(bot.entity.position) > 4) return stopped(bot, 'out_of_reach', `${target.name}（${cellText(cellOf(target.position))}）に届かない（${target.position.distanceTo(bot.entity.position).toFixed(1)}m）`, cellOf(target.position));
    await guard(ctx, Promise.resolve(bot.lookAt(target.position.offset(0, (target.height ?? 1) * 0.6, 0), true)), 1000);
    bot.useOn(target);
    await wait(ctx, 300);
    return { ok: true, text: `${name ?? '素手'} を ${target.name}（id ${target.id}）に使った`, at: cellOf(target.position) };
  }
  // The air: an eye of ender, a potion, a pearl, a bow drawn elsewhere (shoot).
  if (!args.at) {
    if (!name) return stopped(bot, 'invalid_input', 'use には item か at か entity が要る');
    if (name === 'ender_eye') return throwEye(ctx);
    const count = inventoryCount(bot, name);
    bot.activateItem();
    await wait(ctx, 350);
    try { bot.deactivateItem(); } catch { /* released */ }
    return { ok: true, text: `${name} を使った（残り${inventoryCount(bot, name)}、前は${count}）` };
  }
  const cell = args.at;
  const block = blockAt(bot, cell);
  if (!block) return stopped(bot, 'unloaded', `${placeText(bot, cell)} は未ロード`, cell);
  const distance = eyeDistance(bot, cell);
  if (distance > USE_REACH) return stopped(bot, 'out_of_reach', `${placeText(bot, cell)} に届かない（目から${distance.toFixed(1)}m、${USE_REACH}m まで）`, cell);
  // A bed (r8: before any item is looked at; the bed is slept in with an empty hand).
  if (BEDS.test(block.name)) return sleepInBed(ctx, cell, block);
  // A bucket on a source.
  if (name === 'bucket') {
    if (block.name !== 'water' && block.name !== 'lava') return stopped(bot, 'not_liquid', `${placeText(bot, cell)} は ${cellNow(bot, cell)}（水や溶岩ではない）`, cell);
    const level = liquidLevel(block);
    if (level !== 0) return stopped(bot, 'not_source', `${placeText(bot, cell)} は流れる${block.name}（流れ ${level}）。汲めるのは源（レベル0）だけ`, cell);
    const before = inventoryCount(bot, 'bucket');
    await activateItemFacing(bot, new Vec3(cell.x + 0.5, cell.y + 0.5, cell.z + 0.5));
    const filled = `${block.name}_bucket`;
    const ok = await waitUntil(ctx, () => inventoryCount(bot, 'bucket') < before || bot.heldItem?.name === filled, 1500);
    if (!ok) {
      const between = lineBlocker(bot, cell);
      return stopped(bot, 'not_filled', `${placeText(bot, cell)} の ${block.name} を汲めなかった（${between
        ? `目との間の ${cellText(between.cell)} が ${between.name}` : '視線が届かないか、手前に何かある'}。今 ${cellNow(bot, cell)}）`, cell);
    }
    return { ok: true, text: `${cellText(cell)} の ${block.name} 源を汲んだ（${filled}）`, at: cell };
  }
  // A full bucket into the cell given.
  if (name === 'water_bucket' || name === 'lava_bucket') {
    if (!isAirLike(block) && block.name !== 'water' && block.name !== 'lava') return stopped(bot, 'occupied', `${placeText(bot, cell)} は ${cellNow(bot, cell)}（空いたマスを指す）`, cell);
    const neighbour = neighbourFor(bot, cell, args.against);
    if (!neighbour) return stopped(bot, 'nothing_to_set_against', `${placeText(bot, cell)} の周りに当てる固いブロックが無い`, cell);
    const [dx, dy, dz] = DIRECTIONS[neighbour.side];
    const reference = { x: cell.x + dx, y: cell.y + dy, z: cell.z + dz };
    await activateItemFacing(bot, faceCentre(reference, oppositeOf(neighbour.side)));
    const liquid = name === 'water_bucket' ? 'water' : 'lava';
    const ok = await waitUntil(ctx, () => blockAt(bot, cell)?.name === liquid || bot.heldItem?.name === 'bucket', 1500);
    if (!ok) return stopped(bot, 'not_poured', `${placeText(bot, cell)} に ${liquid} を注げなかった（今 ${cellNow(bot, cell)}）`, cell);
    await wait(ctx, 150);
    return { ok: true, text: `${cellText(cell)} に ${liquid} を注いだ（${DIRECTION_JA[neighbour.side]}の ${neighbour.block.name} に当てて。今 ${cellNow(bot, cell)}）`, at: cell };
  }
  // Fire into the cell given (a portal's inside).
  if (name === 'flint_and_steel' || name === 'fire_charge') {
    if (!isAirLike(block)) return stopped(bot, 'occupied', `${placeText(bot, cell)} は ${cellNow(bot, cell)}（火を付けるのは空いたマス）`, cell);
    const neighbour = neighbourFor(bot, cell, args.against);
    if (!neighbour) return stopped(bot, 'nothing_to_set_against', `${placeText(bot, cell)} の周りに火を付ける固いブロックが無い`, cell);
    const [dx, dy, dz] = DIRECTIONS[neighbour.side];
    await guard(ctx, Promise.resolve(bot.activateBlock(neighbour.block, new Vec3(-dx, -dy, -dz))), 3000);
    const ok = await waitUntil(ctx, () => /fire|nether_portal/u.test(String(blockAt(bot, cell)?.name)), 1500);
    if (!ok) return stopped(bot, 'not_lit', `${placeText(bot, cell)} に火が付かなかった（今 ${cellNow(bot, cell)}）`, cell);
    return { ok: true, text: `${cellText(cell)} に火を付けた（今 ${cellNow(bot, cell)}）`, at: cell };
  }
  // An eye into a frame.
  if (block.name === 'end_portal_frame') {
    if (name !== 'ender_eye') return stopped(bot, 'invalid_input', `${placeText(bot, cell)} は枠。はめるのは item:"ender_eye"`, cell);
    const fail = await hold(ctx, 'ender_eye');
    if (fail) return { ...fail, at: cell };
    const had = (() => { try { const eye = block.getProperties?.().eye; return eye === true || eye === 'true'; } catch { return false; } })();
    if (had) { const count = framesAround(bot, cell); return stopped(bot, 'already_filled', `${placeText(bot, cell)} の枠には既に目がある（はまっている ${count.eyes}/${count.frames}）`, cell); }
    await guard(ctx, Promise.resolve(bot.activateBlock(block, new Vec3(0, 1, 0))), 3000);
    const ok = await waitUntil(ctx, () => { try { const eye = blockAt(bot, cell)?.getProperties?.().eye; return eye === true || eye === 'true'; } catch { return false; } }, 1500);
    const count = framesAround(bot, cell);
    if (!ok) return stopped(bot, 'not_set', `${placeText(bot, cell)} の枠に目がはまらなかった（はまっている ${count.eyes}/${count.frames}）`, cell);
    await wait(ctx, 200);
    const portal = [...Array(5).keys()].some(dx => [...Array(5).keys()].some(dz => blockAt(bot, { x: cell.x + dx - 2, y: cell.y, z: cell.z + dz - 2 })?.name === 'end_portal'));
    return { ok: true, text: `${cellText(cell)} の枠に目をはめた（はまっている ${count.eyes}/${count.frames}${portal ? '。エンドポータルが開いた' : ''}）`, at: cell };
  }
  // A door and the like.
  if (WORKED.test(block.name) && (!name || !bot.registry?.blocksByName?.[name] || WORKED.test(name))) {
    const open = () => { try { return String(blockAt(bot, cell)?.getProperties?.().open ?? blockAt(bot, cell)?.getProperties?.().powered); } catch { return '?'; } };
    const before = open();
    await guard(ctx, Promise.resolve(bot.activateBlock(block)), 3000);
    await wait(ctx, 250);
    return { ok: true, text: `${cellText(cell)} の ${block.name} を使った（${before}→${open()}）`, at: cell };
  }
  // Anything else on the block (seeds on farmland, bone meal on a crop, an item on a block that takes it).
  const count = name ? inventoryCount(bot, name) : 0;
  const before = block.name;
  await guard(ctx, Promise.resolve(bot.activateBlock(block, new Vec3(0, 1, 0))), 3000);
  await wait(ctx, 300);
  const above = blockAt(bot, { x: cell.x, y: cell.y + 1, z: cell.z });
  return { ok: true, text: `${name ?? '素手'} を ${cellText(cell)} の ${before} に使った（今 ${cellNow(bot, cell)}、上 ${above?.name ?? '未ロード'}${name ? `、${name} 残り${inventoryCount(bot, name)}（前は${count}）` : ''}）`, at: cell };
}

/**
 * The first solid block on the straight line from her eyes to the middle of `cell`, other than the cell itself and the one she stands
 * in (scene replay 2026-10-21: a source behind one stone, "視線が届かないか、手前に何かある" seven times in twelve, the stone never named).
 */
export function lineBlocker(bot: any, cell: Cell): { cell: Cell; name: string } | null {
  const eye = bot.entity?.position;
  if (!eye) return null;
  const from = { x: eye.x, y: eye.y + 1.62, z: eye.z }, to = { x: cell.x + 0.5, y: cell.y + 0.5, z: cell.z + 0.5 };
  const length = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z), steps = Math.ceil(length / 0.1);
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const at = { x: Math.floor(from.x + (to.x - from.x) * t), y: Math.floor(from.y + (to.y - from.y) * t), z: Math.floor(from.z + (to.z - from.z) * t) };
    if (at.x === cell.x && at.y === cell.y && at.z === cell.z) break;
    const block = blockAt(bot, at);
    if (block && block.boundingBox === 'block') return { cell: at, name: String(block.name) };
  }
  return null;
}

const oppositeOf = (side: string) => ({ down: 'up', up: 'down', north: 'south', south: 'north', east: 'west', west: 'east' } as Record<string, string>)[side];
const cellOf = (position: { x: number; y: number; z: number }): Cell => ({ x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) });

/** A creature by id ("123") or by name, the nearest within 16 m. */
export function findEntity(bot: any, spec: string | number, range = 16): any {
  const at = bot.entity?.position;
  if (!at) return null;
  const id = typeof spec === 'number' ? spec : /^\d+$/u.test(String(spec).trim()) ? Number(spec) : null;
  if (id !== null) return bot.entities?.[id] ?? null;
  const wanted = String(spec).trim().toLowerCase().replace(/^minecraft:/u, '');
  return (Object.values(bot.entities ?? {}) as any[]).filter(entity => entity && entity !== bot.entity && entity.position
    && (String(entity.name ?? '').toLowerCase() === wanted || String(entity.username ?? '').toLowerCase() === wanted) && entity.position.distanceTo(at) <= range)
    .sort((a, b) => a.position.distanceTo(at) - b.position.distanceTo(at))[0] ?? null;
}
