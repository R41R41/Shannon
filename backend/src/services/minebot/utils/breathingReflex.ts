import { Vec3 } from 'vec3';
import { actionLeaseStatus, activeActionCapabilities, hasActiveSafetyLease, nativeActionHost } from '../execution/ActionExecution.js';
import { ceilingOverhead } from '../constantSkills/autoSwim.js';
import { createLogger } from '../../../utils/logger.js';
import { holdsWater } from './waterBlocks.js';
import { bodyPose, eyeHeight } from './bodyPose.js';
import { cachedRouteToAir } from './airRoute.js';

const log = createLogger('Minebot:BreathingReflex');

/** Air at or below which an unattended body kicks for the surface itself, however shallow. */
export const REFLEX_ENGAGE_OXYGEN = 5;
const REFLEX_RELEASE_OXYGEN = 12;
const UNATTENDED_MS = 500;
/** One unit of air lasts 15 ticks; holding jump rises about a block per 0.4s (measured: 10 blocks in 3.7s). */
const AIR_SECONDS_PER_UNIT = 0.75;
const RISE_SECONDS_PER_BLOCK = 0.4;
const SURFACING_MARGIN_SECONDS = 2;

/** Seconds of swimming straight up before the head clears the water (Infinity under a solid block). */
export function secondsToSurface(bot: Pick<ReflexBot, 'entity' | 'blockAt'>, maxRise = 24): number {
  const position = bot.entity?.position;
  if (!position) return Infinity;
  const head = new Vec3(Math.floor(position.x), Math.floor(position.y + eyeHeight(bot)), Math.floor(position.z));
  for (let rise = 0; rise <= maxRise; rise++) {
    const block = bot.blockAt(head.offset(0, rise, 0));
    if (!block) return Infinity;
    if (block.boundingBox === 'block') return Infinity;
    if (!holdsWater(block)) return rise * RISE_SECONDS_PER_BLOCK;
  }
  return Infinity;
}

/** How much ceiling the body will break through for air, and the margin kept on any way that is not straight up. */
const CEILING_MAX_BLOCKS = 3;
const CEILING_MARGIN_SECONDS = 3;
const UNMEASURED_DIG_SECONDS = 5;

function headCell(bot: Pick<ReflexBot, 'entity' | 'blockAt'>): Vec3 {
  const position = bot.entity!.position;
  return new Vec3(Math.floor(position.x), Math.floor(position.y + eyeHeight(bot)), Math.floor(position.z));
}

/**
 * Seconds to break straight up to air: the dig of each solid block overhead
 * with the tool in hand, as slow as it is for a body afloat under water, and
 * the rise through any water between. Infinity when something overhead cannot
 * be dug or the ceiling is thicker than a body breaks through on one breath.
 */
export function secondsToBreakOut(bot: Pick<ReflexBot, 'entity' | 'blockAt' | 'digTime'>, maxRise = 12): number {
  if (!bot.entity?.position) return Infinity;
  const head = headCell(bot);
  let seconds = 0, solid = 0;
  for (let rise = 0; rise <= maxRise; rise++) {
    const block = bot.blockAt(head.offset(0, rise, 0));
    if (!block) return Infinity;
    if (block.boundingBox === 'block') {
      if (block.diggable === false || ++solid > CEILING_MAX_BLOCKS) return Infinity;
      let dig = UNMEASURED_DIG_SECONDS;
      try { const measured = bot.digTime?.(block); if (typeof measured === 'number' && Number.isFinite(measured)) dig = measured / 1000; } catch { /* keep the default */ }
      seconds += dig;
    } else if (holdsWater(block)) seconds += RISE_SECONDS_PER_BLOCK;
    else return seconds;
  }
  return Infinity;
}

