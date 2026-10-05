/**
 * Fight-or-flee from measurements instead of mob-name lists and weapon
 * tables. Per mob kind the bot accumulates how hard and how often it is hit
 * while in contact; per weapon and mob kind, how long a kill took. A decision
 * compares the expected time to kill with the expected time to die at the
 * measured incoming damage rate. Human priors enter as pseudo-observations
 * and are outweighed by the bot's own experience.
 */
export interface MobStats {
  /** Hits taken while this kind was the attacker, and their total damage. */
  hits: number;
  damage: number;
  maxHit: number;
  /** Time spent within melee contact distance of this kind. */
  contactMs: number;
  /** The farthest this kind has hit the body from, in blocks (only hits the server attributed to it). Absent until it has. */
  reach?: number;
  /** Times this kind was seen to shoot at the body: something in flight, coming at it, that began where one of this kind stood. */
  shots?: number;
  /** Of its hits, those it landed itself (the server named the mob, not something in flight, as what struck). */
  blows?: number;
  /** The most health this kind has taken from the body within any three seconds: how fast it hurts when it is at it. */
  peak3s?: number;
}

export interface WeaponStats {
  /** Fights started and won, total time to kill in won fights. */
  fights: number;
  kills: number;
  killMs: number;
}

export interface CombatStatsState {
  version: 1;
  mobs: Record<string, MobStats>;
  /** Keyed `${weapon}|${mob}`, or `${weapon}|*` for priors that apply to any mob. */
  weapons: Record<string, WeaponStats>;
}

export const CONTACT_DISTANCE = 4;
const UNKNOWN_KILL_MS = 8_000;
/** The span the worst burst of a kind is measured over. */
export const PEAK_WINDOW_SECONDS = 3;
const UNKNOWN_HIT = { perHit: 3, perSecond: 1 };

/** Human priors (formerly hardcoded tables), each worth one pseudo-observation. */
export function seedCombatStats(): CombatStatsState {
  const mob = (perHit: number, maxHit = perHit, perSecond = 1): MobStats =>
    ({ hits: 1, damage: perHit, maxHit, contactMs: Math.round(1000 / perSecond) });
  const weapon = (killMs: number): WeaponStats => ({ fights: 1, kills: 1, killMs });
  return {
    version: 1,
    mobs: {
      zombie: mob(3), husk: mob(3), drowned: mob(3), zombie_villager: mob(3), spider: mob(2), cave_spider: mob(2),
      silverfish: mob(1), endermite: mob(2), piglin: mob(5), zombified_piglin: mob(5),
      skeleton: mob(3, 4), stray: mob(3, 4), witch: mob(6, 6, 0.5), creeper: mob(20, 40, 0.2), enderman: mob(7, 7),
      vindicator: mob(13, 13), ravager: mob(12, 18), warden: mob(30, 45),
    },
    weapons: Object.fromEntries([
      ['wooden_sword', 20 / 6.4], ['stone_sword', 20 / 8], ['iron_sword', 20 / 9.6], ['diamond_sword', 20 / 11.2], ['netherite_sword', 20 / 12.8],
      ['wooden_axe', 20 / 5.6], ['stone_axe', 20 / 7.2], ['iron_axe', 20 / 8.1], ['diamond_axe', 20 / 9], ['netherite_axe', 20 / 10],
      ['wooden_pickaxe', 20 / 2.4], ['stone_pickaxe', 20 / 3.6], ['iron_pickaxe', 20 / 4.8], ['diamond_pickaxe', 20 / 6], ['netherite_pickaxe', 20 / 7.2],
    ].map(([name, seconds]) => [`${name}|*`, weapon(Math.round(Number(seconds) * 1000))])),
  };
}

/**
 * The weapon priors above are the time to kill a mob of twenty health. What the game gives a kind that is not
 * twenty, for when the server's own figure for the one in front of the body cannot be read. An enderman has
 * forty: taken for twenty, it was "2.1 seconds to kill with an iron sword", the planner went for it, and it
 * killed the body with three blows (paid run L85).
 */
const MOB_MAX_HEALTH: Record<string, number> = {
  enderman: 40, hoglin: 40, zoglin: 40, ravager: 100, warden: 500, iron_golem: 100, witch: 26, vindicator: 24, evoker: 24,
  spider: 16, cave_spider: 12, piglin: 16, piglin_brute: 50, ghast: 10, silverfish: 8, endermite: 8, vex: 14, phantom: 20,
  guardian: 30, elder_guardian: 80, shulker: 30, wither: 300,
};
const PRIOR_TARGET_HEALTH = 20;

export function emptyCombatStats(): CombatStatsState { return { version: 1, mobs: {}, weapons: {} }; }

