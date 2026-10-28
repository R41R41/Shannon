import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { SkillExecutor, skillCategory } from './SkillExecutor.js';
import type { ActionPhase, ActionProgress, ActionStatus, ActionTrace } from './actionTypes.js';
import type { SkillResult } from '../types/skillParams.js';
import { logger } from '../../../utils/logger.js';
import type { Handover, HandoverReservation } from '../integration/commonFca/continueContract.js';

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
  /** How many actions this one is nested in (0 for a root action). */
  depth?: number;
  /** Continue contracts (4, 8): this root action's place in the count of owners, the effective motor operations it sent, and when the first and the lock came. */
  seq: number;
  motorOps: number;
  lockAt: number;
  firstMotorAt?: number;
  /** Continue contracts (4): the owner has handed the shield to the resident shield for as long as it holds (a fight, an attack, a handover). */
  shieldDelegated?: boolean;
  /** Continue contracts (4): the handover this action was taken over through (set when it took the lock from a reflex it had reserved). */
  handover?: Handover;
}
/**
 * The deepest a skill may call skills inside skills. Ordinary work goes four or five deep (mine-block, dig-block-at, drop-item,
 * move-to); run 22 went on without end (dig-block-at's tidy, drop-item's pit dug through dig-block-at, its tidy again...) on
 * microtasks only, and the process stopped answering for 200 s. A call past this is refused, never run.
 */
export const MAX_NESTED_ACTIONS = 12;
const contextStorage = new AsyncLocalStorage<Context>();
const executors = new WeakMap<object, SkillExecutor>();
const generations = new WeakMap<object, number>();
const sessionIds = new WeakMap<object, string>();
const active = new WeakMap<object, Set<Context>>();
const motorHosts = new WeakMap<object, object>();
/** The count of owners: a root action that moves the body (a physical one) takes the next number when it gets the lock; queries and nested actions do not. */
const holderSeqs = new WeakMap<object, number>();
export function holderSeqOf(bot: object): number { return holderSeqs.get(actionHost(bot)) ?? 0; }
function actionHost<T extends object>(bot: T): T { return (motorHosts.get(bot) ?? bot) as T; }
/** Motor wrappers are views of one native bot, never a new memory/world identity. */
export const nativeActionHost = actionHost;

export function currentAction(bot: object): Context | undefined {
  const context = contextStorage.getStore();
  return context?.bot === actionHost(bot) ? context : undefined;
}
/**
 * Whether a skill about to run is the command itself, not a skill called inside another: no action yet (the legacy planner), or
 * only the action the common-FCA body opened for this very command (nativeBody runs `skill.run` inside an action of the skill's own
 * name). Every skill's preflight was skipped under common FCA, because there an action is always open: run 17's wait-time refusal
 * and the night gate of move-to, stair-mine and dig-block-at never ran (2026-10-20).
 */