/** Seconds to swim to air under a ceiling: back along the trail, or sideways to open water in reach. Infinity when neither is known. */
export function secondsToSwimOut(bot: ReflexBot): number {
  if (!bot.entity?.position) return Infinity;
  let best = Infinity;
  const metres = retraceMetres(bot);
  if (metres !== null) best = metres / RETRACE_METRES_PER_SECOND;
  const route = swimRouteToAir(bot);
  if (route) best = Math.min(best, route.length / RETRACE_METRES_PER_SECOND);
  return best;
}

/** Whether a route to air exists that the air left (and a part of the health after it) covers. */
export function swimRouteFeasible(bot: ReflexBot, now = Date.now()): boolean {
  const route = swimRouteToAir(bot, now);
  return route !== null
    && route.length / RETRACE_METRES_PER_SECOND <= Math.max(0, bot.oxygenLevel ?? 20) * AIR_SECONDS_PER_UNIT + RETRACE_HEALTH_RESERVE_SECONDS;
}

/** The cells to swim through to a place the body can breathe (see routeToAir), or null. */
export function swimRouteToAir(bot: ReflexBot, now = Date.now()): Vec3[] | null {
  const position = bot.entity?.position;
  if (!position) return null;
  return cachedRouteToAir(bot as any, position, now);
}

/**
 * Controls that take the body to the next cell of a route to air. A step up or
 * down is taken from under the middle of the column (a shoulder catches on a
 * rim); a step sideways keeps the body at the level of the cell it enters.
 */
export function steerAlongRoute(bot: ReflexBot, route: Vec3[]): void {
  const position = bot.entity!.position;
  const next = route[0];
  if (!next) { centreInColumn(bot); setJump(bot, true); return; }
  if (Math.floor(next.x) === Math.floor(position.x) && Math.floor(next.z) === Math.floor(position.z)) {
    centreInColumn(bot);
    setJump(bot, next.y > position.y - 0.3);
    bot.setControlState('sneak', next.y < position.y - 0.8);
    return;
  }
  // A step sideways is taken once the body is at a level it goes through at. The route is counted in cells,
  // the feet's and the one above; a body 1.8 high that floats 0.8 above the floor of its cell reaches into a
  // third. Under a shelf one cell lower than the roof it floated against, a body was steered sideways as soon
  // as its feet were counted in the lower cell, struck the shelf with its head, was thrown up by the water
  // (a body pressed against a bank in water is lifted, to climb out), and began again, for the twenty
  // seconds it had: the air was six cells away (paid run L66 drowned).
  if (!fitsColumnAt(bot, next, position.y)) {
    const above = position.y > next.y;
    centreInColumn(bot);
    setJump(bot, !above);
    bot.setControlState('sneak', above);
    return;
  }
  // Rising while it goes would take it out of the level it fits at. The jump key is set once, to what is
  // wanted: pressed and let go in the same tick it still counts as a press (the client queues it), and that
  // one kick upward put the body back against the shelf each time.
  bot.look?.(Math.atan2(-(next.x - position.x), -(next.z - position.z)), 0, true);
  bot.setControlState('forward', Math.hypot(next.x - position.x, next.z - position.z) > 0.3);
  setJump(bot, next.y > position.y - 0.3 && fitsColumnAt(bot, next, position.y + 0.1));
  bot.setControlState('sneak', next.y < position.y - 0.8);
}

const HEADROOM = 0.1;
/**
 * Sets the jump key to what the steering wants on this tick, and makes that the last word. The client
 * queues a jump the moment the key goes down: another mover that pressed it earlier in the same tick (a
 * route follower swimming, a straight-up surfacing pass) has then kicked the body upward even though the
 * key is up again by the time the tick is simulated. A body that has to sink does not get to.
 */
function setJump(bot: ReflexBot, wanted: boolean): void {
  bot.setControlState('jump', wanted);
  if (!wanted) (bot as { jumpQueued?: boolean }).jumpQueued = false;
}

