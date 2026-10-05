import { isHostileEntity } from './hostileMobHints.js';
import { isExposedTo } from './threatExposure.js';
import { gapTrend, secondsToContact } from './threatTracker.js';

/**
 * Whether the body's escape is losing to a pursuer: the gap to it has kept shrinking for a second and a half
 * while the body ran, and at that rate it will be on the body within a few seconds.
 *
 * Running is the default answer to something that comes at the body, and nothing watched whether it worked.
 * In paid run L110 the escape route crossed a shore and then stopped to lay a block, the body crouching and
 * backing toward the edge at a crawl, and a creeper closed from 12 m to 1 m over thirteen seconds while every
 * tick of the escape logged "fleeing". The planner was only updating its task tree. The body was blown up at
 * health 14. A person who sees that the run is not opening the gap stops turning their back and deals with
 * what is coming.
 */
/** How long the gap has to have been seen shrinking. */
export const LOSING_SPAN_MS = 1500;
/** Slower than this the gap is holding (the pursuer's pace jitters a little either way). */
export const LOSING_CLOSING = 0.5;
/** On the body within this many seconds at the rate it is closing. */
export const LOSING_HORIZON_SECONDS = 4;
/** As far as a pursuer is looked for. */
const WATCH = 16;

export interface LosingPursuit { entity: any; name: string; distance: number; closing: number; contactIn: number }

interface RaceBot { entity?: { id?: number; position: { distanceTo(other: unknown): number } }; entities?: Record<string, any> }

/**
 * The pursuer the escape is losing to soonest, or null when the gap to every one is holding or growing.
 * `settled`: a pursuer just dealt with that is to be left alone for now (see EventReactionSystem's cooldown).
 */
export function losingPursuit(bot: RaceBot, settled?: (entity: any, distance: number) => boolean): LosingPursuit | null {
  const self = bot.entity;
  if (!self?.position) return null;
  let worst: LosingPursuit | null = null;
  for (const entity of Object.values(bot.entities ?? {})) {
    if (!entity?.position || entity === self || entity.id === self.id || !isHostileEntity(entity, bot as any)) continue;
    const distance = self.position.distanceTo(entity.position);
    if (distance > WATCH) continue;
    const trend = gapTrend(bot, entity.id);
    if (!trend || trend.spanMs < LOSING_SPAN_MS || trend.closing < LOSING_CLOSING) continue;
    const contactIn = secondsToContact(distance, trend.closing);
    if (contactIn === null || contactIn > LOSING_HORIZON_SECONDS || settled?.(entity, distance) || !isExposedTo(bot as any, entity)) continue;
    if (!worst || contactIn < worst.contactIn) worst = { entity, name: String(entity.name ?? '').toLowerCase(), distance, closing: trend.closing, contactIn };
  }
  return worst;
}

/**
 * What to do about a pursuer the run is losing to, by what the body has measured of it, not by its name.
 * - `fend`: one blow (or blast) of its kind can take all the health the body has, so it must never be let into
 *   contact. Face it, strike it whenever it comes within a blow (a blow knocks any mob back), and back away to
 *   keep it beyond its reach; with a shield on the arm it is raised between blows. A creeper is one of these
 *   by the hit it is known for, and so is anything that has hit the body that hard.
 * - `fight`: it hurts in ordinary blows and the body can strike back: the cornered counterattack, started
 *   before the first blow lands instead of after.
 * - `meet`: the same pursuer has caught the run up again after being fended off, and the measured race favours
 *   the body: running is not the answer to it. Stand, face it, and strike it as it arrives. In paid run L111 the
 *   body fended off and ran from the same zombies eight times in forty seconds at full health with a stone sword
 *   that kills one in 3.5 seconds.
 * Anything else is fended off too: turning the back to something faster than the body only gives it the blows.
 */
export function counterFor(input: { maxHit: number; health: number; armed: boolean; fightFavoured: boolean; distance: number; contactReach: number;
  /** Times this pursuer has already caught the run up lately. */
  repeats?: number }): 'fend' | 'fight' | 'meet' {
  if (input.maxHit >= input.health) return 'fend';
  if ((input.armed || input.fightFavoured) && input.distance <= input.contactReach) return 'fight';
  if ((input.repeats ?? 0) >= 1 && input.fightFavoured) return 'meet';
  return 'fend';
}
