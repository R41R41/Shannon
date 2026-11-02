import { Vec3 } from 'vec3';
import { equipToHandVerified } from '../equipVerified.js';
import { entityHealth } from '../mapMarks.js';
import { type Cell } from '../localMap.js';
import { cellText, findItem, guard, inventoryCount, stopped, wait, type StepContext, type StepOutcome } from './common.js';
import { findEntity } from './use.js';
import { boxCentre, isPerched, partBox, phaseName } from '../dragonParts.js';
import { dragonPhaseOf } from '../dragonState.js';
import { bodyReader } from '../localMap.js';
import { CRYSTAL_REACH, CRYSTAL_SAFE_SHOT } from '../crystalBlast.js';

/**
 * shoot: a bow or a crossbow at a creature or a cell (the owner's dragon list, 2026-10-21). The aim allows for the arrow's fall (the
 * game's own drag and gravity, tick by tick) and leads a moving target by its measured speed and the flight's time. The draw is held
 * for the seconds asked (a bow is at full power from 1 s; a crossbow loads in 1.25 s). The answer says whether it hit (the target was
 * hurt in the flight's time) and how many arrows are left.
 */
export interface ShootArgs { target?: string | number; at?: Cell; charge?: number; weapon?: 'bow' | 'crossbow'; shots?: number }

const ARROWS = ['arrow', 'spectral_arrow', 'tipped_arrow'];
const EYE = 1.62;
const GRAVITY = 0.05;
const DRAG = 0.99;
const CROSSBOW_SPEED = 3.15;
const CROSSBOW_LOAD_MS = 1300;
/** A bow is held 21 ticks before it is let go (full power from 20: a tick over). */
export const BOW_FULL_DRAW_S = 1.05;
/** An end crystal is shot from this far at the most (the arrow's range in the End). */
export const CRYSTAL_SHOT_MAX = 64;

/** Where an arrow of `speed` aimed by yaw and pitch from `eyes` first meets a solid cell before it has flown `ticks` ticks, or null (the cell around `goal` is the target's own). */
export function arrowBlockedAt(bot: any, eyes: Vec3, yaw: number, pitch: number, speed: number, ticks: number, goal: Vec3): { x: number; y: number; z: number; name: string } | null {
  const read = bodyReader(bot);
  let vx = -Math.sin(yaw) * Math.cos(pitch) * speed, vy = Math.sin(pitch) * speed, vz = -Math.cos(yaw) * Math.cos(pitch) * speed;
  let x = eyes.x, y = eyes.y, z = eyes.z;
  for (let tick = 0; tick < ticks; tick++) {
    for (let sub = 1; sub <= 4; sub++) {
      const px = x + vx * sub / 4, py = y + vy * sub / 4, pz = z + vz * sub / 4;
      if (Math.hypot(px - goal.x, py - goal.y, pz - goal.z) <= 1.2) return null;
      const block = read(Math.floor(px), Math.floor(py), Math.floor(pz));
      if (block?.solid === true) return { x: Math.floor(px), y: Math.floor(py), z: Math.floor(pz), name: block.name };
    }
    x += vx; y += vy; z += vz; vx *= DRAG; vy = vy * DRAG - GRAVITY; vz *= DRAG;
  }
  return null;
}

/** The refusal for a crystal shot from where the body is: too near (its blast reaches 12), too far, or no line to it. Null when it can be shot. */
function crystalShotProblem(bot: any, crystal: any): StepOutcome | null {
  const eyes = bot.entity.position.offset(0, EYE - 0.1, 0);
  const distance = crystal.position.distanceTo(bot.entity.position);
  if (distance < CRYSTAL_SAFE_SHOT) return stopped(bot, 'too_close', `クリスタルまで ${distance.toFixed(1)}m。爆発は ${CRYSTAL_REACH}m まで届く: ${CRYSTAL_SAFE_SHOT}m 以上離れてから撃つ`);
  if (distance > CRYSTAL_SHOT_MAX) return stopped(bot, 'too_far', `クリスタルまで ${distance.toFixed(1)}m。矢は ${CRYSTAL_SHOT_MAX}m までしか狙えない`);
  const point = crystal.position.offset(0, 1, 0);
  const aim = aimPitch(bowSpeed(BOW_FULL_DRAW_S), Math.hypot(point.x - eyes.x, point.z - eyes.z), point.y - eyes.y);
  if (!aim) return stopped(bot, 'too_far', `クリスタルまで ${distance.toFixed(1)}m。弓の山なりでは届かない`);
  const yaw = Math.atan2(-(point.x - eyes.x), -(point.z - eyes.z));
  const hit = arrowBlockedAt(bot, eyes, yaw, aim.pitch, bowSpeed(BOW_FULL_DRAW_S), aim.ticks + 2, point);
  if (hit) return stopped(bot, 'line_blocked', `クリスタルへの矢の道が (${hit.x},${hit.y},${hit.z}) の ${hit.name} に塞がれる（距離 ${distance.toFixed(1)}m）。位置を変えるか、塞ぐ物を掘る`, { x: hit.x, y: hit.y, z: hit.z });
  return null;
}

