import { Vec3 } from 'vec3';
import { createLogger } from '../../../utils/logger.js';
import { actionLeaseStatus, actionSignal, activeActionCapabilities, createMotorPort, executeAction, hasActiveSafetyLease, physicalActionBusy, physicalRoots, preemptLowerPriorityActions, safetyLeaseCapabilities } from '../execution/ActionExecution.js';
import { isHeadCombatActive, isHeadCombatRunning } from './combatOwner.js';
import { creeperLit } from './creeperFuse.js';
import { FALLBACK_FOOD_POINTS, RAW_FOOD } from '../constantSkills/autoEat.js';
import { edgeRisk, fallIsDangerous } from './edgeGuard.js';
import { escapeHeading } from './escapeHeading.js';
import { floorConfig, type FloorConfig } from './floorConfig.js';
import { eatIsCritical, FloorBudget, type BudgetKind } from './floorBudget.js';
import { isThreatEntity, type ThreatBody } from './hostileMobHints.js';
import { ensureReflexLedger, type ReflexKind, type ReflexOutcome } from './reflexLedger.js';
import { openSightLines, seesBodyAt, threatExposure } from './threatExposure.js';
import { holdsWater } from './waterBlocks.js';
import { bodyReader, feetCell } from './localMap.js';
import { climbRise, enterable, MAX_CLIMB, passable, standable } from './walkRules.js';
import { footingAt, footingWords, type Footing } from './voidFooting.js';
import { isBurning, lavaReleasedBy } from './lavaSafety.js';
import { engagedWithAny } from './engagement.js';
import { PROTECTED_UTILITY_BLOCKS } from '../constants.js';
import { entityHealth } from './mapMarks.js';
import { eyeOf, probeSight } from './probeTools.js';

const log = createLogger('Minebot:FloorReflexes');

/**
 * The floor (Syzygy ADR-0010 D8, ADR-0011 §4.6, owner answer "defence only", 2026-10-14): what cannot wait for a network
 * decision, done in the body on its physics tick, with no model and no attack. The breathing, lava, shield, knock and edge
 * reflexes already run here; this adds the three that common-FCA mode had switched off with the constant skills: stepping
 * back from a lit creeper or an arrow on its way, eating when short. Each takes the
 * body through ActionExecution with a safety lease, so a model's action or a reflex session underneath gives way, and gives
 * it back by ending; the one above decides again from a fresh observation.
 */
export const FLOOR_RETREAT_PRIORITY = 350;
export const FLOOR_EAT_PRIORITY = 200;
/** Between the retreat (350) and the meal (200): the low-health flee (default mode, P8). */
export const FLOOR_FLEE_PRIORITY = 250;
/**
 * The low-health flee (P8, third round). At or below this health (the API's own `lowHealth`; the legacy autoRunFromHostiles ran at 5) a
 * threat (the legacy `isThreatEntity`, not a fixed list) within FLEE_RANGE that can get at the body starts a flee episode: 8 m, or 16 m for
 * a kind that shoots (the legacy radius, where being seen is the danger). An episode keeps going while one is within FLEE_KEEP_RANGE (12 m,
 * 20 m for shooters; so the body does not stop the moment it is 8.1 m away), in segments of one lease each (at most 1.2 s or 7 blocks:
 * a segment is shorter than the 3 s an API release waits for a safety lease, and a command waiting behind it ends the segment and the episode), the heading
 * chosen again every physics tick from ALL threats. An episode ends at 32 blocks from where it began (the legacy run was 32 m), after 6 s,
 * when it is not getting anywhere, or when nothing is near; it is then followed by 2 s of rest in which the API's fast judgment (shelter,
 * flee-from, a fight) has the body. At most two episodes in 20 s: the guard against a loop.
 */
// Was 6 (the API's lowHealth). Run 16 died to zombies in a cave: the flee began at 3.7 with one hit left, found no way out, and that was
// the end. At 8 the body still has two zombie hits in hand when it starts (owner's change, 2026-10-19).
export const FLEE_HEALTH = 8;
const FLEE_RANGE = 8;
const FLEE_RANGE_SHOOTER = 16;
const FLEE_KEEP_RANGE = 12;
const FLEE_KEEP_RANGE_SHOOTER = 20;
const FLEE_SEGMENT_TICKS = 24;
const FLEE_SEGMENT_BLOCKS = 7;
const FLEE_YIELD_AFTER_TICKS = 4;
/** How far ahead a heading is read for lava, fire, a drop or a wall (the heading itself is chosen again at every tick). */
const FLEE_LOOKAHEAD = 5;
const FLEE_EPISODE_BLOCKS = 32;
const FLEE_EPISODE_MS = 6000;
const FLEE_REST_MS = 2000;
/** A segment that moved less than this made no headway; two in a row end the episode. */
const FLEE_MIN_HEADWAY = 1.5;
/** After a refusal (no safe way) the ground is not read again for this long. */
const FLEE_REFUSAL_CACHE_MS = 500;
const FLEE_REFUSAL_NOTE_GAP_MS = 10_000;
const FLEE_WINDOW_MS = 20_000;
const FLEE_MAX_IN_WINDOW = 2;
/** Kinds that hurt from afar: the flee starts earlier for them (what the legacy 16 m watch was for). */
const SHOOTERS = new Set(['skeleton', 'stray', 'bogged', 'pillager', 'blaze', 'ghast', 'witch', 'evoker', 'breeze']);
/** The kinds whose shots are arrows: a fight with one of them is not cut by an arrow's step aside (a blaze fight still is). */
const ARCHERS = ['skeleton', 'stray', 'bogged', 'pillager', 'piglin'];
/**
 * Skills that are already getting the body out of danger: no floor reflex (the flee, a meal, an armour change, an arrow step-aside) cuts one of
 * these, except starvation (food 3 or less) and a lit creeper. The API's DEFENSIVE_SKILLS (`mind/action/reflex/fastJudgment.ts`) that escape
 * (flee-from, dig-shelter, build-around-self; its attack-* / retreat-attack are fights, which the API's own fast judgment cuts at health 6 or
 * less, so they stay cuttable here), and the other commands whose whole purpose is to get the body out of danger: leave-water (out of water),
 * tower-up (up out of reach), climb-down (off a ledge or out of a hole) and enter-portal (out of the dimension).
 */
export const ESCAPE_SKILLS: ReadonlySet<string> = new Set(['flee-from', 'dig-shelter', 'build-around-self', 'leave-water', 'tower-up', 'climb-down', 'enter-portal']);
/** One retreat lasts at most a second, or three blocks (ADR-0010 D8). */
const RETREAT_TICKS = 20;
const RETREAT_BLOCKS = 3;
const RETREAT_COOLDOWN_TICKS = 10;
/**
 * A lit creeper's retreat runs until the body is this far from it (a creeper's blast reaches about 7 m; run 27: the
 * step back lasted about a second and three blocks, the blast still took 16.4), or the creeper is gone or no longer lit, or
 * CREEPER_RETREAT_TICKS ticks have passed. It runs along a heading the flee's look-ahead finds safe, checked every tick; no such heading,
 * or less than CREEPER_HEADWAY blocks in CREEPER_STILL_TICKS ticks, is `cornered` (the last stand). The default mode and the arrow's
 * side-step keep RETREAT_TICKS / RETREAT_BLOCKS, straight away.
 */
const CREEPER_SAFE_METERS = 7;
const CREEPER_RETREAT_TICKS = 40;
const CREEPER_STILL_TICKS = 8;
const CREEPER_HEADWAY = 0.5;
/** A creeper starts its fuse at three blocks and blows at about three; a lit one this close is stepped away from. */
const CREEPER_REACH = 4.5;
const ARROW_REACH = 12;
const HOSTILE_NEAR = 5;
const RETRY_AFTER_MS = 3000;

type Item = { name: string; type?: number; slot?: number };
interface FloorEntity {
  id?: number; name?: string; type?: string; position: Vec3; velocity?: Vec3; metadata?: unknown[];
  isInLava?: boolean; isInWater?: boolean; onGround?: boolean; height?: number; width?: number; health?: number;
}
export interface FloorBody {
  entity?: FloorEntity; entities?: Record<string, FloorEntity>;
  health?: number; food?: number; heldItem?: Item | null;
  inventory?: { items(): Item[]; slots?: (Item | null)[] };
  setControlState(control: string, state: boolean): void;
  look?(yaw: number, pitch: number, force?: boolean): unknown;
  equip?(item: Item, destination: string): Promise<void>;
  consume?(): Promise<void>;
  on(event: 'physicsTick', listener: () => void): unknown;
  floorReflexes?: FloorState;
  lavaReflex?: { engaged: boolean };
  breathingReflex?: { engaged: boolean };
  /** True while a command, a lease or a held body is the control loop's (set by createCommonFcaBody; absent in tests and probes). */
  fcaLeaseHeld?: () => boolean;
  /** The game's data, as far as `isThreatEntity` reads it (an entity's kind, an angry enderman's flag). */
  registry?: { entitiesByName?: Record<string, { type?: string; metadataKeys?: string[] } | undefined> } | null;
  /** Kinds the body has learned shoot at it (combat knowledge), added to the flee's shooters. */
  shootsAtBody?: (kind: string) => boolean;
  /** Where a refused flee is told to the mind (`state.world.reflexes`). */
  reflexLedger?: { note(kind: ReflexKind, detail: string, outcome?: ReflexOutcome): unknown };
  /** The body's skills: the shelter a refused flee falls back on (build-around-self, tower-up). Absent in most tests. */
  instantSkills?: { getSkill(name: string): unknown };
  /** r10: the protocol client, for the server's `damage_event` (who shot, and with what); absent in tests that send none. */
  _client?: { on?(event: string, listener: (packet: any) => void): unknown };
}
export interface RetreatState {
  engaged: boolean; kind?: 'creeper' | 'arrow'; from?: Vec3; origin?: Vec3; ticks: number; cooldown: number; engagements: number;
  release?: () => void;
  /** Set when the retreat ended before its action started, so a waiting action ends at once instead of holding the body. */
  done?: boolean;
  /** Last seen position of each arrow: one that did not move since the last tick is stuck, whatever velocity it reported. */
  arrows?: Map<number, Vec3>;
  /**
   * A lit creeper: the retreat runs to CREEPER_SAFE_METERS along a heading the flee's look-ahead finds safe (`heading`,
   * kept from tick to tick), and says `cornered` when there is none or the body makes no headway (`checkpoint`, `stillTicks`).
   */
  far?: boolean;
  heading?: number;
  checkpoint?: Vec3;
  stillTicks?: number;
}
/** One run from danger, in segments (`fleeStart`). */
export interface FleeEpisode {
  startedAt: number; origin: Vec3; segments: number;
  /** The heading of the last tick, kept from one segment to the next (`fleeHeadingPlan`: no oscillation between several threats). */
  heading?: number;
  /** Segments in a row that made no headway. */
  stalls: number;
  /** How the latest segment ended, for the ledger entry the episode leaves. */
  outcome: ReflexOutcome;
  /** Called once when the episode is over (the ledger entry). */
  end?: (outcome: ReflexOutcome) => void;
}
export interface FloorState {
  retreat: RetreatState; busy: 'eat' | 'armor' | 'flee' | null; retryAt: number; engagements: { eat: number; armor: number; flee?: number; fleeRefused?: number };
  /** When each flee episode of the last 20 s began (the flee's own allowance). */
  fleeStarts?: number[];
  fleeEpisode?: FleeEpisode;
  /** No new episode before this (the rest after one) and no ground reading before this (the cache after a refusal). */
  fleeRestUntil?: number;
  fleeRefusedUntil?: number;
  fleeRefusedNotedAt?: number;
  /** Set by a refused flee: the tick makes the last stand (`lastStandChoice`); at most once in LAST_STAND_GAP_MS. */
  lastStandWanted?: boolean;
  lastStandAt?: number;
  /** r10: the clock the floor runs on (a test's), for `reflexHeld`. */
  clock?: () => number;
  /** The kind of the last stand that failed: the next one tries another way. */
  lastStandFailed?: LastStand['kind'];
  /** When the retreat from a lit creeper found no way away: the creeper's last stand is wanted until CORNERED_WAIT_MS after. */
  creeperCornered?: number;
  /** Cooldowns, the allowance and the stuck latch of the arrow step-aside, the meal and the armour change (`floorBudget.ts`); absent when denied. */
  budget?: FloorBudget;
  /** r7, the cover: the episode (its digs, when its last hand ended), the next look, the last "no hand" note, and the health seen. */
  cover?: { since: number; digs: number; lastEnd: number; /** r10: the blocks put on a shooter's line in this episode. */ lines?: number };
  coverNextAt?: number;
  coverNotedAt?: number;
  healthSeen?: { last: number; fellAt: number };
  /**
   * r10, the shots that landed (run 34: a piglin's crossbow, 6 times in 14 s, no reflex): a hit the server names as a projectile with a
   * shooter behind it (`damage_event`: cause and direct entity differ), newest last; `damageAt` is when the server named any hit, `falls`
   * when health fell. A fall the server named nothing for is a shot only when a shooter that sees the body stands out of a blow's reach.
   */
  shots?: Array<{ at: number; shooter: number }>;
  damageAt?: number[];
  falls?: number[];
  /** r8, the melee hand: the episode (hands made, when the last ended), the next look, the last "no hand" note. */
  melee?: { since: number; hands: number; lastEnd: number; /** r9: the hands that were blows (their own allowance). */ hits?: number;
    /** Continue contracts (4): the enemy of the episode's latest hand, the kind of that hand, and when the cap was told (once per episode). */
    target?: number; lastKind?: string; cappedAt?: number };
  /** Continue contracts (4): the enemy the running hit hand (the melee's, the last stand's) is after: what an act for the same enemy takes the body over from. */
  handTarget?: { capability: string; target: number; at: number };
  /** Continue contracts (4): after a cap, the move the reflex had already chosen goes on for a short while, and nothing new is chosen. */
  bridge?: ReflexBridge;
  meleeNextAt?: number;
  meleeNotedAt?: number;
}

/** Continue contracts (4): what the reflex goes on with after its cap; the holder in the control view while it lasts. */
export interface ReflexBridge { after: string; hold: 'shield' | 'step_back'; target?: number; since: number; until: number }
/** How long the bridge lasts from the first notice (a first value; a later notice never extends it). */
export const BRIDGE_MS = 3000;
/** Health at or below which the bridge ends (the low-health reflexes take the body back). */
export const BRIDGE_END_HP = 5;

/**
 * The bridge now, or null. It ends when: a command began (a body-moving root that is not a reflex), the enemy is gone, health is at or below
 * BRIDGE_END_HP, or its time is up. Reading it ends it (the state is cleared) so that nothing keeps holding after.
 */
export function bridgeOf(bot: object, now = Date.now()): ReflexBridge | null {
  const b = bot as { floorReflexes?: FloorState; health?: number; entities?: Record<string, { isValid?: boolean; health?: number } | undefined> };
  const state = b.floorReflexes;
  const bridge = state?.bridge;
  if (!state || !bridge) return null;
  const ended = now >= bridge.until || (b.health ?? 20) <= BRIDGE_END_HP
    || (bridge.target !== undefined && (() => { const e = b.entities?.[bridge.target!]; return !e || e.isValid === false || (typeof e.health === 'number' && e.health <= 0); })())
    || physicalRoots(bot).some(root => !root.safetyLease);
  if (ended) { state.bridge = undefined; return null; }
  return bridge;
}
/** The melee episode as the control view shows it (4), or null. */
export function meleeEpisodeView(bot: object, now = Date.now()): { reflex: string; target?: number; hands: number; hits: number; since: number } | null {
  const state = (bot as { floorReflexes?: FloorState }).floorReflexes;
  const melee = state?.melee;
  if (!melee || !(state!.busy === 'flee' || now - melee.lastEnd <= MELEE_EPISODE_MS)) return null;
  return { reflex: 'floor-melee', ...(melee.target !== undefined ? { target: melee.target } : {}), hands: melee.hands, hits: melee.hits ?? 0, since: melee.since };
}

export { creeperLit };
/** What `floor` mode (exactly the 2026-10-16 production floor) takes for an enemy when it decides whether to eat or put on armour. */
const hostileNames = new Set(['zombie', 'husk', 'drowned', 'skeleton', 'stray', 'creeper', 'spider', 'cave_spider', 'witch',
  'pillager', 'vindicator', 'piglin_brute', 'hoglin', 'zoglin', 'blaze', 'wither_skeleton', 'slime', 'magma_cube', 'phantom']);
function others(bot: FloorBody): FloorEntity[] {
  return Object.values(bot.entities ?? {}).filter(entity => entity && entity !== bot.entity && entity.position);
}
/**
 * Whether an entity is a threat to the body: the legacy system's one answer (`isThreatEntity`, hostileMobHints.ts), not a list of
 * names. It counts what the game says is hostile (silverfish, vex, ravager, guardian, warden, evoker, bogged ...), a piglin while the
 * body wears no gold, a zombified piglin or enderman only once angry or after one has struck, and any kind that has hit the body
 * (`noteAttackedBy`, 5 minutes). The same predicate decides the flee, eating near an enemy and walking to a drop.
 */
export function isThreat(bot: FloorBody, entity: FloorEntity): boolean {
  const name = String(entity.name ?? '').toLowerCase();
  if (!name) return false;
  try { return isThreatEntity({ name, type: entity.type, metadata: entity.metadata }, bot.registry?.entitiesByName?.[name]?.type, Date.now(), bot as ThreatBody); }
  catch { return false; }
}
/**
 * An enemy within `reach`. `wide` (default mode) is `isThreat`; `floor` mode keeps the production floor's fixed list of names.
 * `openOnly` leaves out an enemy that can neither see nor reach the body (walled off: `threatExposure` says `sealed`), as the flee does.
 */
