import { Vec3 } from 'vec3';
import { NativeGoalEvidence, GOAL_EVIDENCE_SKILL } from './goalEvidence.js';
import { primitiveState, primitiveCandidates, executePrimitive } from './primitives.js';
import { captureWorldObservation } from '../../cognition/worldFrame.js';
import { activeActionCapabilities, cancelNonSurvivalActions, createMotorPort, executeAction,
  hasActiveSafetyLease, physicalActionBusy, withActionSignal } from '../../execution/ActionExecution.js';
import { bodySkillCatalog, type BodySkill } from './skillCatalog.js';
import type { BodyCandidateDraft, BodyObservation, BodyValue } from './bodyControlContract.js';
import type { MinecraftControlCommand as Command, MinecraftControlReceipt as Receipt } from './minecraftControlContract.js';
import type { CommonFcaActuator } from './controlLoop.js';

const delay = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));
export interface NativeBodyOptions {
  serverId: string; now?: () => number;
  capture(signal: AbortSignal): Promise<{ dataUrl: string; capturedAt: string }>;
  disposeCapture?(): Promise<void>;
  /** False when no first-person picture can come from this connection, so the API does not offer visual control. */
  rendererConfigured?(): boolean;
}
/** One native bot, one ActionExecution resource arbiter, no game planner or model. */
/**
 * How long a release waits for a safety reflex that holds the body to end by itself: a meal takes about 1.6 s, a retreat at
 * most 1 s, armour under 0.5 s. With the 300 ms cleanup after it, the whole leaves room inside the 5 s an API stop or release
 * command allows (minecraftReflexAdapter, delivery included) and the 5 s of a lifecycle logout; a longer hold (a lava escape)
 * still ends held, as before.
 */
const SAFETY_RELEASE_WAIT_MS = 3000;
/**
 * The skill's own failure kind for the API to sort retries by (agreed 2026-10-14: retry the same, change the situation,
 * get material first, or fix the input). move-to's old name for "no route" is said as the agreed no_path.
 */
