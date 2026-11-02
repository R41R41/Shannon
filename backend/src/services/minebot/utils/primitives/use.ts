import { Vec3 } from 'vec3';
import { activateItemFacing } from '../activateItemFacing.js';
import { bedHalves, isBedName } from '../bedRules.js';
import { equipToHandVerified } from '../equipVerified.js';
import { feetCell, type Cell } from '../localMap.js';
import { noteSpawnBed } from '../ownedBlocks.js';
import { blockAt, cellNow, cellText, DIRECTION_JA, DIRECTIONS, eyeDistance, findItem, guard, inventoryCount, isAirLike, placeText, stopped,
  StepStopped, USE_REACH, wait, waitUntil, type StepContext, type StepOutcome } from './common.js';
import { BED_HALF_WAIT_MS } from './place.js';
import { compassOf, eyeReportOf, EYE_FATE_MS, EYE_WATCH_MS, watchEyeFlight } from '../huntEyeFlight.js';
import { barterWithPiglin } from '../huntBarter.js';
import { blastAt } from '../crystalBlast.js';
import { entityHealth } from '../mapMarks.js';
import { boxDistance, partBox } from '../dragonParts.js';
import { endDragonOf } from '../dragonState.js';

/**
 * use: the right hand on a block, a creature, or the air (design mb-llm-centric 2.3 and the owner's dragon list, 2026-10-21).
 *   - a bucket on a source of water or lava fills it (only a source: a flowing cell is said, with its level);
 *   - a water or lava bucket empties into the cell given (set against its first solid neighbour, or `against`);
 *   - flint and steel lights the cell given (a portal frame's inside, a block's top);
 *   - a bed sleeps (what stops it is the game's: not night, monsters near);
 *   - a door, gate, trapdoor, lever or button is worked;
 *   - an eye of ender in the air is thrown, and where it flew is measured (the exact line: the body's position, the horizontal unit vector, the bearing, how far;
 *     and how the eye ended); on an end portal frame it is set in, and
 *     the frames filled are counted;
 *   - seeds, bone meal and the like on the block given; a gold ingot on a piglin is one whole exchange (offer, wait, gather what comes back);
 *     anything else on a creature (`entity`), or in the air.
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

/**
 * The eye's flight, followed by the connection's own words (utils/huntEyeFlight): the eye that appears within three blocks of the body is
 * followed by entityMoved to entityGone (ten seconds at most), its horizontal direction is a unit vector and a bearing, and how it ended
 * (the item fell, or it shattered) is read from what the connection says next, not guessed from the pack. The body's exact position is
 * told with it: the line is that position and that vector, and where two lines cross is for whoever reads the two results (the head).
 */