export function hostileWithin(bot: FloorBody, reach: number, wide = true, openOnly = false): boolean {
  const at = bot.entity?.position; if (!at) return false;
  return others(bot).some(entity => {
    if (!(wide ? isThreat(bot, entity) : hostileNames.has(String(entity.name))) || entity.position.distanceTo(at) > reach) return false;
    if (openOnly) { try { if (threatExposure(bot as any, entity as any) === 'sealed') return false; } catch { /* unknown: counts as near */ } }
    return true;
  });
}
function holdsShield(bot: FloorBody): boolean {
  return bot.inventory?.slots?.[45]?.name === 'shield' || bot.heldItem?.name === 'shield';
}
/** What to step away from now, if anything: a lit creeper close by, or an arrow flying at the body (the shield reflex takes those when one is held). */
export function retreatThreat(bot: FloorBody, arrows?: Map<number, Vec3>): { kind: 'creeper' | 'arrow'; from: Vec3 } | null {
  const body = bot.entity; if (!body) return null;
  const at = body.position;
  for (const entity of others(bot)) {
    if (entity.name === 'creeper' && creeperLit(entity) && entity.position.distanceTo(at) <= CREEPER_REACH) return { kind: 'creeper', from: entity.position };
  }
  if (holdsShield(bot)) return null;
  const seen = new Map<number, Vec3>();
  let found: { kind: 'arrow'; from: Vec3 } | null = null;
  for (const entity of others(bot)) {
    if (!['arrow', 'spectral_arrow', 'trident'].includes(String(entity.name)) || !entity.velocity) continue;
    if (entity.id !== undefined) {
      seen.set(entity.id, entity.position.clone());
      const before = arrows?.get(entity.id);
      if (arrows && (!before || before.distanceTo(entity.position) < 0.05)) continue;
    }
    const toBody = at.offset(0, 1, 0).minus(entity.position), distance = toBody.norm(), speed = entity.velocity.norm();
    if (distance > ARROW_REACH || speed < 0.05) continue;
    // Flying at the body: its course passes within a block of the chest.
    const along = toBody.dot(entity.velocity) / speed;
    if (along <= 0) continue;
    const closest = entity.position.plus(entity.velocity.scaled(along / speed)).distanceTo(at.offset(0, 1, 0));
    if (closest <= 1 && !found) found = { kind: 'arrow', from: entity.position };
  }
  if (arrows) { arrows.clear(); for (const [id, at] of seen) arrows.set(id, at); }
  return found;
}
/** Where the nearest lit creeper within `reach` of `at` is now, or null. */
function nearestLitCreeper(bot: FloorBody, at: Vec3, reach: number): Vec3 | null {
  let best: Vec3 | null = null, bestDistance = reach;
  for (const entity of others(bot)) {
    if (entity.name !== 'creeper' || !creeperLit(entity)) continue;
    const distance = entity.position.distanceTo(at);
    if (distance < bestDistance) { best = entity.position; bestDistance = distance; }
  }
  return best;
}
function releaseKeys(bot: FloorBody) { for (const key of ['forward', 'sprint', 'left', 'right', 'jump']) bot.setControlState(key, false); }
function steer(bot: FloorBody, state: RetreatState) {
  const at = bot.entity!.position, from = state.from!;
  if (state.kind === 'creeper') {
    // Straight away from it; the edge guard keeps the final say over the keys at a drop.
    bot.look?.(Math.atan2(at.x - from.x, at.z - from.z) + Math.PI, 0, true);
    bot.setControlState('forward', true); bot.setControlState('sprint', true);
  } else {
    // Sideways out of the arrow's line.
    bot.look?.(Math.atan2(at.x - from.x, at.z - from.z) + Math.PI, 0, true);
    bot.setControlState('left', true);
  }
}
/**
 * One physics tick of the retreat. Keys are set every tick while engaged, after the other movers, like the lava reflex.
 * `allow` is the budget's say on starting one (a lit creeper's retreat is never asked about it).
 */
export function floorRetreatTick(bot: FloorBody, state: RetreatState, allow?: (kind: 'creeper' | 'arrow') => boolean): 'engaged' | 'released' | 'cornered' | null {
  const body = bot.entity;
  // Lava and breath come first (400, 300): while either holds the keys, the retreat neither steers nor takes the body.
  const yielding = bot.lavaReflex?.engaged === true || bot.breathingReflex?.engaged === true;
  if (!body || (bot.health ?? 20) <= 0 || body.isInLava || yielding) {
    if (!state.engaged) return null;
    state.engaged = false; releaseKeys(bot); return 'released';
  }
  const letGo = (outcome: 'released' | 'cornered') => { state.engaged = false; state.cooldown = RETREAT_COOLDOWN_TICKS; releaseKeys(bot); return outcome; };
  if (state.engaged) {
    state.ticks++;
    const threat = retreatThreat(bot, state.arrows ??= new Map());
    if (state.kind === 'creeper' && state.far) {
      // The nearest lit creeper still inside the safe distance (it may be further than the start's CREEPER_REACH by now); none: out of
      // its reach, gone, or no longer lit.
      const lit = nearestLitCreeper(bot, body.position, CREEPER_SAFE_METERS);
      if (!lit || state.ticks >= CREEPER_RETREAT_TICKS) return letGo('released');
      state.from = lit;
      // No headway (a wall the look-ahead did not see, a mob in the way, a block at the feet): cornered.
      if (body.position.distanceTo(state.checkpoint ?? body.position) >= CREEPER_HEADWAY) { state.checkpoint = body.position.clone(); state.stillTicks = 0; }
      else if ((state.stillTicks = (state.stillTicks ?? 0) + 1) >= CREEPER_STILL_TICKS) return letGo('cornered');
      const plan = creeperHeading(bot, lit, state.heading);
      if (!plan) return letGo('cornered');
      steerAlong(bot, state, plan); return null;
    }
    if (threat) state.from = threat.from;
    if (!threat || state.ticks >= RETREAT_TICKS || body.position.distanceTo(state.origin!) >= RETREAT_BLOCKS) return letGo('released');
    steer(bot, state); return null;
  }
  const threat = retreatThreat(bot, state.arrows ??= new Map());
  if (state.cooldown > 0) { state.cooldown--; return null; }
  if (!threat) return null;
  if (allow && !allow(threat.kind)) return null;
  // A lit creeper with no safe way away is not run at (a cliff, lava, a wall): the body is cornered, and makes its last stand.
  const far = threat.kind === 'creeper';
  const plan = far ? creeperHeading(bot, threat.from) : null;
  if (far && !plan) { state.cooldown = RETREAT_COOLDOWN_TICKS; return 'cornered'; }
  Object.assign(state, { engaged: true, kind: threat.kind, from: threat.from, origin: body.position.clone(), ticks: 0, done: false,
    far, heading: undefined, checkpoint: body.position.clone(), stillTicks: 0 });
  state.engagements++;
  if (plan) steerAlong(bot, state, plan); else steer(bot, state);
  return 'engaged';
}
/** The flee's look-ahead away from a lit creeper (`fleeHeadingPlan`: straight away when safe, else the nearest safe turn), or null. */
function creeperHeading(bot: FloorBody, from: Vec3, previous?: number): { yaw: number; jump: boolean } | null {
  try { return fleeHeadingPlan(bot, from, previous); } catch { return null; }
}
function steerAlong(bot: FloorBody, state: RetreatState, plan: { yaw: number; jump: boolean }) {
  state.heading = plan.yaw;
  bot.look?.(plan.yaw, 0, true);
  bot.setControlState('forward', true); bot.setControlState('sprint', true); bot.setControlState('jump', plan.jump);
}

/** The body's own meals: starving, or nearly dead (every other meal is the planner's, act's eat). */
const SELF_EAT_FOOD = 3;
const SELF_EAT_HEALTH = 6;
const NEVER_EAT = new Set(['pufferfish', 'chorus_fruit', 'suspicious_stew', 'spider_eye', 'poisonous_potato', 'enchanted_golden_apple']);
// (Whether a meal is critical, `eatIsCritical`, is floorBudget.ts's one definition: this choice, the tick's cut rule and the budget's exemption share it.)
/**
 * Food to eat now, or null; never with an enemy at arm's length (standing to eat there killed the body, L18).
 *
 * The body eats by itself only starving (food 3 or less) or nearly dead (health 6 or less, with hunger to fill: `eatIsCritical`); every
 * other meal is the planner's (design mb-llm-centric 2.4). `wide` is the default mode (`FloorConfig.wideThreats`): cooked before raw, raw
 * meat and rotten flesh only when nothing else is carried; "an enemy within 5 m" does not count one that is walled off (`threatExposure`,
 * as in the flee). `wide = false` is `floor` mode: the production floor's own test (food <= 6, or health <= 12 and food < 18) on top.
 */
export function floorEatChoice(bot: FloorBody, wide = true): Item | null {
  const health = bot.health ?? 20, food = bot.food ?? 20;
  if (!(food <= SELF_EAT_FOOD || health <= SELF_EAT_HEALTH)) return null;
  if (wide) {
    // Nearly dead with food 18 or more: a meal gains next to nothing.
    if (!eatIsCritical(health, food)) return null;
  } else if (!(food <= 6 || (health <= 12 && food < 18))) return null;
  if (bot.entity?.isInLava || hostileWithin(bot, HOSTILE_NEAR, wide, wide)) return null;
  let items = (bot.inventory?.items() ?? []).filter(item => (FALLBACK_FOOD_POINTS[item.name] ?? 0) > 0 && !NEVER_EAT.has(item.name)
    && (item.name !== 'rotten_flesh' || food <= 6));
  if (wide) {
    // Cooked (or anything not raw) first; raw meat only when that is all there is.
    // Rotten flesh (hunger) comes after raw meat, though it fills more: it is the last resort, not something ready to eat.
    const rank = (name: string) => name === 'rotten_flesh' ? 2 : RAW_FOOD.has(name) ? 1 : 0;
    const ready = items.filter(item => rank(item.name) === 0);
    if (ready.length) items = ready;
    items.sort((a, b) => rank(a.name) - rank(b.name) || (FALLBACK_FOOD_POINTS[b.name] ?? 0) - (FALLBACK_FOOD_POINTS[a.name] ?? 0));
    return items[0] ?? null;
  }
  items.sort((a, b) => (FALLBACK_FOOD_POINTS[b.name] ?? 0) - (FALLBACK_FOOD_POINTS[a.name] ?? 0));
  return items[0] ?? null;
}

/**
 * True while the body's own safety reflexes are controlling it: a floor retreat, meal or armour change, the lava or breathing
 * reflex, or any other action holding a safety lease. The API's fast judgment waits while this is true (`facts.floorActive`).
 */
export function floorActive(bot: object): boolean {
  const b = bot as { floorReflexes?: FloorState; lavaReflex?: { engaged?: boolean }; breathingReflex?: { engaged?: boolean } };
  return b.floorReflexes?.retreat.engaged === true || !!b.floorReflexes?.busy || b.lavaReflex?.engaged === true
    || b.breathingReflex?.engaged === true || hasActiveSafetyLease(bot);
}

/**
 * r10 (run 34, +576): the reflex that holds the body now, as its action's name (`floor-flee`, `floor-cover`, `auto-swim` ...), or null. A safety
 * lease; a floor reflex that has begun and not ended (its hands are one lease each, the flee's segments follow one another with a tick
 * between, so the lease alone lets go for a moment between two); the lava and breathing reflexes. An act that comes while this holds waits
 * for it (`NativeCommonFcaBody`), rather than take the lock in the moment between two segments and be cut by the next.
 */
/** Run 45: the melee reflex is in an episode now (a hand runs, or the last ended less than MELEE_EPISODE_MS ago). */
export function meleeEpisode(bot: object, now = Date.now()): boolean {
  const state = (bot as { floorReflexes?: FloorState }).floorReflexes;
  return !!state?.melee && (state.busy === 'flee' || now - state.melee.lastEnd <= MELEE_EPISODE_MS);
}
export function reflexHeld(bot: object): string | null {
  const caps = safetyLeaseCapabilities(bot);
  if (caps.length) return caps[0];
  const b = bot as { floorReflexes?: FloorState; lavaReflex?: { engaged?: boolean }; breathingReflex?: { engaged?: boolean } };
  const state = b.floorReflexes;
  if (state?.retreat.engaged) return 'floor-retreat';
  if (state?.fleeEpisode) return 'floor-flee';
  if (state?.busy) return state.busy === 'eat' ? 'floor-eat' : state.busy === 'armor' ? 'floor-armor' : 'floor-flee';
  // The last stand at low health repeats once in LAST_STAND_GAP_MS (run 34 +576: eleven hands in 12 s, a hand each second): the gap between two
  // hands is the same reflex, as long as the health is low. An act that began in the gap was never handed the body (the next hand came first).
  const stood = state?.lastStandAt;
  if (state && stood !== undefined && ((bot as { health?: number }).health ?? 20) <= FLEE_HEALTH
    && (state.clock ?? Date.now)() - stood < LAST_STAND_GAP_MS + LAST_STAND_HOLD_MARGIN_MS) return 'floor-last-stand';
  if (b.lavaReflex?.engaged === true) return 'lava-escape';
  if (b.breathingReflex?.engaged === true) return 'auto-swim';
  return null;
}

/**
 * What the floor's budget is holding back right now (a closed latch, or the allowance used up), or null: the observation's
 * `facts.floorSilenced`, so that a mind that sees no reflex knows why none came. Nothing to say when the floor has no budget.
 */
export function floorSilenced(bot: object): string | null {
  const held = (bot as { floorReflexes?: FloorState }).floorReflexes?.budget?.silenced() ?? [];
  return held.length ? held.join(',') : null;
}

/**
 * Cells the flee will not run into: standing in or on any of these hurts, kills, (cobweb) holds the body for the enemy, carries it off
 * to another dimension (the portals) or springs a trap (a pressure plate, a tripwire). A nether portal is avoided too: it would only
 * take a body at low health somewhere the mind knows nothing of, and 4 s later.
 */
const LETHAL_TO_STAND_IN = new Set(['lava', 'fire', 'soul_fire', 'cactus', 'sweet_berry_bush', 'wither_rose', 'powder_snow', 'cobweb', 'campfire', 'soul_campfire',
  'nether_portal', 'end_portal', 'end_gateway', 'tripwire']);
const isLethalToStandIn = (name: unknown) => LETHAL_TO_STAND_IN.has(String(name)) || String(name).endsWith('_pressure_plate');
/** A stalagmite doubles the damage of a fall onto it. */
const LETHAL_TO_STAND_ON = new Set(['lava', 'magma_block', 'fire', 'soul_fire', 'campfire', 'soul_campfire', 'pointed_dripstone']);
/** The directions the flee may take around the one it prefers, nearest first: no further round than a right angle. */
const FLEE_TURNS = [0, Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2];
/** A heading that brings the body more than this much nearer to a threat within TOWARD_RANGE than it is now runs toward it. */
const TOWARD_RANGE = 10;
const TOWARD_MARGIN = 0.75;
const TOWARD_RUN = 8;
/** The height the body steps up without a jump, and its height: a block above the one is a wall, one below the other bumps the head. */
const STEP_UP = 0.6;
const BODY_HEIGHT = 1.8;
/** A jump lifts the feet a little over a block (1.25): a whole block is climbed by jumping, with a hair to spare for a position that is not exact. */
const JUMP_UP = 1.001;
/** How high the feet get in a jump above the take-off (a jump's arc peaks 1.25 blocks up). */
const JUMP_APEX = 1.25;
/** A jump is pressed when the body's speed over the ground points within about 25 degrees of the heading (cosine), or is below this (blocks per tick). */
const JUMP_ALONG = 0.9;
const JUMP_STANDSTILL = 0.05;
/** How far below the feet the landing of a step down is looked for. */
const LANDING_SCAN = 8;
const EDGE = 1e-6;
type FleeBlock = { name?: string; boundingBox?: string; shapes?: number[][]; isWaterlogged?: boolean; getProperties?: () => Record<string, unknown> } | null;
type TerrainBody = { blockAt?(position: Vec3): FleeBlock };

/** The way a heading runs along the ground (its unit vector on the x and z axes). */
type Heading = { dx: number; dz: number };
/** A heading enters a cell through a face only when it runs across that face at more than this (sin 22.5 degrees). */
const ENTRY_AXIS = 0.38;
const FACE_EPS = 1e-6;

/**
 * How high the part of a stair that a body running along `dir` meets first is: the low step of a stair met from its front (0.5, then the
 * body climbs on to the back half), the whole block when it comes at the back or at the side of the high half (a jump). The height of the
 * shapes that touch the face(s) of the block the heading enters through (and where the lowest of them begins: an upside-down stair is an
 * overhang); null when the shapes say nothing of it.
 */
function stairEntry(shapes: number[][] | undefined, dir: Heading): { low: number; high: number } | null {
  if (!Array.isArray(shapes) || !shapes.length) return null;
  let low = Infinity, high = 0;
  const touching = (touches: (shape: number[]) => boolean) => {
    for (const shape of shapes) {
      if (!touches(shape) || !Number.isFinite(shape[1]) || !Number.isFinite(shape[4])) continue;
      low = Math.min(low, shape[1]); high = Math.max(high, shape[4]);
    }
  };
  if (dir.dx > ENTRY_AXIS) touching(shape => shape[0] <= FACE_EPS);
  else if (dir.dx < -ENTRY_AXIS) touching(shape => shape[3] >= 1 - FACE_EPS);
  if (dir.dz > ENTRY_AXIS) touching(shape => shape[2] <= FACE_EPS);
  else if (dir.dz < -ENTRY_AXIS) touching(shape => shape[5] >= 1 - FACE_EPS);
  return high > 0 && Number.isFinite(low) ? { low, high } : null;
}

/**
 * The part of a cell, bottom to top (0 to 1), that stops a body walking, or null when it does not. Read from the block's shapes when it
 * has them; a stair is judged by the part the heading `dir` meets first (a body walks up a stair from the low side, but the back of one is
 * a block to jump), and without shapes (or a heading) by its low step; without shapes a slab is half a block and a carpet a sliver, so that
 * stepping up onto either is not taken for a wall.
 */
function blockSpan(block: FleeBlock, dir?: Heading): { low: number; high: number } | null {
  if (!block || block.boundingBox !== 'block') return null;
  const name = String(block.name ?? '');
  if (name.endsWith('_stairs')) return (dir ? stairEntry(block.shapes, dir) : null) ?? { low: 0, high: 0.5 };
  if (Array.isArray(block.shapes) && block.shapes.length) {
    const low = Math.min(...block.shapes.map(shape => shape[1])), high = Math.max(...block.shapes.map(shape => shape[4]));
    if (Number.isFinite(low) && Number.isFinite(high)) return { low, high };
  }
  if (name.endsWith('_slab')) return { low: 0, high: 0.5 };
  if (name.endsWith('_carpet')) return { low: 0, high: 0.0625 };
  if (name === 'lily_pad') return { low: 0, high: 0.09375 };
  return { low: 0, high: 1 };
}

/** What a column offers a body whose feet are at `feetY` (its cells counted from `stand`, the block the feet rest on): a wall, ground at some height (by a step or a jump), or no ground. */
type Column = { kind: 'wall' } | { kind: 'open' } | { kind: 'ground'; top: number; jump: boolean };

/** Whether the cell `y` of a column holds something that would stop a body standing with its feet at `feet` (a block whose top is not above `feet` does not). */
function stopsBodyAt(terrain: TerrainBody, x: number, y: number, z: number, feet: number, dir: Heading): boolean {
  const span = blockSpan(terrain.blockAt!(new Vec3(x, y, z)), dir);
  return !!span && y + span.high > feet + EDGE && y + span.low < feet + BODY_HEIGHT - EDGE;
}

/**
 * Reads the column (cx, cz) for a body at `feetY` coming from the column (fromX, fromZ): a block that rises no more than STEP_UP is a
 * step; one whole block that rises up to a block is climbed by jumping, if the body has room to go up it (the target's two cells above
 * the new floor are free, and so is the cell above the head where it takes off: the pathfinder's own rule for a jump); anything else
 * that meets the body is a wall.
 */