/** Whether the body, at the height it is at, goes into the column of `cell` without striking anything. */
function fitsColumnAt(bot: ReflexBot, cell: Vec3, y: number): boolean {
  let height = 1.8;
  try { height = bodyPose(bot as any).height; } catch { /* standing */ }
  const x = Math.floor(cell.x), z = Math.floor(cell.z);
  try {
    // With a little room over the head: a body whose top is level with the underside of a block is stopped by it.
    for (let level = Math.floor(y); level <= Math.floor(y + height + HEADROOM); level++) {
      if (bot.blockAt(new Vec3(x, level, z))?.boundingBox === 'block') return false;
    }
  } catch { return true; }
  return true;
}

/** Seconds to air by the quickest way the body knows: straight up, else swimming out from under the ceiling, else through it. */
export function secondsToAir(bot: ReflexBot): number {
  const up = secondsToSurface(bot);
  if (Number.isFinite(up)) return up;
  return Math.min(secondsToSwimOut(bot), secondsToBreakOut(bot));
}

/**
 * Whether the remaining air no longer covers the way to air (with a margin),
 * or is critical outright. Under a ceiling the way is the longest there is,
 * sideways, back, or through it, and it used to be the one case left to the
 * critical threshold: a bot under an ice sheet was not counted as short of air
 * until 5 of 20, with a 4.7-second dig ahead of it, and until then a hostile
 * emergency kept taking the body (paid run L50 drowned).
 */
export function airRunningOut(bot: Pick<ReflexBot, 'entity' | 'blockAt' | 'oxygenLevel'>): boolean {
  const oxygen = bot.oxygenLevel;
  if (typeof oxygen !== 'number') return false;
  if (oxygen <= REFLEX_ENGAGE_OXYGEN) return true;
  let surface = Infinity;
  try { surface = secondsToSurface(bot); } catch { return false; }
  if (Number.isFinite(surface)) return oxygen * AIR_SECONDS_PER_UNIT <= surface + SURFACING_MARGIN_SECONDS;
  let way = Infinity;
  try { way = secondsToAir(bot as ReflexBot); } catch { return false; }
  // No way known at all: nothing to start early for; the critical threshold above stands.
  return Number.isFinite(way) && oxygen * AIR_SECONDS_PER_UNIT <= way + CEILING_MARGIN_SECONDS;
}

export interface BreathingReflexState {
  engaged: boolean; engagements: number; floating?: boolean;
  /** Set while a survival action works on the ceiling from under water: the body treads water under its work instead of sinking away from it. */
  holdAfloat?: boolean;
  /** The idle body is being taken along a route to air (its sideways keys are this reflex's to release). */
  steering?: boolean;
}

/**
 * The way back to air. A swimmer who has gone under a ceiling cannot surface
 * where it is; the one route known to be open is the one it came by. Guessing
 * at "open water nearby" from the block layout pressed a bot against a wall
 * for 18 seconds until it drowned (paid run L30). The trail runs from the
 * last place the head was in air to where the body is now.
 */
interface AirTrail { points: Vec3[]; retracingAt: number; last?: Vec3; at?: number; oxygen?: number; oxygenFellAt?: number }
/** Height of the body's column that must stay open where it last breathed: feet to eyes, standing. */
const BREATH_COLUMN = [0, 1, 1.62];
/** How long after the air count last fell the head still counts as under water (the count falls about every 0.75s there). */
const OXYGEN_FALL_MEMORY_MS = 2000;
const trails = new WeakMap<object, AirTrail>();
const TRAIL_STEP = 0.75;
const TRAIL_MAX_POINTS = 240;
const TRAIL_REACHED = 1.0;
const TRAIL_JUMP = 4;
/** Swimming speed back along the trail, on the slow side. */
const RETRACE_METRES_PER_SECOND = 1.6;
/** Health is a second reserve once the air is gone (a heart a second); count a part of it. */
const RETRACE_HEALTH_RESERVE_SECONDS = 4;

