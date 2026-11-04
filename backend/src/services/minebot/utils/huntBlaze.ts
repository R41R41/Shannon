import { Vec3 } from 'vec3';
import { flyOn, impact } from './shieldBlock.js';
import { toldVelocity } from './toldVelocity.js';
import { seesBodyAt } from './threatExposure.js';

/**
 * Standing at a blaze spawner and striking what comes within reach (S2, 2026-11-02).
 *
 * The shape follows aibengineering/mine-ai-mcp (MIT: src/actions/hunt-mob/spawner-camp.ts and src/survival/combat/fight/melee-turn.ts): the body
 * stays within three blocks of the spawner with the shield on its left arm; a blaze that hovers more than a sword's reach above the eye is not
 * followed (its hover height is drawn again every five seconds, and it comes down by itself), the body waits for it under the shield; what is
 * within reach and in sight is struck. This file holds the readings that hand and the fight hand share; nothing here moves the body or
 * holds a key.
 *
 * What the Nether taught on the way (paid runs 26, 29, 31; the L77 lab): a blaze shoots three small fireballs six ticks apart after it has
 * been charged for about three seconds, then rests five seconds; a blow of the body's own is struck from behind the raised shield (the server does not refuse it: lab, 2026-11-03; it was believed to, and the shield
 * was lowered for each blow, which counts as up again only five ticks after it is raised: the one moment a fireball could land, 5 points and the fire). Each fireball the shield stops wears it by six points of its 336: six blazes shoot about 13 points a
 * second, which is a shield in 25 seconds. So a blow is struck when no shot is on its way and no blaze that sees the body has been charged long
 * enough to be about to shoot; when the body is hit for it anyway, the wait is bounded (a fight with nothing struck is no safer).
 */

/** Fliers that hover where they stand off and shoot, and are not followed: their height is theirs, and a body that follows one walks off the floor. */
export const HOVERING_SHOOTERS: ReadonlySet<string> = new Set(['blaze']);
/** A blow reaches 3 blocks from the eye to the creature's box. */
export const BLOW_REACH = 3.0;
/** A blaze charged for this long (ms) is about to shoot: the charge lasts 60 ticks, 3 s, and the first fireball goes at its end. */
export const CHARGE_WARN_MS = 2_200;
/** A shot on its way that will land within this many ticks holds a blow back. */
export const SHOT_HOLD_TICKS = 10;
/** The blows held back by these wait at most this long in all within one GATE_WINDOW_MS, and then go (a body that never strikes is no safer than one that does). */
export const GATE_PATIENCE_MS = 1_500;
export const GATE_WINDOW_MS = 8_000;
/** Blazes shoot from this far (their follow range). */
export const SHOOTER_RANGE = 48;

interface BlazeBody {
  entity?: { position: Vec3 };
  entities?: Record<string, any>;
  registry?: { entitiesByName?: Record<string, { metadataKeys?: string[] } | undefined> } | null;
  blockAt?(position: Vec3, extraInfos?: boolean): any;
  toldVelocities?: Map<number, Vec3>;
  _client?: { on(event: string, listener: (packet: any) => void): unknown };
  on?(event: string, listener: (...args: any[]) => void): unknown;
}

/** Whether a blaze is charged (the first bit of its `flags` data: the flame it winds up before its shots), or null when the game's data does not say. */
export function blazeCharged(registry: BlazeBody['registry'], entity: any): boolean | null {
  const keys = registry?.entitiesByName?.blaze?.metadataKeys;
  const index = keys ? keys.indexOf('flags') : -1;
  if (index < 0 || !Array.isArray(entity?.metadata)) return null;
  const flags = entity.metadata[index];
  return typeof flags === 'number' ? (flags & 1) !== 0 : null;
}

/** Whether a creature hovers beyond the reach of a blow from the body's level: the lowest point of its box is more than `reach` above the eye (up 3 or more: not followed). */
export function hoversAboveReach(body: Vec3, entity: any, reach = BLOW_REACH): boolean {
  if (!entity?.position) return false;
  return entity.position.y - (body.y + 1.62) > reach;
}

/**
 * The ticks until the soonest shot in the air lands on the body, within `horizon` ticks; null when none will. The reflex's own prediction
 * (utils/shieldBlock: the game's rule for the kind, carried forward from the last word the server said of the shot) over what is in the air now.
 */