function readColumn(terrain: TerrainBody, cx: number, cz: number, fromX: number, fromZ: number, stand: number, feetY: number, cells: FleeBlock[], dir: Heading): Column {
  let support: number | null = null, jump: number | null = null;
  for (const [index, block] of cells.entries()) {
    const span = blockSpan(block, dir);
    if (!span) continue;
    const low = stand + index + span.low, top = stand + index + span.high;
    if (low >= feetY + BODY_HEIGHT) continue;
    const up = top - feetY;
    // A stair is judged by its first step, but the body climbs it to the top of the block: the next cells are read from there.
    if (up <= STEP_UP) support = Math.max(support ?? -Infinity, String(block?.name ?? '').endsWith('_stairs') ? stand + index + 1 : top);
    else if (up <= JUMP_UP && span.low === 0 && span.high === 1) jump = Math.max(jump ?? -Infinity, top);
    else return { kind: 'wall' };
  }
  if (jump !== null) {
    const target = jump;
    for (let index = 0; index <= 3; index++) {
      // Room for the body on top of the block (its two cells above), and over the head where the jump begins.
      if (stopsBodyAt(terrain, cx, stand + index, cz, target, dir)) return { kind: 'wall' };
      const span = blockSpan(terrain.blockAt!(new Vec3(fromX, stand + index, fromZ)));
      if (span && stand + index + span.high > feetY + BODY_HEIGHT + EDGE && stand + index + span.low < target + BODY_HEIGHT - EDGE) return { kind: 'wall' };
    }
    return { kind: 'ground', top: target, jump: true };
  }
  return support !== null ? { kind: 'ground', top: support, jump: false } : { kind: 'open' };
}

/** Whether the body would be hurt, held or sent off by standing on this block (the floor of a cell it stands in) or in it. */
const isHazardousToStandOn = (name: unknown) => LETHAL_TO_STAND_ON.has(String(name)) || isLethalToStandIn(name);

/**
 * Where a step down through air lands: the top of the first block under the column (lethal: onto lava, magma, a campfire and the like, or
 * through fire or a web on the way, or nothing to land on within LANDING_SCAN), or null when the way down meets water or unloaded ground
 * (the frame is then left as it was, as before).
 */
function landing(terrain: TerrainBody, cx: number, cz: number, stand: number, dir: Heading): { top: number | null; lethal: boolean } {
  for (let y = stand - 1; y >= stand - LANDING_SCAN; y--) {
    const block = terrain.blockAt!(new Vec3(cx, y, cz));
    if (!block) return { top: null, lethal: false };
    if (isHazardousToStandOn(block.name)) return { top: null, lethal: true };
    if (holdsWater(block)) return { top: null, lethal: false };
    const span = blockSpan(block, dir);
    if (span) return { top: y + span.high, lethal: false };
  }
  // Eight blocks of air and no ground (water and unloaded cells returned above): a fall that costs health.
  return { top: null, lethal: true };
}

/**
 * Whether the body can stand on the ground `column.top` reads in the column (cx, cz) and move through the cells above it: the block it
 * stands on is not one that hurts or holds it (magma, a campfire, a stalagmite, fire, cactus ...), and none of the cells the body fills there
 * (and the one its head reaches after a jump) holds lava, fire, a web or another trap. A jump onto a block is judged by the block it lands
 * ON, not only by the one under the block it climbs (P8 sixth review, M1/L2).
 */
function groundIsSafe(terrain: TerrainBody, cx: number, cz: number, top: number): boolean {
  const supporting = Math.ceil(top - EDGE) - 1;
  if (isHazardousToStandOn(terrain.blockAt!(new Vec3(cx, supporting, cz))?.name)) return false;
  for (let y = supporting + 1; y < top + BODY_HEIGHT - EDGE; y++) {
    if (isLethalToStandIn(terrain.blockAt!(new Vec3(cx, y, cz))?.name)) return false;
  }
  return true;
}

/** How far to each side of the line the body reaches (half its width and a little more: a run drifts off the line it was planned on). */
const BODY_REACH = 0.4;
/**
 * Whether the column (cx, cz) beside the path holds a hazard where the body could touch it: in the cells from the head of a body standing
 * on `stand` down to the first block that would stop a fall (or water), anything the flee will not stand on or in.
 */
function columnHasHazard(terrain: TerrainBody, cx: number, cz: number, stand: number): boolean {
  for (let y = stand + 2; y >= stand - LANDING_SCAN; y--) {
    const block = terrain.blockAt!(new Vec3(cx, y, cz));
    if (!block) return false;
    if (isHazardousToStandOn(block.name)) return true;
    if (block.boundingBox === 'block' || holdsWater(block)) return false;
  }
  return false;
}

/** How far along the heading the cells are told apart (every cell the line crosses is read, also the ones a coarser step would skip over). */
const SCAN_SAMPLE = 0.25;
/** The reach of one flight over steps: a running body comes down about this far (in blocks) beyond the edge it left (see `descentIsDangerous`). */
const FLIGHT_REACH = 2;

/**
 * The most the body may come down at a cell: a fall costs nothing up to three blocks, and the limit is the edge guard's (one point to
 * spare). A running body does not stop at each cell of a flight of steps: it comes off one ledge with the speed to clear the next, so the
 * drop at a cell is judged from the HIGHEST floor within the FLIGHT_REACH blocks of the heading before it (two cells on a straight line):
 * a slope of one block per block (or 1.5) is run, steps of two or three blocks each are not (open-loop: 2:1 fell six blocks, 3:1 fifteen;
 * P8 sixth review, M2). `apex` is the top of a jump's arc, when the body is to jump (the flight may end anywhere under it).
 */
function descentIsDangerous(passed: Array<{ d: number; y: number }>, at: number, to: number, apex = -Infinity): boolean {
  let from = apex;
  for (const cell of passed) if (cell.d >= at - FLIGHT_REACH - 0.01) from = Math.max(from, cell.y);
  return fallIsDangerous(from - to, 1);
}

/**
 * Walks a heading for the look-ahead and says whether it is safe, and whether the body must jump to follow it (a whole block to climb
 * within two blocks). Every cell the line crosses is read in order (the body would be in each).
 *
 * The body is followed from cell to cell at its own height: after a step up (by a jump or a half block) or a step down the next cell is
 * read from the new floor. So a slope of one block per block, up or down, is run; what is refused is a cell where the body would come down
 * more than three blocks from the highest floor of the two blocks before it (a single drop of four, or steps of two blocks each:
 * `descentIsDangerous`), lava, fire and the rest below, and a landing (also on top of a block it jumps onto) that hurts.
 */
function scanHeading(bot: FloorBody, at: Vec3, yaw: number): { safe: boolean; jump: boolean } {
  const walked = walkHeading(bot, at, yaw);
  if (!walked.safe || !walked.jump) return walked;
  // A sprint jump flies about four blocks and comes down at the end of the flight, not on the step it was pressed for: from the top of the arc
  // (a block and a quarter over the take-off). So every cell the flight can end in is judged as a drop from there (open-loop: a jump toward a
  // plateau that ends in a drop of five fell 5.25 blocks). The take-off is where the body is now; the jump is pressed at once.
  return { safe: walkHeading(bot, at, yaw, at.y + JUMP_APEX).safe, jump: true };
}

function walkHeading(bot: FloorBody, at: Vec3, yaw: number, apex?: number): { safe: boolean; jump: boolean } {
  const terrain = bot as unknown as TerrainBody;
  if (typeof terrain.blockAt !== 'function') return { safe: true, jump: false };
  const dx = -Math.sin(yaw), dz = -Math.cos(yaw), heading: Heading = { dx, dz };
  let jump = false;
  try {
    const start = Math.floor(at.y - 0.01);
    const here = terrain.blockAt(new Vec3(Math.floor(at.x), start, Math.floor(at.z)));
    const swimmingNow = holdsWater(here) || (here?.boundingBox !== 'block' && holdsWater(terrain.blockAt(new Vec3(Math.floor(at.x), start + 1, Math.floor(at.z)))));
    let reachesShallow = false, feetY = at.y, fromX = Math.floor(at.x), fromZ = Math.floor(at.z);
    // The cells the line crosses, in order, how far along it each is entered, and the cells beside it that the body's width reaches there.
    const cells: Array<{ cx: number; cz: number; x: number; z: number; d: number; beside: Map<string, [number, number]> }> = [];
    let lastX = fromX, lastZ = fromZ;
    for (let d = SCAN_SAMPLE; d <= FLEE_LOOKAHEAD + 1e-9; d += SCAN_SAMPLE) {
      const x = at.x + dx * d, z = at.z + dz * d, cx = Math.floor(x), cz = Math.floor(z);
      if (cx !== lastX || cz !== lastZ) { cells.push({ cx, cz, x, z, d, beside: new Map() }); lastX = cx; lastZ = cz; }
      const current = cells[cells.length - 1];
      if (!current) continue;
      for (const ox of [-BODY_REACH, BODY_REACH]) for (const oz of [-BODY_REACH, BODY_REACH]) {
        const bx = Math.floor(x + ox), bz = Math.floor(z + oz);
        if (bx !== current.cx || bz !== current.cz) current.beside.set(`${bx},${bz}`, [bx, bz]);
      }
    }
    // The height of the feet in each cell passed (the first is where the body is).
    const passed = [{ d: 0, y: at.y }];
    for (const { cx, cz, x, z, d, beside } of cells) {
      const stand = Math.floor(feetY - 0.01);
      const floor = terrain.blockAt(new Vec3(cx, stand, cz)), feet = terrain.blockAt(new Vec3(cx, stand + 1, cz)), head = terrain.blockAt(new Vec3(cx, stand + 2, cz));
      if ([floor, feet, head].some(block => isLethalToStandIn(block?.name))) return { safe: false, jump };
      // What the feet would rest on: the floor cell, or the one under it when that is open (a step down).
      const resting = floor && floor.boundingBox === 'block' ? floor : terrain.blockAt(new Vec3(cx, stand - 1, cz));
      if (LETHAL_TO_STAND_ON.has(String(resting?.name))) return { safe: false, jump };
      // The body is 0.6 wide, and a run does not keep to the line: a trap or a lava, magma or fire cell it would brush is as bad as one under it.
      for (const [bx, bz] of beside.values()) if (columnHasHazard(terrain, bx, bz, stand)) return { safe: false, jump };
      const swim = holdsWater(floor) || (floor?.boundingBox !== 'block' && holdsWater(feet));
      if (swim && !swimmingNow) return { safe: false, jump };
      if (!swim) reachesShallow = true;
      // A wall in the first two blocks: the run would be into it. (Further on the flee has stopped by then, and the frame is left as it is.)
      const column = readColumn(terrain, cx, cz, fromX, fromZ, stand, feetY, [floor, feet, head], heading);
      if (column.kind === 'wall' && d <= 2) return { safe: false, jump };
      // Any drop that would cost health (more than three blocks, or lava below), judged as the edge guard does with one point to spare,
      // from the floor the body stands on at the cell before: a slope is a row of small drops, not one big one.
      if (!blockSpan(floor, heading) && edgeRisk(bot as any, x, feetY, z, 1) !== null) return { safe: false, jump };
      if (column.kind === 'ground') {
        if (!groundIsSafe(terrain, cx, cz, column.top) || descentIsDangerous(passed, d, column.top, apex)) return { safe: false, jump };
        if (column.jump && d <= 2) jump = true;
        feetY = column.top;
      } else if (column.kind === 'open' && !swim) {
        const down = landing(terrain, cx, cz, stand, heading);
        if (down.lethal) return { safe: false, jump };
        // The drop at this cell, from the highest floor of the blocks before it (see `descentIsDangerous`).
        if (down.top !== null && descentIsDangerous(passed, d, down.top, apex)) return { safe: false, jump };
        if (down.top !== null) feetY = down.top;
      }
      passed.push({ d, y: feetY });
      fromX = cx; fromZ = cz;
    }
    if (swimmingNow && !reachesShallow) return { safe: false, jump };
  } catch { return { safe: true, jump: false }; }
  return { safe: true, jump };
}

/**
 * Whether running from `at` along `yaw` for the look-ahead meets lava, fire, a drop that would cost health, a wall, or (from land) deep
 * water. The edge guard also clips a step over a ledge or into lava at the physics tick, but the flee does not rely on it alone: a heading
 * that leads there is not taken. Missing terrain data (no `blockAt`, an unloaded cell) is not a danger, as in the guard.
 *
 * The cells are read by what the feet stand on, not by the cell the position falls in: on a slab, soul sand, farmland, a path, a carpet,
 * mud, honey, a lily pad or a stair the position is inside the floor block's own cell (y 64.5 on a slab at 64), and taking that cell for
 * the feet's turned every such floor into a wall, so that the low-health flee never started there (P8 third review, H1). `stand` is the
 * block the feet rest on (the edge guard's `floorY`); the body fills the two cells above it; and a wall is any block that would stop the
 * body, judged by its real top and bottom: half a block up is a step, a whole block up is a jump (when there is room above it), more is a
 * wall. The body is followed along the heading, so a slope of one block per block, up or down, is open ground (P8 fifth review, M2).
 *
 * The drop at a cell is judged from the highest floor of the two blocks before it, so a slope of 1:1 or 1.5:1 is run and steps of two or more
 * blocks each (2:1, terraces) are not: a running body clears one step and comes down on the next (P8 sixth review, M2). A heading that needs a
 * jump is judged again for the flight, from the top of the arc. Every cell the line crosses is read, and the cells the body's width reaches
 * beside it are checked for traps and lava (a run does not keep to the line). The block a jump lands on, and the cells its head passes, are
 * read like any other (M1, L2); a stair is read on the side the heading meets (L3).
 *
 * Also refused: the portals, pressure plates and tripwires (a trap, another dimension) and a fall onto a stalagmite.
 *
 * In water the flee only runs for a shore: a heading is taken only when it reaches ground that is not deep water within the look-ahead,
 * so that being chased by a drowned does not send the body out to sea. From land it does not run into deep water.
 */
export function fleeHeadingSafe(bot: FloorBody, at: Vec3, yaw: number): boolean { return scanHeading(bot, at, yaw).safe; }

/** Whether running along `yaw` brings the body more than TOWARD_MARGIN nearer to a threat (within TOWARD_RANGE) than it stands now. */
function runsToward(at: Vec3, yaw: number, from: Vec3[]): boolean {
  const dx = -Math.sin(yaw), dz = -Math.cos(yaw);
  return from.some(point => {
    const ax = point.x - at.x, az = point.z - at.z, distance = Math.hypot(ax, az);
    if (distance > TOWARD_RANGE) return false;
    const along = Math.max(0, Math.min(TOWARD_RUN, ax * dx + az * dz));
    return Math.hypot(ax - dx * along, az - dz * along) < distance - TOWARD_MARGIN;
  });
}

/**
 * Where `from` pushes the body: the yaw straight away from the sum of the threats' pushes, each weighted by 1 / distance squared (the
 * near one counts most). Threats on two sides push against each other and what is left is noise (the legacy note, paid run L65), and a
 * push can also lead past another threat on the same line: then the legacy gap heading (`escapeHeading`, the way that stays farthest
 * from every one) is used instead.
 */
function repulsionYaw(at: Vec3, from: Vec3[]): number {
  let sx = 0, sz = 0, weights = 0;
  for (const point of from) {
    const ax = at.x - point.x, az = at.z - point.z, distance = Math.max(Math.hypot(ax, az), 0.5), weight = 1 / (distance * distance);
    sx += (ax / distance) * weight; sz += (az / distance) * weight; weights += weight;
  }
  const strength = weights > 0 ? Math.hypot(sx, sz) / weights : 0;
  const pushed = Math.hypot(sx, sz) < 1e-9 ? 0 : Math.atan2(sx, sz) + Math.PI;
  if (from.length > 1 && (strength < 0.3 || runsToward(at, pushed, from))) {
    const gap = escapeHeading({ x: at.x, z: at.z }, from.map(point => ({ x: point.x, z: point.z })), null, 12);
    return Math.atan2(-gap.x, -gap.z);
  }
  return pushed;
}

/**
 * The yaw to flee along from `from` (one threat, or all of them: the heading is the repulsion of every one, weighted by nearness): straight
 * away when that is safe, else the nearest safe turn that does not run toward another threat; null when no way out is safe. With more
 * than one threat and a `previous` heading, that one is kept while it is still safe, does not run toward a threat and is within 45 degrees
 * of the new push (hysteresis: the push shifts as the threats move, and a heading that follows it tick by tick zigzags).
 */
export function fleeHeading(bot: FloorBody, from: Vec3 | Vec3[], previous?: number): number | null {
  return fleeHeadingPlan(bot, from, previous)?.yaw ?? null;
}
/** With several threats the previous heading is kept while it is still safe and within this angle of the new push: no zigzag as the push shifts. */
const HEADING_HOLD = Math.PI / 4 + 1e-9;
const angleBetween = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
/** `fleeHeading`, with whether the body must jump to follow it (a whole block to climb a step or two ahead). `previous` is the last heading of the run. */
export function fleeHeadingPlan(bot: FloorBody, from: Vec3 | Vec3[], previous?: number): { yaw: number; jump: boolean } | null {
  const at = bot.entity?.position; if (!at) return null;
  const sources = Array.isArray(from) ? from : [from];
  if (!sources.length) return null;
  const away = repulsionYaw(at, sources);
  if (previous !== undefined && sources.length > 1 && angleBetween(previous, away) <= HEADING_HOLD && !runsToward(at, previous, sources)) {
    const held = scanHeading(bot, at, previous);
    if (held.safe) return { yaw: previous, jump: held.jump };
  }
  for (const turn of FLEE_TURNS) {
    const yaw = away + turn;
    if (turn !== 0 && runsToward(at, yaw, sources)) continue;
    const scan = scanHeading(bot, at, yaw);
    if (scan.safe) return { yaw, jump: scan.jump };
  }
  return null;
}

/** What the flee is run from: every threat in range (the nearest first in `from`, for logging and the single-threat callers), and how near the nearest is. */
export interface FleeThreat { from: Vec3; threats: Vec3[]; nearest: number }

/**
 * The threats to run from at low health: every `isThreat` entity that can get at the body (not walled off) within the flee's range, which is
 * wider for a kind that shoots, and wider once an episode is running (`keeping`: so that the body is not let go at 8.1 m). Null above FLEE_HEALTH.
 */
export function fleeThreat(bot: FloorBody, keeping = false): FleeThreat | null {
  const health = bot.health ?? 20, at = bot.entity?.position;
  if (!at || !(health > 0 && health <= FLEE_HEALTH) || bot.entity?.isInLava) return null;
  const found: Array<{ distance: number; position: Vec3 }> = [];
  for (const entity of others(bot)) {
    if (!isThreat(bot, entity)) continue;
    const name = String(entity.name).toLowerCase(), shooter = SHOOTERS.has(name) || bot.shootsAtBody?.(name) === true;
    const range = shooter ? (keeping ? FLEE_KEEP_RANGE_SHOOTER : FLEE_RANGE_SHOOTER) : (keeping ? FLEE_KEEP_RANGE : FLEE_RANGE);
    const distance = entity.position.distanceTo(at);
    if (distance > range) continue;
    let sealed = false;
    try { sealed = threatExposure(bot as any, entity as any) === 'sealed'; } catch { sealed = false; }
    if (!sealed) found.push({ distance, position: entity.position });
  }
  if (!found.length) return null;
  found.sort((a, b) => a.distance - b.distance);
  return { from: found[0].position, threats: found.map(item => item.position), nearest: found[0].distance };
}