/** Sum two states field by field (base snapshot + this process's unsaved delta). */
export function mergeCombatStats(base: CombatStatsState, delta: CombatStatsState): CombatStatsState {
  const out: CombatStatsState = structuredClone(base);
  for (const [name, d] of Object.entries(delta.mobs)) {
    const m = out.mobs[name] ??= { hits: 0, damage: 0, maxHit: 0, contactMs: 0 };
    m.hits += d.hits; m.damage += d.damage; m.contactMs += d.contactMs; m.maxHit = Math.max(m.maxHit, d.maxHit);
    if (d.reach !== undefined) m.reach = Math.max(m.reach ?? 0, d.reach);
    if (d.shots) m.shots = (m.shots ?? 0) + d.shots;
    if (d.blows) m.blows = (m.blows ?? 0) + d.blows;
    if (d.peak3s) m.peak3s = Math.max(m.peak3s ?? 0, d.peak3s);
  }
  for (const [key, d] of Object.entries(delta.weapons)) {
    const w = out.weapons[key] ??= { fights: 0, kills: 0, killMs: 0 };
    w.fights += d.fights; w.kills += d.kills; w.killMs += d.killMs;
  }
  return out;
}

/**
 * How far the body has to be from this kind of mob before its attacks stop, by what the body has measured:
 * the farthest it has been hit from, with room to spare. Zero for a kind that has only ever hit from contact
 * (or never): for those the ordinary clearance holds. No list of "ranged mobs": a skeleton is known to shoot
 * because it has shot.
 */
export function attackReach(stats: CombatStatsState, mob: string): number {
  const reach = stats.mobs[mob]?.reach ?? 0;
  return reach > CONTACT_DISTANCE + 2 ? reach : 0;
}

/**
 * Whether this kind attacks the body with shots, by what the body has seen of it: no list of mobs that shoot.
 * It has been seen shooting at the body, or has hit it from further off than a blow reaches, and has not
 * struck the body itself more often than it has shot (a skeleton that got close and hit with its bow arm once
 * is still one that shoots).
 */
export function shootsAtBody(stats: CombatStatsState, mob: string): boolean {
  const m = stats.mobs[mob];
  return !!m && ((m.shots ?? 0) >= 1 || attackReach(stats, mob) > 0) && (m.shots ?? 0) >= (m.blows ?? 0);
}

export interface IncomingThreat { name: string; distance: number }

export interface EncounterEstimate {
  /** Expected ms to kill the target with the best carried weapon. */
  timeToKillMs: number;
  /** Expected ms until death at the combined incoming rate of everything in contact. */
  timeToDieMs: number;
  weapon: string | null;
  /** A single hit from something nearby could kill outright. */
  lethalBurst: boolean;
  fight: boolean;
  reason: string;
}

export function incomingDamagePerSecond(stats: CombatStatsState, name: string): number {
  const m = stats.mobs[name];
  if (!m || m.hits === 0 || m.contactMs <= 0) return UNKNOWN_HIT.perHit * UNKNOWN_HIT.perSecond;
  // The average over all the time spent near this kind says how it went on the whole; a fight is lost in its
  // worst seconds. Two wither skeletons were "nine seconds to die" by the average (their hits thinned out by
  // the seconds spent walled off beside them) and took the body from full health to dead in two (lab
  // continuation L77q). The fastest this kind has ever hurt the body stands beside the average, and the
  // larger of the two is used.
  return Math.max((m.damage / m.hits) * Math.min(4, m.hits / (m.contactMs / 1000)), (m.peak3s ?? 0) / PEAK_WINDOW_SECONDS);
}

export function expectedKillMs(stats: CombatStatsState, weapon: string, mob: string, targetHealth?: number): number {
  const specific = stats.weapons[`${weapon}|${mob}`];
  const general = stats.weapons[`${weapon}|*`];
  const kills = (specific?.kills ?? 0) + (general?.kills ?? 0);
  // The prior is for twenty health; what has been measured on this kind is that kind's own.
  const health = targetHealth && targetHealth > 0 ? targetHealth : MOB_MAX_HEALTH[mob] ?? PRIOR_TARGET_HEALTH;
  const ms = (specific?.killMs ?? 0) + (general?.killMs ?? 0) * (health / PRIOR_TARGET_HEALTH);
  return kills > 0 ? ms / kills : UNKNOWN_KILL_MS;
}

/** About how often the body swings (the cornered counterattack's period): how many blows a kill takes. */
export const SWING_MS = 650;
/** Durability a blow costs the item: one for a sword or a trident, two for any other tool (a pickaxe, an axe). */
export function wearPerHit(item: string): number {
  return /_sword$|^trident$/.test(item) ? 1 : 2;
}