/**
 * Whether the place the trail leads back to can still hold a breathing body:
 * nothing solid where the body was, and no water where its eyes were. A trail
 * is a memory, and the world moves on under it: a hole in the ice freezes
 * over, a block is placed, the water rises. Swimming back to a breath that is
 * no longer there pressed a body against the underside of the ice until the
 * air for breaking out was spent (paid run L50).
 */
function breathStillOpen(bot: Pick<ReflexBot, 'blockAt'>, breath: Vec3): boolean {
  for (const dy of BREATH_COLUMN) {
    let block: any;
    try { block = bot.blockAt(new Vec3(Math.floor(breath.x), Math.floor(breath.y + dy), Math.floor(breath.z))); } catch { return true; }
    if (!block) return true; // not loaded: nothing known against it
    if (block.boundingBox === 'block') return false;
    if (dy === BREATH_COLUMN[BREATH_COLUMN.length - 1] && holdsWater(block)) return false;
  }
  return true;
}

/** Length of the way back to the last breath, or null when no trail is known or the breath is no longer there. */
function retraceMetres(bot: ReflexBot): number | null {
  const trail = trails.get(nativeActionHost(bot));
  if (!trail || trail.points.length < 1 || !bot.entity) return null;
  if (!breathStillOpen(bot, trail.points[0])) { trail.points = []; return null; }
  let metres = trail.points[trail.points.length - 1].distanceTo(bot.entity.position);
  for (let index = trail.points.length - 1; index > 0; index--) metres += trail.points[index].distanceTo(trail.points[index - 1]);
  return metres;
}

/** Whether the trail back to air is short enough for the air that is left. */
export function retraceFeasible(bot: ReflexBot): boolean {
  const metres = retraceMetres(bot);
  return metres !== null
    && metres / RETRACE_METRES_PER_SECOND <= Math.max(0, bot.oxygenLevel ?? 20) * AIR_SECONDS_PER_UNIT + RETRACE_HEALTH_RESERVE_SECONDS;
}

function headSubmerged(bot: Pick<ReflexBot, 'entity' | 'blockAt'>): boolean {
  const position = bot.entity!.position;
  return holdsWater(bot.blockAt(new Vec3(Math.floor(position.x), Math.floor(position.y + eyeHeight(bot)), Math.floor(position.z))));
}

/** The recorded way back, oldest (the breath) first: for diagnostics and lab probes. */
export function airTrailPoints(bot: object): Vec3[] { return [...(trails.get(nativeActionHost(bot))?.points ?? [])]; }

/** One sample of the trail: restart it wherever the head is in air, extend it while it is under water. */
export function recordAirTrail(bot: ReflexBot, now = Date.now()): void {
  const position = bot.entity?.position;
  if (!position) return;
  const host = nativeActionHost(bot);
  const trail = trails.get(host) ?? { points: [], retracingAt: 0 };
  trails.set(host, trail);
  let submerged = false;
  try { submerged = headSubmerged(bot); } catch { return; }
  // The server's air count is the witness that cannot be wrong about the head: while it is falling,
  // the head is under water whatever the client's geometry says, and this is no place to call "air".
  const oxygen = bot.oxygenLevel;
  if (typeof oxygen === 'number') {
    if (trail.oxygen !== undefined && oxygen < trail.oxygen) trail.oxygenFellAt = now;
    trail.oxygen = oxygen;
  }
  if (trail.oxygenFellAt !== undefined && now - trail.oxygenFellAt < OXYGEN_FALL_MEMORY_MS) submerged = true;
  if (!submerged) { trail.points = [position.clone()]; trail.last = position.clone(); trail.at = now; return; }
  // A jump no swimmer makes (a teleport, a respawn): the old trail leads nowhere from here.
  if (trail.at !== undefined && position.distanceTo(trail.last ?? position) > TRAIL_JUMP) trail.points = [];
  trail.last = position.clone(); trail.at = now;
  if (now - trail.retracingAt < 1500) return; // going back along it: do not lay new trail over the old
  // A trail begins at a breath. A body that was never seen in air here (it
  // arrived under water) has no way back to offer.
  const last = trail.points[trail.points.length - 1];
  if (last && last.distanceTo(position) >= TRAIL_STEP) {
    trail.points.push(position.clone());
    if (trail.points.length > TRAIL_MAX_POINTS) trail.points.splice(1, 1); // keep the air point
  }
}

