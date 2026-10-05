import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { SkillExecutor, skillCategory } from './SkillExecutor.js';
import type { ActionPhase, ActionProgress, ActionStatus, ActionTrace } from './actionTypes.js';
import type { SkillResult } from '../types/skillParams.js';
import { logger } from '../../../utils/logger.js';

interface ActionHost {
  executingSkill: boolean;
  interruptExecution: boolean;
  clearControlStates?(): void;
  stopDigging?(): void;
  deactivateItem?(): void;
  pathfinder?: { stop(): void; setGoal?(goal: null): void };
}
interface Context {
  bot: ActionHost;
  controller: AbortController;
  progress: ActionProgress;
  trace: ActionTrace;
  phaseStartedAt: number;
  physical: boolean;
  legacyExecutingSkill: boolean;
  /** A separately owned critical ConstantSkill, not part of the main task run. */
  safetyLease: boolean;
  /** Rank of the lease this action runs on: a reflex pre-empts only what ranks below it. */
  priority: number;
  settled: boolean;
  root?: Context;
}
const contextStorage = new AsyncLocalStorage<Context>();
const executors = new WeakMap<object, SkillExecutor>();
const generations = new WeakMap<object, number>();
const sessionIds = new WeakMap<object, string>();
const active = new WeakMap<object, Set<Context>>();
const motorHosts = new WeakMap<object, object>();
function actionHost<T extends object>(bot: T): T { return (motorHosts.get(bot) ?? bot) as T; }
/** Motor wrappers are views of one native bot, never a new memory/world identity. */
export const nativeActionHost = actionHost;

export function currentAction(bot: object): Context | undefined {
  const context = contextStorage.getStore();
  return context?.bot === actionHost(bot) ? context : undefined;
}
export function actionSignal(bot: object): AbortSignal | undefined {
  return currentAction(bot)?.controller.signal;
}
export function assertActionActive(bot: object): void {
  const context = currentAction(bot);
  if (context && (context.controller.signal.aborted || context.settled || (context.root ?? context).trace.quiescent)) throw new Error('Action interrupted');
}

/** The physical lease holders and waiters, for diagnostics. */
export function actionLeaseStatus(bot: object): { activeLocks: string[]; waitQueue: number } | null {
  return executors.get(actionHost(bot))?.getStatus() ?? null;
}
/** Capabilities of the actions currently running on this bot, for diagnostics. */
export function activeActionCapabilities(bot: object): string[] {
  return [...(active.get(actionHost(bot)) ?? [])].filter(context => !context.settled).map(context => context.progress.capability);
}
export function physicalActionBusy(bot: object): boolean { return [...(active.get(actionHost(bot)) ?? [])].some(context => context.physical); }
export function hasActiveSafetyLease(bot: object): boolean {
  return [...(active.get(actionHost(bot)) ?? [])].some(context => context.physical && context.safetyLease && !context.settled);
}
export async function waitForActionQuiescence(bot: object): Promise<void> {
  while (physicalActionBusy(bot)) await new Promise(resolve => setTimeout(resolve, 10));
}

/** Guard at each motor call, including after an awaited protocol operation.
 * Native methods retain their receiver. Queries and event subscriptions stay intact.
 */
export function createMotorPort<T extends object>(bot: T): T {
  const owner = currentAction(bot);
  const assertMotorActive = () => {
    if (owner && (owner.controller.signal.aborted || owner.settled || (owner.root ?? owner).trace.quiescent)) throw new Error('Motor owner expired');
    assertActionActive(bot);
  };
  const writes = new Set(['equip', 'consume', 'look', 'lookAt', 'attack', 'activateItem', 'deactivateItem',
    'setControlState', 'clearControlStates', 'dig', 'stopDigging', 'placeBlock', 'activateBlock', 'openContainer', 'openFurnace']);
  const paths = new Set(['setGoal', 'goto', 'stop', 'setMovements']);
  const path = (value: any) => new Proxy(value, { get(target, key) {
    const field = Reflect.get(target, key, target);
    return typeof field === 'function' ? (...args: unknown[]) => { if (paths.has(String(key))) assertMotorActive(); return field.apply(target, args); } : field;
  } });
  const port = new Proxy(bot, { get(target, key) {
    const field = Reflect.get(target, key, target);
    if (key === 'pathfinder' && field) return path(field);
    return typeof field === 'function' ? (...args: unknown[]) => { if (writes.has(String(key))) assertMotorActive(); return field.apply(target, args); } : field;
  } });
  motorHosts.set(port, actionHost(bot));
  return port;
}