export function nextShotTicks(bot: BlazeBody, horizon = 14): number | null {
  const at = bot.entity?.position;
  if (!at) return null;
  let soonest: number | null = null;
  for (const entity of Object.values(bot.entities ?? {})) {
    if (!entity?.position || entity.type !== 'projectile') continue;
    const kind = String(entity.name ?? '');
    if (['ender_pearl', 'eye_of_ender', 'experience_bottle', 'egg', 'snowball', 'fishing_bobber', 'firework_rocket', 'splash_potion', 'lingering_potion'].includes(kind)) continue;
    const told: Vec3 | undefined = toldVelocity(bot as never, entity.id) ?? entity.velocity;
    if (!told || told.norm() <= 0.05) continue;
    const coming = impact(at, kind, { position: entity.position.clone(), velocity: told.clone() });
    if (coming && coming.ticks <= horizon && (soonest === null || coming.ticks < soonest)) soonest = coming.ticks;
  }
  return soonest;
}

/** A blaze that is winding up its shots and sees the body. */
export interface ChargedShooter { entity: any; ms: number }

/**
 * The blazes charged now, how long each has been (from the first time this watch saw the flame), and whether the body is in their sight. The watch is
 * the hand's own, for the length of the hand; a blaze is forgotten when its flame is out.
 */
export class ShooterWatch {
  private since = new Map<number, number>();
  constructor(private readonly bot: BlazeBody) {}

  /** Blazes within range that see the body at `feet` (any state). */
  seeing(feet: Vec3 = this.bot.entity!.position): any[] {
    const out: any[] = [];
    for (const entity of Object.values(this.bot.entities ?? {})) {
      if (!entity?.position || entity.name !== 'blaze' || entity.isValid === false) continue;
      if (entity.position.distanceTo(feet) > SHOOTER_RANGE) continue;
      try { if (seesBodyAt(this.bot as never, entity, feet)) out.push(entity); } catch { /* unseen */ }
    }
    return out;
  }

  /** The charged blazes that see the body, the longest charged first. */
  charged(now = Date.now()): ChargedShooter[] {
    const live = new Set<number>();
    const out: ChargedShooter[] = [];
    for (const entity of this.seeing()) {
      const flame = blazeCharged(this.bot.registry, entity);
      if (flame !== true) { this.since.delete(entity.id); continue; }
      live.add(entity.id);
      if (!this.since.has(entity.id)) this.since.set(entity.id, now);
      out.push({ entity, ms: now - this.since.get(entity.id)! });
    }
    for (const id of [...this.since.keys()]) if (!live.has(id)) this.since.delete(id);
    return out.sort((a, b) => b.ms - a.ms);
  }
}

/** Why a blow is held back now, or null when it may go: a shot lands within SHOT_HOLD_TICKS, or a blaze that sees the body has been charged long enough to shoot at any moment. */
export function strikeHold(bot: BlazeBody, watch: ShooterWatch, now = Date.now()): string | null {
  const shot = nextShotTicks(bot, SHOT_HOLD_TICKS);
  if (shot !== null) return `火の玉が ${Math.max(0, Math.round(shot))} tick 後に当たる`;
  const winding = watch.charged(now).find(item => item.ms >= CHARGE_WARN_MS);
  if (winding) return `blaze #${winding.entity.id} が ${(winding.ms / 1000).toFixed(1)} 秒溜めていて撃つ直前`;
  return null;
}

/** Why a blow is held back while any blaze that sees the body has its flame on (it is charging: its shots come within three seconds), or null: the shield is the only thing that is up then. */
export function chargeHold(watch: ShooterWatch, now = Date.now()): string | null {
  const charging = watch.charged(now)[0];
  return charging ? `blaze #${charging.entity.id} が ${(charging.ms / 1000).toFixed(1)} 秒溜めている（盾だけ構える）` : null;
}

/**
 * Holds a blow back while `strikeHold` says why, but only for GATE_PATIENCE_MS in all within each GATE_WINDOW_MS: a blaze that stays charged (or fireballs that never stop) would
 * otherwise defer every blow by the whole patience. Once the window's patience is used the blows go, until the window is over.
 */
export class StrikeGate {
  /** The holds begun (a hold is one stretch of waiting for a shot). */
  count = 0;
  private spent = 0;
  private windowAt = 0;
  private last = 0;
  private holding = false;

  /** True when the blow may go now; `why` is `strikeHold`'s answer. */
  may(now: number, why: string | null): boolean {
    if (now - this.windowAt > GATE_WINDOW_MS) { this.windowAt = now; this.spent = 0; }
    const dt = this.holding && this.last ? now - this.last : 0;
    this.last = now;
    if (!why) { this.holding = false; return true; }
    this.spent += dt;
    if (this.spent >= GATE_PATIENCE_MS) { this.holding = false; return true; }
    if (!this.holding) { this.holding = true; this.count++; }
    return false;
  }
}