/** The next point to swim to on the way back to air, or null when no trail is known. */
export function retraceWaypoint(bot: ReflexBot, now = Date.now()): Vec3 | null {
  const trail = trails.get(nativeActionHost(bot));
  const position = bot.entity?.position;
  if (!trail?.points.length || !position) return null;
  trail.retracingAt = now;
  // Whatever lies beyond the point nearest the body is behind it now (deeper in): forget it.
  let nearest = trail.points.length - 1;
  for (let index = nearest - 1; index >= 0; index--)
    if (trail.points[index].distanceTo(position) < trail.points[nearest].distanceTo(position)) nearest = index;
  trail.points.length = nearest + 1;
  while (trail.points.length > 1 && trail.points[trail.points.length - 1].distanceTo(position) < TRAIL_REACHED) trail.points.pop();
  return trail.points[trail.points.length - 1];
}

/** Swimming for air made no headway: until this passes, surfacing counts as not possible and breaking out takes over. */
const stalls = new WeakMap<object, number>();
/** Where and when swimming for air has stalled lately, for the judgement of whether the swim is worth another try. */
const stallPlaces = new WeakMap<object, Array<{ at: number; where: Vec3 }>>();
const STALL_MEMORY_MS = 30_000;
const STALL_SAME_PLACE = 2.5;
export function markSurfacingStalled(bot: object, forMs = 8000, now = Date.now()): void {
  const host = nativeActionHost(bot);
  stalls.set(host, now + forMs);
  const where = (host as { entity?: { position?: Vec3 } }).entity?.position;
  if (!where || typeof where.clone !== 'function') return;
  const list = (stallPlaces.get(host) ?? []).filter(entry => now - entry.at < STALL_MEMORY_MS);
  list.push({ at: now, where: where.clone() });
  stallPlaces.set(host, list.slice(-8));
}
/**
 * How many times lately swimming for air has stalled near where the body is now. A route through the water that
 * the body has twice failed to make headway along is no way out, whatever the search says: the swim was retried
 * on its word each time breaking out looked too slow, the two reflexes undid each other every second and a half,
 * every action the planner tried was cut off by the next attempt, and the body drowned (paid runs L89, L91).
 */
export function surfacingStallsHere(bot: object, now = Date.now()): number {
  const host = nativeActionHost(bot);
  const position = (host as { entity?: { position?: Vec3 } }).entity?.position;
  if (!position) return 0;
  return (stallPlaces.get(host) ?? []).filter(entry => now - entry.at < STALL_MEMORY_MS && entry.where.distanceTo(position) <= STALL_SAME_PLACE).length;
}
/** The world changed (a block overhead was broken): swimming may work again. */
export function clearSurfacingStall(bot: object): void { stalls.delete(nativeActionHost(bot)); }

/**
 * Rising straight up through a one-block opening needs the body under its
 * middle: a 0.6-wide body 0.3 off-centre catches on the rim. A bot held jump
 * under the hole it had just broken in the ice, an edge of the ice above one
 * shoulder, until it drowned (lab probe). Returns whether it is centred.
 */
