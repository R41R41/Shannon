import { isThreatEntity } from './hostileMobHints.js';
/**
 * How fast each nearby hostile is closing on the body, measured from the
 * positions the body has actually seen. A distance alone does not say whether
 * there is time for anything: a planner shown "zombie 12.7m" began a shelter
 * that takes longer to dig than the zombie took to arrive, and was killed in
 * its own pit (paid run L18). No per-mob speed table: the rate is observed.
 */
const SAMPLE_TICKS = 5;
const WINDOW_MS = 2500;
const MIN_SPAN_MS = 750;
const RANGE = 48;
/** Reach of a melee attacker: contact, not the centre, is what the time is counted to. */
const CONTACT_REACH = 2;

/**
 * A coarser and longer record of where each hostile has been, for telling a mob that is coming from one that
 * took a few steps. A mob wandering at night walks at the speed it chases with, a few blocks and then stops: over
 * the short window both read as "on the body in eight seconds". In paid run L109, 13 of the 15 emergencies after
 * the iron pickaxe were raised by such a stroll (or by two mobs standing 14 m off), the mob stopped within a second,
 * and the planner was woken only to confirm that nothing was within 16 blocks. A chase goes on; a stroll does not.
 */
const TRAIL_STEP_MS = 400;
const TRAIL_MS = 5000;
/** The span of the longer record needed before it is used; until then the short window speaks alone. */
const SUSTAIN_MS = 4000;
/** Slower than this is not coming at all (the same floor as the time to contact). */
export const APPROACH_FLOOR = 0.3;

interface Sample { at: number; distance: number; x?: number; y?: number; z?: number }
export interface ThreatMotionState { samples: Map<number, Sample[]>; trail?: Map<number, Sample[]> }

interface TrackedEntity { id?: number; name?: string; type?: string; position?: { distanceTo(other: unknown): number; x?: number; y?: number; z?: number } }
interface TrackerBot {
  entity?: TrackedEntity;
  entities?: Record<string, TrackedEntity | undefined>;
  registry?: { entitiesByName?: Record<string, { type?: string }> };
  threatMotion?: ThreatMotionState;
  on(event: 'physicsTick', listener: () => void): unknown;
}

function isHostile(bot: TrackerBot, entity: TrackedEntity): boolean {
  return isThreatEntity(entity as any, bot.registry?.entitiesByName?.[entity.name ?? '']?.type, Date.now(), bot as any);
}

export function sampleThreatMotion(bot: TrackerBot, state: ThreatMotionState, now = Date.now()): void {
  const self = bot.entity?.position;
  if (!self) return;
  const seen = new Set<number>();
  for (const entity of Object.values(bot.entities ?? {})) {
    if (!entity?.position || entity === bot.entity || typeof entity.id !== 'number' || !isHostile(bot, entity)) continue;
    const distance = self.distanceTo(entity.position);
    if (!(distance <= RANGE)) continue;
    seen.add(entity.id);
    const samples = state.samples.get(entity.id) ?? [];
    samples.push({ at: now, distance, x: entity.position.x, y: entity.position.y, z: entity.position.z });
    while (samples.length > 1 && now - samples[0].at > WINDOW_MS) samples.shift();
    state.samples.set(entity.id, samples);
    const trail = (state.trail ??= new Map()).get(entity.id) ?? [];
    if (!trail.length || now - trail[trail.length - 1].at >= TRAIL_STEP_MS) {
      trail.push({ at: now, distance, x: entity.position.x, y: entity.position.y, z: entity.position.z });
    }
    while (trail.length > 1 && now - trail[0].at > TRAIL_MS) trail.shift();
    state.trail!.set(entity.id, trail);
  }
  for (const id of state.samples.keys()) if (!seen.has(id)) state.samples.delete(id);
  if (state.trail) for (const id of state.trail.keys()) if (!seen.has(id)) state.trail.delete(id);
}

/** Metres per second by which the gap to this entity is shrinking (negative: widening); null until observed long enough. */
export function closingSpeed(bot: unknown, entityId: number | undefined): number | null {
  const samples = entityId === undefined ? undefined : (bot as TrackerBot | undefined)?.threatMotion?.samples.get(entityId);
  if (!samples || samples.length < 2) return null;
  const first = samples[0], last = samples[samples.length - 1];
  const span = last.at - first.at;
  return span >= MIN_SPAN_MS ? (first.distance - last.distance) / (span / 1000) : null;
}

/**
 * How the gap to this entity has gone over the window: metres a second it shrank (negative: grew) and over
 * how long, both the body's movement and the entity's counted. Whether an escape is working is this: a body
 * running and a mob following at the same pace keep the gap; one losing the race sees it shrink.
 */
