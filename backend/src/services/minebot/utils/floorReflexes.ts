import { Vec3 } from 'vec3';
import { createLogger } from '../../../utils/logger.js';
import { actionLeaseStatus, activeActionCapabilities, createMotorPort, executeAction, hasActiveSafetyLease, physicalActionBusy, preemptLowerPriorityActions } from '../execution/ActionExecution.js';
import { creeperLit } from './creeperFuse.js';
import { FALLBACK_FOOD_POINTS } from '../constantSkills/autoEat.js';
import { edgeRisk, fallIsDangerous } from './edgeGuard.js';
import { escapeHeading } from './escapeHeading.js';
import { floorConfig, type FloorConfig } from './floorConfig.js';
import { EAT_CRITICAL_FOOD, eatIsCritical, FloorBudget, type BudgetKind } from './floorBudget.js';
import { isThreatEntity, type ThreatBody } from './hostileMobHints.js';
import { ensureReflexLedger, type ReflexKind, type ReflexOutcome } from './reflexLedger.js';
import { threatExposure } from './threatExposure.js';
import { holdsWater } from './waterBlocks.js';

const log = createLogger('Minebot:FloorReflexes');

/**
 * The floor (Syzygy ADR-0010 D8, ADR-0011 §4.6, owner answer "defence only", 2026-10-14): what cannot wait for a network
 * decision, done in the body on its physics tick, with no model and no attack. The breathing, lava, shield, knock and edge
 * reflexes already run here; this adds the three that common-FCA mode had switched off with the constant skills: stepping
 * back from a lit creeper or an arrow on its way, eating when short, and wearing armour into an empty slot. Each takes the
 * body through ActionExecution with a safety lease, so a model's action or a reflex session underneath gives way, and gives
 * it back by ending; the one above decides again from a fresh observation.
 */
export const FLOOR_RETREAT_PRIORITY = 350;
export const FLOOR_EAT_PRIORITY = 200;
export const FLOOR_ARMOR_PRIORITY = 150;
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
export const FLEE_HEALTH = 6;
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
/** A creeper starts its fuse at three blocks and blows at about three; a lit one this close is stepped away from. */
const CREEPER_REACH = 4.5;
const ARROW_REACH = 12;
const HOSTILE_NEAR = 5;
const RETRY_AFTER_MS = 3000;