export function centreInColumn(bot: ReflexBot): boolean {
  const position = bot.entity!.position;
  const cx = Math.floor(position.x) + 0.5, cz = Math.floor(position.z) + 0.5;
  if (Math.hypot(cx - position.x, cz - position.z) <= 0.12) { bot.setControlState('forward', false); return true; }
  bot.look?.(Math.atan2(-(cx - position.x), -(cz - position.z)), 0, true);
  bot.setControlState('forward', true);
  return false;
}
export function surfacingStalled(bot: object, now = Date.now()): boolean { return (stalls.get(nativeActionHost(bot)) ?? 0) > now; }

/** Controls that take the body toward a trail point: forward along the look, up or down as the point lies. */
export function steerToward(bot: ReflexBot, target: Vec3): void {
  const position = bot.entity!.position;
  bot.look?.(Math.atan2(-(target.x - position.x), -(target.z - position.z)), 0, true);
  bot.setControlState('forward', Math.hypot(target.x - position.x, target.z - position.z) > 0.3);
  setJump(bot, target.y > position.y - 0.3);
  bot.setControlState('sneak', target.y < position.y - 0.8);
}

interface ReflexBot {
  /** True while an instant skill or a reflex action (escape, counterattack) runs; not for the constant skills' checks. */
  executingSkill?: boolean;
  entity?: { position: Vec3; isInWater?: boolean; onGround?: boolean };
  oxygenLevel?: number;
  health?: number;
  constantSkills?: { getSkills(): Array<{ skillName: string; priority: number; isLocked: boolean; status?: boolean; isSwimmingUp?: boolean }> };
  blockAt(position: Vec3): any;
  /** Milliseconds to dig the block with the tool in hand, in the body's present state (mineflayer). */
  digTime?(block: any): number;
  getControlState(control: string): boolean;
  setControlState(control: string, state: boolean): void;
  look?(yaw: number, pitch: number, force?: boolean): unknown;
  on(event: 'physicsTick', listener: () => void): unknown;
}

/** Why the regular surfacing did not happen: which skills held locks, what ran, who waited for the body. */
export function describeSurfacingBlockers(bot: ReflexBot): string {
  const skills = bot.constantSkills?.getSkills() ?? [];
  const swim = skills.find(skill => skill.skillName === 'auto-swim');
  const locked = skills.filter(skill => skill.isLocked).map(skill => `${skill.skillName}(優先度${skill.priority})`);
  const lease = actionLeaseStatus(bot);
  return `auto-swim=${swim ? `status:${swim.status} locked:${swim.isLocked} swimming:${swim.isSwimmingUp}` : 'なし'}`
    + ` ロック中の常駐スキル=[${locked.join(',')}] 実行中の行動=[${activeActionCapabilities(bot).join(',')}]`
    + ` 行動ロック=[${lease?.activeLocks.join(',') ?? ''}] 待ち=${lease?.waitQueue ?? 0}`;
}

/**
 * One physics tick of the last-resort breathing reflex, run after the movers
 * set their keys. Surfacing normally belongs to the auto-swim survival skill,
 * scheduled through the constant-skill queue and the physical lease; a paid
 * run (L12) drowned on a seabed with nobody pressing jump while that path
 * stayed silent. When the remaining air no longer covers the swim up, no one
 * is swimming up and no survival action holds the body for half a second, kick
 * for the surface directly (sideways to open water under a ceiling) until air
 * recovers or a survival action takes over.
 */