/** A bow's arrow speed (blocks a tick) after a draw of `seconds` (the game: power = (f^2 + 2f) / 3, f the draw in seconds, at most 1). */
export function bowSpeed(seconds: number): number {
  const f = Math.max(0, seconds);
  return Math.min(1, (f * f + 2 * f) / 3) * 3;
}

/**
 * The pitch (radians, up positive) to send an arrow of `speed` to a point `horizontal` blocks away and `rise` blocks up, on the low
 * arc, and the ticks of its flight; null when it cannot reach. Simulated as the game moves an arrow: move, drag, gravity.
 */
export function aimPitch(speed: number, horizontal: number, rise: number): { pitch: number; ticks: number } | null {
  let best: { pitch: number; ticks: number; error: number } | null = null;
  for (let degrees = -70; degrees <= 70; degrees += 0.25) {
    const pitch = degrees * Math.PI / 180;
    let vx = Math.cos(pitch) * speed, vy = Math.sin(pitch) * speed, x = 0, y = 0;
    for (let tick = 1; tick <= 200; tick++) {
      x += vx; y += vy;
      vx *= DRAG; vy = vy * DRAG - GRAVITY;
      if (x >= horizontal) {
        const error = Math.abs(y - rise);
        if (!best || error < best.error - 1e-9) best = { pitch, ticks: tick, error };
        break;
      }
      if (y < rise - 64) break;
    }
    // The low arc: the first pitch that comes within a tenth of a block is kept.
    if (best && best.error < 0.1) break;
  }
  return best && best.error < 1.0 ? { pitch: best.pitch, ticks: best.ticks } : null;
}

/** The target's speed (blocks a tick) measured over a fifth of a second. */
async function measureVelocity(ctx: StepContext, entity: any): Promise<Vec3> {
  const from = entity.position.clone();
  await wait(ctx, 200);
  const to = ctx.bot.entities?.[entity.id]?.position ?? from;
  return to.minus(from).scaled(1 / 4);
}

