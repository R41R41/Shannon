import { Vec3 } from 'vec3';
import { createLogger } from '../../../utils/logger.js';
import { BALL_NAME, advance, type BallTrack } from './fireballDeflect.js';
import { installToldVelocity, toldVelocity } from './toldVelocity.js';
import { answerWith } from './reflexAnswers.js';
import { isEngaged } from './engagement.js';
import { isLikelyHostileMobName } from './hostileMobHints.js';

const log = createLogger('Minebot:ShieldBlock');

/**
 * Raising the shield at what is flying at the body.
 *
 * Most of what has killed the body from afar was shot at it: a skeleton's arrows (paid runs L77c to L77g, and
 * the overworld's nights before them), a blaze's fireballs (L77j, L77k, L77l). A shield stops all of these
 * whole, and the body that carried one never raised it: blocking was a tool call for the planner, and an arrow
 * is in the air for half a second. Like the ghast's ball, this is no plan, it is a reflex.
 *
 * Each tick the things in flight are followed. The server speaks of a projectile when it is shot (where, and
 * how fast) and then seldom, so from its last word each is carried forward here by the game's own rule for its
 * kind: an arrow keeps 99% of its speed and falls a twentieth of a block a tick; a fireball gains a tenth along
 * its path and keeps 95%. One that will pass within reach of the body is met: the look goes to it (a shield
 * stops what comes from in front), the body stops walking so that the look does not carry it off, and the
 * shield is raised. The server counts a shield as up five ticks after it is raised, so it goes up as soon as
 * the shot is seen to be coming, and comes down a few ticks after the last one has passed.
 *
 * Only with a shield in the off hand (the body puts one it carries there itself, see auto-wear-armor). A
 * ghast's ball is left to the reflex that strikes it back, while that one is on.
 *
 * And in a fight the planner chose, between the body's own blows: a hostile within a blow's reach is met with
 * the shield up, and the shield comes down for the tick the body strikes (the server refuses a blow from
 * behind a raised shield). Two wither skeletons took an iron-clad body from full health to dead in sixteen
 * seconds while its shield hung on its arm (lab). Not outside such a fight: a raised shield slows the body to
 * a crawl, and one running away needs its legs.
 */
/** Ticks ahead a shot is followed. A skeleton's arrow from sixteen blocks takes ten. */
const LOOK_AHEAD_TICKS = 24;
/** How near the body's middle a shot has to pass to be taken as coming at it. */
const HIT_DISTANCE = 1.6;
/**
 * How long before a shot arrives the shield goes up. The server counts it as up after five ticks; the rest is
 * margin. Not sooner: while it is up the look and the legs are the shield's, and a slow fireball seen a second
 * and more ahead held a body that was digging itself a shelter (lab continuation L77r).
 */
const RAISE_AHEAD_TICKS = 12;
/** Ticks the shield stays up after nothing more is coming (a blaze shoots three in a second). */
const HOLD_TICKS = 6;
const BODY_MIDDLE = 0.9;
const HORIZONTAL = ['forward', 'back', 'left', 'right', 'sprint'] as const;
/** Things in flight that are no attack: what the body throws, and what only looks like a shot. */
/** How near a hostile has to stand for the shield to be kept up between blows. */
const GUARD_DISTANCE = 4;
const HARMLESS = new Set(['ender_pearl', 'eye_of_ender', 'experience_bottle', 'egg', 'snowball', 'fishing_bobber', 'firework_rocket', 'splash_potion', 'lingering_potion']);

/** A shot one tick on, by the game's rule for its kind. */
export function flyOn(kind: string, shot: BallTrack): BallTrack {
  if (kind.includes('fireball') || kind === 'wither_skull') return advance(shot);
  const position = shot.position.plus(shot.velocity);
  return { position, velocity: new Vec3(shot.velocity.x * 0.99, shot.velocity.y * 0.99 - 0.05, shot.velocity.z * 0.99) };
}

