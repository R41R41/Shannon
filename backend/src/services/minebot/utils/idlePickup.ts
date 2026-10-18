import { Vec3 } from 'vec3';
import { createLogger } from '../../../utils/logger.js';
import { createMotorPort, executeAction, hasActiveSafetyLease, physicalActionBusy } from '../execution/ActionExecution.js';
import { dropBurnsIn } from './dropFate.js';
import { floorConfig, type FloorConfig } from './floorConfig.js';
import { hostileWithin, type FloorBody } from './floorReflexes.js';
import { ensureReflexLedger } from './reflexLedger.js';
import { gotoSafe } from './gotoSafe.js';

const log = createLogger('Minebot:IdlePickup');

/**
 * Idle pickup (`extended` only, P8): between commands, with nothing to do, walk to a drop lying close by. A fight or a dig
 * leaves some behind; the planner's own mine-block / attack-continuously collect what they make, so this only takes what was left.
 *
 * It is idle work, priority -1: it starts only when the body is free (no command or lease held, no action running, no safety
 * lease), and a command that arrives cancels it at once (`cancelIdleActions` in the body's `execute`). It never starts near an
 * enemy, at low health, with a full pack, towards a drop that would burn, or towards what the body threw away itself.
 */
export const IDLE_PICKUP_PRIORITY = -1;
const REACH = 4;
const CHECK_EVERY_TICKS = 10;
const MIN_GAP_MS = 10_000;
const WALK_MS = 3000;
const MIN_HEALTH = 10;
const HOSTILE_CLEAR = 16;
const SELF_TOSS_MS = 60_000;
const SELF_TOSS_RADIUS = 6;
const MAX_TRIED = 32;

export interface PickupBody extends FloorBody {
  inventory?: FloorBody['inventory'] & { emptySlotCount?(): number };
  /** True while a command, a lease or a held body is the control loop's (set by createCommonFcaBody). Absent: never pick up. */
  fcaLeaseHeld?: () => boolean;
  toss?: (...args: any[]) => Promise<unknown>;
  blockAt?(position: Vec3): unknown;
  pathfinder?: unknown;
  idlePickup?: { attempts: number; tried: Set<number>; lastAt: number; tossed: Array<{ at: number; position: Vec3 }> };
}
type Goals = { GoalNear: new (x: number, y: number, z: number, range: number) => unknown };

const isItem = (entity: { name?: string; displayName?: unknown }) => entity.name === 'item' || String((entity as { displayName?: unknown }).displayName) === 'Item';

/** The drop worth walking to, or null. Pure apart from reading the body. */
export function pickupTarget(bot: PickupBody, now: number, options: { checkLease?: boolean } = {}): { id: number; position: Vec3 } | null {
  const state = bot.idlePickup, at = bot.entity?.position;
  if (!state || !at) return null;
  if (options.checkLease !== false && (typeof bot.fcaLeaseHeld !== 'function' || bot.fcaLeaseHeld())) return null;
  if (physicalActionBusy(bot) || hasActiveSafetyLease(bot)) return null;
  const floor = bot.floorReflexes;
  if (floor && (floor.retreat.engaged || floor.busy)) return null;
  if (bot.lavaReflex?.engaged === true || bot.breathingReflex?.engaged === true) return null;
  if ((bot.health ?? 20) < MIN_HEALTH || now - state.lastAt < MIN_GAP_MS) return null;
  if (typeof bot.inventory?.emptySlotCount !== 'function' || bot.inventory.emptySlotCount() <= 0) return null;
  if (hostileWithin(bot, HOSTILE_CLEAR)) return null;
  const recentToss = state.tossed.filter(toss => now - toss.at < SELF_TOSS_MS);
  let best: { id: number; position: Vec3; distance: number } | null = null;
  for (const entity of Object.values(bot.entities ?? {})) {
    if (!entity || entity === bot.entity || !entity.position || entity.id === undefined || !isItem(entity) || state.tried.has(entity.id)) continue;
    const distance = entity.position.distanceTo(at);
    if (distance > REACH || (best && distance >= best.distance)) continue;
    // Still moving (thrown, falling, drifting): not yet where it will lie.
    if (entity.velocity && entity.velocity.norm() > 0.1) continue;
    if (recentToss.some(toss => toss.position.distanceTo(entity.position) <= SELF_TOSS_RADIUS)) continue;
    try { if (dropBurnsIn(bot as any, entity.position.floored()) !== null) continue; } catch { continue; }
    best = { id: entity.id, position: entity.position, distance };
  }
  return best ? { id: best.id, position: best.position } : null;
}