export async function shoot(ctx: StepContext, args: ShootArgs): Promise<StepOutcome> {
  const bot = ctx.bot;
  const weaponName = args.weapon ?? (findItem(bot, 'bow') ? 'bow' : findItem(bot, 'crossbow') ? 'crossbow' : bot.heldItem?.name === 'crossbow' ? 'crossbow' : 'bow');
  const weapon = findItem(bot, weaponName) ?? (bot.heldItem?.name === weaponName ? bot.heldItem : null);
  if (!weapon) return stopped(bot, 'missing_item', `${weaponName} を持っていない`);
  const arrowsLeft = () => ARROWS.reduce((sum, name) => sum + inventoryCount(bot, name), 0);
  if (arrowsLeft() === 0 && bot.game?.gameMode !== 'creative') return stopped(bot, 'missing_item', '矢を持っていない');
  const target = args.target !== undefined ? findEntity(bot, args.target, 96) : null;
  if (args.target !== undefined && !target) return stopped(bot, 'target_not_found', `${args.target} が 96m 内にいない`);
  if (!target && !args.at) return stopped(bot, 'invalid_input', 'shoot には target か at が要る');
  if (bot.heldItem?.type !== weapon.type) {
    const held = await guard(ctx, equipToHandVerified(bot, weapon), 5000);
    if (!held?.value.held) return stopped(bot, 'equip_failed', `${weaponName} を手に持てなかった`);
  }
  const crossbow = weaponName === 'crossbow';
  const charge = crossbow ? CROSSBOW_LOAD_MS / 1000 : Math.max(0.2, Math.min(1.2, args.charge ?? BOW_FULL_DRAW_S));
  const speed = crossbow ? CROSSBOW_SPEED : bowSpeed(charge);
  const shots = Math.max(1, Math.min(8, Math.round(args.shots ?? 1)));
  const results: string[] = [];
  let hits = 0;
  // The End: a crystal is shot from beyond its blast and along a clear line; a perched dragon takes nothing from an arrow.
  if (target?.name === 'end_crystal') {
    const refusal = crystalShotProblem(bot, target);
    if (refusal) return refusal;
  }
  if (target?.name === 'ender_dragon') {
    const phase = dragonPhaseOf(bot, target);
    if (isPerched(phase)) return stopped(bot, 'perched_immune', `止まり木の竜（phase ${phase} ${phaseName(phase)}）に矢は効かない（飛んでいる間だけ。近接は attack）`);
  }
  for (let shot = 0; shot < shots; shot++) {
    const live = target ? bot.entities?.[target.id] : null;
    if (target && !live) { results.push('的が見えなくなった'); break; }
    /** The aim from where the body and the target are now: the fall allowed for, the target led by its speed over the flight. */
    const aimNow = async (): Promise<{ yaw: number; pitch: number; ticks: number; far: number } | null> => {
      const now = target ? bot.entities?.[target.id] : null;
      const velocity = now ? await measureVelocity(ctx, now) : new Vec3(0, 0, 0);
      const eyes = bot.entity.position.offset(0, EYE - 0.1, 0);
      const seen = target ? bot.entities?.[target.id] : null;
      if (target && !seen) return null;
      // The dragon is hit through its parts: the body's box (a 5 x 3 block at its feet), not the middle of its 16 x 8 one.
      const middle = seen?.name === 'ender_dragon' ? boxCentre(partBox({ position: seen.position, yaw: seen.yaw }, 'body')) : null;
      const base = middle ? new Vec3(middle.x, middle.y, middle.z) : seen ? seen.position.offset(0, (seen.height ?? 1.8) * 0.5, 0) : new Vec3(args.at!.x + 0.5, args.at!.y + 0.5, args.at!.z + 0.5);
      let point = base, aim: { pitch: number; ticks: number } | null = null;
      for (let round = 0; round < 3; round++) {
        aim = aimPitch(speed, Math.hypot(point.x - eyes.x, point.z - eyes.z), point.y - eyes.y);
        if (!aim) return { yaw: 0, pitch: 0, ticks: -1, far: Math.hypot(point.x - eyes.x, point.z - eyes.z) };
        point = base.plus(velocity.scaled(aim.ticks));
      }
      return { yaw: Math.atan2(-(point.x - eyes.x), -(point.z - eyes.z)), pitch: aim!.pitch, ticks: aim!.ticks, far: 0 };
    };
    let hurt = false;
    const onHurt = (entity: any) => { if (live && entity?.id === live.id) hurt = true; };
    // A crystal is not hurt: it breaks, and the client is told it is gone.
    const onGone = (entity: any) => { if (live && entity?.id === live.id && live.name === 'end_crystal') hurt = true; };
    const before = arrowsLeft();
    let aim: { yaw: number; pitch: number; ticks: number; far: number } | null = null;
    bot.on('entityHurt', onHurt); bot.on('entityGone', onGone);
    try {
      const first = await aimNow();
      if (first && first.ticks > 0) await guard(ctx, Promise.resolve(bot.look(first.yaw, first.pitch, true)), 1000);
      bot.activateItem();
      await wait(ctx, charge * 1000);
      if (crossbow) { bot.deactivateItem(); await wait(ctx, 100); }
      aim = await aimNow();
      if (!aim || aim.ticks < 0) { bot.deactivateItem(); }
      else {
        await guard(ctx, Promise.resolve(bot.look(aim.yaw, aim.pitch, true)), 1000);
        if (crossbow) { bot.activateItem(); await wait(ctx, 50); }
        bot.deactivateItem();
        await wait(ctx, aim.ticks * 50 + 500);
      }
    } finally { bot.removeListener('entityHurt', onHurt); bot.removeListener('entityGone', onGone); }
    if (!aim) { results.push('的が見えなくなった'); break; }
    if (aim.ticks < 0) { results.push(`${live ? `${live.name}` : cellText(args.at!)} は遠すぎて届かない（${aim.far.toFixed(0)}m）`); break; }
    if (hurt) hits++;
    const health = live && bot.entities?.[live.id] ? entityHealth(bot, bot.entities[live.id]) : null;
    results.push(`${shot + 1}発目: ${live ? (live.name === 'end_crystal' ? (hurt ? 'クリスタルを壊した（爆発した）' : '外れた（クリスタルは残っている）') : hurt ? `当たった${health !== null ? `（残り体力 ${health}）` : ''}` : '外れた') : `${cellText(args.at!)} へ射った`}（飛ぶ時間 ${(aim.ticks / 20).toFixed(1)}秒、仰角 ${(aim.pitch * 180 / Math.PI).toFixed(1)}°${before === arrowsLeft() ? '、矢が減っていない' : ''}）`);
  }
  return { ok: true, data: { arrowsLeft: arrowsLeft() }, text: `${weaponName}で射った: ${results.join('、')}。当たり ${hits}/${results.length}、矢の残り ${arrowsLeft()}` };
}
