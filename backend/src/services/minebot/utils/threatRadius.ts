import { attackReach, type CombatStatsState } from '../../../modules/minecraftLearning/index.js';
import { answeredByReflex } from './reflexAnswers.js';
import { engagedWith } from './engagement.js';
import { isHostileEntity } from './hostileMobHints.js';
import { isExposedTo } from './threatExposure.js';
import { approachSpeed, secondsToContact, sustainedApproachSpeed } from './threatTracker.js';

/**
 * How near a hostile has to be to count as a threat to a dig (`bot.hostileThreatRadius`, read by the dig guard): the legacy
 * EventReactionSystem's `emergencyClearanceRadius`, kept rule for rule (P8 review M1, 2026-10-19). It is not one number.
 *
 *   base      min(detection 16, 2 x critical 8): the radius an emergency is judged by when nothing says otherwise
 *   reach     a kind that has been MEASURED to hit from afar (a skeleton, a ghast), exposed to the body and within its reach plus 6,
 *             is kept away from by that reach plus 6 -- unless a reflex of the body answers its attack (a shield for arrows, the
 *             fireball strike) or the body is fighting it, in which case only a hit that got through raises it (the `justHit` below)
 *   arriving  a hostile outside the base that will be on the body within 9 s at the rate it has been seen to come (sustained
 *             approach once it has time in hand; the short rate when it is urgent or the body is at 10 health or less): its
 *             distance plus 4
 *   justHit   as far as the hit that landed in the last 5 s came from, plus 6
 * The greatest of these, never past 64 (a ghast shoots from that far). The constants are the legacy ones; a test holds the source
 * of EventReactionSystem and CombatEventHandler against them, so the two cannot drift apart unnoticed.
 */
export const DETECTION_DISTANCE = 16;
export const CRITICAL_DISTANCE = 8;
export const CLEARANCE_CAP = 64;
export const REACH_SCAN_RADIUS = 64;
export const REACH_MARGIN = 6;
export const ARRIVING_MARGIN = 4;
export const LEAD_RANGE = 48;
export const SAFE_LEAD_SECONDS = 9;
export const URGENT_LEAD_SECONDS = 5;
export const CANNOT_WAIT_HEALTH = 10;
export const JUST_HIT_MS = 5_000;

interface RadiusEntity { id?: number; name?: string | null; type?: string | null; position?: { distanceTo(other: any): number }; metadata?: unknown[] }
export interface RadiusBot {
  entity?: RadiusEntity & { position: { distanceTo(other: any): number } };
  entities?: Record<string, RadiusEntity | undefined>;
  health?: number;
}
/** The last hit that named a cause, whatever it was (a player's too: the radius follows how far a blow came from, not whose). */
export interface NamedHit { at: number; source: string | null; from?: number }

/** The radius when nothing is known beyond the settings: min(detection, critical x 2). */
export function baseClearanceRadius(): number { return Math.min(DETECTION_DISTANCE, CRITICAL_DISTANCE * 2); }

function hostilesAround(bot: RadiusBot, radius: number): Array<{ entity: RadiusEntity; name: string; distance: number }> {
  const self = bot.entity; if (!self) return [];
  return Object.values(bot.entities ?? {})
    .filter((entity): entity is RadiusEntity & { position: { distanceTo(other: any): number } } => !!entity && entity !== self && entity.id !== self.id && !!entity.position
      && isHostileEntity(entity as any, bot as any))
    .map(entity => ({ entity, name: String(entity.name).toLowerCase(), distance: self.position.distanceTo(entity.position) }))
    .filter(entry => entry.distance <= radius)
    .sort((a, b) => a.distance - b.distance);
}

/** Seconds until this hostile is on the body at the rate it has been seen to come; null when it is not coming. */
function arrivalSeconds(bot: RadiusBot, entity: RadiusEntity, distance: number): number | null {
  try {
    const quick = secondsToContact(distance, approachSpeed(bot, entity.id));
    if (quick === null || quick <= URGENT_LEAD_SECONDS || (bot.health ?? 20) <= CANNOT_WAIT_HEALTH) return quick;
    return secondsToContact(distance, sustainedApproachSpeed(bot, entity.id));
  } catch { return null; }
}

/** Exposed hostiles beyond `radius` that will be on the body within the lead it needs, with how far off they are. */
function arrivingBeyond(bot: RadiusBot, radius: number): number[] {
  const self = bot.entity; if (!self) return [];
  const far: number[] = [];
  for (const entity of Object.values(bot.entities ?? {})) {
    if (!entity || entity.id === self.id || !entity.position || !isHostileEntity(entity as any, bot as any)) continue;
    const distance = self.position.distanceTo(entity.position);
    if (distance <= radius || distance > LEAD_RANGE) continue;
    const arrivesIn = arrivalSeconds(bot, entity, distance);
    if (arrivesIn === null || arrivesIn > SAFE_LEAD_SECONDS || !isExposedTo(bot as any, entity as any)) continue;
    far.push(distance);
  }
  return far;
}

/** Kinds of mob near enough to matter that have hit the body from beyond contact: the farthest reach among them (0 when none). */
function farthestReach(bot: RadiusBot, stats: CombatStatsState): number {
  let farthest = 0;
  for (const entry of hostilesAround(bot, REACH_SCAN_RADIUS)) {
    const reach = attackReach(stats, entry.name);
    // A kind whose attack a reflex of the body answers is not kept away from by its mere presence: only a hit that got through raises it.
    if (answeredByReflex(bot, entry.name) || engagedWith(bot, entry.name)) continue;
    if (reach > 0 && entry.distance <= reach + REACH_MARGIN && isExposedTo(bot as any, entry.entity as any)) farthest = Math.max(farthest, reach);
  }
  return farthest;
}

export function emergencyClearanceRadius(bot: RadiusBot, stats: CombatStatsState, lastHit: NamedHit | null, now = Date.now()): number {
  const base = baseClearanceRadius();
  const farthest = farthestReach(bot, stats);
  const arriving = Math.max(0, ...arrivingBeyond(bot, base));
  const justHit = lastHit?.source && lastHit.from !== undefined && now - lastHit.at < JUST_HIT_MS ? lastHit.from : 0;
  return Math.min(CLEARANCE_CAP, Math.max(base, farthest > 0 ? Math.ceil(farthest + REACH_MARGIN) : 0,
    arriving > 0 ? Math.ceil(arriving + ARRIVING_MARGIN) : 0, justHit > 0 ? Math.ceil(justHit + REACH_MARGIN) : 0));
}