export function gapTrend(bot: unknown, entityId: number | undefined): { closing: number; spanMs: number } | null {
  const samples = entityId === undefined ? undefined : (bot as TrackerBot | undefined)?.threatMotion?.samples.get(entityId);
  if (!samples || samples.length < 2) return null;
  const first = samples[0], last = samples[samples.length - 1];
  const spanMs = last.at - first.at;
  return spanMs > 0 ? { closing: (first.distance - last.distance) / (spanMs / 1000), spanMs } : null;
}

/**
 * Metres per second by which the entity itself has been coming toward where the body now stands: its own
 * movement, with the body's taken out. The closing speed counts both: a body sprinting toward a creeper
 * that stood forty blocks off "closed" on it at over five blocks a second, and that read as the creeper
 * arriving in seven seconds (paid run L74 raised an emergency for it). Null until observed long enough;
 * the closing speed when the entity's positions were not kept.
 */
export function approachSpeed(bot: unknown, entityId: number | undefined): number | null {
  const body = bot as TrackerBot | undefined;
  const samples = entityId === undefined ? undefined : body?.threatMotion?.samples.get(entityId);
  if (!samples || samples.length < 2) return null;
  const first = samples[0], last = samples[samples.length - 1];
  const span = last.at - first.at;
  if (span < MIN_SPAN_MS) return null;
  const self = body?.entity?.position as { x?: number; y?: number; z?: number } | undefined;
  if ([first.x, first.y, first.z, last.x, last.y, last.z, self?.x, self?.y, self?.z].some(value => typeof value !== 'number')) return closingSpeed(bot, entityId);
  const from = Math.hypot(first.x! - self!.x!, first.y! - self!.y!, first.z! - self!.z!);
  const to = Math.hypot(last.x! - self!.x!, last.y! - self!.y!, last.z! - self!.z!);
  return (from - to) / (span / 1000);
}

/**
 * The entity's own approach as it has kept it up: the short-window rate, or the rate over the last four to five
 * seconds when that is slower (a few quick steps and a stop average out). The short rate alone until the longer
 * record spans enough (a mob that has just come into range is not held back). Null until observed long enough.
 */
export function sustainedApproachSpeed(bot: unknown, entityId: number | undefined): number | null {
  const short = approachSpeed(bot, entityId);
  if (short === null) return null;
  const body = bot as TrackerBot | undefined;
  const trail = entityId === undefined ? undefined : body?.threatMotion?.trail?.get(entityId);
  const self = body?.entity?.position as { x?: number; y?: number; z?: number } | undefined;
  if (!trail || trail.length < 2 || !self) return short;
  const recent = body?.threatMotion?.samples.get(entityId!);
  const latest = recent?.[recent.length - 1];
  const first = trail[0], last = latest && typeof latest.x === 'number' && latest.at > trail[trail.length - 1].at ? latest : trail[trail.length - 1];
  const span = last.at - first.at;
  if (span < SUSTAIN_MS || [first.x, first.y, first.z, last.x, last.y, last.z, self.x, self.y, self.z].some(value => typeof value !== 'number')) return short;
  const from = Math.hypot(first.x! - self.x!, first.y! - self.y!, first.z! - self.z!);
  const to = Math.hypot(last.x! - self.x!, last.y! - self.y!, last.z! - self.z!);
  return Math.min(short, (from - to) / (span / 1000));
}

/** Seconds until the entity is within reach at the observed closing rate; null when it is not closing. */
export function secondsToContact(distance: number, closing: number | null): number | null {
  if (closing === null || closing < APPROACH_FLOOR) return null;
  return Math.max(0, distance - CONTACT_REACH) / closing;
}

/** The hostile that will be within reach first at the observed rates (0s: already there); null when none is closing. */
export function soonestContact(bot: unknown): { name: string; seconds: number; distance: number } | null {
  const body = bot as TrackerBot | undefined;
  const self = body?.entity?.position;
  if (!self || !body?.threatMotion) return null;
  let soonest: { name: string; seconds: number; distance: number } | null = null;
  for (const entity of Object.values(body.entities ?? {})) {
    if (!entity?.position || entity === body.entity || typeof entity.id !== 'number' || !isHostile(body, entity)) continue;
    const distance = self.distanceTo(entity.position);
    const seconds = distance <= CONTACT_REACH + 1 ? 0 : secondsToContact(distance, closingSpeed(body, entity.id));
    if (seconds !== null && (!soonest || seconds < soonest.seconds)) soonest = { name: String(entity.name), seconds, distance };
  }
  return soonest;
}

export function installThreatTracker(bot: TrackerBot): void {
  if (bot.threatMotion) return;
  const state: ThreatMotionState = { samples: new Map() };
  bot.threatMotion = state;
  let tick = 0;
  bot.on('physicsTick', () => {
    if (++tick % SAMPLE_TICKS !== 0) return;
    try { sampleThreatMotion(bot, state); } catch { /* perception must not stop the body */ }
  });
}

export function threatTrackerPlugin(bot: unknown): void { installThreatTracker(bot as TrackerBot); }
