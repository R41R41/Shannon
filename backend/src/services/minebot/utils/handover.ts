import { cancelAction, physicalRoots } from '../execution/ActionExecution.js';
import { findEntity } from './primitives/use.js';
import { lifeOf } from './life.js';

/**
 * The handover from a reflex to the act that is for the same enemy (continue contracts, 4). Run 45, +929: a fight act that came while the melee reflex
 * was at the enemy waited 6.4 s behind it. Only a reflex that is already doing what the act would do is taken over from:
 *
 * - `floor-melee` (a hand of its episode), and `floor-last-stand` while health is above LAST_STAND_YIELD_HP (it hits). The flee at low health, lava, a wall,
 *   a retreat, a dig out, breath, a meal and armour are never taken from. An ordinary act is not raised in priority (a meal must not be cut).
 * - the act's first hand that moves the body is a `fight` or an `attack`, and its target is the enemy of the reflex's current hand.
 *
 * This only decides and starts it: the reservation (ActionExecution `reserveHandover`) is made before the reflex is stopped, the stop is for the reason
 * `handover` (the shield is not lowered, the keys are let go), and the act takes the body and the shield's right in the moment it gets the lock.
 */
export const HANDOVER_REFLEXES: ReadonlySet<string> = new Set(['floor-melee', 'floor-last-stand']);
/** Above this health a last stand's hit may be taken over (at or below it the reflex is the body's own limit). */
export const LAST_STAND_YIELD_HP = 5;

export interface HandoverPlan { reflex: string; actionId: string; target: number; shield: boolean }

interface ActHandLike { do?: unknown; target?: unknown; item?: unknown; hold?: unknown }

/**
 * The first hand that would move the body. A hand that is already satisfied (`equip` of what is held, `look`, `sneak`, `jump` before the fight, an `eat`
 * with a full stomach) does not count: it is skipped, as the hand's own already.
 */
export function firstMovingHand(bot: any, hands: ActHandLike[]): ActHandLike | null {
  for (const hand of hands) {
    const kind = String(hand?.do ?? '');
    if (kind === 'look' || kind === 'sneak' || kind === 'wait') continue;
    if (kind === 'equip' && typeof hand.item === 'string' && (bot.heldItem?.name === hand.item)) continue;
    if (kind === 'eat' && (bot.food ?? 0) >= 20) continue;
    return hand;
  }
  return null;
}

/** The id of the creature a fight or attack hand is after, or null. */
export function handTargetId(bot: any, hand: ActHandLike): number | null {
  const raw = hand.target;
  if (typeof raw === 'number') return raw;
  if (typeof raw !== 'string') return null;
  if (/^#\d+$/u.test(raw.trim())) return Number(raw.trim().slice(1));
  const entity = findEntity(bot, raw, 32);
  return typeof entity?.id === 'number' ? entity.id : null;
}

/** The target the reflex's current hand is after: set by the floor when it starts a hit or a melee hand. */
export function reflexTargetOf(bot: any, capability: string): number | undefined {
  const mark = bot.floorReflexes?.handTarget as { capability?: string; target?: number } | undefined;
  return mark && mark.capability === capability && typeof mark.target === 'number' ? mark.target : undefined;
}

/** The plan to take the body over from the reflex, or null (then the act waits for the reflex, as before). */
export function planHandover(bot: any, args: unknown): HandoverPlan | null {
  const hands = (args as { hands?: ActHandLike[] } | undefined)?.hands;
  if (!Array.isArray(hands)) return null;
  const first = firstMovingHand(bot, hands);
  if (!first || (first.do !== 'fight' && first.do !== 'attack')) return null;
  const target = handTargetId(bot, first);
  if (target === null) return null;
  const roots = physicalRoots(bot).filter(root => root.safetyLease && HANDOVER_REFLEXES.has(root.capability));
  if (roots.length !== 1) return null;
  // Nothing else holds the body: no other safety lease (a lava escape, a breath, a meal) beside it.
  if (physicalRoots(bot).some(root => root.safetyLease && root !== roots[0] && !HANDOVER_REFLEXES.has(root.capability))) return null;
  const root = roots[0];
  if (root.capability === 'floor-last-stand' && (bot.health ?? 20) <= LAST_STAND_YIELD_HP) return null;
  const reflexTarget = reflexTargetOf(bot, root.capability);
  if (reflexTarget === undefined || reflexTarget !== target) return null;
  return { reflex: root.capability, actionId: root.actionId, target, shield: bot.shieldBlock?.up === true };
}

/** The last check, made in the moment the act takes the lock: the enemy is still there, and it is the same life. */
export function handoverStillHolds(bot: any, plan: HandoverPlan, life: number | undefined): boolean {
  const entity = bot.entities?.[plan.target];
  if (!entity || entity.isValid === false || (typeof entity.health === 'number' && entity.health <= 0)) return false;
  const now = lifeOf(bot);
  if (life !== undefined && now && now.number !== life) return false;
  return (bot.health ?? 20) > 0;
}

/** Stops the reflex's action for the handover (the shield stays; the keys are let go). */
export function stopReflexForHandover(bot: any, plan: HandoverPlan): boolean {
  return cancelAction(bot, plan.actionId, 'handover');
}