/** Native protocol emitters run outside the registering action's async context. */
export function bindActionCallback<Args extends unknown[]>(
  bot: object, callback: (...args: Args) => void,
): (...args: Args) => void {
  const context = currentAction(bot);
  if (!context) return callback;
  return (...args) => {
    // A queued native event must not revive cancelled/completed action progress.
    if (context.controller.signal.aborted || context.settled || (context.root ?? context).trace.quiescent) return;
    contextStorage.run(context, () => callback(...args));
  };
}

function emit(context: Context): void {
  const progress = structuredClone(context.progress);
  context.trace.events.push(progress);
  context.trace.events = context.trace.events.slice(-128);
  try {
    (context.bot as unknown as { emit?: (event: string, value: ActionProgress) => unknown })
      .emit?.('minebotActionProgress', progress);
  } catch { /* a telemetry consumer must not break physical execution */ }
}
export function reportActionProgress(
  bot: object, phase: ActionPhase, evidence: Record<string, unknown> = {},
  madeProgress = false, status: ActionStatus = 'running',
): void {
  const local = currentAction(bot);
  if (!local) return;
  assertActionActive(bot);
  const context = local.root ?? local;
  const now = Date.now();
  const previousPhase = context.progress.phase;
  context.trace.phaseMs[previousPhase] = (context.trace.phaseMs[previousPhase] ?? 0) + now - context.phaseStartedAt;
  context.phaseStartedAt = now;
  context.progress = { ...context.progress, phase, status, evidence: structuredClone(evidence),
    sequence: context.progress.sequence + 1, updatedAt: now,
    lastProgressAt: madeProgress ? now : context.progress.lastProgressAt,
    elapsedMs: now - context.progress.startedAt };
  emit(context);
}

export function cancelActiveActions(bot: object, reason = 'interrupted'): void {
  for (const context of active.get(actionHost(bot)) ?? []) context.controller.abort(reason);
}
/**
 * Cancel running actions except critical survival skills that hold a safety
 * lease (e.g. auto-swim surfacing). An emergency must take the body from the
 * task, not from the reflex keeping the bot alive: a breathing-priority
 * interrupt on every suffocation tick cancelled auto-swim 22 times in 8s and
 * the bot drowned.
 */
export function cancelNonSurvivalActions(bot: object, reason = 'interrupted'): void {
  for (const context of active.get(actionHost(bot)) ?? []) if (!context.safetyLease) context.controller.abort(reason);
}
/**
 * Take the body for a reflex of the given rank: cancel what runs below it, and
 * yield (false) when the body is held at or above it. Without ranks a
 * pre-empting auto-eat cancelled the counterattack the body had chosen two
 * seconds earlier and then blocked the escape while it chewed; the bot stood
 * still under a zombie and died (paid run L18).
 */
export function preemptLowerPriorityActions(bot: object, priority: number, reason = 'interrupted'): boolean {
  const running = [...(active.get(actionHost(bot)) ?? [])].filter(context => !context.settled);
  if (running.some(context => context.physical && context.priority >= priority)) return false;
  for (const context of running) context.controller.abort(reason);
  return true;
}
export function cancelAction(bot: object, actionId: string, reason = 'interrupted'): boolean {
  const context = [...(active.get(actionHost(bot)) ?? [])].find(c => c.progress.actionId === actionId);
  if (!context) return false;
  context.controller.abort(reason);
  return true;
}
export function cancelCapability(bot: object, capability: string, reason = 'interrupted'): void {
  for (const context of active.get(actionHost(bot)) ?? []) if (context.progress.capability === capability) context.controller.abort(reason);
}

/** A task-scoped signal also reaches nested runImpl calls via AsyncLocalStorage. */
const taskSignals = new AsyncLocalStorage<{ bot: object; signal?: AbortSignal }>();
export function withActionSignal<T>(bot: object, signal: AbortSignal | undefined, work: () => T): T {
  return taskSignals.run({ bot: actionHost(bot), signal }, work);
}

/** How long a cancelled action may keep the body before its lease is taken back. */
const LEASE_RECLAIM_MS = 15_000;
/** Everything that makes the native body stop, including plugins that drive it on their own. */
function physicalStops(bot: ActionHost): Array<() => unknown> {
  return [() => (bot as any).collectBlock?.cancelTask?.(), () => bot.pathfinder?.stop(), () => bot.pathfinder?.setGoal?.(null),
    () => bot.stopDigging?.(), () => bot.deactivateItem?.(), () => bot.clearControlStates?.()];
}