/** Whether a shot will pass through the body, and in how many ticks. */
export function impact(body: Vec3, kind: string, shot: BallTrack): { ticks: number; distance: number } | null {
  const middle = body.offset(0, BODY_MIDDLE, 0);
  let track = shot, nearest = Infinity, at = 0;
  for (let tick = 0; tick <= LOOK_AHEAD_TICKS; tick++) {
    // Between two ticks the shot covers a block or more: the nearest point of that step, not only its ends.
    const step = track.velocity, to = middle.minus(track.position);
    const along = step.norm() > 0.001 ? Math.max(0, Math.min(1, to.dot(step) / step.dot(step))) : 0;
    const distance = track.position.plus(step.scaled(along)).distanceTo(middle);
    if (distance < nearest) { nearest = distance; at = tick + along; }
    if (distance > nearest + 3) break;
    track = flyOn(kind, track);
  }
  return nearest <= HIT_DISTANCE ? { ticks: at, distance: nearest } : null;
}

/** The kind of mob standing where a shot began (a shot leaves from its shooter), or null when nothing stood there. */
export function shooterAt(bot: Pick<ShieldBot, 'entities' | 'entity'>, origin: Vec3, shotId: number): string | null {
  let nearest: string | null = null, nearestDistance = 6;
  for (const entity of Object.values(bot.entities ?? {})) {
    if (!entity?.position || !entity.name || entity.id === shotId || entity.id === bot.entity?.id) continue;
    if (['projectile', 'object', 'orb', 'other', 'global'].includes(String(entity.type))) continue;
    const distance = entity.position.offset(0, (entity.height ?? 1.8) / 2, 0).distanceTo(origin);
    if (distance < nearestDistance) { nearest = String(entity.name).toLowerCase(); nearestDistance = distance; }
  }
  return nearest;
}

/** Whether something hostile stands within a blow's reach of the body. */
function hostileInReach(bot: ShieldBot): boolean {
  const at = bot.entity?.position;
  if (!at) return false;
  for (const entity of Object.values(bot.entities ?? {})) {
    if (!entity?.position || entity.id === bot.entity?.id || entity.type === 'projectile') continue;
    if (entity.type !== 'hostile' && !isLikelyHostileMobName(String(entity.name ?? '').toLowerCase())) continue;
    if (entity.position.distanceTo(at) <= GUARD_DISTANCE) return true;
  }
  return false;
}

interface ShieldBot {
  entity?: { id?: number; position: Vec3 };
  entities?: Record<string, any>;
  health?: number;
  inventory?: { slots: Array<{ name: string } | null | undefined> };
  getEquipmentDestSlot?(destination: string): number;
  look?(yaw: number, pitch: number, force?: boolean): unknown;
  attack?(...args: unknown[]): unknown;
  activateItem?(offHand?: boolean): unknown;
  deactivateItem?(): unknown;
  getControlState?(control: string): boolean;
  setControlState?(control: string, state: boolean): void;
  on?(event: string, listener: (...args: any[]) => void): unknown;
  usingHeldItem?: boolean;
  fireballDeflect?: { enabled: boolean };
  shieldBlock?: ShieldBlockState;
}
/** `raised` counts the times the shield went up; `upTicks` the ticks it was held. */
export interface ShieldBlockState { enabled: boolean; guard: boolean; raised: number; guards: number; upTicks: number; up: boolean; last?: string }