export interface FleeStart extends FleeThreat { continuing: boolean }
/** A command (the API's) is queued for the body behind this lease. */
const commandWaiting = (bot: object) => (actionLeaseStatus(bot)?.waitQueue ?? 0) > 0;
/** One of the API's own escape or shelter commands is running (it is already getting the body away: the floor does not cut it). */
const escapeRunning = (bot: object) => activeActionCapabilities(bot).some(capability => ESCAPE_SKILLS.has(capability));
/**
 * Whether the low-health flee may run a segment now, and from what. Precedence (P8): a floor retreat, meal or armour change, or any other
 * safety lease holds the body first; the API's own escape skills (flee-from, a shelter) are never cut; a command waiting for the body
 * ends the segment (`runLowHealthFlee`) and, with it, the episode. A fight or a task action under it is cut: at this health the API's fast judgment would cut it too.
 * A new episode costs one of the two in 20 seconds; the segments after the first (`continuing`) are part of it and cost nothing.
 */
export function fleeStart(bot: FloorBody, state: FloorState, now: number): FleeStart | null {
  const endEpisode = (outcome?: ReflexOutcome) => {
    const episode = state.fleeEpisode; if (!episode) return;
    state.fleeEpisode = undefined;
    try { episode.end?.(outcome ?? episode.outcome); } catch { /* a report must not change what the reflex did */ }
  };
  // An episode nobody came back to (the body was held by something else for longer than it could run) is over.
  if (state.fleeEpisode && now - state.fleeEpisode.startedAt > FLEE_EPISODE_MS + 2000) endEpisode();
  // Healthy, and nothing to end: nothing to do (this runs every physics tick).
  if (!state.fleeEpisode && !((bot.health ?? 20) > 0 && (bot.health ?? 20) <= FLEE_HEALTH)) return null;
  if (state.retreat.engaged || state.busy || hasActiveSafetyLease(bot)) return null;
  if (bot.lavaReflex?.engaged === true || bot.breathingReflex?.engaged === true) return null;
  if (escapeRunning(bot)) return null;
  // After a refusal the ground is not read again for half a second: a body that cannot run must not cost the tick a search every 50 ms.
  if (now < (state.fleeRefusedUntil ?? 0)) return null;
  const at = bot.entity?.position;
  let episode = state.fleeEpisode;
  if (episode) {
    if (now - episode.startedAt >= FLEE_EPISODE_MS || (at && at.distanceTo(episode.origin) >= FLEE_EPISODE_BLOCKS) || episode.stalls >= 2) {
      // Two segments in a row without headway is a way out that is not there (a heading the look-ahead took, a body that does not move):
      // the last stand follows, as for a refused flee.
      if (episode.stalls >= 2) state.lastStandWanted = true;
      endEpisode(); state.fleeRestUntil = now + FLEE_REST_MS; return null;
    }
  } else {
    if (now < (state.fleeRestUntil ?? 0)) return null;
    state.fleeStarts = (state.fleeStarts ?? []).filter(started => now - started < FLEE_WINDOW_MS);
    if (state.fleeStarts.length >= FLEE_MAX_IN_WINDOW) return null;
  }
  const threat = fleeThreat(bot, !!episode);
  if (!threat) { endEpisode(); return null; }
  // No safe way to run (a cliff or lava on every side the flee may take): it does not take the body, nor spend its allowance.
  // The API's fast judgment (a shelter, its own flee) decides what to do instead, and is told so (`state.world.reflexes`).
  if (fleeHeading(bot, threat.threats, episode?.heading) === null) {
    state.engagements.fleeRefused = (state.engagements.fleeRefused ?? 0) + 1;
    state.fleeRefusedUntil = now + FLEE_REFUSAL_CACHE_MS;
    endEpisode();
    // The body builds no shelter (the walls are the planner's); its last resort at low health is a blow, a step down or one block up
    // (`lastStandChoice`).
    state.lastStandWanted = true;
    if (now - (state.fleeRefusedNotedAt ?? -Infinity) >= FLEE_REFUSAL_NOTE_GAP_MS) {
      state.fleeRefusedNotedAt = now;
      try { bot.reflexLedger?.note('flee', '低体力だが安全な逃げ道が無く走れなかった', 'failed'); } catch { /* a report must not change what the reflex did */ }
    }
    return null;
  }
  return { ...threat, continuing: !!episode };
}

/**
 * The heading and the jump key for one tick of the run, or null when there is no safe way (`fleeHeadingPlan`, with `memory.heading` as the
 * previous heading; it is set to the heading taken). Two things the plan alone does not say:
 *  - In the air the heading is held: a jump (or a step off a ledge) has committed the body to the flight the heading was judged for
 *    (`scanHeading` reads its landing), and turning on the way only drifts it off that line, onto cells nobody read (open-loop, the body
 *    came down on magma and in lava a block to the side of the planned line).
 *  - In water the jump key is the way up and out: a body that swims is never `onGround`, so a step up to the shore that needs a jump
 *    would be a wall for ever (the physics: pressing jump at the shore gets out of the water onto a bank flush with it; without, it
 *    sticks there).
 */
export function fleeKeys(bot: FloorBody, threats: Vec3[], memory: { heading?: number }): { yaw: number; jump: boolean } | null {
  const body = bot.entity;
  const swimming = body?.isInWater === true;
  if (body && body.onGround === false && !swimming && body.isInLava !== true && memory.heading !== undefined) return { yaw: memory.heading, jump: false };
  const plan = fleeHeadingPlan(bot, threats, memory.heading);
  if (plan === null) return null;
  memory.heading = plan.yaw;
  // A jump carries the speed the body has into the air, and it is judged for a flight along the heading: it is pressed once the body runs
  // that way (a few ticks after a turn), or from a standstill (open-loop: a jump pressed right after a 40 degree turn flew 15 degrees off the
  // line it was judged for and came down on lava).
  return { yaw: plan.yaw, jump: plan.jump && (swimming || (body?.onGround !== false && runsAlong(body, plan.yaw))) };
}

/** Whether the body's own speed over the ground is (nearly) along `yaw`, or too small to matter. */
function runsAlong(body: FloorEntity | undefined, yaw: number): boolean {
  const v = body?.velocity;
  if (!v) return true;
  const speed = Math.hypot(v.x, v.z);
  return speed < JUMP_STANDSTILL || (v.x * -Math.sin(yaw) + v.z * -Math.cos(yaw)) / speed >= JUMP_ALONG;
}

/**
 * One segment of the flee, run as the work of a safety-lease action. Keys go through the motor port, so an action that took the body
 * from it (a retreat, lava) makes the next write fail instead of fighting it; the keys are always let go at the end. At most
 * FLEE_SEGMENT_TICKS ticks or FLEE_SEGMENT_BLOCKS blocks; the heading is chosen again each tick from every threat in range.
 */
export async function runLowHealthFlee(bot: FloorBody, port: FloorBody, tickMs = 50, memory: { heading?: number } = {}): Promise<{ success: boolean; result: string; moved: number; ended: 'clear' | 'blocked' | 'cap' | 'yield' }> {
  const origin = bot.entity!.position.clone();
  let ticks = 0, ended: 'clear' | 'blocked' | 'cap' | 'yield' = 'cap', jumping = false;
  try {
    for (; ticks < FLEE_SEGMENT_TICKS; ticks++) {
      const threat = fleeThreat(bot, true), body = bot.entity;
      if (!threat || !body || bot.lavaReflex?.engaged === true || bot.breathingReflex?.engaged === true) { ended = 'clear'; break; }
      if (body.position.distanceTo(origin) >= FLEE_SEGMENT_BLOCKS) break;
      // A command is waiting for the body: it has it after a fifth of a second of the run (the API decides from a fresh observation).
      if (ticks >= FLEE_YIELD_AFTER_TICKS && commandWaiting(bot)) { ended = 'yield'; break; }
      // Away from all of them, or the nearest turn that does not lead to lava or a drop (and none: it stops here). The edge guard
      // still has the final say over the keys at the physics tick.
      const keys = fleeKeys(bot, threat.threats, memory);
      if (keys === null) { ended = 'blocked'; break; }
      port.look?.(keys.yaw, 0, true);
      port.setControlState('forward', true); port.setControlState('sprint', true);
      // A whole block to climb a step or two ahead: a sprint jump (set only on a change, so level ground costs no extra write).
      if (keys.jump !== jumping) { jumping = keys.jump; port.setControlState('jump', jumping); }
      await new Promise(resolve => setTimeout(resolve, tickMs));
    }
  } finally {
    // Through the port: when another reflex has taken the body this fails and is ignored, so its keys are not let go from under it.
    try { releaseKeys(port); } catch { /* ownership lost: the new owner holds the keys */ }
  }
  const moved = bot.entity ? bot.entity.position.distanceTo(origin) : 0;
  return { success: true, result: ticks > 0 ? '低体力のため敵から離れた' : '離れる必要がなくなった（または安全な逃げ道がない）', moved, ended };
}

// ===== The last stand =====

/**
 * What the body does at low health when the flee finds no way out (run 27: with no automatic shelter, the body
 * stood for 4 s and a spider killed it). One minimal hand, chosen in this order, and told in the ledger (so the act that was running stops
 * as `reflex`): (a) a blow at a threat within LAST_STAND_RANGE that can reach the body, with the best melee weapon carried; (b) one block
 * down, when the cell under the feet can be dug and the one under that is solid; (c) one block up, when a full block is carried and the
 * two cells over the head are air. At most once in LAST_STAND_GAP_MS, and never over another safety lease.
 */
const LAST_STAND_RANGE = 3.2;
const LAST_STAND_HITS = 2;
const LAST_STAND_HIT_GAP_MS = 600;
const LAST_STAND_GAP_MS = 1500;
/** r10: `reflexHeld` holds this long past the gap (the next hand comes on the first tick after it). */
const LAST_STAND_HOLD_MARGIN_MS = 150;
/** A creeper's fuse is a second and a half: a cornered body that cannot make its stand by then has no stand to make. */
const CORNERED_WAIT_MS = 1500;
/** The ledger keeps this much of the last stand's detail (the usual 40 cannot hold the place, the health and, r6, the threat that reaches). */
const LAST_STAND_DETAIL_MAX = 160;
const LAST_STAND_TIMEOUT_MS: Record<LastStand['kind'], number> = { hit: 3000, dig: 7000, pillar: 5000, melee: 3000 };
/** The act's hands that lay blocks (the act sets `actHandNow` on the body while a hand runs). */
export const LAYING_HANDS = new Set(['place', 'pillarUp', 'vertical-place']);
const TOOL_TIERS = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden'];
/** A sword before an axe before any other tool; within a kind the better material first. 0: not a melee tool. */
function meleeRank(name: string): number {
  const kind = name.endsWith('_sword') ? 300 : name.endsWith('_axe') ? 200 : /_(pickaxe|shovel|hoe)$/u.test(name) ? 100 : 0;
  if (!kind) return 0;
  const tier = TOOL_TIERS.findIndex(material => name.startsWith(`${material}_`));
  return kind + (tier < 0 ? 0 : TOOL_TIERS.length - tier);
}
/** The best melee weapon carried (sword, then axe, then another tool), or null. */
export function bestMeleeWeapon(items: Item[]): Item | null {
  let best: Item | null = null, bestRank = 0;
  for (const item of items) { const rank = meleeRank(item.name); if (rank > bestRank) { best = item; bestRank = rank; } }
  return best;
}

export type LastStand =
  | { kind: 'hit'; target: FloorEntity; weapon: Item | null; detail: string }
  | { kind: 'dig'; cell: { x: number; y: number; z: number }; detail: string }
  | { kind: 'pillar'; block: string; detail: string }
  /** r8: at the rim of a drop, where a jump is a body in the air that a blow throws: the melee hand (a step off the rim, a block between). */
  | { kind: 'melee'; hand: MeleeHand; detail: string };

/** Whole blocks a wall or a pillar can be made of (build-around-self's BUILDING_BLOCKS, without importing the skill here). */
const WALL_BLOCKS = new Set(['cobblestone', 'cobbled_deepslate', 'stone', 'deepslate', 'andesite', 'diorite', 'granite', 'blackstone',
  'tuff', 'basalt', 'nether_bricks', 'stone_bricks', 'end_stone', 'dirt', 'netherrack']);
/** Whole blocks a last-stand pillar is made of: those and any planks. */
const isPillarBlock = (name: string) => WALL_BLOCKS.has(name) || name.endsWith('_planks');
const isFluid = (name: unknown) => name === 'water' || name === 'lava';

/**
 * The last stand for a lit creeper with no safe way away (`floorRetreatTick` says `cornered`): another order, for a blast in about a second
 * and a half. (b) one block down first, only when the cell is dug in CREEPER_DIG_MS or less (the hole takes the blast off the lower half of
 * the body); then (a) a blow at the lit creeper itself (the knock puts it further off; no other mob is hit); then (c) one block up.
 */
const CREEPER_DIG_MS = 1000;

/**
 * The threats that can get at the body now (r6): every threat within the flee's range (wider for a kind that shoots) whose exposure, read
 * from the blocks this moment (`threatExposure` fresh, not the cached answer), is not sealed. Nearest first, with how it reaches.
 */
export function reachingThreats(bot: FloorBody): Array<{ entity: FloorEntity; distance: number; exposure: 'seen' | 'reachable' }> {
  const at = bot.entity?.position; if (!at) return [];
  const out: Array<{ entity: FloorEntity; distance: number; exposure: 'seen' | 'reachable' }> = [];
  for (const entity of others(bot)) {
    if (!isThreat(bot, entity)) continue;
    const name = String(entity.name).toLowerCase(), shooter = SHOOTERS.has(name) || bot.shootsAtBody?.(name) === true;
    const distance = entity.position.distanceTo(at);
    if (distance > (shooter ? FLEE_RANGE_SHOOTER : FLEE_RANGE)) continue;
    let exposure: ReturnType<typeof threatExposure>;
    try { exposure = threatExposure(bot as any, entity as any, Date.now(), { fresh: true }); } catch { exposure = 'reachable'; }
    if (exposure !== 'sealed') out.push({ entity, distance, exposure });
  }
  return out.sort((a, b) => a.distance - b.distance);
}

export function lastStandChoice(bot: FloorBody, skip?: LastStand['kind'], cause: 'low-health' | 'creeper' = 'low-health'): LastStand | null {
  const body = bot.entity; if (!body) return null;
  const at = body.position, health = Math.round((bot.health ?? 0) * 10) / 10;
  // r7: the cell the body stands in (on a slab or a stair's step, the cell over it: utils/localMap feetCell).
  const feet = feetCell(bot as never) ?? { x: Math.floor(at.x), y: Math.floor(at.y + 1e-3), z: Math.floor(at.z) };
  const creeper = cause === 'creeper';
  // r6 (run 29): the low-health stand only while a threat can get at the body now. Twelve steps down were made after the planner's blocks
  // had gone in over the head; once walled off (sealed, read now), there is nothing to make a stand against.
  const reaching = creeper ? [] : reachingThreats(bot);
  if (!creeper && !reaching.length) return null;
  const reach = reaching[0];
  const fact = reach ? `。届く: ${reach.entity.name} #${reach.entity.id} ${reach.distance.toFixed(1)}m ${reach.exposure === 'seen' ? '見える' : '道がある'}` : '';
  const where = `(${feet.x},${feet.y},${feet.z}) 体力${health}`;
  const lead = creeper ? '点火したクリーパーから逃げ道なし:' : '低体力で逃げ道なし:';
  const items = bot.inventory?.items() ?? [];
  const read = (dy: number) => (bot as unknown as TerrainBody).blockAt?.(new Vec3(feet.x, feet.y + dy, feet.z)) as (FleeBlock & { diggable?: boolean }) | null | undefined;
  /** (b) One block down: the cell under the feet can be dug, and the cell under that holds the body (a step, not a drop; no water or lava). */
  const stepDown = (): LastStand | null => {
    const under = read(-1), below = read(-2);
    if (!(under && below && under.boundingBox === 'block' && under.diggable !== false && !isFluid(under.name) && !isHazardousToStandOn(under.name)
      && !['bedrock', 'barrier', 'end_portal_frame', 'reinforced_deepslate'].includes(String(under.name)) && !PROTECTED_UTILITY_BLOCKS.has(String(under.name))
      && below.boundingBox === 'block' && !isHazardousToStandOn(below.name))) return null;
    if (creeper) {
      // Too slow to be a hole before the blast (stone by hand is seconds): not this way. Unknown (no digTime): taken.
      let ms: number | null = null;
      try { const time = (bot as { digTime?: (block: unknown) => number }).digTime?.(under); ms = typeof time === 'number' && Number.isFinite(time) ? time : null; } catch { ms = null; }
      if (ms !== null && ms > CREEPER_DIG_MS) return null;
    }
    return { kind: 'dig', cell: { x: feet.x, y: feet.y - 1, z: feet.z }, detail: `${lead} 足元を掘って下がった ${where}${fact}` };
  };
  if (creeper) {
    if (skip !== 'dig') { const down = stepDown(); if (down) return down; }
    if (skip !== 'hit') {
      const lit = others(bot).filter(entity => entity.name === 'creeper' && creeperLit(entity))
        .map(entity => ({ entity, distance: entity.position.distanceTo(at) })).filter(entry => entry.distance <= LAST_STAND_RANGE)
        .sort((a, b) => a.distance - b.distance)[0];
      if (lit) return { kind: 'hit', target: lit.entity, weapon: bestMeleeWeapon(items), detail: `${lead} creeper #${lit.entity.id} を打って離した ${where}` };
    }
  }
  // (a) A threat in arm's reach that can get at the body. A lit creeper is never hit (the blast is the danger); an unlit one may be (the knock helps).
  if (!creeper && skip !== 'hit') {
    const near = reaching.filter(entry => !(entry.entity.name === 'creeper' && creeperLit(entry.entity)) && entry.distance <= LAST_STAND_RANGE)[0];
    if (near) {
      const target = near.entity;
      return { kind: 'hit', target, weapon: bestMeleeWeapon(items), detail: `${lead} ${target.name} #${target.id} を打ち返した ${where}` };
    }
  }
  if (!creeper && skip !== 'dig') { const down = stepDown(); if (down) return down; }
  // r8 (run 32): at the rim of a drop (a cell round the feet that falls three or more, or into lava) no jump is made: the pillar is a body in
  // the air for a third of a second, and a blow there threw it off a bridge into the lava. The melee hand instead (a step off the rim, a block
  // between the body and the enemy), when a melee enemy is near; else nothing, and the planner decides from the fact.
  let rim: Footing | null = null;
  try { rim = footingAt(bodyReader(bot as never), feet); } catch { rim = null; }
  if (rim && rim.count > 0) {
    if (!creeper && skip !== 'melee') {
      try {
        const threats = meleeThreatsNear(bot);
        const choice = threats.length ? meleeChoice(bot, threats, { hands: 0, beingHit: true }) : null;
        if (choice?.hand) return { kind: 'melee', hand: choice.hand, detail: `${lead} ${choice.hand.detail}。足場: ${footingWords(choice.footing)} ${where}${fact}` };
      } catch { /* no hand */ }
    }
    return null;
  }
  // (c) One block up: a full block carried, and the two cells over the head are air.
  if (skip !== 'pillar') {
    const block = items.filter(item => isPillarBlock(item.name)).reduce<{ name: string; count: number } | null>((best, item) => {
      const count = (item as { count?: number }).count ?? 1;
      return !best || count > best.count ? { name: item.name, count } : best;
    }, null);
    const open = (dy: number) => { const cell = read(dy); return !!cell && cell.boundingBox !== 'block' && !isFluid(cell.name) && !isHazardousToStandOn(cell.name); };
    if (block && open(2) && open(3)) return { kind: 'pillar', block: block.name, detail: `${lead} 1段積んで上がった ${where}${fact}` };
  }
  return null;
}