async function throwEye(ctx: StepContext): Promise<StepOutcome> {
  const bot = ctx.bot;
  const from = feetCell(bot)!;
  const origin = bot.entity.position.clone();
  const watcher = watchEyeFlight(bot, { origin });
  try {
    bot.activateItem();
    const appeared = await guard(ctx, watcher.spawned, 2_200);
    try { bot.deactivateItem(); } catch { /* released */ }
    if (!appeared?.value) return stopped(bot, 'eye_not_thrown', 'エンダーアイは飛ばなかった（要塞の無い次元か、エンドポータルの枠を見ている）', from);
    const seen = await guard(ctx, watcher.flight, EYE_WATCH_MS + EYE_FATE_MS + 1_000);
    const flight = seen?.value ?? null;
    const kept = inventoryCount(bot, 'ender_eye');
    if (!flight) return { ok: true, at: from, text: `目玉を${cellText(from)}で投げたが、飛びを追えなかった。残り${kept}` };
    // The act's line is clipped at 160 characters: the direction and the end of the eye come first; the exact numbers are in `eye` (the result's structure).
    const cellOf = (p: { x: number; y: number; z: number }) => cellText({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
    const how = flight.fate === 'dropped' ? `落ちて残る${flight.drop ? `#${flight.drop.id}${cellOf(flight.drop.at)}` : ''}`
      : flight.fate === 'shattered' ? '割れた' : flight.gone ? '落ちたか割れたか不明' : `${Math.round(EYE_WATCH_MS / 1000)}秒見ても消えず`;
    const report = eyeReportOf(flight, from);
    if (!report) return { ok: true, at: from, text: `目玉を${cellText(from)}で投げた: 横に${flight.flat.toFixed(1)}しか動かず、要塞は真下かすぐ近く。${how}。残り${kept}` };
    if (report.down) {
      return { ok: true, at: from, data: { eye: report }, text: `目玉を${cellText(from)}で投げた: 横に${flight.flat.toFixed(1)}しか動かず${(-flight.rise).toFixed(1)}落ちた=要塞はほぼ真下（終点${cellOf(flight.end)}）。${how}。残り${kept}` };
    }
    return { ok: true, at: from, data: { eye: report }, text: `目玉を${cellText(from)}で投げた: 方位${report.bearingDeg.toFixed(2)}°${compassOf(report.bearingDeg)}・水平${report.flew.toFixed(1)}・上${report.rise.toFixed(1)}`
      + `・向き x${report.unit!.x.toFixed(3)} z${report.unit!.z.toFixed(3)}。${how}${report.arrived ? '。短い飛び=終点のx,zが要塞の起点' : ''}。残り${kept}` };
  } finally { watcher.cancel(); }
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

/** A bed's blast: power 5 at the bed's middle. */
const BED_POWER = 5;
/**
 * The blast is waited for this long after the click (the server blows it in the same tick), and its harm this long more (the health packet follows within a tick or two).
 * The act stops a body that lost 4 health or more a quarter of a second after (`damage_taken`), and at once when a floor reflex takes the body (the blast's fire sent the lava escape
 * about a tenth of a second after, lab 2026-11-02), so the hand answers before that, or the planner is told "hit" or "reflex" and not what the bed did (a bed blown 4.4 blocks off in the open
 * took 15 and the answer was "被弾: 体力 20 → 6"). The server sends the health in the tick of the blast or the next: a little over a tick.
 */
const BLAST_WAIT_MS = 1500;
const HARM_SETTLE_MS = 80;

/**
 * A bed right-clicked in the Nether or the End (the planner asked: a use hand at the bed's cell): it blows, power 5, fire, and is gone. Said in
 * numbers: whether it blew, how far the body was from its centre, the health the body lost, and the dragon's, when one is in sight (its head's
 * distance to the centre and its health before and after). Refused beforehand, with the numbers, when the blast would leave the body less than
 * its health (an estimate: distance, the part of the body in its sight, difficulty and armour; the shield, enchantments and resistance are not
 * counted). The click is `bot.activateBlock`, never a sleep (the body's evidence reads it as the bed it used).
 */
async function blowBed(ctx: StepContext, cell: Cell, block: any): Promise<StepOutcome> {
  const bot = ctx.bot;
  // The click on the foot is passed to the head (BedBlock): the blast is centred on the HEAD half whichever half was clicked. Both halves are gone when it blows: neither shuts the blast out.
  const halves = bedHalves(block, cell);
  const blastCell = halves?.head ?? cell;
  const centre = { x: blastCell.x + 0.5, y: blastCell.y + 0.5, z: blastCell.z + 0.5 };
  const guess = blastAt(bot, centre, bot.entity.position, BED_POWER, halves ? [halves.foot, halves.head] : []);
  if (!guess.safe) {
    return stopped(bot, 'blast_unsafe', `${placeText(bot, cell)} のベッドを使うと爆発（威力${BED_POWER}）が自分に当たる見込み: 中心まで ${guess.distance}m・見える割合 ${guess.seen}・素の被害 ${guess.raw}→防具後 ${guess.expected}`
      + `（体力 ${guess.health}。盾・エンチャント・耐性は数えない）。離れるか、間にブロックを置く`, cell);
  }
  const healthBefore = Number(bot.health ?? 20);
  const dragon = endDragonOf(bot);
  const dragonBefore = dragon ? entityHealth(bot, dragon) : null;
  let blast: { x: number; y: number; z: number } | null = null;
  const onBlast = (packet: any) => {
    const c = packet?.center ?? (typeof packet?.x === 'number' ? { x: packet.x, y: packet.y, z: packet.z } : null);
    if (c && Math.hypot(c.x - centre.x, c.y - centre.y, c.z - centre.z) <= 3) blast = { x: c.x, y: c.y, z: c.z };
  };
  /** What the bed did, as far as it has been seen now (the blast is told by the server's explosion packet, not by the bed being gone). */
  const account = () => {
    const gone = !isBedName(blockAt(bot, cell)?.name);
    const exploded = blast !== null;
    const at = blast ?? centre;
    const distance = Math.round(Math.hypot(bot.entity.position.x - at.x, bot.entity.position.y - at.y, bot.entity.position.z - at.z) * 10) / 10;
    const lost = Math.max(0, Math.round((healthBefore - Number(bot.health ?? healthBefore)) * 10) / 10);
    const live = dragon ? bot.entities?.[dragon.id] : null;
    const dragonAfter = live ? entityHealth(bot, live) : null;
    const toHead = live ? Math.round(boxDistance(at, partBox({ position: live.position, yaw: live.yaw }, 'head')) * 10) / 10 : null;
    const dragonText = live ? `。竜: 頭の箱まで爆発の中心から ${toHead}m・体力 ${dragonBefore ?? '?'}→${dragonAfter ?? '?'}` : '';
    const blew = `爆発した（威力${BED_POWER}）: 自分まで ${distance}m・見込み ${guess.expected}・失った体力 ${lost}（体力 ${healthBefore}→${Number(bot.health ?? healthBefore)}）${dragonText}`;
    return { gone, exploded, distance, lost, blew, data: { bed: { exploded, distance: exploded ? distance : null, damage: exploded ? lost : null } } };
  };
  try { bot._client?.on?.('explosion', onBlast); } catch { /* the packet is a help */ }
  try {
    await guard(ctx, Promise.resolve(bot.activateBlock(block)), 3000);
    await waitUntil(ctx, () => blast !== null || !isBedName(blockAt(bot, cell)?.name), BLAST_WAIT_MS, 25);
    await wait(ctx, HARM_SETTLE_MS);
  } catch (error) {
    if (error instanceof StepStopped || /Action interrupted/u.test(String((error as Error)?.message))) {
      // The act or a floor reflex ended the hand after the click (the blast's fire sent the lava escape within a tenth of a second, lab 2026-11-02): the act says the stop, and this says what the bed did.
      // HandCut is the act's own word for it; fight.ts imports this file, so it is loaded when it is needed.
      const cutAt = account();
      const { HandCut } = await import('./fight.js');
      throw new HandCut(error instanceof StepStopped ? error.why : String((error as Error).message), `ベッド ${cellText(cell)}: ${cutAt.exploded ? cutAt.blew : `爆発の知らせはまだ受けていない（今 ${cellNow(bot, cell)}）`}`);
    }
  } finally { try { bot._client?.removeListener?.('explosion', onBlast); } catch { /* gone */ } }
  const seen = account();
  // A bed that is merely gone (someone mined it, the cell is not loaded) is not a bed that blew: the server's blast is what says so.
  if (!seen.exploded) return { ...stopped(bot, 'not_exploded', `${placeText(bot, cell)} のベッドを右クリックしたが爆発の知らせは受けていない（今 ${cellNow(bot, cell)}${seen.gone ? '。ベッドは消えたが、爆発したかは分からない' : ''}）。次: ベッドの足と頭の両方のマスが揃っているか見て、置き直してからもう一度`, cell), data: seen.data };
  return { ok: true, at: cell, data: seen.data, text: `${cellText(cell)} のベッドが${seen.blew}` };
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
    // Gold to a piglin is an exchange, one whole: the offer, the six seconds of looking, and what comes back taken (utils/huntBarter).
    if (name === 'gold_ingot' && target.name === 'piglin') return barterWithPiglin(ctx, target);
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
  // A bed (r8: before any item is looked at; the bed is slept in with an empty hand). In the Nether and the End it cannot be slept in: the right click is a blast, and a use hand
  // at a bed there is the planner asking for it (the body never does it by itself).
  if (BEDS.test(block.name)) return /(^|:)(the_end|the_nether)$/u.test(String(bot.game?.dimension ?? '')) ? blowBed(ctx, cell, block) : sleepInBed(ctx, cell, block);
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

/** A creature at 0 health that the game still shows for its death (about a second): the registry names a health datum for its kind and it reads 0 or less. */
export function isDying(bot: any, entity: any): boolean {
  const keys: string[] | undefined = bot.registry?.entitiesByName?.[String(entity.name ?? '')]?.metadataKeys;
  if (!keys || keys.indexOf('health') < 0) return false;
  const health = entityHealth(bot, entity);
  return health !== null && health <= 0;
}

/** A creature by id ("123") or by name, the nearest within 16 m. */
export function findEntity(bot: any, spec: string | number, range = 16): any {
  const at = bot.entity?.position;
  if (!at) return null;
  const id = typeof spec === 'number' ? spec : /^\d+$/u.test(String(spec).trim()) ? Number(spec) : null;
  if (id !== null) return bot.entities?.[id] ?? null;
  const wanted = String(spec).trim().toLowerCase().replace(/^minecraft:/u, '');
  // A kind named by its name is not the one that is dying (a corpse that is still shown was taken for "the nearest blaze" again after its kill); one named by its id is whatever is there.
  return (Object.values(bot.entities ?? {}) as any[]).filter(entity => entity && entity !== bot.entity && entity.position
    && (String(entity.name ?? '').toLowerCase() === wanted || String(entity.username ?? '').toLowerCase() === wanted) && entity.position.distanceTo(at) <= range && !isDying(bot, entity))
    .sort((a, b) => a.position.distanceTo(at) - b.position.distanceTo(at))[0] ?? null;
}