/** Readings for shield_rush only. Unknown phases never become safe merely because time passed. */
export class RushShooterWatch {
  readonly shooters = new Map<number, { entity: any; flame: boolean | null; restUntil: number; missing: boolean; shots: number }>();
  private balls = new Map<number, { entity: any; said: Vec3; position: Vec3; velocity: Vec3; tick: number }>();
  private tick = 0;
  constructor(private readonly bot: BlazeBody, private readonly dead: (id: number, entity: any) => boolean = () => false) {}

  update(now: number): void {
    this.tick++;
    const loaded = new Set<number>();
    for (const e of Object.values(this.bot.entities ?? {}) as any[]) {
      if (e?.name !== 'blaze' || !e.position || e.isValid === false || this.dead(e.id, e)) continue;
      loaded.add(e.id);
      const flame = blazeCharged(this.bot.registry, e), row = this.shooters.get(e.id);
      // Even out of sight the metadata edges are retained; after an unload a true flame has unknown age.
      if (!row) this.shooters.set(e.id, { entity: e, flame, restUntil: 0, missing: false, shots: 0 });
      else {
        if (row.flame === true && flame === false && !row.missing) row.restUntil = now + 4500;
        // Missing is reset below using the previous tick's presence, not the view's line of sight.
        row.entity = e; row.flame = flame; row.missing = false;
        if (flame !== false) row.restUntil = 0;
      }
    }
    for (const [id, row] of this.shooters) if (!loaded.has(id)) { row.missing = true; row.restUntil = 0; }
    const live = new Set<number>();
    for (const e of Object.values(this.bot.entities ?? {}) as any[]) {
      if (!e?.position || !(e.type === 'projectile' || String(e.name).includes('fireball'))) continue;
      if (!['small_fireball', 'fireball', 'arrow', 'spectral_arrow', 'wither_skull', 'dragon_fireball'].includes(String(e.name))) continue;
      live.add(e.id);
      const old = this.balls.get(e.id);
      if (!old || !old.said.equals(e.position)) {
        const told = toldVelocity(this.bot, e.id) ?? e.velocity;
        const velocity = told?.norm() > 0.05 ? told.clone() : old && this.tick > old.tick
          ? e.position.minus(old.said).scaled(1 / (this.tick - old.tick)) : new Vec3(0, 0, 0);
        this.balls.set(e.id, { entity: e, said: e.position.clone(), position: e.position.clone(), velocity, tick: this.tick });
        if (!old && e.name === 'small_fireball') {
          const owner = [...this.shooters.values()].filter(r => r.entity.position.distanceTo(e.position) < 3)
            .sort((a, b) => a.entity.position.distanceTo(e.position) - b.entity.position.distanceTo(e.position))[0];
          if (owner) owner.shots++;
        }
      } else {
        const next = flyOn(String(e.name), { position: old.position, velocity: old.velocity });
        old.position = next.position; old.velocity = next.velocity;
      }
    }
    // An unloaded ball is still carried to the prediction horizon, never erased into an immediate window.
    for (const [id, b] of this.balls) if (!live.has(id)) {
      if (this.tick - b.tick > 24) this.balls.delete(id);
      else { const next = flyOn(String(b.entity.name), b); b.position = next.position; b.velocity = next.velocity; }
    }
  }
  seeing(feet = this.bot.entity!.position): any[] {
    return [...this.shooters.values()].filter(r => !r.missing && r.entity.position.distanceTo(feet) <= 32
      && seesBodyAt(this.bot as never, r.entity, feet)).map(r => r.entity);
  }
  incoming(feet = this.bot.entity!.position): Array<{ entity: any; position: Vec3; ticks: number }> {
    return [...this.balls.values()].flatMap(b => {
      const hit = b.velocity.norm() > 0.05 ? impact(feet, String(b.entity.name), b) : { ticks: 0 };
      return hit ? [{ entity: b.entity, position: b.position, ticks: hit.ticks }] : [];
    }).sort((a, b) => a.ticks - b.ticks);
  }
  mayClose(feet: Vec3, now: number): boolean {
    return !this.incoming(feet).length && this.seeing(feet).every(e => {
      const r = this.shooters.get(e.id)!;
      return r.flame === false && now < r.restUntil;
    });
  }
}
