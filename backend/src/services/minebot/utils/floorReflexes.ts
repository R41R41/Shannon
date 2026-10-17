import { Vec3 } from 'vec3';
import { createLogger } from '../../../utils/logger.js';
import { activeActionCapabilities, createMotorPort, executeAction, hasActiveSafetyLease, physicalActionBusy, preemptLowerPriorityActions } from '../execution/ActionExecution.js';
import { creeperLit } from './creeperFuse.js';
import { FALLBACK_FOOD_POINTS } from '../constantSkills/autoEat.js';
import { floorConfig, type FloorConfig } from './floorConfig.js';
import { ensureReflexLedger, type ReflexKind } from './reflexLedger.js';
import { threatExposure } from './threatExposure.js';

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
/** Between the retreat (350) and the meal (200): the low-health flee (`extended` only, P8). */
export const FLOOR_FLEE_PRIORITY = 250;
/** At or below this health (the API's own `lowHealth`) a hostile within FLEE_RANGE is run from at once. */
export const FLEE_HEALTH = 6;
const FLEE_RANGE = 3;
/** One flee lasts at most 1.2 s or 5 blocks, twice in 20 s; what comes after is the API's fast judgment (shelter, flee-from). */
const FLEE_TICKS = 24;
const FLEE_BLOCKS = 5;
const FLEE_WINDOW_MS = 20_000;
const FLEE_MAX_IN_WINDOW = 2;
/** Skills that are already getting the body away: the flee never cuts one of these (the API's DEFENSIVE_SKILLS that escape). */
export const ESCAPE_SKILLS: ReadonlySet<string> = new Set(['flee-from', 'dig-shelter', 'build-around-self', 'retreat-attack']);
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
  isInLava?: boolean; isInWater?: boolean;
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
}
export interface RetreatState {
  engaged: boolean; kind?: 'creeper' | 'arrow'; from?: Vec3; origin?: Vec3; ticks: number; cooldown: number; engagements: number;
  release?: () => void;
  /** Set when the retreat ended before its action started, so a waiting action ends at once instead of holding the body. */
  done?: boolean;
  /** Last seen position of each arrow: one that did not move since the last tick is stuck, whatever velocity it reported. */
  arrows?: Map<number, Vec3>;
}
export interface FloorState {
  retreat: RetreatState; busy: 'eat' | 'armor' | 'flee' | null; retryAt: number; engagements: { eat: number; armor: number; flee?: number };
  /** When each flee of the last 20 s began (the budget). */
  fleeStarts?: number[];
}

export { creeperLit };
const hostileNames = new Set(['zombie', 'husk', 'drowned', 'skeleton', 'stray', 'creeper', 'spider', 'cave_spider', 'witch',
  'pillager', 'vindicator', 'piglin_brute', 'hoglin', 'zoglin', 'blaze', 'wither_skeleton', 'slime', 'magma_cube', 'phantom']);