export async function executeAction(
  bot: ActionHost, capability: string, timeoutMs: number, work: () => Promise<SkillResult>, options: { legacyExecutingSkill?: boolean; priority?: number; waitForQuiescence?: boolean; safetyLease?: boolean } = {},
): Promise<SkillResult> {
  bot = actionHost(bot);
  const parent = currentAction(bot);
  if (parent) {
    assertActionActive(bot);
    // One physical lease, immutable linked child signals. Preserve each child's
    // own deadline without resetting the parent's emergency cancellation.
    const controller = new AbortController();
    const abort = () => controller.abort(parent.controller.signal.reason);
    parent.controller.signal.addEventListener('abort', abort, { once: true });
    const child: Context = { ...parent, controller, settled: false, root: parent.root ?? parent };
    const startedAt = Date.now();
    const stop = () => {
      if (parent.controller.signal.aborted || skillCategory(capability) === 'query') return; // root performs containment
      for (const operation of [() => bot.pathfinder?.stop(), () => bot.pathfinder?.setGoal?.(null),
        () => bot.stopDigging?.(), () => bot.deactivateItem?.(), () => bot.clearControlStates?.()]) {
        try { operation(); } catch { /* keep cancellation observable */ }
      }
    };
    controller.signal.addEventListener('abort', stop, { once: true });
    const timer = timeoutMs > 0 ? setTimeout(() => controller.abort('timeout'), timeoutMs) : undefined;
    try {
      return await contextStorage.run(child, async () => {
        try {
          const result = await work();
          assertActionActive(bot);
          return { ...result, duration: Date.now() - startedAt };
        } catch (error) {
          if (!controller.signal.aborted) throw error;
          const reason = controller.signal.reason === 'timeout' ? 'timeout' : 'interrupted';
          return { success: false, failureType: reason, recoverable: true,
            result: `${capability}: ${reason}`, duration: Date.now() - startedAt };
        }
      });
    } finally {
      child.settled = true;
      if (timer) clearTimeout(timer);
      parent.controller.signal.removeEventListener('abort', abort);
      controller.signal.removeEventListener('abort', stop);
    }
  }
  let executor = executors.get(bot);
  if (!executor) { executor = new SkillExecutor(); executors.set(bot, executor); }
  const controller = new AbortController();
  const task = taskSignals.getStore();
  const externalSignal = task?.bot === bot ? task.signal : undefined;
  const abortFromTask = () => controller.abort(externalSignal?.reason ?? 'interrupted');
  externalSignal?.addEventListener('abort', abortFromTask, { once: true });
  if (externalSignal?.aborted) abortFromTask();
  const queuedAt = Date.now();
  let release: (() => void);
  try { release = await executor.acquire(capability, controller.signal, options.priority); }
  catch (error) {
    externalSignal?.removeEventListener('abort', abortFromTask);
    return { success: false, failureType: controller.signal.aborted ? 'interrupted' : 'lock_timeout',
      recoverable: true, result: String(error), duration: Date.now() - queuedAt };
  }
  const startedAt = Date.now();
  const generation = (generations.get(bot) ?? 0) + 1;
  generations.set(bot, generation);
  const executionSessionId = sessionIds.get(bot) ?? randomUUID();
  sessionIds.set(bot, executionSessionId);
  const physical = executor.getCategory(capability) !== 'query';
  const context: Context = { bot, controller, physical, legacyExecutingSkill: options.legacyExecutingSkill ?? true,
    safetyLease: options.safetyLease === true, priority: options.priority ?? 0, settled: false, phaseStartedAt: startedAt,
    progress: { actionId: randomUUID(), executionSessionId, generation, sequence: 0, capability, physical, phase: 'execute',
      status: 'running', startedAt, updatedAt: startedAt, lastProgressAt: startedAt,
      elapsedMs: 0, evidence: {} },
    trace: { actionId: '', generation, queueMs: startedAt - queuedAt, phaseMs: {}, events: [], quiescent: false } };
  context.trace.actionId = context.progress.actionId;
  const contexts = active.get(bot) ?? new Set<Context>();
  active.set(bot, contexts);
  contexts.add(context);
  if (physical) {
    // Only after acquiring ownership: the previous cancelled action has settled.
    bot.interruptExecution = false;
    if (context.legacyExecutingSkill) bot.executingSkill = true;
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let containmentWarning: ReturnType<typeof setTimeout> | undefined;
  // The legacy flag is raised whenever any physical action is cancelled. A
  // survival skill on its own safety lease must not fall with the task it
  // pre-empted; it still stops on its own signal, timeout or task cancel.
  const interruptPoll = physical && !context.safetyLease ? setInterval(() => {
    if (bot.interruptExecution) controller.abort('interrupted');
  }, 50) : undefined;
  if (timeoutMs > 0) timeout = setTimeout(() => controller.abort('timeout'), timeoutMs);
  let leaseReclaim: ReturnType<typeof setTimeout> | undefined;
  /** Once only: when runImpl settles, or when a cancelled action that never does has its lease reclaimed. */
  const settle = () => {
    if (context.settled) return;
    if (timeout) clearTimeout(timeout);
    if (containmentWarning) clearTimeout(containmentWarning);
    if (leaseReclaim) clearTimeout(leaseReclaim);
    if (interruptPoll) clearInterval(interruptPoll);
    externalSignal?.removeEventListener('abort', abortFromTask);
    controller.signal.removeEventListener('abort', onAbort);
    const now = Date.now();
    if (context.trace.containment) context.trace.containment.settledAt = now;
    context.settled = true;
    context.trace.phaseMs[context.progress.phase] = (context.trace.phaseMs[context.progress.phase] ?? 0) + now - context.phaseStartedAt;
    context.trace.quiescent = true;
    contexts.delete(context);
    bot.executingSkill = [...contexts].some(c => c.physical && c.legacyExecutingSkill);
    release();
  };
  let cancelResolve: (result: SkillResult) => void = () => {};
  const cancelled = new Promise<SkillResult>(resolve => { cancelResolve = resolve; });
  const onAbort = () => {
    if (interruptPoll) clearInterval(interruptPoll);
    context.trace.containment = { cancelledAt: Date.now(), warningAt: null, settledAt: null };
    if (physical) {
      containmentWarning = setTimeout(() => {
        if (context.settled) return;
        context.trace.containment!.warningAt = Date.now();
        context.progress = { ...context.progress, sequence: context.progress.sequence + 1,
          updatedAt: Date.now(), evidence: { ...context.progress.evidence, containment: 'body_not_quiescent', leaseRetained: true } };
        emit(context);
        logger.warn(`[Minebot:ActionContainment] Action ${context.progress.actionId} (${capability}) remains fenced after cancellation; physical lease retained`);
      }, 2000);
      containmentWarning.unref();
      // Retaining the lease protects the successor from a body still in
      // motion, but not for ever: a cancelled pick-up waited inside a plugin
      // call that never returned, and every later action timed out on the
      // lock for the rest of the run (paid run L29). Its controls are fenced
      // and stopped again; after this bound the body goes to the next action.
      leaseReclaim = setTimeout(() => {
        if (context.settled) return;
        logger.error(`[Minebot:ActionContainment] Action ${context.progress.actionId} (${capability}) did not settle ${LEASE_RECLAIM_MS / 1000}s after cancellation; its lease is reclaimed`);
        for (const stop of physicalStops(bot)) { try { stop(); } catch { /* keep reclaiming */ } }
        context.trace.containment!.reclaimedAt = Date.now();
        settle();
      }, LEASE_RECLAIM_MS);
      leaseReclaim.unref();
    }
    context.progress = { ...context.progress, status: 'cancelling', updatedAt: Date.now(),
      sequence: context.progress.sequence + 1 };
    emit(context);
    if (physical) {
      bot.interruptExecution = true; // compatibility for loops not yet using actionSignal
      for (const stop of physicalStops(bot)) {
        try { stop(); } catch { /* cleanup must not hide cancellation */ }
      }
    }
    const reason = controller.signal.reason === 'timeout' ? 'timeout' : 'interrupted';
    cancelResolve({ success: false, failureType: reason, recoverable: true,
      result: `${capability}: ${reason}（実行済みの効果は取り消されません）`,
      duration: Date.now() - startedAt, execution: structuredClone(context.trace) });
  };
  controller.signal.addEventListener('abort', onAbort, { once: true });
  emit(context);
  if (controller.signal.aborted) onAbort();
  const running = contextStorage.run(context, async () => {
    try {
      assertActionActive(bot);
      const result = await work();
      assertActionActive(bot);
      return result;
    } catch (error) {
      return { success: false, failureType: controller.signal.aborted ? 'interrupted' : 'execution_error',
        recoverable: true, result: String(error), error: error instanceof Error ? error.message : String(error) };
    } finally {
      // A cancelled caller may already have returned, but its lease is kept
      // until runImpl actually settles. A late finally cannot unlock a successor.
      settle();
    }
  }).then(result => {
    context.progress = { ...context.progress, status: controller.signal.aborted ? 'cancelled' : result.success ? 'completed' : 'failed',
      sequence: context.progress.sequence + 1, updatedAt: Date.now(), elapsedMs: Date.now() - startedAt };
    emit(context);
    return { ...result, duration: Date.now() - startedAt, execution: structuredClone(context.trace) };
  });
  return options.waitForQuiescence ? running : Promise.race([running, cancelled]);
}