export function installIdlePickup(bot: PickupBody, config: FloorConfig = floorConfig(),
  options: { goals?: () => Promise<Goals>; now?: () => number } = {}): void {
  if (bot.idlePickup || !config.pickup) return;
  const state = bot.idlePickup = { attempts: 0, tried: new Set<number>(), lastAt: 0, tossed: [] as Array<{ at: number; position: Vec3 }> };
  const now = options.now ?? Date.now;
  const ledger = ensureReflexLedger(bot as any);
  const loadGoals = options.goals ?? (async () => (await import('mineflayer-pathfinder')).default.goals as unknown as Goals);
  // What the body throws away itself is not picked up again.
  const toss = bot.toss;
  if (typeof toss === 'function') bot.toss = function (this: unknown, ...args: any[]) {
    if (bot.entity) { state.tossed.push({ at: now(), position: bot.entity.position.clone() }); state.tossed = state.tossed.slice(-8); }
    return toss.apply(bot, args);
  };
  let ticks = 0, running = false;
  bot.on('physicsTick', () => {
    if (running || ++ticks % CHECK_EVERY_TICKS !== 0) return;
    let target: ReturnType<typeof pickupTarget> = null;
    try { target = pickupTarget(bot, now()); } catch { target = null; }
    if (!target) return;
    running = true; state.attempts++; state.lastAt = now(); state.tried.add(target.id);
    if (state.tried.size > MAX_TRIED) state.tried.delete(state.tried.values().next().value as number);
    log.info(`🎒 手が空いている: 近くの落とし物へ歩く（${target.position.x.toFixed(0)},${target.position.y.toFixed(0)},${target.position.z.toFixed(0)}）`);
    const handle = ledger.begin('pickup', '近くの落とし物を拾いに歩いた');
    void executeAction(bot as any, 'idle-pickup', WALK_MS + 500, async () => {
      // A command accepted between the check above and this start has not reached the action list yet (so `cancelIdleActions` could
      // not see this walk): ask again here, and give the body back at once.
      if (typeof bot.fcaLeaseHeld !== 'function' || bot.fcaLeaseHeld()) return { success: false, result: '命令が来たので歩かない', failureType: 'interrupted', recoverable: true };
      const goals = await loadGoals(), spot = target!.position;
      const result = await gotoSafe(createMotorPort(bot) as any, new goals.GoalNear(spot.x, spot.y, spot.z, 1) as any,
        { timeoutMs: WALK_MS, stuckAbortCount: 2, logStuck: false });
      return { success: result.success, result: result.success ? '近づいた' : `届かなかった（${result.error ?? 'unknown'}）`,
        ...(result.success ? {} : { failureType: result.error === 'timeout' ? 'timeout' : 'no_path', recoverable: true }) };
    }, { priority: IDLE_PICKUP_PRIORITY, safetyLease: false, waitForQuiescence: false, legacyExecutingSkill: false })
      .then(result => { ledger.end(handle, result?.success ? 'done' : result?.failureType === 'interrupted' ? 'cut' : 'failed'); },
        () => { ledger.end(handle, 'failed'); })
      .finally(() => { running = false; });
  });
}

/** mineflayer plugin form. */
export function idlePickupPlugin(bot: unknown): void { installIdlePickup(bot as PickupBody); }