/**
 * Which carried weapon to strike with. The fastest kill used to win outright: the iron pickaxe kept for the
 * Nether was swung at zombies ("TTK≈3.3s(iron_pickaxe)") with a stone sword in the bag that kills in 3.5
 * (paid run L111), and a pickaxe loses two points a blow. Of the weapons that kill nearly as fast as the
 * fastest, and fast enough to win the race against what is in contact, the one cheapest in time plus wear.
 * When the race is tight (only the fastest is fast enough) the fastest is used, whatever it costs.
 */
export function chooseWeapon(options: Array<{ name: string; killMs: number }>, input: { timeToDieMs: number; elapsedMs?: number; wearCost?: (item: string) => number }): { name: string; killMs: number } | null {
  if (!options.length) return null;
  const fastest = options.reduce((best, option) => (option.killMs < best.killMs ? option : best));
  if (!input.wearCost) return fastest;
  const elapsed = input.elapsedMs ?? 0;
  const acceptable = options.filter(option => option.killMs <= fastest.killMs * 1.25 + 1000
    && (!Number.isFinite(input.timeToDieMs) || Math.max(0, option.killMs - elapsed) * 1.5 < input.timeToDieMs));
  if (!acceptable.length) return fastest;
  const cost = (option: { name: string; killMs: number }) =>
    option.killMs / 1000 + (option.killMs / SWING_MS) * wearPerHit(option.name) * input.wearCost!(option.name);
  return acceptable.reduce((best, option) => (cost(option) < cost(best) ? option : best));
}

/**
 * Fight only when the escape is demonstrably failing and the measured race
 * favours the bot: it should finish the target before the combined damage of
 * everything in contact would finish it, and nothing nearby can kill it in one
 * hit. `elapsedMs` lets a running fight re-check its remainder.
 */
export function estimateEncounter(stats: CombatStatsState, input: {
  target: string; health: number; threats: IncomingThreat[]; carried: string[]; escapeFailing: boolean; elapsedMs?: number;
  /** The target's own health, as the server gives it, when it can be read. */
  targetHealth?: number;
  /** Seconds one point of this item's durability is worth (see the minebot's toolChoice); none: wear is not weighed. */
  wearCost?: (item: string) => number;
}): EncounterEstimate {
  const candidates = input.carried.filter(name => stats.weapons[`${name}|${input.target}`] || stats.weapons[`${name}|*`]);
  const contact = input.threats.filter(threat => threat.distance <= CONTACT_DISTANCE + 2);
  const incoming = contact.reduce((sum, threat) => sum + incomingDamagePerSecond(stats, threat.name), 0);
  const timeToDieMs = incoming > 0 ? (input.health / incoming) * 1000 : Infinity;
  const choice = chooseWeapon(candidates.map(name => ({ name, killMs: expectedKillMs(stats, name, input.target, input.targetHealth) })),
    { timeToDieMs, elapsedMs: input.elapsedMs ?? 0, wearCost: input.wearCost });
  const weapon = choice?.name ?? null;
  const killMs = choice?.killMs ?? UNKNOWN_KILL_MS * 2.5; // bare hands, nothing learned
  const remainingKillMs = Math.max(0, killMs - (input.elapsedMs ?? 0));
  // The blows of the mob already being fought are what the race is run
  // against; they are not news. A live probe broke off at 0.0s from the kill
  // because the zombie's ordinary hit now exceeded the remaining health, then
  // died turning away. Something else nearby that can kill in one hit still is.
  const committed = input.elapsedMs !== undefined;
  const lethalBurst = input.threats.some(threat => threat.distance <= 8 && !(committed && threat.name === input.target)
    && (stats.mobs[threat.name]?.maxHit ?? 0) >= input.health);
  // A failing escape takes the same damage without ever removing its source,
  // so the comparison is kill-before-death, not kill-with-margin. A margin made
  // a cornered bot keep fleeing a lone zombie until it died (paid run L6), and
  // a bot that never fights never measures its real kill times.
  const fight = input.escapeFailing && !lethalBurst && remainingKillMs < timeToDieMs;
  const reason = `TTK≈${(remainingKillMs / 1000).toFixed(1)}s(${weapon ?? '素手'}) TTD≈${Number.isFinite(timeToDieMs) ? (timeToDieMs / 1000).toFixed(1) : '∞'}s`
    + `${lethalBurst ? ' 一撃で倒される恐れ' : ''}${input.escapeFailing ? '' : ' 逃走は有効'}`;
  return { timeToKillMs: remainingKillMs, timeToDieMs, weapon, lethalBurst, fight, reason };
}