/** Runs a last stand as the work of a safety-lease action: `port` is the body's motor port, so a stronger reflex taking the body ends it. */
export async function runLastStand(bot: FloorBody, port: FloorBody, stand: LastStand): Promise<{ success: boolean; result: string }> {
  const motor = port as any;
  if (stand.kind === 'hit') {
    const weapon = stand.weapon;
    if (weapon && bot.heldItem?.name !== weapon.name) {
      try { await motor.equip(weapon, 'hand'); } catch (error) { if (/Action interrupted|Motor owner expired/u.test(String((error as Error)?.message))) throw error; }
    }
    let blows = 0;
    for (let blow = 0; blow < LAST_STAND_HITS; blow++) {
      const live = Object.values(bot.entities ?? {}).find(entity => entity === stand.target || (entity?.id !== undefined && entity.id === stand.target.id));
      if (!live || !bot.entity || live.position.distanceTo(bot.entity.position) > LAST_STAND_RANGE + 1) break;
      try { await motor.lookAt?.(live.position.offset(0, 1, 0), true); } catch (error) { if (/Action interrupted|Motor owner expired/u.test(String((error as Error)?.message))) throw error; }
      motor.attack(live); blows++;
      if (blow < LAST_STAND_HITS - 1) await abortableDelay(port, LAST_STAND_HIT_GAP_MS);
      if (actionSignal(port as never)?.aborted) break;
    }
    return { success: blows > 0, result: blows > 0 ? `${blows}回打った` : '打つ相手が離れた' };
  }
  if (stand.kind === 'melee') return runMelee(bot, port, stand.hand);
  const position = bot.entity!.position;
  const base = { x: Math.floor(position.x), y: Math.floor(position.y + 1e-3), z: Math.floor(position.z) };
  const ctx = { bot: port, stop: new AbortController().signal, deadline: Date.now() + LAST_STAND_TIMEOUT_MS[stand.kind], facing: 'north' as const, base };
  if (stand.kind === 'dig') {
    const { dig } = await import('./primitives/dig.js');
    const outcome = await dig(ctx as never, { at: [stand.cell], collect: false, exposeOk: true });
    return { success: outcome.ok, result: outcome.text };
  }
  const { pillarUp } = await import('./primitives/pillarUp.js');
  const outcome = await pillarUp(ctx as never, { n: 1, block: stand.block });
  return { success: outcome.ok, result: outcome.text };
}

// ===== r7: out of a shooter's line while burning =====

/**
 * Run 31 (2026-10-22): in a fortress corridor joined to the blazes' room the body took three fireballs, burned, and went from 18 to 0 in
 * ten seconds. The flee found no way, the last stand dug one cell down, and then the body stood for three seconds, burning, still in the
 * line (the stand is made only once in 1.5 s, and only against a threat in reach). In the Nether no water puts the fire out; an eight
 * second decision does not come in time for a point a second.
 *
 * The cover: while the body burns and a shooter (blaze, ghast, a skeleton's kind) within its reach sees it (its eyes to
 * the body's eye or chest, nothing solid between), one minimal hand that cuts the line, and again after it while the body still burns or
 * keeps losing health and is still seen:
 *   (a) a step of one or two cells (walked as the walk walks) to a cell no shooter in reach sees;
 *   (b) a block over the head, when the body stands in a hole and that block is what the lines come through (a full block carried);
 *   (c) the cell under the feet dug, when the cell under it holds the body and no lava runs in (at most three in a row).
 * No way round, no place chosen further than two cells. The act running stops (its lease is taken), and the ledger says what the body did
 * and whether the line is cut, with the shooters still seeing it.
 */
const COVER_SHOOTERS: Readonly<Record<string, number>> = { blaze: 48, ghast: 64, skeleton: 24, stray: 24, bogged: 24 };
/** Between two hands, and between two looks at the lines (the looks are a few hundred block reads). */
const COVER_GAP_MS = 250;
/** Health that fell within this is "still falling": the cover goes on while the body is seen, burning or not. */
const COVER_FALL_MS = 2000;
/** An episode is the hands with less than this between them; its digs are counted. */
const COVER_EPISODE_MS = 4000;
const COVER_MAX_DIGS = 3;
/** "No hand to make" is told at most this often. */
const COVER_NOTE_GAP_MS = 5000;
const COVER_TIMEOUT_MS: Record<Cover['kind'], number> = { step: 3000, seal: 3000, line: 3000, dig: 5000 };
const COVER_DETAIL_MAX = 160;
/**
 * r10 (run 34, +488 to +502): a piglin with a crossbow stood 5.9 to 7 m off, in sight of a body in a rock tunnel, and hit it six times in 14 s
 * (health 20 to 11.3). The cover moved only for a burning body, the melee hand only for an enemy within 4 m; the line was cut 29 s after the
 * first hit, by the planner's third try. The cover now also starts when the body was shot twice in SHOT_WINDOW_MS (the server's damage event
 * names a projectile and who shot it) and a shooter that sees it stands in reach: the same one minimal hand, and (only then) one more, a
 * block put on the line a cell or two from the body (`line`), counted by the sight lines it closes.
 */
const SHOT_WINDOW_MS = 5000;
const SHOT_HITS = 2;
/** A hit the server named nothing for is a shot only when it lands within this of the fall in health. */
const SHOT_NAMED_WITHIN_MS = 400;
const SHOT_NAMED_WAIT_MS = 150;
/** Beside COVER_SHOOTERS: kinds that shoot from afar with a crossbow; their reach is that of a bolt in the air. */
const SHOT_EXTRA_KINDS: Readonly<Record<string, number>> = { piglin: 32, pillager: 32 };
/** A block on the line is put at most this far from the body's eye, and at most this many in an episode. */
const LINE_REACH = 2.5;
const COVER_MAX_LINES = 4;
const COVER_STEP_DIRS: ReadonlyArray<readonly [number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

export interface CoverShooter { entity: FloorEntity; distance: number }
export type Cover =
  | { kind: 'step'; to: { x: number; y: number; z: number }; detail: string }
  | { kind: 'seal'; cell: { x: number; y: number; z: number }; block: string; detail: string }
  /** r10: a block in a cell on the shooters' line, a cell or two from the body (shot at from afar). */
  | { kind: 'line'; cell: { x: number; y: number; z: number }; block: string; detail: string }
  | { kind: 'dig'; cell: { x: number; y: number; z: number }; detail: string };

const centreOf = (cell: { x: number; y: number; z: number }) => new Vec3(cell.x + 0.5, cell.y, cell.z + 0.5);
const cellWords = (cell: { x: number; y: number; z: number }) => `(${cell.x},${cell.y},${cell.z})`;

/** The shooters within their reach of `feet` (all of them; `fought` leaves out a kind the planner fights by choice). */
export function shootersInReach(bot: FloorBody, feet: Vec3, fought?: (name: string) => boolean): CoverShooter[] {
  const out: CoverShooter[] = [];
  for (const entity of others(bot)) {
    const name = String(entity.name ?? '').toLowerCase(), reach = COVER_SHOOTERS[name];
    if (reach === undefined || (fought && fought(name))) continue;
    const distance = entity.position.distanceTo(feet);
    if (distance <= reach) out.push({ entity, distance });
  }
  return out.sort((a, b) => a.distance - b.distance);
}
/** A test of "solid" over the chunks' states (bodyReader: no Block made per cell; a cell not loaded is closed, as in threatExposure). */
function solidReader(bot: FloorBody): (x: number, y: number, z: number) => boolean {
  const read = bodyReader(bot as never);
  return (x, y, z) => { const block = read(x, y, z); return !block || block.solid === true; };
}
/** Of `shooters`, those that see a body standing at `feet`. */
export function shootersSeeing(bot: FloorBody, shooters: CoverShooter[], feet: Vec3, closed = solidReader(bot)): CoverShooter[] {
  return shooters.filter(shooter => { try { return seesBodyAt(bot as any, shooter.entity as any, feet, closed); } catch { return false; } });
}
/** "blaze #12 上5・9.1m、ghast #3 …" (the nearest three). */
export function shooterWords(feet: Vec3, shooters: CoverShooter[]): string {
  return shooters.slice(0, 3).map(({ entity, distance }) => {
    const dy = Math.round(entity.position.y - feet.y);
    return `${entity.name} #${entity.id} ${dy > 0 ? `上${dy}・` : dy < 0 ? `下${-dy}・` : ''}${distance.toFixed(1)}m`;
  }).join('、');
}

/** r10: the shooter behind a hit the server names as a projectile's (`damage_event`: the cause and the direct entity differ), or null. Ids are the server's plus one. */
export function projectileShooter(packet: { sourceCauseId?: number; sourceDirectId?: number } | null | undefined): number | null {
  const cause = Number(packet?.sourceCauseId ?? 0), direct = Number(packet?.sourceDirectId ?? 0);
  return cause > 0 && direct > 0 && direct !== cause ? cause - 1 : null;
}
/**
 * r10: the shots that landed in the last SHOT_WINDOW_MS and the shooters to cover from. A hit the server named (a projectile with a shooter)
 * counts with that shooter. A fall in health the server named nothing for (no packet, an older server) counts only when a shooter (the
 * cover's kinds, a piglin or a pillager) that sees the body stands out of a blow's reach and no melee enemy is within it.
 */
export function recentShots(bot: FloorBody, state: FloorState, feet: Vec3, t: number, fought?: (name: string) => boolean): { hits: number; shooters: CoverShooter[] } {
  const shots = (state.shots ?? []).filter(shot => t - shot.at <= SHOT_WINDOW_MS);
  // (A fall younger than the wait may still have its packet on the way.)
  const unnamed = (state.falls ?? []).filter(at => t - at <= SHOT_WINDOW_MS && t - at >= SHOT_NAMED_WAIT_MS && !(state.damageAt ?? []).some(named => Math.abs(named - at) <= SHOT_NAMED_WITHIN_MS));
  if (!shots.length && !unnamed.length) return { hits: 0, shooters: [] };
  const found = new Map<number, CoverShooter>();
  const keep = (entity: FloorEntity | undefined) => {
    if (!entity?.position || entity === bot.entity || entity.id === undefined) return;
    const name = String(entity.name ?? '').toLowerCase();
    if (fought && fought(name)) return;
    found.set(entity.id, { entity, distance: entity.position.distanceTo(feet) });
  };
  for (const shot of shots) keep(bot.entities?.[shot.shooter]);
  let hits = shots.length;
  if (unnamed.length) {
    const near = others(bot).some(entity => entity.position.distanceTo(feet) <= MELEE_RANGE && isThreat(bot, entity) && COVER_SHOOTERS[String(entity.name ?? '').toLowerCase()] === undefined
      && SHOT_EXTRA_KINDS[String(entity.name ?? '').toLowerCase()] === undefined);
    const watchers: CoverShooter[] = [];
    if (!near) {
      for (const entity of others(bot)) {
        const name = String(entity.name ?? '').toLowerCase(), reach = COVER_SHOOTERS[name] ?? SHOT_EXTRA_KINDS[name];
        if (reach === undefined || (fought && fought(name))) continue;
        const distance = entity.position.distanceTo(feet);
        if (distance > MELEE_RANGE && distance <= reach) watchers.push({ entity, distance });
      }
    }
    const seeing = watchers.length ? shootersSeeing(bot, watchers, feet) : [];
    if (seeing.length) { hits += unnamed.length; for (const { entity } of seeing) keep(entity); }
  }
  return { hits, shooters: [...found.values()].sort((a, b) => a.distance - b.distance) };
}

/**
 * The cover's hand now (`(a)` a step, `(b)` a block over the head, `(b')` r10, when shot at: a block on the shooters' line, `(c)` a step
 * down), or null with the facts of why none: the cells round it all seen or not to be stood in, the hole not sealable, the cell under the
 * feet not to be dug. `digs` is how many the episode has made. With `options.line` (the body is being shot at from afar), a block on the
 * line that closes every open sight line is taken before the dig; one that closes some, only when no dig can be made.
 */
export function coverChoice(bot: FloorBody, shooters: CoverShooter[], digs = 0, options: { line?: boolean; lines?: number } = {}): { cover: Cover | null; why: string } {
  const feet = feetCell(bot as never);
  if (!feet || !shooters.length) return { cover: null, why: '射手がいない' };
  const read = bodyReader(bot as never);
  const closed = solidReader(bot);
  // The nearest first: the line a step must leave is most likely theirs (and the test stops at the first that sees).
  const watching = shooters.slice(0, 8);
  const unseen = (cell: { x: number; y: number; z: number }, solidAt = closed) => !watching.some(shooter => {
    try { return seesBodyAt(bot as any, shooter.entity as any, centreOf(cell), solidAt); } catch { return true; }
  });
  const open = (x: number, y: number, z: number) => passable(read(x, y, z)) && passable(read(x, y + 1, z));
  // (a) A step: one or two cells across, at the same height, one up (a climb) or down (two at most); diagonal only one cell, its corners open.
  // The cells a body can be in are listed first (cheap), then looked at for the lines in order of the step's size, the first unseen taken.
  const steps: Array<{ cell: { x: number; y: number; z: number }; cost: number }> = [];
  for (const [dx, dz] of COVER_STEP_DIRS) {
    const diagonal = dx !== 0 && dz !== 0;
    if (diagonal && !(open(feet.x + dx, feet.y, feet.z) && open(feet.x, feet.y, feet.z + dz))) continue;
    for (let k = 1; k <= (diagonal ? 1 : 2); k++) {
      const x = feet.x + dx * k, z = feet.z + dz * k;
      if (k === 2 && !(standable(read, feet.x + dx, feet.y, feet.z + dz))) break;
      for (const dy of [0, 1, -1, -2]) {
        if (dy === 1 && (k !== 1 || !passable(read(feet.x, feet.y + 2, feet.z)) || climbRise(read, feet.x, feet.y, feet.z, x, z) > MAX_CLIMB + 1e-9)) continue;
        // Down: walked off the edge, so the cells over it at the feet's height are open.
        if (dy < 0 && !open(x, feet.y, z)) continue;
        const cell = { x, y: feet.y + dy, z };
        if (!standable(read, cell.x, cell.y, cell.z)) continue;
        steps.push({ cell, cost: k + Math.abs(dy) * 0.5 + (diagonal ? 0.4 : 0) });
      }
    }
  }
  steps.sort((a, b) => a.cost - b.cost);
  const best = steps.find(step => unseen(step.cell));
  if (best) {
    const way = `${best.cell.x - feet.x > 0 ? `東${best.cell.x - feet.x}` : best.cell.x < feet.x ? `西${feet.x - best.cell.x}` : ''}${best.cell.z > feet.z ? `南${best.cell.z - feet.z}` : best.cell.z < feet.z ? `北${feet.z - best.cell.z}` : ''}`;
    return { cover: { kind: 'step', to: best.cell, detail: `${way}へ動いた ${cellWords(feet)}→${cellWords(best.cell)}` }, why: '' };
  }
  const items = bot.inventory?.items() ?? [];
  // (b) A block over the head: the body is in a hole (something solid beside the cell over its head to set the block against), and with
  // that cell solid no shooter sees it.
  const over = { x: feet.x, y: feet.y + 2, z: feet.z };
  const overBlock = read(over.x, over.y, over.z);
  const block = items.filter(item => isPillarBlock(item.name)).sort((a, b) => ((b as { count?: number }).count ?? 1) - ((a as { count?: number }).count ?? 1))[0];
  const against = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]].some(([dx, dy, dz]) => {
    const side = (bot as unknown as TerrainBody).blockAt?.(new Vec3(over.x + dx, over.y + dy, over.z + dz));
    return side?.boundingBox === 'block';
  });
  const overOpen = !!overBlock && !overBlock.solid && overBlock.name !== 'lava' && overBlock.name !== 'water';
  let sealWhy = '';
  if (!block) sealWhy = '置くブロックを持っていない';
  else if (!overOpen) sealWhy = `頭の上 ${cellWords(over)} が ${overBlock?.name ?? '未ロード'}`;
  else if (!against) sealWhy = `頭の上 ${cellWords(over)} の周りに当てる面が無い`;
  else {
    const sealed = (x: number, y: number, z: number) => (x === over.x && y === over.y && z === over.z) || closed(x, y, z);
    if (unseen(feet, sealed)) return { cover: { kind: 'seal', cell: over, block: block.name, detail: `頭の上 ${cellWords(over)} を ${block.name} で塞いだ` }, why: '' };
    sealWhy = '頭の上を塞いでも横から見える';
  }
  // (b') r10, shot at from afar: one block on the shooters' line, a cell or two from the body, in the cell that closes the most sight lines.
  let lineWhy = '', partial: { cell: { x: number; y: number; z: number }; before: number; left: number } | null = null;
  if (options.line) {
    if (!block) lineWhy = '置くブロックを持っていない';
    else if ((options.lines ?? 0) >= COVER_MAX_LINES) lineWhy = `線上にはもう ${options.lines} 個置いた`;
    else {
      const found = lineChoice(bot, read, closed, watching, feet);
      if (found && found.left === 0) {
        return { cover: { kind: 'line', cell: found.cell, block: block.name, detail: `線上の ${cellWords(found.cell)} を ${block.name} で塞いだ` }, why: '' };
      }
      partial = found;
      if (!found) lineWhy = '線上の 1 マスでは見える線が減らない（当てる面が無いか、すでに塞がっている）';
    }
  }
  // (c) The cell under the feet dug: the body goes down one, onto the cell under it (solid, not lava or magma); no lava beside or under
  // the dug cell (it would run in onto the body); at most COVER_MAX_DIGS in an episode.
  const terrain = bot as unknown as TerrainBody;
  const under = terrain.blockAt?.(new Vec3(feet.x, feet.y - 1, feet.z)) as (FleeBlock & { diggable?: boolean }) | null | undefined;
  const below = terrain.blockAt?.(new Vec3(feet.x, feet.y - 2, feet.z));
  let digWhy = '';
  if (digs >= COVER_MAX_DIGS) digWhy = `足元はもう ${digs} 段掘った`;
  else if (!(under && under.boundingBox === 'block' && under.diggable !== false && !isFluid(under.name) && !isHazardousToStandOn(under.name)
    && !['bedrock', 'barrier', 'end_portal_frame', 'reinforced_deepslate'].includes(String(under.name)) && !PROTECTED_UTILITY_BLOCKS.has(String(under.name)))) {
    digWhy = `足元 ${cellWords({ ...feet, y: feet.y - 1 })} は ${under?.name ?? '未ロード'}（掘らない）`;
  } else if (!(below && below.boundingBox === 'block' && !isHazardousToStandOn(below.name))) digWhy = `足元の下 ${cellWords({ ...feet, y: feet.y - 2 })} が ${below?.name ?? '未ロード'}（立てない）`;
  else {
    let lava: Vec3 | null = null;
    try { lava = lavaReleasedBy(bot as never, new Vec3(feet.x, feet.y - 1, feet.z)); } catch { lava = null; }
    if (lava) digWhy = `足元の隣 ${cellWords(lava)} が溶岩`;
    else return { cover: { kind: 'dig', cell: { x: feet.x, y: feet.y - 1, z: feet.z }, detail: `足元を掘って下がった ${cellWords(feet)}` }, why: '' };
  }
  if (partial && block) {
    return { cover: { kind: 'line', cell: partial.cell, block: block.name, detail: `線上の ${cellWords(partial.cell)} を ${block.name} で塞いだ（見える線 ${partial.before}→${partial.left}）` }, why: '' };
  }
  return { cover: null, why: `周り 2 マスに見えない立つ所が無い・${sealWhy}${lineWhy && lineWhy !== sealWhy ? `・${lineWhy}` : ''}・${digWhy}` };
}