export function breathingReflexTick(bot: ReflexBot, state: BreathingReflexState & { unattendedSince: number | null }, now = Date.now()): 'engaged' | 'released' | null {
  const inWater = bot.entity?.isInWater === true;
  const oxygen = bot.oxygenLevel;
  if (state.engaged) {
    // Bobbing at the surface reads as out of water for a moment; letting go
    // there sank the body again (a live probe cycled down to 1 air), so hold
    // until the air itself has recovered.
    // Engaged early under a ceiling, the air count alone would let go again at once: hold while it is still short for the way out.
    const stillShort = inWater && (() => { try { return airRunningOut(bot); } catch { return false; } })();
    if ((oxygen ?? 20) >= REFLEX_RELEASE_OXYGEN && !stillShort || (bot.health ?? 20) <= 0 || hasActiveSafetyLease(bot)) {
      state.engaged = false;
      bot.setControlState('jump', false);
      bot.setControlState('forward', false);
      return 'released';
    }
    const position = bot.entity!.position;
    const head = new Vec3(Math.floor(position.x), Math.floor(position.y + eyeHeight(bot)), Math.floor(position.z));
    let route: Vec3[] | null = null;
    let ceiling = false;
    try { ceiling = ceilingOverhead(bot, head); if (ceiling) route = swimRouteToAir(bot, now); } catch { /* keep kicking up */ }
    // A route found in the water as it is now comes before the remembered one.
    const back = ceiling && !route?.length && retraceFeasible(bot) ? retraceWaypoint(bot, now) : null;
    // Each branch sets the jump key once. Pressed here and let go by the steering in the same tick, it still
    // counted as a press (the client queues it), and a body steered downward was kicked up every tick.
    if (route?.length) steerAlongRoute(bot, route);
    else if (back) steerToward(bot, back);
    else { bot.setControlState('jump', true); centreInColumn(bot); }
    return null;
  }
  const drowning = inWater && (bot.health ?? 20) > 0 && airRunningOut(bot);
  // Treading water is not swimming for air: under a ceiling it needs this reflex's sideways steer.
  const someoneSwimming = bot.getControlState('jump') && !state.floating;
  if (!drowning || someoneSwimming || hasActiveSafetyLease(bot)) { state.unattendedSince = null; return null; }
  state.unattendedSince ??= now;
  if (now - state.unattendedSince < UNATTENDED_MS) return null;
  state.unattendedSince = null;
  state.engaged = true;
  state.engagements++;
  bot.setControlState('jump', true);
  return 'engaged';
}

/**
 * Between actions nobody holds the body, and in deep water it sank every
 * time the planner stopped to think: air ran down, a suffocation emergency
 * paused the task, and with no dry footing in reach that emergency could not
 * end. A bot spent its last three minutes sinking and resurfacing among
 * drowned (paid run L21). An idle body in water it cannot stand in treads
 * water; any action that takes the body gets the keys back untouched.
 */
export function buoyancyTick(bot: ReflexBot, state: { floating?: boolean; holdAfloat?: boolean; steering?: boolean }): 'floating' | 'released' | null {
  const entity = bot.entity;
  let afloat = false;
  // The periodic checks of the constant skills are physical actions too, a
  // few milliseconds each; counting them let go of the water several times a
  // second. Only a skill or reflex that really has the body takes the keys.
  // Breaking out through a ceiling is the one action that wants them held: a
  // dig presses no keys, and the body sank two blocks below the ice it was
  // breaking, the air that opened above it out of reach for what health was
  // left (paid run L50).
  if (entity?.isInWater === true && (bot.health ?? 20) > 0 && (bot.executingSkill !== true || state.holdAfloat === true)) {
    let headUnderWater = false;
    try { headUnderWater = holdsWater(bot.blockAt(new Vec3(Math.floor(entity.position.x), Math.floor(entity.position.y + eyeHeight(bot)), Math.floor(entity.position.z)))); }
    catch { /* unreadable world: stay afloat */ headUnderWater = true; }
    // Standing in shallows with the head out needs nothing.
    afloat = headUnderWater || entity.onGround !== true;
  }
  if (afloat) {
    // Up is where the air usually is, not where it always is. An idle body standing in a waterfall it
    // had just dug into held jump, swam ten cells up the falling water into the flooded pocket it came
    // from, and drowned under stone, with the dry tunnel one step to its side (paid run L59). With the
    // head under water the body goes where the air is: along the route to it, when one is within reach.
    let route: Vec3[] | null = null;
    if (headUnderWaterNow(bot)) { try { route = swimRouteToAir(bot); } catch { route = null; } }
    if (route?.length) { steerAlongRoute(bot, route); state.steering = true; }
    else {
      if (state.steering) { bot.setControlState('forward', false); bot.setControlState('sneak', false); state.steering = false; }
      bot.setControlState('jump', true);
    }
    if (state.floating) return null;
    state.floating = true;
    return 'floating';
  }
  if (!state.floating) return null;
  state.floating = false;
  bot.setControlState('jump', false);
  if (state.steering) { bot.setControlState('forward', false); bot.setControlState('sneak', false); state.steering = false; }
  return 'released';
}