type Item = { name: string; type?: number; slot?: number };
interface FloorEntity {
  id?: number; name?: string; type?: string; position: Vec3; velocity?: Vec3; metadata?: unknown[];
  isInLava?: boolean; isInWater?: boolean; onGround?: boolean;
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
}
export interface RetreatState {
  engaged: boolean; kind?: 'creeper' | 'arrow'; from?: Vec3; origin?: Vec3; ticks: number; cooldown: number; engagements: number;
  release?: () => void;
  /** Set when the retreat ended before its action started, so a waiting action ends at once instead of holding the body. */
  done?: boolean;
  /** Last seen position of each arrow: one that did not move since the last tick is stuck, whatever velocity it reported. */
  arrows?: Map<number, Vec3>;
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
  /** Cooldowns, the allowance and the stuck latch of the arrow step-aside, the meal and the armour change (`floorBudget.ts`); absent when denied. */
  budget?: FloorBudget;
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
export function floorRetreatTick(bot: FloorBody, state: RetreatState, allow?: (kind: 'creeper' | 'arrow') => boolean): 'engaged' | 'released' | null {
  const body = bot.entity;
  // Lava and breath come first (400, 300): while either holds the keys, the retreat neither steers nor takes the body.
  const yielding = bot.lavaReflex?.engaged === true || bot.breathingReflex?.engaged === true;
  if (!body || (bot.health ?? 20) <= 0 || body.isInLava || yielding) {
    if (!state.engaged) return null;
    state.engaged = false; releaseKeys(bot); return 'released';
  }
  if (state.engaged) {
    state.ticks++;
    const threat = retreatThreat(bot, state.arrows ??= new Map());
    if (threat) state.from = threat.from;
    if (!threat || state.ticks >= RETREAT_TICKS || body.position.distanceTo(state.origin!) >= RETREAT_BLOCKS) {
      state.engaged = false; state.cooldown = RETREAT_COOLDOWN_TICKS; releaseKeys(bot); return 'released';
    }
    steer(bot, state); return null;
  }
  const threat = retreatThreat(bot, state.arrows ??= new Map());
  if (state.cooldown > 0) { state.cooldown--; return null; }
  if (!threat) return null;
  if (allow && !allow(threat.kind)) return null;
  Object.assign(state, { engaged: true, kind: threat.kind, from: threat.from, origin: body.position.clone(), ticks: 0, done: false });
  state.engagements++;
  steer(bot, state);
  return 'engaged';
}

const NEVER_EAT = new Set(['pufferfish', 'chorus_fruit', 'suspicious_stew', 'spider_eye', 'poisonous_potato', 'enchanted_golden_apple']);
/** The old auto-eat's trigger (legacy constant skill, e94a236): food below 18, or health below 18 and food below 20. */
const TOPUP_FOOD = 18, TOPUP_FOOD_HURT = 20, TOPUP_HEALTH = 18;
/** While the pathfinder is walking the legacy auto-eat ate only at health 8 or less, or food 6 or less. */
const MOVING_EAT_HEALTH = 8;
/** Food that is worth more than its hunger points (a regeneration potion, a poison cure, a brewing ingredient): a top-up leaves it alone while it can. */
const VALUABLE_FOOD = new Set(['golden_apple', 'golden_carrot', 'honey_bottle']);
// (Whether a meal is critical, `eatIsCritical`, is floorBudget.ts's one definition: this choice, the tick's cut rule and the budget's exemption share it.)
/**
 * Food to eat now, or null; never with an enemy at arm's length (standing to eat there killed the body, L18).
 *
 * `wide` is the default mode (`FloorConfig.wideThreats`): the legacy auto-eat's trigger (food < 18, or health < 18 and food < 20), with
 * the production floor's safety kept on top. A meal at food 6 or less, or at health 6 or less with food 17 or less, is critical (exempt
 * from the budget, and the idle rule below does not apply to it; the tick cuts a running command for it only at health 6 or less or food
 * 3 or less, and never the API's own escape skills unless food is 3 or less); any other meal is a top-up and happens only when the body
 * is idle (no physical action running, no command waiting for the body, no command accepted by the control loop: `fcaLeaseHeld`, so that
 * a top-up never delays the next command while the model thinks), and it leaves valuable food (golden apple and the like) alone. "An
 * enemy within 5 m" does not count one that is walled off (`threatExposure`, as in the flee). While the pathfinder is walking a top-up
 * waits unless health is 8 or less or food 6 or less (the legacy rule). `wide = false` is `floor` mode: exactly the production floor
 * (food <= 6, or health <= 12 and food < 18), unchanged.
 */
export function floorEatChoice(bot: FloorBody, wide = true): Item | null {
  const health = bot.health ?? 20, food = bot.food ?? 20;
  let topUp = false;
  if (wide) {
    if (!(food < TOPUP_FOOD || (health < TOPUP_HEALTH && food < TOPUP_FOOD_HURT))) return null;
    topUp = !eatIsCritical(health, food);
    if (topUp && (physicalActionBusy(bot) || hasActiveSafetyLease(bot) || commandWaiting(bot) || bot.fcaLeaseHeld?.() === true)) return null;
    if (health > MOVING_EAT_HEALTH && food > EAT_CRITICAL_FOOD && (bot as { pathfinder?: { isMoving?(): boolean } }).pathfinder?.isMoving?.() === true) return null;
  } else if (!(food <= 6 || (health <= 12 && food < 18))) return null;
  if (bot.entity?.isInLava || hostileWithin(bot, HOSTILE_NEAR, wide, wide)) return null;
  const items = (bot.inventory?.items() ?? []).filter(item => (FALLBACK_FOOD_POINTS[item.name] ?? 0) > 0 && !NEVER_EAT.has(item.name)
    && (item.name !== 'rotten_flesh' || food <= 6) && !(topUp && VALUABLE_FOOD.has(item.name)));
  items.sort((a, b) => (FALLBACK_FOOD_POINTS[b.name] ?? 0) - (FALLBACK_FOOD_POINTS[a.name] ?? 0));
  return items[0] ?? null;
}
// The off-hand takes a shield: the shield reflex blocks with an off-hand shield only (a blaze's fireballs, a skeleton's arrows).
const ARMOR = [['head', '_helmet', 5], ['torso', '_chestplate', 6], ['legs', '_leggings', 7], ['feet', '_boots', 8], ['off-hand', 'shield', 45]] as const;
const MATERIAL = ['netherite', 'diamond', 'iron', 'chainmail', 'turtle', 'golden', 'leather'];
/** Armour or a shield for an empty slot, best material first; what is worn or held is never swapped (that choice is the model's). */
export function floorArmorChoice(bot: FloorBody): { item: Item; destination: string } | null {
  const slots = bot.inventory?.slots; if (!slots) return null;
  for (const [destination, suffix, slot] of ARMOR) {
    if (slots[slot]) continue;
    // A shield the planner holds in the main hand is its choice: only a stowed one goes to the off-hand.
    const pieces = (bot.inventory?.items() ?? []).filter(item => item.name.endsWith(suffix) && !(slot === 45 && item === bot.heldItem));
    pieces.sort((a, b) => MATERIAL.findIndex(m => a.name.startsWith(m)) - MATERIAL.findIndex(m => b.name.startsWith(m)));
    if (pieces[0]) return { item: pieces[0], destination };
  }
  return null;
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

export function installFloorReflexes(bot: FloorBody, config: FloorConfig = floorConfig(), options: { fleeTickMs?: number; now?: () => number } = {}): void {
  if (bot.floorReflexes) return;
  const now = options.now ?? Date.now;
  const state: FloorState = bot.floorReflexes = { retreat: { engaged: false, ticks: 0, cooldown: 0, engagements: 0 }, busy: null, retryAt: 0,
    engagements: { eat: 0, armor: 0, flee: 0 }, fleeStarts: [] };
  const ledger = ensureReflexLedger(bot as any);
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
  const takeNoted = (kind: ReflexKind, detail: string, capability: string, priority: number, timeoutMs: number, work: Work, metered?: BudgetKind) => {
    const handle = ledger.begin(kind, detail), startedAt = now();
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
  const retreatAllow = config.wideThreats || budget
    ? (kind: 'creeper' | 'arrow') => kind === 'creeper' || ((!config.wideThreats || !escapeRunning(bot)) && (!budget || budget.allow('arrow', bot.health ?? 20)))
    : undefined;
  bot.on('physicsTick', () => {
    let outcome: ReturnType<typeof floorRetreatTick> = null;
    try { outcome = config.retreat ? floorRetreatTick(bot, state.retreat, retreatAllow) : null; } catch { return; }
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
    if (config.flee) {
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
    }
    if (!budget && Date.now() < state.retryAt) return;
    let food: Item | null = null, armor: ReturnType<typeof floorArmorChoice> = null;
    try { food = config.eat ? floorEatChoice(bot, config.wideThreats) : null; armor = food || !config.armor ? null : floorArmorChoice(bot); } catch { return; }
    if (food && bot.equip && bot.consume) {
      // Never over another safety reflex (breath, lava). Over a model's action or a reflex session only when it cannot wait
      // (starving or nearly dead); otherwise between actions, so the work it would cut is not cut for a meal. (In the default mode a
      // top-up, a meal above health 6 and food 6, is already refused by `floorEatChoice` while anything physical runs or waits.)
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
        await bot.equip!(food!, 'hand'); await bot.consume!();
        if (held && held.name !== food!.name) await bot.equip!(held, 'hand').catch(() => undefined);
        return { success: true, result: `${food!.name}を食べた` };
      }, 'eat').then(result => { if (!result?.success) failed(); })
        .catch(() => failed()).finally(() => { state.busy = null; });
    } else if (armor && bot.equip && !hasActiveSafetyLease(bot) && (!physicalActionBusy(bot) || (hostileWithin(bot, 16, config.wideThreats) && !(config.wideThreats && escapeRunning(bot))))
      && (!budget || budget.allow('armor', bot.health ?? 20))) {
      state.busy = 'armor'; state.engagements.armor++;
      log.info(`🛡️ 防具を着ける: ${armor.item.name}`);
      void takeNoted('armor', `防具（${armor.item.name}）を着けた`, 'floor-armor', FLOOR_ARMOR_PRIORITY, 3000, async () => {
        await bot.equip!(armor!.item, armor!.destination);
        return { success: true, result: `${armor!.item.name}を着けた` };
      }, 'armor').then(result => { if (!result?.success) failed(); })
        .catch(() => failed()).finally(() => { state.busy = null; });
    }
  });
}

/** mineflayer plugin form, loaded after the other reflexes so its keys win a tick it is engaged in. */
export function floorReflexPlugin(bot: unknown): void { installFloorReflexes(bot as FloorBody); }