/**
 * r10: of the cells on the lines from the shooters' eyes to the body's eye and chest, within LINE_REACH of the body (air, not the body's own,
 * with a solid face to set a block against), the one that leaves the fewest sight lines open when it is a block (nearest first among equals).
 * Null when no cell closes any. The sight lines are counted (`openSightLines`): one block rarely closes both the eye's and the chest's.
 */
function lineChoice(bot: FloorBody, read: ReturnType<typeof bodyReader>, closed: (x: number, y: number, z: number) => boolean, watching: CoverShooter[],
  feet: { x: number; y: number; z: number }): { cell: { x: number; y: number; z: number }; before: number; left: number } | null {
  const at = centreOf(feet);
  const origins = [at.offset(0, 1.62, 0), at.offset(0, 0.9, 0)];
  const cells = new Map<string, { cell: { x: number; y: number; z: number }; near: number }>();
  for (const { entity } of watching) {
    const eyes = entity.position.offset(0, (entity.height ?? 1.8) * 0.85, 0);
    for (const from of origins) {
      const span = from.distanceTo(eyes);
      if (span < 0.75) continue;
      const step = eyes.minus(from).scaled(1 / span);
      for (let s = 0.25; s <= LINE_REACH && s < span; s += 0.25) {
        const p = from.plus(step.scaled(s));
        const cell = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
        if (cell.x === feet.x && cell.z === feet.z && (cell.y === feet.y || cell.y === feet.y + 1)) continue;
        const key = `${cell.x},${cell.y},${cell.z}`, old = cells.get(key);
        if (!old || s < old.near) cells.set(key, { cell, near: s });
      }
    }
  }
  const count = (solidAt: (x: number, y: number, z: number) => boolean) => watching.reduce((sum, { entity }) => {
    try { return sum + openSightLines(bot as any, entity as any, at, solidAt); } catch { return sum; }
  }, 0);
  const before = count(closed);
  if (before === 0) return null;
  const placeable = [...cells.values()].filter(({ cell }) => {
    const here = read(cell.x, cell.y, cell.z);
    if (!here || !enterable(here) || isFluid(here.name)) return false;
    return [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].some(([dx, dy, dz]) => read(cell.x + dx, cell.y + dy, cell.z + dz)?.solid === true);
  }).sort((a, b) => a.near - b.near).slice(0, 10);
  let best: { cell: { x: number; y: number; z: number }; before: number; left: number } | null = null;
  for (const { cell } of placeable) {
    const left = count((x, y, z) => (x === cell.x && y === cell.y && z === cell.z) || closed(x, y, z));
    if (left < before && (!best || left < best.left)) best = { cell, before, left };
    if (left === 0) break;
  }
  return best;
}

/** Runs one hand of the cover as the work of a safety-lease action (`port` is the body's motor port). */
export async function runCover(bot: FloorBody, port: FloorBody, cover: Cover, timeoutMs = COVER_TIMEOUT_MS[cover.kind]): Promise<{ success: boolean; result: string }> {
  const base = feetCell(bot as never) ?? { x: 0, y: 0, z: 0 };
  const ctx = { bot: port, stop: new AbortController().signal, deadline: Date.now() + timeoutMs, facing: 'north' as const, base };
  if (cover.kind === 'step') {
    const { walk } = await import('./primitives/walk.js');
    const outcome = await walk(ctx as never, { to: cover.to, range: 0, sprint: true });
    return { success: outcome.ok, result: outcome.text };
  }
  if (cover.kind === 'seal' || cover.kind === 'line') {
    const { place } = await import('./primitives/place.js');
    const outcome = await place(ctx as never, { block: cover.block, at: [cover.cell] });
    return { success: outcome.ok, result: outcome.text };
  }
  const { dig } = await import('./primitives/dig.js');
  const outcome = await dig(ctx as never, { at: [cover.cell], collect: false, exposeOk: true });
  return { success: outcome.ok, result: outcome.text };
}

// ===== r8: a melee enemy near, and the rim of a drop at the feet =====

/**
 * Run 32 (2026-10-22, +321 to +330 s): on a bridge one block wide over a lava sea (24 to 30 cells of air on both sides) a wither skeleton
 * from the fortress above came to 6 m, the planner's next decision took 10.3 s, and in 2.3 s it struck three times. The flee found no way
 * (every cell round was air), the last stand struck back once and then jumped to lay a block under the feet (pillarUp); a blow in the air
 * threw the body off the bridge, and it fell 30 cells into the lava. The cover (r7) is for shooters only.
 *
 * The melee hand: one minimal hand, told as a fact, never a plan. A melee enemy (a threat that is not a shooter or a
 * creeper) within MELEE_RANGE that can get at the body (its exposure is not `sealed`, read now), and either
 *   - the body stands at the rim of a drop (a cell round the feet that is open and falls VOID_DROP cells or more, or ends in lava:
 *     utils/voidFooting): (a) one step to a cell with fewer such cells round it; else (b) a block put in the cell toward the enemy (a second
 *     one over it, in the same episode); else (c) one step that gets farther from it;
 *   - or the body is on a floor and was hurt in the last two seconds (and is above the flee's health): one step away, never to a rim.
 * At most MELEE_MAX_HANDS in an episode (hands less than MELEE_EPISODE_MS apart); then it says so and leaves the decision to the planner. The
 * act running stops (the lease is taken); the ledger says what was done, the footing and how near the enemy is now. A kind the planner fights
 * by choice is left alone above the flee's health. No pillar is ever made at a rim: a jump there is a body in the air that a blow throws.
 */
const MELEE_RANGE = 4;
const MELEE_GAP_MS = 250;
const MELEE_EPISODE_MS = 4000;
const MELEE_MAX_HANDS = 3;
const MELEE_NOTE_GAP_MS = 5000;
/** A step must get this much farther from the nearest melee enemy (a step that does not is no step away). */
const MELEE_STEP_GAIN = 0.6;
const MELEE_DETAIL_MAX = 160;
/** How many of the nearest enemies have their exposure read at a look. */
const MELEE_LOOKED_AT = 3;
const MELEE_TIMEOUT_MS: Record<MeleeHand['kind'], number> = { step: 3000, block: 3000, hit: 3500, pillar: 5000 };
const AIR_BLOCKS = new Set(['air', 'cave_air', 'void_air']);

/**
 * r9 (run 33, +992 to +999 s): on a floor (no rim) a normal piglin with a golden sword chased the body at its own speed: three "one step away"
 * hands, a flee of 8 m that did not shake it, five blows taken in 6.5 s, dead; the iron sword was in the hand. A step away from an enemy that
 * is as fast as the body is no answer, and neither is the flee. On a floor, when a melee enemy is on the body (it hurt the body in the last two
 * seconds, or it is still within MELEE_CHASED_RANGE after a hand of this episode):
 *   - a blade (sword or axe) carried and health above MELEE_HIT_HEALTH: a blow back, at the nearest enemy that is within reach of the eye
 *     (MELEE_HIT_REACH to its box) and in sight (nothing solid on the line), MELEE_BLOWS_PER_HAND blows to a hand with the weapon's own wait
 *     between; the hand says the blows swung, those that landed and what is left of the enemy. Never a chase: an enemy out of reach or out of
 *     sight is left (it comes, or it does not);
 *   - no blade, or health at or below MELEE_HIT_HEALTH: a block put in the cell between (r8's block), else two blocks up (when the three cells
 *     over the head are clear), else, above the flee's health, a step away (r8's).
 * At a rim the r8 hands stand as they were: no blow, no jump. The hands of an episode: MELEE_MAX_HANDS of a block, a step or a pillar, and
 * MELEE_MAX_HITS of a blow; then it says so and the decision is the planner's.
 */
const MELEE_HIT_REACH = 3;
const MELEE_HIT_HEALTH = 6;
const MELEE_CHASED_RANGE = 3;
const MELEE_BLOWS_PER_HAND = 2;
const MELEE_MAX_HITS = 5;
const MELEE_PILLAR_N = 2;
/** The wait between two blows of a weapon (the game's attack speed), as primitives/attack reads it. */
function bladeWaitMs(name: string): number {
  if (name.endsWith('_sword')) return 650;
  return name.startsWith('wooden_') || name.startsWith('stone_') ? 1270 : name.startsWith('iron_') ? 1130 : 1020;
}
/** A sword or an axe (a pickaxe, a shovel or a hoe is a tool, not a blade), the better first; null when none is carried. */
export function bestBlade(items: Item[]): Item | null {
  const blade = bestMeleeWeapon(items.filter(item => item.name.endsWith('_sword') || item.name.endsWith('_axe')));
  return blade;
}

export interface MeleeThreat { entity: FloorEntity; distance: number }
export type MeleeHand =
  | { kind: 'step'; to: { x: number; y: number; z: number }; detail: string }
  | { kind: 'block'; cell: { x: number; y: number; z: number }; block: string; detail: string }
  /** r9, on a floor: a blow back at an enemy on the body, with a blade carried. */
  | { kind: 'hit'; target: FloorEntity; weapon: Item; detail: string }
  /** r9, on a floor: `n` blocks up under the feet, out of a melee enemy's reach. */
  | { kind: 'pillar'; block: string; n: number; detail: string };

/** The melee enemies within MELEE_RANGE, the nearest first, without a look at whether they can get at the body (cheap: the tick's first test). */
export function meleeCandidates(bot: FloorBody, fought?: (name: string) => boolean): MeleeThreat[] {
  const at = bot.entity?.position; if (!at) return [];
  const near: MeleeThreat[] = [];
  for (const entity of others(bot)) {
    const name = String(entity.name ?? '').toLowerCase();
    if (!name || name === 'creeper' || SHOOTERS.has(name) || COVER_SHOOTERS[name] !== undefined || bot.shootsAtBody?.(name) === true || (fought && fought(name))) continue;
    const distance = entity.position.distanceTo(at);
    if (distance <= MELEE_RANGE && isThreat(bot, entity)) near.push({ entity, distance });
  }
  return near.sort((a, b) => a.distance - b.distance);
}

/** The melee enemies within MELEE_RANGE that can get at the body now, the nearest first (`fought`: kinds the planner fights by choice, left out). */
export function meleeThreatsNear(bot: FloorBody, fought?: (name: string) => boolean): MeleeThreat[] {
  const near = meleeCandidates(bot, fought);
  // The exposure is a flood fill of up to 15 ms each, read fresh: for the nearest few only (a crowd is told by the nearest).
  const out: MeleeThreat[] = [];
  for (const threat of near.slice(0, MELEE_LOOKED_AT)) {
    let exposure: ReturnType<typeof threatExposure>;
    try { exposure = threatExposure(bot as any, threat.entity as any, Date.now(), { fresh: true }); } catch { exposure = 'reachable'; }
    if (exposure !== 'sealed') out.push(threat);
  }
  return out;
}

/** "wither_skeleton #12 上3・3.1m" (and "ほか 1 体"): the nearest melee enemy as the reflex's line names it. */
function meleeWho(body: Vec3, threats: MeleeThreat[]): string {
  const first = threats[0], dy = Math.round(first.entity.position.y - body.y);
  return `近接の ${first.entity.name} #${first.entity.id} ${dy > 0 ? `上${dy}・` : dy < 0 ? `下${-dy}・` : ''}${first.distance.toFixed(1)}m${threats.length > 1 ? `ほか${threats.length - 1}体` : ''}`;
}

function wayWordsOf(from: { x: number; z: number }, to: { x: number; z: number }): string {
  return `${to.x > from.x ? `東${to.x - from.x}` : to.x < from.x ? `西${from.x - to.x}` : ''}${to.z > from.z ? `南${to.z - from.z}` : to.z < from.z ? `北${from.z - to.z}` : ''}`;
}

/**
 * The melee hand now, or null with the facts of why none: `quiet` is true when there is nothing to do (not at a rim, not being hurt).
 * `hands` is how many the episode has made (the second block goes over the first); `beingHit` is a body on a floor that was hurt just now.
 */
export function meleeChoice(bot: FloorBody, threats: MeleeThreat[], options: { hands?: number; beingHit?: boolean; chased?: boolean } = {}): { hand: MeleeHand | null; why: string; footing: Footing; quiet: boolean } {
  const feet = feetCell(bot as never), body = bot.entity?.position;
  const nothing: Footing = { sides: [], count: 0, deepest: 0, lava: false, bridge: false, pillar: false };
  if (!feet || !body || !threats.length) return { hand: null, why: '', footing: nothing, quiet: true };
  const read = bodyReader(bot as never);
  const here = footingAt(read, feet);
  const rim = here.count > 0;
  if (!rim && !options.beingHit && !options.chased) return { hand: null, why: '', footing: here, quiet: true };
  const open = (x: number, y: number, z: number) => passable(read(x, y, z)) && passable(read(x, y + 1, z));
  const apart = (x: number, y: number, z: number) => Math.min(...threats.map(({ entity }) => Math.hypot(entity.position.x - x, (entity.position.y - y) * 0.5, entity.position.z - z)));
  const now = apart(body.x, body.y, body.z);
  // One step across (or one up or down) to a cell a body can stand in, not into a creature, with the rim round the cell it comes to.
  const steps: Array<{ cell: { x: number; y: number; z: number }; footing: Footing; gain: number }> = [];
  for (const [dx, dz] of COVER_STEP_DIRS) {
    if (dx !== 0 && dz !== 0 && !(open(feet.x + dx, feet.y, feet.z) && open(feet.x, feet.y, feet.z + dz))) continue;
    const x = feet.x + dx, z = feet.z + dz;
    for (const dy of [0, 1, -1]) {
      if (dy === 1 && (!passable(read(feet.x, feet.y + 2, feet.z)) || climbRise(read, feet.x, feet.y, feet.z, x, z) > MAX_CLIMB + 1e-9)) continue;
      if (dy === -1 && !open(x, feet.y, z)) continue;
      const cell = { x, y: feet.y + dy, z };
      if (!standable(read, cell.x, cell.y, cell.z)) continue;
      if (threats.some(({ entity }) => Math.abs(entity.position.x - (cell.x + 0.5)) < 0.9 && Math.abs(entity.position.z - (cell.z + 0.5)) < 0.9 && Math.abs(entity.position.y - cell.y) < 2)) continue;
      steps.push({ cell, footing: footingAt(read, cell), gain: apart(cell.x + 0.5, cell.y, cell.z + 0.5) - now });
    }
  }
  const stepHand = (step: typeof steps[number], lead: string): MeleeHand => ({ kind: 'step', to: step.cell,
    detail: `${lead}${wayWordsOf(feet, step.cell)}へ動いた ${cellWords(feet)}→${cellWords(step.cell)}` });
  const order = (a: typeof steps[number], b: typeof steps[number]) => a.footing.count - b.footing.count || b.gain - a.gain;
  const why: string[] = [];
  const items = bot.inventory?.items() ?? [];
  /** A block in the cell toward the enemy (over the first one when it is in): the hand, or null with the why pushed. */
  const blockBetween = (): MeleeHand | null => {
    const block = items.filter(item => isPillarBlock(item.name)).sort((a, b) => ((b as { count?: number }).count ?? 1) - ((a as { count?: number }).count ?? 1))[0];
    if (!block) { why.push('置くブロックを持っていない'); return null; }
    const ex = threats[0].entity.position.x - (feet.x + 0.5), ez = threats[0].entity.position.z - (feet.z + 0.5);
    if (Math.abs(ex) < 0.5 && Math.abs(ez) < 0.5) { why.push('敵が真上か真下で、間のマスが無い'); return null; }
    const sx = Math.abs(ex) >= Math.abs(ez) ? Math.sign(ex) : 0, sz = sx === 0 ? Math.sign(ez) : 0;
    const x = feet.x + sx, z = feet.z + sz;
    const own = bodyCellsOf(body);
    const placeable = (y: number) => {
      const cell = read(x, y, z);
      if (!cell || !AIR_BLOCKS.has(cell.name) || own.some(c => c.x === x && c.y === y && c.z === z)) return false;
      if (threats.some(({ entity }) => Math.abs(entity.position.x - (x + 0.5)) < 1 && Math.abs(entity.position.z - (z + 0.5)) < 1 && Math.abs(entity.position.y - y) < 2.5)) return false;
      return [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]].some(([ax, ay, az]) => read(x + ax, y + ay, z + az)?.solid === true);
    };
    const low = feet.y, high = feet.y + 1;
    const lowSolid = read(x, low, z)?.solid === true;
    const target = placeable(low) ? low : ((options.hands ?? 0) > 0 && lowSolid && placeable(high)) ? high : null;
    if (target !== null) return { kind: 'block', cell: { x, y: target, z }, block: block.name, detail: `間 ${cellWords({ x, y: target, z })} に ${block.name} を置いた` };
    why.push(lowSolid ? '敵との間は既に塞がっている' : `敵との間の ${cellWords({ x, y: low, z })} に置けない`);
    return null;
  };
  if (rim) {
    // (a) away from the drop: a cell with fewer open-over-air cells round it.
    const fewer = steps.filter(step => step.footing.count < here.count && step.gain >= -0.5).sort(order)[0];
    if (fewer) return { hand: stepHand(fewer, '空所から離れる向きへ'), why: '', footing: here, quiet: false };
    // (b) a block in the cell toward the enemy (over the first one when it is in).
    const placed = blockBetween();
    if (placed) return { hand: placed, why: '', footing: here, quiet: false };
  } else {
    // r9, on a floor with an enemy on the body: a blow back with a blade carried and health above MELEE_HIT_HEALTH; else a block between, else
    // two blocks up. A blow is struck only at what is within reach of the eye and in sight; an enemy that is not yet is left (no chase).
    const health = bot.health ?? 20;
    const blade = bestBlade(items);
    if (blade && health > MELEE_HIT_HEALTH) {
      const reached = threats.find(({ entity }) => { try { return inReachOfBlow(bot, entity); } catch { return false; } });
      if (!reached) return { hand: null, why: '', footing: here, quiet: true };
      return { hand: { kind: 'hit', target: reached.entity, weapon: blade, detail: `${blade.name} で打ち返す` }, why: '', footing: here, quiet: false };
    }
    const placed = blockBetween();
    if (placed) return { hand: placed, why: '', footing: here, quiet: false };
    const up = pillarOver(read, feet, items, why);
    if (up) return { hand: up, why: '', footing: here, quiet: false };
    // Nothing to put: at the flee's health the flee is the one that runs; above it a step away (r8's) is the last of the hands.
    if ((bot.health ?? 20) <= FLEE_HEALTH) return { hand: null, why: why.join('・'), footing: here, quiet: true };
  }
  // (c) a step that gets away (on a floor: never to a rim; at a rim: to one no worse).
  const away = steps.filter(step => step.footing.count <= here.count && step.gain >= MELEE_STEP_GAIN).sort(order)[0];
  if (away) return { hand: stepHand(away, '敵から離れる向きへ'), why: '', footing: here, quiet: false };
  why.push('下がる所が無い');
  return { hand: null, why: why.join('・'), footing: here, quiet: false };
}