function failureOf(result: { failureType?: string; recoverable?: boolean }): Pick<Receipt, 'failureType' | 'recoverable'> | undefined {
  const type = typeof result.failureType === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(result.failureType)
    ? (result.failureType === 'path_not_found' ? 'no_path' : result.failureType) : undefined;
  if (!type && typeof result.recoverable !== 'boolean') return undefined;
  return { ...(type ? { failureType: type } : {}), ...(typeof result.recoverable === 'boolean' ? { recoverable: result.recoverable } : {}) };
}
export class NativeCommonFcaBody implements CommonFcaActuator {
  readonly skills;
  private readonly catalog;
  private readonly goalEvidence: NativeGoalEvidence;
  private sequence = 0;
  private connected = true;
  private imageAvailable = false;
  private lastPosition: Vec3 | null = null;
  private movedAt = 0;
  private lastSafety: Record<string, BodyValue> | null = null;
  private readonly onEnd = () => { this.connected = false; };
  private readonly onProgress = (progress: any) => {
    if (progress.capability === 'auto-swim') this.lastSafety = { capability: 'auto-swim', status: String(progress.status),
      actionId: String(progress.actionId), observedAt: new Date(this.now()).toISOString() };
  };
  constructor(private readonly bot: any, private readonly options: NativeBodyOptions) {
    this.catalog = bodySkillCatalog(bot.instantSkills.getSkills() as BodySkill[], bot);
    if (this.catalog.definitions.some(skill => skill.name === GOAL_EVIDENCE_SKILL.name)) throw Error('BODY_RESERVED_SKILL');
    this.skills = [...this.catalog.definitions, GOAL_EVIDENCE_SKILL];
    this.goalEvidence = new NativeGoalEvidence(bot, () => this.now());
    bot.on('end', this.onEnd); bot.on('minebotActionProgress', this.onProgress);
  }
  private now() { return (this.options.now ?? Date.now)(); }
  observe(): BodyObservation {
    const world = captureWorldObservation(this.bot), now = this.now();
    const position = this.bot.entity?.position;
    if (position && (!this.lastPosition || position.distanceTo(this.lastPosition) > 0.1)) {
      this.movedAt = now; this.lastPosition = position.clone();
    }
    const moving = ['forward', 'back', 'left', 'right', 'jump'].some(name => this.bot.controlState?.[name]);
    const facts: Record<string, null | string | number | boolean> = {
      connected: this.connected && !!this.bot.entity, alive: (this.bot.health ?? 0) > 0,
      onGround: this.bot.entity?.onGround === true, dimension: String(this.bot.game?.dimension ?? ''),
      yaw: Number(this.bot.entity?.yaw ?? 0), pitch: Number(this.bot.entity?.pitch ?? 0),
      equipped: this.bot.heldItem?.name ?? null, window: this.bot.currentWindow?.type ?? null,
      danger: (this.bot.health ?? 20) <= 8 || (this.bot.oxygenLevel ?? 20) <= 6 || (world.nearbyThreats ?? []).some(t => t.distance <= 5 && t.canReachMe !== false),
      stuck: !!moving && now - this.movedAt > 1500, visualRequired: false, imageAvailable: this.imageAvailable,
      rendererConfigured: this.options.rendererConfigured?.() ?? null,
    };
    const primitives = primitiveState(this.bot); Object.assign(facts, primitives.facts);
    return { schemaVersion: 1, bodyId: `minecraft:${this.options.serverId}`, sequence: ++this.sequence,
      stateAt: new Date(now).toISOString(), receivedAt: new Date(now).toISOString(), connected: facts.connected === true,
      state: JSON.parse(JSON.stringify({ world, primitives: primitives.state, activeCapabilities: activeActionCapabilities(this.bot), localSafety: this.lastSafety })), facts };
  }
  candidates(observation: BodyObservation): BodyCandidateDraft[] {
    return primitiveCandidates(observation, this.now());
  }
  async execute(command: Command, signal: AbortSignal): Promise<Receipt> {
    if (command.kind === 'capture') {
      // Capture never owns motor inputs. Missing exact assets or cancelled observation are a
      // known no-image result, not an uncertain physical effect. Existing cleanup holds remain held.
      try {
        signal.throwIfAborted();
        if (!this.connected || !this.bot.entity) throw Error('BODY_DISCONNECTED');
        const image = await this.options.capture(signal); signal.throwIfAborted();
        this.imageAvailable = true;
        return this.receipt(command, 'completed', true, undefined, image);
      } catch {
        this.imageAvailable = false;
        return this.receipt(command, signal.aborted ? 'cancelled' : 'failed', true, 'BODY_CAPTURE_UNAVAILABLE');
      }
    }
    signal.throwIfAborted();
    if (!this.connected || !this.bot.entity) throw Error('BODY_DISCONNECTED');
    // Each skill runs for its own time (build-around-self five minutes, mine-block three), never past the command's deadline.
    const limit = command.kind === 'skill' ? this.skills.find(skill => skill.name === command.skill)?.maxDurationMs ?? 120_000 : 120_000;
    const milliseconds = Math.min(limit, Date.parse(command.deadlineAt) - this.now());
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) throw Error('BODY_DEADLINE');
    this.goalEvidence.begin(command);
    const cancelled = () => this.goalEvidence.cancel(command.context);
    signal.addEventListener('abort', cancelled, { once: true });
    try {
      if (command.kind === 'skill' && command.skill === GOAL_EVIDENCE_SKILL.name) {
        if (!command.arguments || typeof command.arguments !== 'object' || Array.isArray(command.arguments) || Object.keys(command.arguments).length) throw Error('BODY_EVIDENCE_ARGUMENTS');
        return this.receipt(command, 'completed', true, JSON.stringify(this.goalEvidence.snapshot()));
      }
      let capability: string, work: () => Promise<{ success: boolean; result: string; failureType?: string; recoverable?: boolean }>;
      if (command.kind === 'skill') {
        const resolved = this.catalog.resolve(command.skill ?? '', command.arguments ?? {});
        capability = resolved.skill.skillName; work = () => resolved.skill.run(...resolved.args);
      } else if (command.kind === 'reflex' && command.operation) {
        const operation = command.operation, candidate = operation.candidate;
        if (JSON.stringify(operation.context) !== JSON.stringify(command.context) || candidate.sessionId !== command.context.sessionId
          || candidate.generation !== command.context.generation || candidate.taskRevision !== command.context.taskRevision
          || Date.parse(candidate.expiresAt) <= this.now() || Date.parse(operation.deadlineAt) <= this.now()) throw Error('BODY_STALE_CANDIDATE');
        const observation = this.observe();
        if (candidate.preconditions.some(item => observation.facts[item.key] !== item.value)) throw Error('BODY_PRECONDITION');
        // Only arguments generated by this adapter are admitted; no provider authored operation is executable.
        const current = this.candidates(observation).find(item => item.kind === candidate.kind && item.operation === candidate.operation
          && JSON.stringify(item.arguments) === JSON.stringify(candidate.arguments));
        if (!current || current.preconditions.some(required => !candidate.preconditions.some(p => p.key === required.key && p.value === required.value))
          || candidate.kind !== 'action' || candidate.maxDurationMs > 5000) throw Error('BODY_CANDIDATE_NOT_SUPPORTED');
        capability = 'common-fca-reflex';
        work = async () => {
          await executePrimitive(this.bot, createMotorPort(this.bot), candidate, signal);
          return { success: true, result: 'bounded primitive finished' };
        };
      } else throw Error('BODY_COMMAND_UNSUPPORTED');
      const result = await withActionSignal(this.bot, signal, () => executeAction(this.bot, capability, milliseconds,
        work, { waitForQuiescence: true }));
      const outcome = signal.aborted ? 'cancelled' : result.success ? 'completed' : 'failed';
      const readOnly = command.kind === 'skill' && this.skills.find(skill => skill.name === capability)?.readOnly === true;
      const released = readOnly || await this.release(AbortSignal.timeout(300));
      return this.receipt(command, outcome, released, result.result, undefined, outcome === 'failed' ? failureOf(result) : undefined);
    } finally { signal.removeEventListener('abort', cancelled); }
  }
  private receipt(command: Command, outcome: Receipt['outcome'], inputsReleased: boolean, result?: string, image?: Receipt['image'],
    failure?: Pick<Receipt, 'failureType' | 'recoverable'>): Receipt {
    const observedAt = new Date(this.now()).toISOString();
    return { id: command.id, connectionId: command.connectionId, outcome, inputsReleased, observedAt,
      ...(result ? { result: result.slice(0, 16_000) } : {}), ...(image ? { image } : {}), ...(failure ?? {}),
      ...(command.operation ? { action: { schemaVersion: 1, operationId: command.operation.operationId, bodyId: command.context.bodyId,
        sessionId: command.context.sessionId, generation: command.context.generation, outcome, inputsReleased, observedAt,
        evidenceId: command.id, observation: this.observe() } } : {}) };
  }
  async release(signal: AbortSignal): Promise<boolean> {
    cancelNonSurvivalActions(this.bot, 'common_fca_release');
    // Critical air reflex owns the same arbiter; never acknowledge stopped while it is moving. A safety reflex (the floor's
    // eat/armour/retreat, lava, breath) ends by itself within seconds: wait for it, bounded, instead of reporting the body held
    // (2026-10-14 review: an interrupted action came back inputsReleased=false and every later command was refused).
    // Only a caller still waiting gets the extension; one that has already given up is answered at once, as before.
    const extend = !signal.aborted, safetyUntil = Date.now() + SAFETY_RELEASE_WAIT_MS;
    let waited = false;
    while (physicalActionBusy(this.bot)) {
      if (signal.aborted) {
        if (!extend || !hasActiveSafetyLease(this.bot) || Date.now() >= safetyUntil) return false;
        waited = true;
      }
      await delay(10);
    }
    // The caller's time was spent waiting for the safety reflex: the cleanup that follows gets its own short bound.
    if (waited) signal = AbortSignal.timeout(300);
    try {
      if (signal.aborted) return false;
      let removeAbort = () => {};
      const interrupted = new Promise<false>(resolve => { const abort = () => resolve(false);
        signal.addEventListener('abort', abort, { once: true }); removeAbort = () => signal.removeEventListener('abort', abort); });
      try {
        const stopped = await Promise.race([Promise.resolve(this.bot.collectBlock?.cancelTask?.()).then(() => true), interrupted]);
        if (!stopped || signal.aborted) return false;
      } finally { removeAbort(); }
      if (physicalActionBusy(this.bot)) return false; // A critical safety owner may start while plugin cleanup awaited.
      this.bot.pathfinder?.stop(); this.bot.pathfinder?.setGoal(null);
      this.bot.stopDigging?.(); this.bot.deactivateItem?.(); this.bot.clearControlStates();
      return !physicalActionBusy(this.bot) && !Object.values(this.bot.controlState ?? {}).some(Boolean);
    } catch { return false; }
  }
  closeEvidence(context: Command['context']): void { this.goalEvidence.cancel(context); }
  async dispose(): Promise<void> {
    this.goalEvidence.dispose();
    this.bot.removeListener('end', this.onEnd); this.bot.removeListener('minebotActionProgress', this.onProgress);
    await this.options.disposeCapture?.();
  }
}
