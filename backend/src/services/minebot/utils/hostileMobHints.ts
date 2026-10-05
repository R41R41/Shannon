/**
 * 敵対 Mob 名のヒント（部分一致）。CombatEventHandler / 距離判定で共有する。
 * リストを変える場合は CombatEventHandler と整合させること。
 */
export const HOSTILE_MOB_NAME_HINTS: readonly string[] = [
  'zombie',
  'skeleton',
  'creeper',
  'spider',
  'witch',
  'phantom',
  'drowned',
  'husk',
  'stray',
  'blaze',
  'ghast',
  'magma_cube',
  'slime',
  'pillager',
  'vindicator',
  'evoker',
  'warden',
  'piglin_brute',
  'hoglin',
  'zoglin',
] as const;

/**
 * What the list above does not name is learned the way a person learns it: a kind of mob that has just hit
 * the body is hostile to it, whatever it is called. The list is what is known beforehand (it has no piglin,
 * which attacks anyone not wearing gold, and nothing a later version adds); the hit is the evidence. The
 * memory fades: a wolf or a zombified piglin hit back at leaves its kind alone again after a while, and an
 * emergency for every one of them for the rest of the session would be a worse mistake than the first hit.
 */
export const ATTACK_MEMORY_MS = 5 * 60_000;
const attackedBy = new Map<string, number>();

export function noteAttackedBy(mobName: string, now = Date.now()): void {
  const n = mobName.trim().toLowerCase();
  if (n) attackedBy.set(n, now + ATTACK_MEMORY_MS);
}

/** Known beforehand to be hostile (the list alone, without what has been learned from being hit). */
export function isListedHostileMobName(mobName: string): boolean {
  const n = mobName.toLowerCase();
  return HOSTILE_MOB_NAME_HINTS.some((h) => n.includes(h));
}

export function isLikelyHostileMobName(mobName: string, now = Date.now()): boolean {
  const n = mobName.toLowerCase();
  if (isListedHostileMobName(n)) return true;
  const until = attackedBy.get(n);
  if (until === undefined) return false;
  if (until > now) return true;
  attackedBy.delete(n);
  return false;
}

/**
 * Kinds the game itself sets down as hostile that leave the body alone until it gives them cause: they are a
 * threat once one has struck (see noteAttackedBy), not before.
 */
const NEUTRAL_UNTIL_STRUCK: readonly string[] = ['zombified_piglin', 'piglin', 'enderman'];

/**
 * Of the neutral kinds, those whose anger the server shows: the flag (by its name in the entity's data) it sets
 * while one is after someone. An enderman is left alone unless it is looked in the eye or struck (the gaze guard
 * keeps the look off its eyes). It was on the list of hostiles: one wandering six blocks off was an emergency,
 * the measures said it was "faster to kill", the planner struck it, and it killed the body with three blows of
 * 6.3 (paid run L85, fifteen minutes in).
 */
const ANGER_FLAGS: Record<string, string> = { enderman: 'creepy' };

interface DataRegistry { entitiesByName?: Record<string, { metadataKeys?: string[] } | undefined> }
/** The body a judgement is made for, as far as it bears on it: the game's data, and what it wears. */
export interface ThreatBody { registry?: DataRegistry | null; inventory?: { slots?: Array<{ name?: string } | null | undefined> } }

/** The armour slots of a player's inventory window (head, chest, legs, feet). */
const ARMOUR_SLOTS = [5, 6, 7, 8];

/**
 * A piglin goes for any player who wears no piece of gold armour; with one on it leaves them alone (and trades).
 * Taken as neutral until struck, two of them were run into while the body fled a hoglin, and killed it with two
 * blows of 5.1 a minute after it came through the portal (paid run L88b, wearing iron).
 */
function wearsGold(body?: ThreatBody | null): boolean {
  const slots = body?.inventory?.slots;
  return Array.isArray(slots) && ARMOUR_SLOTS.some(index => String(slots[index]?.name ?? '').startsWith('golden_'));
}
const HOSTILE_UNLESS_GOLD: readonly string[] = ['piglin'];

/** Whether a neutral one is after someone now, by the flag the server sets for it (false when it cannot be read). */
export function isAngry(entity: { name?: string | null; metadata?: unknown[] } | null | undefined, registry?: DataRegistry | null): boolean {
  const name = String(entity?.name ?? '').toLowerCase();
  const flag = ANGER_FLAGS[name];
  if (!flag || !Array.isArray(entity?.metadata)) return false;
  const index = registry?.entitiesByName?.[name]?.metadataKeys?.indexOf(flag) ?? -1;
  return index >= 0 && entity!.metadata![index] === true;
}

/**
 * A hostile by kind or by what has struck the body, a neutral one that is angry now, or one that goes for the
 * body as it is dressed (a piglin, at a body without gold).
 */
export function isHostileEntity(entity: { name?: string | null; metadata?: unknown[] } | null | undefined, body?: ThreatBody | null, now = Date.now()): boolean {
  const name = String(entity?.name ?? '').toLowerCase();
  return !!name && (isLikelyHostileMobName(name, now) || isAngry(entity, body?.registry)
    || (HOSTILE_UNLESS_GOLD.includes(name) && !!body && !wearsGold(body)));
}

/**
 * Whether an entity is a threat to the body: one answer for every place that asks.
 *
 * There were three. The watch that starts an emergency went by the list of names above and by who had struck.
 * The check that ends an emergency, the count of who will reach the body first, and the habit of running from
 * hostiles went by the game's own category, in which a zombified piglin is "hostile". So a zombified piglin
 * never started an emergency, but one wandering within sixteen blocks kept an emergency from ending, and one
 * standing five blocks off was "about to reach the body" and a shelter was refused for it (lab continuation
 * L77r, and the same refusal reproduced on the fortress bridge without a model). The Nether is full of them.
 */
export function isThreatEntity(entity: { name?: string | null; type?: string | null; metadata?: unknown[] } | null | undefined, registryType?: string | null, now = Date.now(), body?: ThreatBody | null): boolean {
  const name = String(entity?.name ?? '').toLowerCase();
  if (!name) return false;
  if (isLikelyHostileMobName(name, now)) return true;
  if (NEUTRAL_UNTIL_STRUCK.includes(name)) return isHostileEntity(entity, body, now);
  return (registryType ?? entity?.type) === 'hostile';
}