/** An enemy within reach of a blow (the eye to its box, MELEE_HIT_REACH) and in sight (nothing solid on the line), as `attack mode=hold` reads it. */
function inReachOfBlow(bot: FloorBody, entity: FloorEntity): boolean {
  const body = bot.entity?.position; if (!body) return false;
  const answer = probeSight(bodyReader(bot as never), eyeOf(body), { creature: { id: Number(entity.id), name: String(entity.name ?? 'entity'), position: entity.position, height: entity.height, width: entity.width } });
  return answer.visible && answer.reach;
}

/** r9: MELEE_PILLAR_N blocks up under the feet, when a full block is carried (that many) and the cells over the head are clear for the jumps. */
function pillarOver(read: ReturnType<typeof bodyReader>, feet: { x: number; y: number; z: number }, items: Item[], why: string[]): MeleeHand | null {
  const totals = new Map<string, number>();
  for (const item of items) if (isPillarBlock(item.name)) totals.set(item.name, (totals.get(item.name) ?? 0) + ((item as { count?: number }).count ?? 1));
  const best = [...totals.entries()].sort((a, b) => b[1] - a[1])[0];
  if (!best) { why.push('積むブロックを持っていない'); return null; }
  if (best[1] < MELEE_PILLAR_N) { why.push(`積むブロックが${MELEE_PILLAR_N}個に足りない`); return null; }
  for (let dy = 2; dy <= MELEE_PILLAR_N + 2; dy++) {
    const cell = read(feet.x, feet.y + dy, feet.z);
    if (!cell || !enterable(cell) || isFluid(cell.name)) { why.push(`頭の上 ${cellWords({ x: feet.x, y: feet.y + dy, z: feet.z })} が${cell ? cell.name : '未ロード'}で積めない`); return null; }
  }
  return { kind: 'pillar', block: best[0], n: MELEE_PILLAR_N, detail: `${MELEE_PILLAR_N}段積んで上がった` };
}

/** The cells the body's box fills at `position` (0.6 wide, 1.8 tall; as the `place` hand counts them). */
function bodyCellsOf(position: { x: number; y: number; z: number }): Array<{ x: number; y: number; z: number }> {
  const cells: Array<{ x: number; y: number; z: number }> = [];
  for (const dx of [-0.3, 0.3]) for (const dz of [-0.3, 0.3]) for (const dy of [0, 0.9, 1.79]) {
    const cell = { x: Math.floor(position.x + dx), y: Math.floor(position.y + dy), z: Math.floor(position.z + dz) };
    if (!cells.some(other => other.x === cell.x && other.y === cell.y && other.z === cell.z)) cells.push(cell);
  }
  return cells;
}

/** Runs one melee hand as the work of a safety-lease action (`port` is the body's motor port): a step is walked, a block is placed. */
export function runMelee(bot: FloorBody, port: FloorBody, hand: MeleeHand): Promise<{ success: boolean; result: string }> {
  if (hand.kind === 'hit') return runHit(bot, port, hand);
  if (hand.kind === 'pillar') return runPillarHand(bot, port, hand);
  return runCover(bot, port, hand.kind === 'step' ? { kind: 'step', to: hand.to, detail: hand.detail } : { kind: 'seal', cell: hand.cell, block: hand.block, detail: hand.detail },
    MELEE_TIMEOUT_MS[hand.kind]);
}

const rethrowIfTaken = (error: unknown) => { if (/Action interrupted|Motor owner expired/u.test(String((error as Error)?.message))) throw error; };

/**
 * r9: the blows of a hit hand. The blade is put in the hand, then up to MELEE_BLOWS_PER_HAND blows at the enemy while it is within reach of the
 * eye and in sight and the health is above MELEE_HIT_HEALTH, with the weapon's own wait between. Says the blows swung, those that landed (the
 * enemy's hurt after a swing) and what is left of it; a hand that struck nothing says why.
 */
/**
 * A wait that ends at once when the action it belongs to is stopped (continue contracts, 4: a hand the act takes the body over from must let go in a few
 * milliseconds, not after the weapon's wait; the isolated lab measured 0.7 to 1.0 s from the stop to the settle with plain sleeps).
 */
function abortableDelay(port: unknown, ms: number): Promise<void> {
  return new Promise(resolve => {
    const signal = actionSignal(port as object);
    if (signal?.aborted) { resolve(); return; }
    const timer = setTimeout(done, ms);
    function done() { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); }
    signal?.addEventListener('abort', done, { once: true });
  });
}
async function runHit(bot: FloorBody, port: FloorBody, hand: Extract<MeleeHand, { kind: 'hit' }>): Promise<{ success: boolean; result: string }> {
  const motor = port as any, raw = bot as any, target = hand.target, weapon = hand.weapon;
  if (bot.heldItem?.name !== weapon.name) {
    try { await motor.equip(weapon, 'hand'); } catch (error) { rethrowIfTaken(error); }
  }
  let swung = 0, landed = 0, dead = false, stopped = '';
  const onHurt = (entity: any) => { if (entity?.id === target.id) landed++; };
  const onDead = (entity: any) => { if (entity?.id === target.id) dead = true; };
  raw.on?.('entityHurt', onHurt); raw.on?.('entityDead', onDead);
  const find = () => Object.values(bot.entities ?? {}).find(entity => entity === target || (entity?.id !== undefined && entity.id === target.id));
  try {
    for (let blow = 0; blow < MELEE_BLOWS_PER_HAND && !dead; blow++) {
      // Run 45 (+929: seven blows at a zombie, every other one 0.14 to 0.2 s after the one before, the first of the next hand; a blow before the
      // weapon is ready deals a fifth of its damage): the weapon's own wait is kept from the last blow, whichever hand struck it.
      const ready = (raw.meleeBlowAt ?? 0) + bladeWaitMs(weapon.name) - Date.now();
      if (ready > 0) await abortableDelay(motor, Math.min(ready, 1_000));
      if (actionSignal(motor)?.aborted) { stopped = '止められた'; break; }
      const live = find();
      if (!live || !bot.entity) { stopped = '相手が見えなくなった'; break; }
      if ((bot.health ?? 0) <= MELEE_HIT_HEALTH) { stopped = `体力が${MELEE_HIT_HEALTH}以下になった`; break; }
      let reachable = false;
      try { reachable = inReachOfBlow(bot, live); } catch { reachable = false; }
      if (!reachable) { stopped = '届かない所へ離れた'; break; }
      try { await motor.lookAt?.(live.position.offset(0, (live.height ?? 1.8) * 0.6, 0), true); } catch (error) { rethrowIfTaken(error); }
      motor.attack(live); swung++; raw.meleeBlowAt = Date.now();
      // A moment for the hurt that answers it (the wait for the weapon is at the next blow).
      await abortableDelay(motor, 120);
      if (actionSignal(motor)?.aborted) { stopped = '止められた'; break; }
    }
  } finally { raw.removeListener?.('entityHurt', onHurt); raw.removeListener?.('entityDead', onDead); }
  if (!swung) return { success: false, result: `打てなかった: ${stopped || '届かない'}` };
  const left = find();
  let health: number | null = null;
  try { health = left ? entityHealth(bot as never, left as never) : null; } catch { health = null; }
  return { success: true, result: `打ち返した ${swung} 回（${weapon.name}）・当たった ${Math.min(landed, swung)}${health !== null ? `・相手の残り体力 ${health}` : ''}${dead ? '（倒した）' : ''}${stopped ? `（${stopped}）` : ''}` };
}

/** r9: MELEE_PILLAR_N blocks up under the feet (pillarUp), through the safety lease's motor port. */
async function runPillarHand(bot: FloorBody, port: FloorBody, hand: Extract<MeleeHand, { kind: 'pillar' }>): Promise<{ success: boolean; result: string }> {
  const position = bot.entity!.position;
  const base = { x: Math.floor(position.x), y: Math.floor(position.y + 1e-3), z: Math.floor(position.z) };
  const ctx = { bot: port, stop: new AbortController().signal, deadline: Date.now() + MELEE_TIMEOUT_MS.pillar, facing: 'north' as const, base };
  const { pillarUp } = await import('./primitives/pillarUp.js');
  const outcome = await pillarUp(ctx as never, { n: hand.n, block: hand.block });
  return { success: outcome.ok, result: outcome.text };
}