export function isCommandLevel(bot: object, capability: string): boolean {
  const context = currentAction(bot);
  return !context || (!context.root && context.progress.capability === capability);
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
/** Capabilities of the physical actions running now (a query holds nothing of the body and is not among them). */
export function physicalActionCapabilities(bot: object): string[] {
  return [...(active.get(actionHost(bot)) ?? [])].filter(context => context.physical && !context.settled).map(context => context.progress.capability);
}
export function physicalActionBusy(bot: object): boolean { return [...(active.get(actionHost(bot)) ?? [])].some(context => context.physical); }
export function hasActiveSafetyLease(bot: object): boolean {
  return [...(active.get(actionHost(bot)) ?? [])].some(context => context.physical && context.safetyLease && !context.settled);
}
/** The capabilities (skill names) of the safety reflexes holding the body now: auto-swim surfacing, the lava escape. */
export function safetyLeaseCapabilities(bot: object): string[] {
  return [...(active.get(actionHost(bot)) ?? [])].filter(context => context.physical && context.safetyLease && !context.settled)
    .map(context => context.progress.capability);
}
export async function waitForActionQuiescence(bot: object): Promise<void> {
  while (physicalActionBusy(bot)) await new Promise(resolve => setTimeout(resolve, 10));
}

/** Guard at each motor call, including after an awaited protocol operation.
 * Native methods retain their receiver. Queries and event subscriptions stay intact.
 *
 * Always one layer over the native bot, whatever is passed: a nested skill (callSkill) passed its parent's port, and each nesting
 * wrapped one more Proxy round the last, so that every property read walked all the layers and anything keyed on the bot object
 * (the tidy's hold) saw a new bot at every level (run 22). The parent's fence is not lost: a child action is aborted with its parent,
 * and the child's own owner is checked here.
 */
export function createMotorPort<T extends object>(given: T): T {
  return portFor(given, currentAction(actionHost(given)));
}

/** What a motor operation was, for the record of the operations (continue contracts, 8): the time, the kind, a short detail. */
export interface MotorOp { at: number; op: string; detail?: string; actionId: string; capability: string }
const opSinks = new WeakMap<object, (op: MotorOp) => void>();
const recentOpRings = new WeakMap<object, MotorOp[]>();
/** The continuous record of the operations (the lab benches and the production use one entrance): told every effective operation, from the start. */
export function setMotorOpSink(bot: object, sink: ((op: MotorOp) => void) | null): void {
  if (sink) opSinks.set(actionHost(bot), sink); else opSinks.delete(actionHost(bot));
}
/** The last operations (16), oldest first, whoever sent them: what a hand's start record carries. */
export function recentMotorOps(bot: object): MotorOp[] { return [...(recentOpRings.get(actionHost(bot)) ?? [])]; }

/** Operations that only let go of something: they are not "a hand that moved" (the count of effective operations leaves them out). */
function releasesOnly(key: string, args: unknown[]): boolean {
  if (key === 'clearControlStates' || key === 'stopDigging' || key === 'deactivateItem' || key === 'stop') return true;
  if (key === 'setControlState') return args[1] === false;
  if (key === 'setGoal') return args[0] === null || args[0] === undefined;
  return false;
}
function opDetail(key: string, args: unknown[]): string | undefined {
  try {
    if (key === 'setControlState') return `${String(args[0])}=${String(args[1])}`;
    const first = args[0] as { position?: { x: number; y: number; z: number }; x?: number; y?: number; z?: number; name?: string } | undefined;
    const at = first?.position ?? (typeof first?.x === 'number' ? first : undefined);
    if (at) return `${first?.name ? `${first.name} ` : ''}(${Math.floor(at.x as number)},${Math.floor(at.y as number)},${Math.floor(at.z as number)})`;
    if (typeof args[0] === 'string') return args[0].slice(0, 40);
  } catch { /* a detail is a help */ }
  return undefined;
}
/** An effective motor operation of `owner`'s root action: counted on it, recorded, told to the record. */
function noteMotorOp<T extends object>(bot: T, owner: Context | undefined, key: string, args: unknown[]): void {
  if (!owner || releasesOnly(key, args)) return;
  const root = owner.root ?? owner, at = Date.now();
  root.motorOps++;
  if (root.firstMotorAt === undefined && root.handover) noteShieldState(bot, 'first_op', { op: key, command: undefined });
  root.firstMotorAt ??= at;
  const op: MotorOp = { at, op: key, ...(opDetail(key, args) ? { detail: opDetail(key, args) } : {}), actionId: root.progress.actionId, capability: root.progress.capability };
  const ring = recentOpRings.get(bot) ?? [];
  recentOpRings.set(bot, ring);
  ring.push(op);
  if (ring.length > 16) ring.shift();
  try { opSinks.get(bot)?.(op); } catch { /* the record never stops a motor operation */ }
}

/** The motor port of one owner: what `createMotorPort` makes for the action that is running, and what the resident shield acts through while an owner has delegated it (4). */
function portFor<T extends object>(given: T, owner: Context | undefined): T {
  const bot = actionHost(given);
  const assertMotorActive = () => {
    if (owner && (owner.controller.signal.aborted || owner.settled || (owner.root ?? owner).trace.quiescent)) throw new Error('Motor owner expired');
    assertActionActive(bot);
  };
  const writes = new Set(['equip', 'moveSlotItem', 'setQuickBarSlot', 'consume', 'look', 'lookAt', 'attack', 'activateItem', 'deactivateItem',
    'setControlState', 'clearControlStates', 'dig', 'unconfirmedDig', 'stopDigging', 'placeBlock', 'activateBlock', 'openContainer', 'openFurnace']);
  const paths = new Set(['setGoal', 'goto', 'stop', 'setMovements']);
  const path = (value: any) => new Proxy(value, { get(target, key) {
    const field = Reflect.get(target, key, target);
    return typeof field === 'function' ? (...args: unknown[]) => { if (paths.has(String(key))) { assertMotorActive(); noteMotorOp(bot, owner, String(key), args); } return field.apply(target, args); } : field;
  } });
  const port = new Proxy(bot, { get(target, key) {
    const field = Reflect.get(target, key, target);
    if (key === 'pathfinder' && field) return path(field);
    return typeof field === 'function' ? (...args: unknown[]) => { if (writes.has(String(key))) { assertMotorActive(); noteMotorOp(bot, owner, String(key), args); } return field.apply(target, args); } : field;
  } });
  motorHosts.set(port, bot);
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
  const cut = running.filter(context => !context.controller.signal.aborted);
  for (const context of running) context.controller.abort(reason);
  // Said to the body's reflex ledger, if it has one: which actions this reflex really cut off (P8, `interrupted_by_reflex`).
  if (cut.length) {
    try {
      (actionHost(bot) as { reflexLedger?: { preempted(by: string, aborted: string[], ids?: string[]): void } }).reflexLedger
        ?.preempted(reason, cut.map(context => context.progress.capability), cut.map(context => context.progress.actionId));
    } catch { /* a report must not change what the reflex did */ }
  }
  return true;
}
/**
 * Idle work (priority below 0: nothing is waiting for it) gives way to a command at once. Safety leases are never idle work.
 * Returns how many were cancelled.
 */
export function cancelIdleActions(bot: object, reason = 'interrupted'): number {
  let cancelled = 0;
  for (const context of [...(active.get(actionHost(bot)) ?? [])]) {
    if (context.priority < 0 && !context.safetyLease && !context.settled && !context.controller.signal.aborted) { context.controller.abort(reason); cancelled++; }
  }
  return cancelled;
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
function physicalStops(bot: ActionHost, reason?: unknown): Array<() => unknown> {
  // Continue contracts (4): a stop for a handover leaves the shield up (the reservation holds its right; if the handover fails, the reservation's removal lowers it).
  const keepShield = reason === 'handover';
  return [() => (bot as any).collectBlock?.cancelTask?.(), () => bot.pathfinder?.stop(), () => bot.pathfinder?.setGoal?.(null),
    () => bot.stopDigging?.(), ...(keepShield ? [] : [() => bot.deactivateItem?.()]), () => bot.clearControlStates?.()];
}

/* ----- continue contracts (4): the shield's right, the handover reservation ----- */
/**
 * The root action that moves the body and has handed the shield to the resident shield (a fight, an attack, a handover). The resident shield then
 * raises and lowers it through that owner's motor port; an owner that has lapsed refuses it.
 */
export function delegateShield(bot: object, on = true): void {
  const context = currentAction(bot);
  if (context) (context.root ?? context).shieldDelegated = on;
}
/** The port the resident shield acts through: the delegated owner's, or null when no owner has delegated (the shield then acts on its own). */
export function shieldPort<T extends object>(bot: T): T | null {
  const owner = [...(active.get(actionHost(bot)) ?? [])].find(context => !context.root && context.physical && !context.settled && context.shieldDelegated);
  return owner ? portFor(bot, owner) : null;
}
/** Whether any owner holds the shield's right (delegated) now. */
export function shieldHeldByOwner(bot: object): boolean {
  return [...(active.get(actionHost(bot)) ?? [])].some(context => !context.root && context.physical && !context.settled && context.shieldDelegated);
}
/** The first value of the reservation's window (ms). The isolated lab measures it (contract 13). */
export const HANDOVER_WINDOW_MS = 300;
const reservations = new WeakMap<object, HandoverReservation>();
/**
 * A-6 (2, 9): what the resident shield's state was when a reservation was made, so that at the claim "the shield was up without a break" is measured, not
 * assumed: no lowering and no `deactivateItem` since the reservation, and the shield still up and still in use.
 */
const reservationShield = new WeakMap<HandoverReservation, { lowered: number; deactivateCalls: number }>();
interface ShieldHost { shieldBlock?: { up?: boolean; lowered?: number; deactivateCalls?: number }; usingHeldItem?: boolean; deactivateItem?: unknown }
export interface ShieldView { up: boolean; using: boolean | null; lowered: number; deactivateCalls: number; hasDeactivate: boolean }
function shieldViewOf(host: object): ShieldView {
  const h = host as ShieldHost;
  return { up: h.shieldBlock?.up === true, using: typeof h.usingHeldItem === 'boolean' ? h.usingHeldItem : null, lowered: h.shieldBlock?.lowered ?? 0,
    deactivateCalls: h.shieldBlock?.deactivateCalls ?? 0, hasDeactivate: typeof h.deactivateItem === 'function' };
}
const noteSinks = new WeakMap<object, (kind: string, data: Record<string, unknown>) => void>();
/** The record of the operations also takes the notes of the shield's state (the measurement reads them beside the operations). */
export function setShieldNoteSink(bot: object, sink: ((kind: string, data: Record<string, unknown>) => void) | null): void {
  if (sink) noteSinks.set(actionHost(bot), sink); else noteSinks.delete(actionHost(bot));
}
/** The actual state of the shield at one moment of a handover (`reserve`, `stop`, `claim`, `first_op`, `released`): up or not, in use or not, and what was lowered since the reservation. */
export function noteShieldState(bot: object, phase: 'reserve' | 'stop' | 'claim' | 'first_op' | 'released', extra: Record<string, unknown> = {}): void {
  try {
    const host = actionHost(bot);
    const sink = noteSinks.get(host);
    if (!sink) return;
    const view = shieldViewOf(host), reservation = reservations.get(host), was = reservation ? reservationShield.get(reservation) : undefined;
    sink('shield_state', { phase, up: view.up, using: view.using, hasDeactivate: view.hasDeactivate,
      ...(was ? { loweredSince: view.lowered - was.lowered, deactivatedSince: view.deactivateCalls - was.deactivateCalls } : {}), ...extra });
  } catch { /* a note never changes what the body did */ }
}
const reservationTimers = new WeakMap<object, ReturnType<typeof setTimeout>>();
const rootSettledAt = new WeakMap<object, { actionId: string; at: number }>();
export function reservationOf(bot: object): HandoverReservation | null { return reservations.get(actionHost(bot)) ?? null; }
function lowerShield(bot: object): void {
  const host = actionHost(bot) as { deactivateItem?(): void; shieldBlock?: { up?: boolean } };
  if (host.shieldBlock) { if (host.shieldBlock.up) (host.shieldBlock as { lowered?: number }).lowered = ((host.shieldBlock as { lowered?: number }).lowered ?? 0) + 1; host.shieldBlock.up = false; }
  try { host.deactivateItem?.(); } catch { /* nothing held */ }
}
/**
 * The reservation of a handover: made from the reflex action that is about to be stopped, before it is stopped. Whoever takes the body next and is not
 * the command it is for removes it (and lowers the shield it held); the command it is for checks and takes it in the same moment as the lock (executeAction).
 * It lapses by itself after `HANDOVER_WINDOW_MS`, the reservation's removal lowering the shield.
 */
export function reserveHandover(bot: object, input: Pick<HandoverReservation, 'fromActionId' | 'reflex' | 'target' | 'life' | 'forCommand' | 'shield'>, now = Date.now(), windowMs = HANDOVER_WINDOW_MS): HandoverReservation {
  const host = actionHost(bot);
  dropReservation(host, 'replaced');
  const reservation: HandoverReservation = { ...input, holderSeq: holderSeqs.get(host) ?? 0, at: new Date(now).toISOString(), until: new Date(now + windowMs).toISOString() };
  reservations.set(host, reservation);
  { const view = shieldViewOf(host); reservationShield.set(reservation, { lowered: view.lowered, deactivateCalls: view.deactivateCalls }); }
  noteShieldState(host, 'reserve', { forCommand: input.forCommand, reserved: input.shield, reflex: input.reflex });
  const timer = setTimeout(() => { if (reservations.get(host) === reservation) dropReservation(host, 'expired'); }, windowMs + 5);
  timer.unref?.();
  reservationTimers.set(host, timer);
  return reservation;
}
/** The reservation is removed; the shield it held is lowered. True when a reservation was removed. */
export function dropReservation(bot: object, _why: 'expired' | 'other_holder' | 'replaced' | 'refused' | 'cancelled' | 'death' = 'cancelled'): boolean {
  const host = actionHost(bot);
  const reservation = reservations.get(host);
  clearTimeout(reservationTimers.get(host)); reservationTimers.delete(host);
  if (!reservation) return false;
  noteShieldState(host, 'released', { why: _why, forCommand: reservation.forCommand });
  reservations.delete(host);
  if (reservation.shield && !shieldHeldByOwner(host)) lowerShield(host);
  return true;
}
/** The bot's root actions that move the body now: for the observation's state.control (4). */
export function physicalRoots(bot: object): Array<{ actionId: string; capability: string; priority: number; safetyLease: boolean; startedAt: number; seq: number; shieldDelegated: boolean }> {
  return [...(active.get(actionHost(bot)) ?? [])].filter(context => !context.root && context.physical && !context.settled)
    .map(context => ({ actionId: context.progress.actionId, capability: context.progress.capability, priority: context.priority, safetyLease: context.safetyLease,
      startedAt: context.progress.startedAt, seq: context.seq, shieldDelegated: context.shieldDelegated === true }));
}
/** Effective motor operations the running root action has sent (0 outside an action). */
export function motorOpsOf(bot: object): number {
  const context = currentAction(bot);
  return context ? (context.root ?? context).motorOps : 0;
}
/** The handover the running action was taken over through, if it was (continue contracts, 4). */
export function handoverOf(bot: object): Handover | undefined {
  const context = currentAction(bot);
  return context ? (context.root ?? context).handover : undefined;
}

/** The root action's counts and times copied to its trace (what the result's execution carries to the body's receipt). */
function syncTrace(context: Context): void {
  context.trace.lockAt = context.lockAt;
  if (context.firstMotorAt !== undefined) context.trace.firstMotorAt = context.firstMotorAt;
  context.trace.motorOps = context.motorOps;
  context.trace.holderSeq = context.seq;
}

export async function executeAction(
  bot: ActionHost, capability: string, timeoutMs: number, work: () => Promise<SkillResult>, options: { legacyExecutingSkill?: boolean; priority?: number; waitForQuiescence?: boolean; safetyLease?: boolean;
    /** Continue contracts (4): this action is the command a handover was reserved for; verify is its last check (the target is still there, the life is the same). */
    handover?: { command: string; verify(): boolean } } = {},
): Promise<SkillResult> {
  bot = actionHost(bot);
  const parent = currentAction(bot);
  if (parent) {
    assertActionActive(bot);
    const depth = (parent.depth ?? 0) + 1;
    if (depth > MAX_NESTED_ACTIONS) {
      logger.warn(`[Minebot:ActionExecution] ${capability} refused: ${depth} actions deep (more than ${MAX_NESTED_ACTIONS}; a skill calling itself round a loop)`);
      return { success: false, failureType: 'nesting_too_deep', recoverable: true,
        result: `${capability}: スキルの入れ子が${MAX_NESTED_ACTIONS}段を超えたため実行しませんでした（同じ手順が自分を呼び続けている）` };
    }
    // One physical lease, immutable linked child signals. Preserve each child's
    // own deadline without resetting the parent's emergency cancellation.
    const controller = new AbortController();
    const abort = () => controller.abort(parent.controller.signal.reason);
    parent.controller.signal.addEventListener('abort', abort, { once: true });
    const child: Context = { ...parent, controller, settled: false, root: parent.root ?? parent, depth };
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
  let handover: Handover | undefined;
  /** In the moment the lock is granted (nobody else can have taken the body since): a reservation is taken over by the command it is for, else removed. */
  const claim = () => {
    const reservation = reservations.get(bot);
    if (!reservation || executor!.getCategory(capability) === 'query') return;
    if (options.safetyLease || options.handover?.command !== reservation.forCommand) { dropReservation(bot, 'other_holder'); return; }
    const settled = rootSettledAt.get(bot);
    const within = Date.now() <= Date.parse(reservation.until), sameOwner = (holderSeqs.get(bot) ?? 0) === reservation.holderSeq;
    let valid = false;
    try { valid = options.handover.verify(); } catch { valid = false; }
    const confirmed = within && sameOwner && valid;
    const reflexSettledAt = new Date(settled && settled.actionId === reservation.fromActionId ? settled.at : Date.now()).toISOString();
    // A-6 (2): 'kept' only when the shield was up without a break since the reservation (nothing lowered it, no deactivateItem, still up and in use);
    // a handover that is confirmed but found it down says 'dropped' (the act then raises it as its own, the resident shield acts through its port).
    const was = reservationShield.get(reservation), view = shieldViewOf(bot);
    const unbroken = !!was && view.up && view.using !== false && view.lowered === was.lowered && view.deactivateCalls === was.deactivateCalls;
    handover = { from: reservation.reflex, target: reservation.target, waitedMs: Math.max(0, Date.now() - Date.parse(reservation.at)), reflexSettledAt, confirmed,
      shield: !reservation.shield ? 'none' : !confirmed ? 'lowered' : unbroken ? 'kept' : 'dropped' };
    noteShieldState(bot, 'claim', { forCommand: reservation.forCommand, confirmed, shield: handover.shield });
    if (confirmed) { reservations.delete(bot); clearTimeout(reservationTimers.get(bot)); reservationTimers.delete(bot); }
    else dropReservation(bot, within ? 'refused' : 'expired');
  };
  try { release = await executor.acquire(capability, controller.signal, options.priority, claim); }
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
  const seq = physical ? (holderSeqs.get(bot) ?? 0) + 1 : holderSeqs.get(bot) ?? 0;
  if (physical) holderSeqs.set(bot, seq);
  const context: Context = { bot, controller, physical, legacyExecutingSkill: options.legacyExecutingSkill ?? true, seq, motorOps: 0, lockAt: startedAt,
    ...(handover?.confirmed && handover.shield === 'kept' ? { shieldDelegated: true } : {}), ...(handover ? { handover } : {}),
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
    syncTrace(context);
    if (physical) rootSettledAt.set(bot, { actionId: context.progress.actionId, at: now });
    contexts.delete(context);
    bot.executingSkill = [...contexts].some(c => c.physical && c.legacyExecutingSkill);
    release();
  };
  let cancelResolve: (result: SkillResult) => void = () => {};
  const cancelled = new Promise<SkillResult>(resolve => { cancelResolve = resolve; });
  const onAbort = () => {
    if (interruptPoll) clearInterval(interruptPoll);
    context.trace.containment = { cancelledAt: Date.now(), warningAt: null, settledAt: null };
    syncTrace(context);
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
      // Exact handoff callers require actual unwind; a timed reclamation is not a stop acknowledgement.
      if (!options.waitForQuiescence) leaseReclaim = setTimeout(() => {
        if (context.settled) return;
        logger.error(`[Minebot:ActionContainment] Action ${context.progress.actionId} (${capability}) did not settle ${LEASE_RECLAIM_MS / 1000}s after cancellation; its lease is reclaimed`);
        for (const stop of physicalStops(bot, controller.signal.reason)) { try { stop(); } catch { /* keep reclaiming */ } }
        context.trace.containment!.reclaimedAt = Date.now();
        settle();
      }, LEASE_RECLAIM_MS);
      leaseReclaim?.unref();
    }
    context.progress = { ...context.progress, status: 'cancelling', updatedAt: Date.now(),
      sequence: context.progress.sequence + 1 };
    emit(context);
    if (physical) {
      bot.interruptExecution = true; // compatibility for loops not yet using actionSignal
      for (const stop of physicalStops(bot, controller.signal.reason)) {
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