export function installShieldBlock(bot: ShieldBot): void {
  if (bot.shieldBlock || typeof bot.on !== 'function') return;
  const state: ShieldBlockState = bot.shieldBlock = { enabled: true, guard: true, raised: 0, guards: 0, upTicks: 0, up: false };
  // The body's own blow goes out from behind a lowered shield: down for the blow, up again on the next tick.
  if (typeof bot.attack === 'function') {
    const strike = bot.attack.bind(bot);
    bot.attack = (...args: unknown[]) => { if (state.up) { state.up = false; try { bot.deactivateItem?.(); } catch { /* nothing held */ } } return strike(...args); };
  }
  installToldVelocity(bot as any);
  // Said to the threat watch: with a shield on the arm, a kind that has hit the body with shots is answered here.
  answerWith(bot, kind => state.enabled && bot.inventory?.slots?.[bot.getEquipmentDestSlot?.('off-hand') ?? 45]?.name === 'shield'
    && (bot as any).shootsAtBody?.(kind) === true);
  const seen = new Map<number, { said: Vec3; saidTick: number; velocity: Vec3; shooterNoted?: boolean }>();
  let tick = 0, lastComing = -Infinity;
  const lower = () => { if (state.up) { state.up = false; try { bot.deactivateItem?.(); } catch { /* nothing held */ } } };
  bot.on('physicsTick', () => {
    tick++;
    try {
      if (!state.enabled || !bot.entity || (bot.health ?? 20) <= 0) { lower(); return; }
      const shielded = bot.inventory?.slots?.[bot.getEquipmentDestSlot?.('off-hand') ?? 45]?.name === 'shield';
      let soonest: { entity: any; ticks: number; position: Vec3 } | null = null;
      const alive = new Set<number>();
      for (const entity of Object.values(bot.entities ?? {})) {
        if (!entity?.position || entity.type !== 'projectile') continue;
        const kind = String(entity.name ?? '');
        if (HARMLESS.has(kind) || (kind === BALL_NAME && bot.fireballDeflect?.enabled)) continue;
        alive.add(entity.id);
        let record = seen.get(entity.id);
        if (!record || !record.said.equals(entity.position)) {
          // A new word from the server: the speed it sent with it, or, when it sent none, what the shot covered since its last word.
          const told: Vec3 | undefined = toldVelocity(bot as any, entity.id) ?? entity.velocity;
          let velocity = told && told.norm() > 0.05 ? told.clone() : record && tick > record.saidTick
            ? entity.position.minus(record.said).scaled(1 / (tick - record.saidTick)) : new Vec3(0, 0, 0);
          if (velocity.norm() <= 0.05 && record) velocity = record.velocity;
          record = { said: entity.position.clone(), saidTick: tick, velocity, shooterNoted: record?.shooterNoted };
          seen.set(entity.id, record);
        }
        if (record.velocity.norm() <= 0.05) continue;                    // stuck in the ground, or not yet moving
        let track: BallTrack = { position: record.said, velocity: record.velocity };
        for (let step = record.saidTick; step < tick; step++) track = flyOn(kind, track);
        const coming = impact(bot.entity.position, kind, track);
        if (!coming) continue;
        // Who shot it is learned here, shield or no shield: the kind that stood where the shot began.
        if (!record.shooterNoted) {
          record.shooterNoted = true;
          const shooter = shooterAt(bot, record.said, entity.id);
          if (shooter) (bot as any).shotAtBy?.(shooter);
        }
        if (!soonest || coming.ticks < soonest.ticks) soonest = { entity, ticks: coming.ticks, position: track.position };
      }
      for (const id of seen.keys()) if (!alive.has(id)) seen.delete(id);
      if (!shielded) { lower(); return; }
      if (soonest && soonest.ticks > RAISE_AHEAD_TICKS && !state.up) soonest = null;      // coming, but not yet
      if (soonest) lastComing = tick;
      if (tick - lastComing > HOLD_TICKS) {
        // Nothing in flight. In a fight of the planner's choosing, the shield is kept up against whoever is in
        // reach of a blow; the look and the legs are the fight's own.
        if (state.guard && isEngaged(bot) && hostileInReach(bot)) {
          if (!state.up && !bot.usingHeldItem) { state.up = true; state.guards++; bot.activateItem?.(true); }
          if (state.up) state.upTicks++;
        } else lower();
        return;
      }
      // Something is coming, or has only just passed: the shield is up and turned to it.
      if (soonest) {
        const eyes = bot.entity.position.offset(0, 1.62, 0);
        const dx = soonest.position.x - eyes.x, dy = soonest.position.y - eyes.y, dz = soonest.position.z - eyes.z;
        bot.look?.(Math.atan2(-dx, -dz), Math.atan2(dy, Math.hypot(dx, dz)), true);
      }
      for (const control of HORIZONTAL) if (bot.getControlState?.(control)) bot.setControlState?.(control, false);
      // Eating or drawing a bow with the other hand is left to finish; the shield goes up after it.
      if (!state.up && !bot.usingHeldItem) {
        state.up = true;
        state.raised++;
        state.last = soonest ? `${soonest.entity.name} in ${soonest.ticks.toFixed(0)} ticks` : state.last;
        bot.activateItem?.(true);
        log.info(`🛡 盾を構える（${soonest?.entity?.name ?? '飛来物'}、約${soonest ? soonest.ticks.toFixed(0) : '?'}tick後。累計${state.raised}回）`);
      }
      if (state.up) state.upTicks++;
    } catch { /* a reflex never breaks the tick */ }
  });
}

/** Loaded after the reflex that strikes a ghast's ball back, so that for that ball the blow is what stands. */
export function shieldBlockPlugin(bot: unknown): void { installShieldBlock(bot as ShieldBot); }