function headUnderWaterNow(bot: ReflexBot): boolean {
  const position = bot.entity?.position;
  if (!position) return false;
  try { return holdsWater(bot.blockAt(new Vec3(Math.floor(position.x), Math.floor(position.y + eyeHeight(bot)), Math.floor(position.z)))); }
  catch { return false; }
}

/**
 * While auto-swim is taking the body to air under a ceiling, the route is steered here, on every tick and
 * after every other mover. Auto-swim sets the keys ten times a second; whatever else writes them in between
 * (a path still being walked by an escape it took the body from, another surfacing pass) had the ticks in
 * between, and a body that had to dive under a shelf hung where it was (paid run L66, and again in its world
 * afterwards with two spiders near).
 */
export function steerSwimmingRoute(bot: ReflexBot): boolean {
  const entity = bot.entity;
  if (entity?.isInWater !== true || (bot.health ?? 20) <= 0) return false;
  if (!bot.constantSkills?.getSkills().some(skill => skill.skillName === 'auto-swim' && skill.isSwimmingUp === true)) return false;
  const head = new Vec3(Math.floor(entity.position.x), Math.floor(entity.position.y + eyeHeight(bot)), Math.floor(entity.position.z));
  if (!holdsWater(bot.blockAt(head)) || !ceilingOverhead(bot as any, head)) return false;
  const route = swimRouteToAir(bot);
  if (!route?.length) return false;
  steerAlongRoute(bot, route);
  return true;
}

export function installBreathingReflex(bot: ReflexBot): void {
  const marked = bot as ReflexBot & { breathingReflex?: BreathingReflexState };
  if (marked.breathingReflex) return;
  const state = { engaged: false, engagements: 0, floating: false, unattendedSince: null as number | null };
  marked.breathingReflex = state;
  let floatNotedAt = 0;
  let trailTick = 0;
  bot.on('physicsTick', () => {
    if (++trailTick % 5 === 0) { try { recordAirTrail(bot); } catch { /* perception must not stop the body */ } }
    try {
      // Bobbing at the surface leaves and re-enters the water about once a second: say it once per stay.
      if (buoyancyTick(bot, state) === 'floating' && Date.now() - floatNotedAt > 30_000) log.debug('🫧 行動の合間は水面に浮く');
      if (state.floating) floatNotedAt = Date.now();
    } catch { /* the air reflex below still runs */ }
    try { steerSwimmingRoute(bot); } catch { /* the air reflex below still runs */ }
    let outcome: ReturnType<typeof breathingReflexTick>;
    try { outcome = breathingReflexTick(bot, state); } catch { return; }
    if (outcome === 'engaged') {
      log.warn(`🫧 呼吸の最終反射: 水中で酸素${bot.oxygenLevel}/20（水面まで約${secondsToSurface(bot).toFixed(1)}秒）なのに浮上する行動がなかったため直接浮上する | ${describeSurfacingBlockers(bot)}`);
    } else if (outcome === 'released') log.info(`🫧 呼吸の最終反射を解除（酸素${bot.oxygenLevel}/20）`);
  });
}

/** As a mineflayer plugin, loaded after the movement plugins so its keys win the tick. */
export function breathingReflexPlugin(bot: unknown): void { installBreathingReflex(bot as ReflexBot); }