function others(bot: FloorBody): FloorEntity[] {
  return Object.values(bot.entities ?? {}).filter(entity => entity && entity !== bot.entity && entity.position);
}
export function hostileWithin(bot: FloorBody, reach: number): boolean {
  const at = bot.entity?.position; if (!at) return false;
  return others(bot).some(entity => hostileNames.has(String(entity.name)) && entity.position.distanceTo(at) <= reach);
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
/** One physics tick of the retreat. Keys are set every tick while engaged, after the other movers, like the lava reflex. */
export function floorRetreatTick(bot: FloorBody, state: RetreatState): 'engaged' | 'released' | null {
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
  Object.assign(state, { engaged: true, kind: threat.kind, from: threat.from, origin: body.position.clone(), ticks: 0, done: false });
  state.engagements++;
  steer(bot, state);
  return 'engaged';
}

const NEVER_EAT = new Set(['pufferfish', 'chorus_fruit', 'suspicious_stew', 'spider_eye', 'poisonous_potato', 'enchanted_golden_apple']);
/** Food to eat now, or null: short of food, or hurt and not full; never with an enemy at arm's length (standing to eat there killed the body, L18). */
export function floorEatChoice(bot: FloorBody): Item | null {
  const health = bot.health ?? 20, food = bot.food ?? 20;
  if (!(food <= 6 || (health <= 12 && food < 18))) return null;
  if (bot.entity?.isInLava || hostileWithin(bot, HOSTILE_NEAR)) return null;
  const items = (bot.inventory?.items() ?? []).filter(item => (FALLBACK_FOOD_POINTS[item.name] ?? 0) > 0 && !NEVER_EAT.has(item.name)
    && (item.name !== 'rotten_flesh' || food <= 6));
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

/** The hostile to run from at low health: reachable (not walled off), within FLEE_RANGE, nearest first. Null above FLEE_HEALTH. */
export function fleeThreat(bot: FloorBody): { from: Vec3 } | null {
  const health = bot.health ?? 20, at = bot.entity?.position;
  if (!at || !(health > 0 && health <= FLEE_HEALTH) || bot.entity?.isInLava) return null;
  let nearest: { distance: number; position: Vec3 } | null = null;
  for (const entity of others(bot)) {
    if (!hostileNames.has(String(entity.name))) continue;
    const distance = entity.position.distanceTo(at);
    if (distance > FLEE_RANGE || (nearest && distance >= nearest.distance)) continue;
    let sealed = false;
    try { sealed = threatExposure(bot as any, entity as any) === 'sealed'; } catch { sealed = false; }
    if (!sealed) nearest = { distance, position: entity.position };
  }
  return nearest ? { from: nearest.position } : null;
}
/**
 * Whether the low-health flee may start now. Precedence (P8): a floor retreat, meal or armour change, or any other safety lease
 * holds the body first; the API's own escape skills (flee-from, a shelter) are never cut; the budget is two flees in 20 s.
 * A fight or a task action under it is cut: at this health the API's fast judgment would cut it too.
 */
export function fleeStart(bot: FloorBody, state: FloorState, now: number): { from: Vec3 } | null {
  if (state.retreat.engaged || state.busy || hasActiveSafetyLease(bot)) return null;
  if (bot.lavaReflex?.engaged === true || bot.breathingReflex?.engaged === true) return null;
  if (activeActionCapabilities(bot).some(capability => ESCAPE_SKILLS.has(capability))) return null;
  state.fleeStarts = (state.fleeStarts ?? []).filter(at => now - at < FLEE_WINDOW_MS);
  if (state.fleeStarts.length >= FLEE_MAX_IN_WINDOW) return null;
  return fleeThreat(bot);
}
/**
 * The flee itself, run as the work of a safety-lease action. Keys go through the motor port, so an action that took the body
 * from it (a retreat, lava) makes the next write fail instead of fighting it; the keys are always let go at the end.
 */
export async function runLowHealthFlee(bot: FloorBody, port: FloorBody, tickMs = 50): Promise<{ success: boolean; result: string }> {
  const origin = bot.entity!.position.clone();
  let ticks = 0;
  try {
    for (; ticks < FLEE_TICKS; ticks++) {
      const threat = fleeThreat(bot), body = bot.entity;
      if (!threat || !body || bot.lavaReflex?.engaged === true || bot.breathingReflex?.engaged === true) break;
      if (body.position.distanceTo(origin) >= FLEE_BLOCKS) break;
      // Straight away from it; the edge guard keeps the final say over the keys at a drop.
      port.look?.(Math.atan2(body.position.x - threat.from.x, body.position.z - threat.from.z) + Math.PI, 0, true);
      port.setControlState('forward', true); port.setControlState('sprint', true);
      await new Promise(resolve => setTimeout(resolve, tickMs));
    }
  } finally { releaseKeys(bot); }
  return { success: true, result: ticks > 0 ? '低体力のため敵から離れた' : '離れる必要がなくなった' };
}

export function installFloorReflexes(bot: FloorBody, config: FloorConfig = floorConfig(), options: { fleeTickMs?: number } = {}): void {
  if (bot.floorReflexes) return;
  const state: FloorState = bot.floorReflexes = { retreat: { engaged: false, ticks: 0, cooldown: 0, engagements: 0 }, busy: null, retryAt: 0,
    engagements: { eat: 0, armor: 0, flee: 0 }, fleeStarts: [] };
  const ledger = ensureReflexLedger(bot as any);
  type Work = () => Promise<{ success: boolean; result: string }>;
  const take = (capability: string, priority: number, timeoutMs: number, work: Work) => {
    preemptLowerPriorityActions(bot, priority, capability);
    return executeAction(bot as any, capability, timeoutMs, work as any,
      { priority, safetyLease: true, waitForQuiescence: false, legacyExecutingSkill: true });
  };
  /** `take`, with the ledger told when it began and how it ended (done, cut off by a stronger reflex, or failed). */
  const takeNoted = (kind: ReflexKind, detail: string, capability: string, priority: number, timeoutMs: number, work: Work) => {
    const handle = ledger.begin(kind, detail);
    return take(capability, priority, timeoutMs, work).then(result => {
      ledger.end(handle, result?.success ? 'done' : result?.failureType === 'interrupted' ? 'cut' : 'failed'); return result;
    }, error => { ledger.end(handle, 'failed'); throw error; });
  };
  bot.on('physicsTick', () => {
    let outcome: ReturnType<typeof floorRetreatTick> = null;
    try { outcome = config.retreat ? floorRetreatTick(bot, state.retreat) : null; } catch { return; }
    if (outcome === 'engaged') {
      log.warn(state.retreat.kind === 'creeper' ? '💥 火の付いたクリーパー: 離れる' : '🏹 矢が向かってくる: 横へよける');
      void takeNoted('retreat', state.retreat.kind === 'creeper' ? '火の付いたクリーパーから離れた' : '飛んでくる矢をよけた', 'floor-retreat', FLOOR_RETREAT_PRIORITY, 3000,
        () => new Promise(resolve => {
          if (state.retreat.done || !state.retreat.engaged) return resolve({ success: true, result: '下がった' });
          state.retreat.release = () => resolve({ success: true, result: '下がった' });
        }))
        .catch(() => undefined).finally(() => { state.retreat.release = undefined; });
      return;
    }
    if (outcome === 'released') { state.retreat.done = true; state.retreat.release?.(); return; }
    if (state.retreat.engaged || state.busy) return;
    if (config.flee) {
      let threat: ReturnType<typeof fleeStart> = null;
      try { threat = fleeStart(bot, state, Date.now()); } catch { threat = null; }
      if (threat) {
        state.busy = 'flee'; state.engagements.flee = (state.engagements.flee ?? 0) + 1; (state.fleeStarts ??= []).push(Date.now());
        log.warn(`🏃 低体力（${bot.health}）で敵が近い: 離れる`);
        void takeNoted('flee', '低体力のため敵から離れた', 'floor-flee', FLOOR_FLEE_PRIORITY, 3000,
          () => runLowHealthFlee(bot, createMotorPort(bot), options.fleeTickMs))
          .catch(() => undefined).finally(() => { state.busy = null; });
        return;
      }
    }
    if (Date.now() < state.retryAt) return;
    let food: Item | null = null, armor: ReturnType<typeof floorArmorChoice> = null;
    try { food = config.eat ? floorEatChoice(bot) : null; armor = food || !config.armor ? null : floorArmorChoice(bot); } catch { return; }
    if (food && bot.equip && bot.consume) {
      // Never over another safety reflex (breath, lava). Over a model's action or a reflex session only when it cannot wait
      // (starving or nearly dead); otherwise between actions, so the work it would cut is not cut for a meal.
      if (hasActiveSafetyLease(bot)) return;
      if (physicalActionBusy(bot) && (bot.food ?? 20) > 3 && (bot.health ?? 20) > 6) return;
      state.busy = 'eat'; state.engagements.eat++;
      log.info(`🍖 食べる: ${food.name}（体力 ${bot.health} / 満腹度 ${bot.food}）`);
      const held = bot.heldItem;
      void takeNoted('eat', `食事（${food.name}）`, 'floor-eat', FLOOR_EAT_PRIORITY, 6000, async () => {
        await bot.equip!(food!, 'hand'); await bot.consume!();
        if (held && held.name !== food!.name) await bot.equip!(held, 'hand').catch(() => undefined);
        return { success: true, result: `${food!.name}を食べた` };
      }).then(result => { if (!result?.success) state.retryAt = Date.now() + RETRY_AFTER_MS; })
        .catch(() => { state.retryAt = Date.now() + RETRY_AFTER_MS; }).finally(() => { state.busy = null; });
    } else if (armor && bot.equip && !hasActiveSafetyLease(bot) && (!physicalActionBusy(bot) || hostileWithin(bot, 16))) {
      state.busy = 'armor'; state.engagements.armor++;
      log.info(`🛡️ 防具を着ける: ${armor.item.name}`);
      void takeNoted('armor', `防具（${armor.item.name}）を着けた`, 'floor-armor', FLOOR_ARMOR_PRIORITY, 3000, async () => {
        await bot.equip!(armor!.item, armor!.destination);
        return { success: true, result: `${armor!.item.name}を着けた` };
      }).then(result => { if (!result?.success) state.retryAt = Date.now() + RETRY_AFTER_MS; })
        .catch(() => { state.retryAt = Date.now() + RETRY_AFTER_MS; }).finally(() => { state.busy = null; });
    }
  });
}

/** mineflayer plugin form, loaded after the other reflexes so its keys win a tick it is engaged in. */
export function floorReflexPlugin(bot: unknown): void { installFloorReflexes(bot as FloorBody); }