export function installFloorReflexes(bot: FloorBody, config: FloorConfig = floorConfig(), options: { fleeTickMs?: number; now?: () => number } = {}): void {
  if (bot.floorReflexes) return;
  const now = options.now ?? Date.now;
  const state: FloorState = bot.floorReflexes = { retreat: { engaged: false, ticks: 0, cooldown: 0, engagements: 0 }, busy: null, retryAt: 0,
    engagements: { eat: 0, armor: 0, flee: 0 }, fleeStarts: [], clock: now };
  const ledger = ensureReflexLedger(bot as any);
  // r10: what the server says hit the body. A projectile with a shooter behind it (the cause and the direct entity differ) is a shot: the
  // cover starts on the second in SHOT_WINDOW_MS. Every named hit is kept, so that a fall in health nothing named is told from these.
  try {
    bot._client?.on?.('damage_event', (packet: { entityId?: number; sourceCauseId?: number; sourceDirectId?: number }) => {
      if (!bot.entity || packet?.entityId !== bot.entity.id) return;
      const at = now(), keepFor = 2 * SHOT_WINDOW_MS;
      state.damageAt = [...(state.damageAt ?? []).filter(when => at - when <= keepFor), at];
      const shooter = projectileShooter(packet);
      if (shooter !== null) state.shots = [...(state.shots ?? []).filter(shot => at - shot.at <= keepFor), { at, shooter }];
    });
  } catch { /* the packet is a help */ }
  // Said to the mind (ledger -> state.world.reflexes) when the allowance runs out or a latch closes; the facts say what is held.
  const budget = config.budget ? state.budget = new FloorBudget(now, detail => {
    log.warn(`🚦 ${detail}`);
    ledger.note('budget', detail);
  }) : null;
  type Work = () => Promise<{ success: boolean; result: string }>;
  const take = (capability: string, priority: number, timeoutMs: number, work: Work) => {
    preemptLowerPriorityActions(bot, priority, capability);
    return executeAction(bot as any, capability, timeoutMs, work as any,
      { priority, safetyLease: true, waitForQuiescence: false, legacyExecutingSkill: true });
  };
  /** `take`, with the ledger told when it began and how it ended (done, cut off by a stronger reflex, or failed). */
  const takeNoted = (kind: ReflexKind, detail: string, capability: string, priority: number, timeoutMs: number, work: Work, metered?: BudgetKind, detailMax?: number) => {
    const handle = ledger.begin(kind, detail, detailMax), startedAt = now();
    return take(capability, priority, timeoutMs, work).then(result => {
      const outcome = result?.success ? 'done' : result?.failureType === 'interrupted' ? 'cut' : 'failed';
      ledger.end(handle, outcome); if (metered) budget?.end(metered, startedAt, outcome);
      return result;
    }, error => { ledger.end(handle, 'failed'); if (metered) budget?.end(metered, startedAt, 'failed'); throw error; });
  };
  /** The retry after a failed meal or armour change: the budget's backoff, or (budget denied) the fixed three seconds as before. */
  const failed = () => { if (!budget) state.retryAt = Date.now() + RETRY_AFTER_MS; };
  // The budget's say on an arrow step-aside. In the default mode it also does not cut the API's escape or shelter command (a lit creeper's
  // retreat is never asked about: that is a second from an explosion, as in production).
  // A lit creeper is stepped back from whatever runs, except flee-from's straight run away (`fleeStraightRun`, set on the body while
  // it lasts): a one-second step cut that off and handed the body back standing (run 17: interrupted, then caught at 3 m). The route
  // search after the run is still cut: stuck there, the step back is the last thing between the body and the blast.
  // An arrow's step aside does not cut a fight of the planner's choosing against archers either (engagement with a kind that shoots,
  // or with whatever is hostile: attack-*, combat, shoot-bow, accept-threat): the fight moves the body itself, and a step that ends
  // the command hands the body back standing in the archer's line while the next decision is made. A fight with a zombie is still
  // stepped out of for a skeleton's arrow (a kind not taken on is an emergency as before). The low-health flee and a lit creeper
  // still come first.
  const baseAllow = config.wideThreats || budget
    ? (kind: 'creeper' | 'arrow') => kind === 'creeper' ? !(config.wideThreats && (bot as { fleeStraightRun?: boolean }).fleeStraightRun === true)
      : ((!config.wideThreats || (!escapeRunning(bot) && !engagedWithAny(bot, ARCHERS))) && (!budget || budget.allow('arrow', bot.health ?? 20)))
    : undefined;
  // A creeper fought on purpose (attack-continuously creeper, in iron with a sword: utils/creeperDuel) steps back from its own fuse; the
  // floor's step back would end the fight a second after it began (run 24: the planner's order was cut three times by a creeper 13 m off).
  const retreatAllow = (kind: 'creeper' | 'arrow') => (kind === 'creeper' && (bot as { creeperDuel?: boolean }).creeperDuel === true) ? false : (baseAllow ? baseAllow(kind) : true);
  /**
   * The last stand (`lastStandChoice`): one minimal hand, told in the ledger so that the act running stops as a reflex. Once in
   * LAST_STAND_GAP_MS, never over another safety lease or one of the API's escapes. False when nothing was started.
   */
  const lastStand = (cause: 'low-health' | 'creeper'): boolean => {
    // r6 (run 29): the planner's act is laying blocks (place, pillarUp): the low-health stand does not cut it. Three hands that closed the
    // shaft over the head were cut by steps down; the facts are read again when the hand is over (the next refused flee).
    if (cause === 'low-health' && LAYING_HANDS.has(String((bot as { actHandNow?: string }).actHandNow ?? ''))) return false;
    let stand: LastStand | null = null;
    try {
      stand = !hasActiveSafetyLease(bot) && !escapeRunning(bot) && (bot.health ?? 20) > 0 && now() - (state.lastStandAt ?? -Infinity) >= LAST_STAND_GAP_MS
        ? lastStandChoice(bot, state.lastStandFailed, cause) : null;
    } catch { stand = null; }
    if (!stand) return false;
    const chosen = stand;
    state.lastStandAt = now(); state.busy = 'flee';
    if (chosen.kind === 'hit' && typeof chosen.target?.id === 'number') state.handTarget = { capability: 'floor-last-stand', target: chosen.target.id, at: now() };
    log.warn(`🧱 ${cause === 'creeper' ? '点火したクリーパーから' : '低体力で'}逃げ道なし、最後の手: ${chosen.kind}`);
    void takeNoted(cause === 'creeper' ? 'retreat' : 'flee', chosen.detail, 'floor-last-stand', cause === 'creeper' ? FLOOR_RETREAT_PRIORITY : FLOOR_FLEE_PRIORITY,
      LAST_STAND_TIMEOUT_MS[chosen.kind], () => runLastStand(bot, createMotorPort(bot), chosen), undefined, LAST_STAND_DETAIL_MAX)
      .then(result => { state.lastStandFailed = result?.success ? undefined : chosen.kind; }, () => { state.lastStandFailed = chosen.kind; })
      .catch(() => undefined).finally(() => { state.busy = null; });
    return true;
  };
  /**
   * r7, the cover (`coverChoice`): while the body burns (or, in an episode, keeps losing health) and a shooter in reach sees it, one hand that
   * cuts the line, told in the ledger with whether it is cut. Never over another safety lease, an escape, or the planner's blocks going in;
   * a kind the planner fights by choice (accept, attack) is left out while health is above the flee's. True when a hand was started.
   */
  const coverTick = (): boolean => {
    if (!config.flee) return false;
    const t = now(), health = bot.health ?? 20;
    if (health <= 0) return false;
    let burning = false;
    try { burning = isBurning(bot as never); } catch { burning = false; }
    const falling = t - (state.healthSeen?.fellAt ?? -Infinity) <= COVER_FALL_MS;
    const episode = state.cover && t - state.cover.lastEnd <= COVER_EPISODE_MS ? state.cover : undefined;
    if (!episode) state.cover = undefined;
    // r10: shot at from afar (twice in SHOT_WINDOW_MS) also starts it, whether the body burns or not.
    const mayBeShot = !!state.shots?.length || !!state.falls?.length;
    if (!burning && !(episode && falling) && !mayBeShot) return false;
    if (t < (state.coverNextAt ?? 0)) return false;
    if (hasActiveSafetyLease(bot) || escapeRunning(bot) || bot.lavaReflex?.engaged === true || bot.breathingReflex?.engaged === true) return false;
    if (LAYING_HANDS.has(String((bot as { actHandNow?: string }).actHandNow ?? ''))) return false;
    const body = bot.entity; if (!body) return false;
    const fought = health > FLEE_HEALTH ? (name: string) => engagedWithAny(bot, [name]) : undefined;
    let shot: { hits: number; shooters: CoverShooter[] } | null = null;
    if (mayBeShot) {
      try { const found = recentShots(bot, state, body.position, t, fought); if (found.hits >= SHOT_HITS && found.shooters.length) shot = found; } catch { shot = null; }
    }
    if (!burning && !(episode && falling) && !shot) return false;
    state.coverNextAt = t + COVER_GAP_MS;
    let shooters: CoverShooter[] = [], seeing: CoverShooter[] = [];
    try {
      shooters = shootersInReach(bot, body.position, fought);
      if (shot) for (const extra of shot.shooters) if (!shooters.some(known => known.entity === extra.entity)) shooters.push(extra);
      shooters.sort((a, b) => a.distance - b.distance);
      seeing = shootersSeeing(bot, shooters, body.position);
    } catch { return false; }
    if (!seeing.length) return false;
    let choice: ReturnType<typeof coverChoice>;
    try { choice = coverChoice(bot, shooters, episode?.digs ?? 0, shot ? { line: true, lines: episode?.lines ?? 0 } : {}); } catch { return false; }
    const lead = burning ? '燃えて射手から見えている:' : shot ? `${shooterWords(body.position, seeing)} に${SHOT_WINDOW_MS / 1000}秒で${shot.hits}回撃たれた:` : '体力が減り続け射手から見えている:';
    if (!choice.cover) {
      if (t - (state.coverNotedAt ?? -Infinity) >= COVER_NOTE_GAP_MS) {
        state.coverNotedAt = t;
        try { ledger.end(Object.assign(ledger.begin('cover_none', '', COVER_DETAIL_MAX), { detail: `${lead} 動ける手が無い（${choice.why}）。見えている: ${shooterWords(body.position, seeing)}`.slice(0, COVER_DETAIL_MAX) }), 'failed'); } catch { /* a report */ }
      }
      return false;
    }
    const cover = choice.cover;
    const shotShooters: CoverShooter[] = shot ? shot.shooters : [];
    const run = state.cover = episode ?? { since: t, digs: 0, lastEnd: t };
    if (cover.kind === 'dig') run.digs++;
    if (cover.kind === 'line') run.lines = (run.lines ?? 0) + 1;
    state.busy = 'flee';
    log.warn(`🔥 ${lead} ${cover.kind}（${shooterWords(body.position, seeing)}）`);
    const handle = ledger.begin('cover', `${lead} ${cover.detail}`, COVER_DETAIL_MAX);
    void take('floor-cover', FLOOR_FLEE_PRIORITY, COVER_TIMEOUT_MS[cover.kind] + 500, () => runCover(bot, createMotorPort(bot), cover))
      .then(result => {
        // What it did, and whether the line is cut now (read after the hand: the shooters move too).
        const after = bot.entity?.position;
        let still: CoverShooter[] = [];
        try {
          if (after) {
            const known = shootersInReach(bot, after, fought);
            for (const extra of shotShooters) if (extra.entity.position && !known.some(other => other.entity === extra.entity)) known.push({ entity: extra.entity, distance: extra.entity.position.distanceTo(after) });
            still = shootersSeeing(bot, known, after);
          }
        } catch { still = []; }
        const done = !!(result as { success?: boolean } | undefined)?.success;
        const failed = done ? '' : `（できなかった: ${String((result as { result?: string } | undefined)?.result ?? '').slice(0, 50)}）`;
        handle.detail = `${lead} ${cover.detail}${failed}。${still.length ? `まだ見えている: ${shooterWords(after!, still)}` : '射線が切れた'} 体力${Math.round((bot.health ?? 0) * 10) / 10}`.slice(0, COVER_DETAIL_MAX);
        ledger.end(handle, done ? 'done' : (result as { failureType?: string } | undefined)?.failureType === 'interrupted' ? 'cut' : 'failed');
      }, () => { ledger.end(handle, 'failed'); })
      .catch(() => undefined)
      .finally(() => {
        state.busy = null;
        run.lastEnd = now();
        // Still burning or losing health and still seen: the next hand at once (no gap); else the usual look.
        state.coverNextAt = now();
      });
    return true;
  };
  /**
   * r8, the melee hand (`meleeChoice`): a melee enemy near and the body at the rim of a drop (or hurt just now on a floor): one minimal hand,
   * told in the ledger with the footing and how near the enemy is now. Never over another safety lease, an escape, or the planner's blocks going
   * in. True when a hand was started.
   */
  const meleeTick = (): boolean => {
    if (!config.flee) return false;
    const t = now(), health = bot.health ?? 20;
    if (health <= 0) return false;
    if (t < (state.meleeNextAt ?? 0)) return false;
    if (hasActiveSafetyLease(bot) || escapeRunning(bot) || bot.lavaReflex?.engaged === true || bot.breathingReflex?.engaged === true) return false;
    if (LAYING_HANDS.has(String((bot as { actHandNow?: string }).actHandNow ?? ''))) return false;
    state.meleeNextAt = t + MELEE_GAP_MS;
    const body = bot.entity; if (!body) return false;
    // The cheap looks first: an enemy within reach of a blow, then a rim or a hurt just now on a floor (the enemies' exposure is read after).
    const fought = health > FLEE_HEALTH ? (name: string) => engagedWithAny(bot, [name]) : undefined;
    let candidates: MeleeThreat[] = [];
    try { candidates = meleeCandidates(bot, fought); } catch { return false; }
    if (!candidates.length) return false;
    // r9: hurt just now, or still near after a hand of this episode (chased): the body is on a floor with an enemy on it, whatever the health
    // (the choice says what to do at which; a hand-less low health is quiet and leaves the body to the flee).
    const beingHurt = t - (state.healthSeen?.fellAt ?? -Infinity) <= COVER_FALL_MS;
    const episode = state.melee && t - state.melee.lastEnd <= MELEE_EPISODE_MS ? state.melee : undefined;
    // A-6 (7): once the cap was told for this episode, no new reflex hand of any kind (a different kind of hand included) until the episode ends.
    if (episode && episode.cappedAt !== undefined) return false;
    const chased = !!episode && candidates[0].distance <= MELEE_CHASED_RANGE;
    if (!beingHurt && !chased) {
      try { const feetNow = feetCell(bot as never); if (!feetNow || footingAt(bodyReader(bot as never), feetNow).count === 0) return false; } catch { return false; }
    }
    let threats: MeleeThreat[] = [];
    try { threats = meleeThreatsNear(bot, fought); } catch { return false; }
    if (!threats.length) return false;
    if (!episode) state.melee = undefined;
    const hands = episode?.hands ?? 0, hits = episode?.hits ?? 0;
    let choice: ReturnType<typeof meleeChoice>;
    try { choice = meleeChoice(bot, threats, { hands, beingHit: beingHurt, chased }); } catch { return false; }
    if (choice.quiet) return false;
    const who = meleeWho(body.position, threats);
    const told = (text: string) => {
      if (t - (state.meleeNotedAt ?? -Infinity) < MELEE_NOTE_GAP_MS) return;
      state.meleeNotedAt = t;
      const footing = footingWords(choice.footing);
      try { ledger.end(Object.assign(ledger.begin('melee_none', '', MELEE_DETAIL_MAX), { detail: `${who}: ${text}${footing ? `。足場: ${footing}` : ''}`.slice(0, MELEE_DETAIL_MAX) }), 'failed'); } catch { /* a report */ }
    };
    const striking = choice.hand?.kind === 'hit';
    if (striking ? hits >= MELEE_MAX_HITS : hands >= MELEE_MAX_HANDS) {
      told(striking ? `この間に打ち返しを${hits}手続けたがまだ近い。これ以上は反射でしない` : `この間に${hands}手を打ったがまだ近い。これ以上は反射でしない`);
      // Continue contracts (4): told once per episode as an urgent notice, and the move already chosen (a shield up, a step back under way) goes on
      // for BRIDGE_MS from this first notice. Nothing new is chosen; a second notice does not extend it.
      if (episode && episode.cappedAt === undefined) {
        episode.cappedAt = t;
        const shieldUp = (bot as { shieldBlock?: { up?: boolean } }).shieldBlock?.up === true;
        const stepping = episode.lastKind === 'step' && state.busy === 'flee';
        const hold = shieldUp ? 'shield' as const : stepping ? 'step_back' as const : null;
        const until = hold ? t + BRIDGE_MS : null;
        if (hold) state.bridge = { after: 'floor-melee', hold, ...(episode.target !== undefined ? { target: episode.target } : {}), since: t, until: until! };
        try {
          (bot as { emit?: (event: string, data: unknown) => unknown }).emit?.('minebotReflexCapped', { reflex: 'floor-melee', limit: striking ? 'melee_hits' : 'melee_hands',
            count: striking ? hits : hands, bridge: hold === 'shield' ? 'shield' : hold === 'step_back' ? 'step_back' : 'none', until: until === null ? null : new Date(until).toISOString() });
        } catch { /* a notice never changes what the reflex did */ }
      }
      return false;
    }
    if (!choice.hand) { told(`動ける手が無い（${choice.why}）`); return false; }
    const hand = choice.hand;
    const run = state.melee = episode ?? { since: t, hands: 0, lastEnd: t };
    if (hand.kind === 'hit') run.hits = (run.hits ?? 0) + 1; else run.hands++;
    // Continue contracts (4): the enemy this hand is after (the blow's own, else the nearest one), for a handover to an act for the same enemy.
    const handEnemy = hand.kind === 'hit' ? hand.target.id : threats[0]?.entity?.id;
    if (typeof handEnemy === 'number') { run.target = handEnemy; state.handTarget = { capability: 'floor-melee', target: handEnemy, at: t }; }
    run.lastKind = hand.kind;
    state.busy = 'flee';
    log.warn(`🗡️ ${who}、${choice.footing.count ? '空所の縁' : '打たれている'}: ${hand.kind}`);
    const handle = ledger.begin('melee', `${who}: ${hand.detail}`, MELEE_DETAIL_MAX);
    void take('floor-melee', FLOOR_FLEE_PRIORITY, MELEE_TIMEOUT_MS[hand.kind] + 500, () => runMelee(bot, createMotorPort(bot), hand))
      .then(result => {
        const done = !!(result as { success?: boolean } | undefined)?.success;
        // A blow's own words are what it did (the blows, those that landed, what is left of the enemy); the others say the hand and what failed.
        const said = hand.kind === 'hit' ? String((result as { result?: string } | undefined)?.result ?? hand.detail) : hand.detail;
        const failed = done || hand.kind === 'hit' ? '' : `（できなかった: ${String((result as { result?: string } | undefined)?.result ?? '').slice(0, 50)}）`;
        // What the ground and the enemy are now (read after the hand: it moves too).
        let footing = '', nearest = '';
        try {
          const feetNow = feetCell(bot as never);
          if (feetNow) footing = footingWords(footingAt(bodyReader(bot as never), feetNow));
          const still = meleeThreatsNear(bot);
          nearest = still.length ? ` 今${still[0].distance.toFixed(1)}m` : ' 4m内に居ない';
        } catch { /* the line stands without it */ }
        handle.detail = `${who}: ${said}${failed}。足場: ${footing || '空所なし'}${nearest} 体力${Math.round((bot.health ?? 0) * 10) / 10}`.slice(0, MELEE_DETAIL_MAX);
        ledger.end(handle, done ? 'done' : (result as { failureType?: string } | undefined)?.failureType === 'interrupted' ? 'cut' : 'failed');
      }, () => { ledger.end(handle, 'failed'); })
      .catch(() => undefined)
      .finally(() => {
        state.busy = null;
        run.lastEnd = now();
        state.meleeNextAt = now();
      });
    return true;
  };
  bot.on('physicsTick', () => {
    // r7: the health seen tick by tick (the cover goes on while it falls).
    const health = bot.health ?? 20, seen = state.healthSeen;
    if (!seen) state.healthSeen = { last: health, fellAt: -Infinity };
    else {
      if (health < seen.last - 1e-6) {
        const at = seen.fellAt = now();
        state.falls = [...(state.falls ?? []).filter(when => at - when <= 2 * SHOT_WINDOW_MS), at];
      }
      seen.last = health;
    }
    let outcome: ReturnType<typeof floorRetreatTick> = null;
    try { outcome = config.retreat ? floorRetreatTick(bot, state.retreat, retreatAllow) : null; } catch { return; }
    // A lit creeper and no way away: the retreat let go (its action ends), and the last stand is made as soon as no
    // safety lease holds the body (the retreat's own ends within a tick or two).
    if (outcome === 'cornered') { state.retreat.done = true; state.retreat.release?.(); state.creeperCornered = now(); }
    if (state.creeperCornered !== undefined) {
      if (now() - state.creeperCornered > CORNERED_WAIT_MS) state.creeperCornered = undefined;
      else if (!state.retreat.engaged && state.busy !== 'flee' && !hasActiveSafetyLease(bot)) {
        if (lastStand('creeper')) { state.creeperCornered = undefined; return; }
      }
    }
    if (outcome === 'engaged') {
      log.warn(state.retreat.kind === 'creeper' ? '💥 火の付いたクリーパー: 離れる' : '🏹 矢が向かってくる: 横へよける');
      void takeNoted('retreat', state.retreat.kind === 'creeper' ? '火の付いたクリーパーから離れた' : '飛んでくる矢をよけた', 'floor-retreat', FLOOR_RETREAT_PRIORITY, 3000,
        () => new Promise(resolve => {
          if (state.retreat.done || !state.retreat.engaged) return resolve({ success: true, result: '下がった' });
          state.retreat.release = () => resolve({ success: true, result: '下がった' });
        }), state.retreat.kind === 'arrow' ? 'arrow' : undefined)
        .catch(() => undefined).finally(() => { state.retreat.release = undefined; });
      return;
    }
    if (outcome === 'released') { state.retreat.done = true; state.retreat.release?.(); return; }
    if (state.retreat.engaged || state.busy) return;
    // The planner's own fight (combat, combat-engage, attack-nearest, attack-continuously) holds the body: the floor neither runs from it
    // nor walls the body in, whatever the health (down to the yield limit of combatOwner). Run 21: three fights chosen in a cave were
    // each dropped by this flee, and for 140 s nobody attacked. A flee already under way is ended, not carried on.
    const headFight = config.flee && isHeadCombatActive(bot);
    if (headFight) {
      const episode = state.fleeEpisode;
      if (episode) { state.fleeEpisode = undefined; try { episode.end?.('cut'); } catch { /* a report must not change what the reflex did */ } }
    }
    // r7: burning in a shooter's line, the cover first (before the low-health flee and the last stand, which read the threats in reach).
    if (!headFight && coverTick()) return;
    // r8: a melee enemy near, at the rim of a drop (or hurting the body on a floor): one minimal hand, before the flee and the last stand.
    // Run 43: the melee hand waits only for a fight that runs (`isHeadCombatRunning`), not for the grace after one ended.
    if (!isHeadCombatRunning(bot) && meleeTick()) return;
    if (config.flee && !headFight) {
      let threat: ReturnType<typeof fleeStart> = null;
      try { threat = fleeStart(bot, state, now()); } catch { threat = null; }
      if (threat) {
        // A new episode is one ledger entry and one of the two in 20 s; its later segments (`continuing`) are part of it.
        if (!threat.continuing) {
          state.engagements.flee = (state.engagements.flee ?? 0) + 1; (state.fleeStarts ??= []).push(now());
          const handle = ledger.begin('flee', '低体力のため敵から離れた');
          state.fleeEpisode = { startedAt: now(), origin: bot.entity!.position.clone(), segments: 0, stalls: 0, outcome: 'done', end: outcome => { ledger.end(handle, outcome); } };
          log.warn(`🏃 低体力（${bot.health}）で敵が近い（${threat.threats.length}体、最寄り${threat.nearest.toFixed(1)}m）: 離れる`);
        }
        const episode = state.fleeEpisode!;
        episode.segments++;
        state.busy = 'flee';
        const finish = (outcome: ReflexOutcome) => { if (state.fleeEpisode === episode) { state.fleeEpisode = undefined; try { episode.end?.(outcome); } catch { /* a report */ } } };
        void take('floor-flee', FLOOR_FLEE_PRIORITY, 3000, () => runLowHealthFlee(bot, createMotorPort(bot), options.fleeTickMs, episode))
          .then(result => {
            const done = result as { success?: boolean; failureType?: string; moved?: number; ended?: string } | undefined;
            // Taken away by a stronger reflex, or failed: the episode ends now, and says how.
            if (!done?.success) { episode.outcome = done?.failureType === 'interrupted' ? 'cut' : 'failed'; finish(episode.outcome); return; }
            episode.stalls = (done.moved ?? 0) < FLEE_MIN_HEADWAY ? episode.stalls + 1 : 0;
            if (done.ended === 'clear') finish('done');
            else if (done.ended === 'yield') { finish('done'); state.fleeRestUntil = now() + FLEE_REST_MS; }
          }, () => finish('failed'))
          .catch(() => undefined).finally(() => { state.busy = null; });
        return;
      }
      // The flee found no way out: the last stand, one minimal hand (`lastStandChoice`), told in the ledger so that the
      // act running stops as a reflex. Once in LAST_STAND_GAP_MS, never over another safety lease.
      if (state.lastStandWanted) {
        state.lastStandWanted = false;
        if (lastStand('low-health')) return;
      }
    }
    if (!budget && Date.now() < state.retryAt) return;
    // The body puts on no armour by itself (equip is a step of act).
    let food: Item | null = null;
    try { food = config.eat ? floorEatChoice(bot, config.wideThreats) : null; } catch { return; }
    if (food && bot.equip && bot.consume) {
      // Never over another safety reflex (breath, lava). Over a model's action or a reflex session only when it cannot wait
      // (starving or nearly dead); otherwise between actions, so the work it would cut is not cut for a meal. (`floorEatChoice`
      // offers no meal above health 6 and food 3.)
      if (hasActiveSafetyLease(bot)) return;
      if (physicalActionBusy(bot)) {
        // Default mode: the API's own escape and shelter commands (flee-from, dig-shelter, build-around-self) are never cut for a meal;
        // the one exception is starvation (food 3 or less), when the meal cannot wait for the escape to end.
        if (config.wideThreats && (bot.food ?? 20) > 3 && escapeRunning(bot)) return;
        if ((bot.food ?? 20) > 3 && (bot.health ?? 20) > 6) return;
      }
      // Starving or at 6 health or less the meal is not metered (floorBudget.ts): only a short backoff after one that failed.
      if (budget && !budget.allow('eat', bot.health ?? 20, bot.food ?? 20)) return;
      state.busy = 'eat'; state.engagements.eat++;
      log.info(`🍖 食べる: ${food.name}（体力 ${bot.health} / 満腹度 ${bot.food}）`);
      const held = bot.heldItem;
      void takeNoted('eat', `食事（${food.name}）`, 'floor-eat', FLOOR_EAT_PRIORITY, 6000, async () => {
        try { await bot.equip!(food!, 'hand'); await bot.consume!(); }
        finally {
          // What was in hand before the meal goes back, also when the meal was cut off: a fight went on with mutton in hand (run 16).
          // Found again by name: the stack the body held may have moved slots while the food was in hand.
          if (held && held.name !== food!.name) {
            const again = (bot.inventory?.items() ?? []).find(item => item.name === held.name) ?? held;
            await bot.equip!(again, 'hand').catch(() => undefined);
          }
        }
        return { success: true, result: `${food!.name}を食べた` };
      }, 'eat').then(result => { if (!result?.success) failed(); })
        .catch(() => failed()).finally(() => { state.busy = null; });
    }
  });
}

/** mineflayer plugin form, loaded after the other reflexes so its keys win a tick it is engaged in. */
export function floorReflexPlugin(bot: unknown): void { installFloorReflexes(bot as FloorBody); }
