import { Vec3 } from 'vec3';
import { primitiveState, primitiveCandidates, executePrimitive } from './primitives.js';
import { captureWorldObservation } from '../../cognition/worldFrame.js';
import { activeActionCapabilities, cancelNonSurvivalActions, createMotorPort, executeAction,
  physicalActionBusy, withActionSignal } from '../../execution/ActionExecution.js';
import { bodySkillCatalog, type BodySkill } from './skillCatalog.js';
import type { BodyCandidateDraft, BodyObservation, BodyValue } from './bodyControlContract.js';
import type { MinecraftControlCommand as Command, MinecraftControlReceipt as Receipt } from './minecraftControlContract.js';
import type { CommonFcaActuator } from './controlLoop.js';

const delay = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));
export interface NativeBodyOptions {
  serverId: string; now?: () => number;
  capture(signal: AbortSignal): Promise<{ dataUrl: string; capturedAt: string }>;
  disposeCapture?(): Promise<void>;
}
/** One native bot, one ActionExecution resource arbiter, no game planner or model. */
export class NativeCommonFcaBody implements CommonFcaActuator {
  readonly skills;
  private readonly catalog;
  private sequence = 0;
  private connected = true;
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
    this.skills = this.catalog.definitions;
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
      stuck: !!moving && now - this.movedAt > 1500, visualRequired: false,
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
    signal.throwIfAborted();
    if (!this.connected || !this.bot.entity) throw Error('BODY_DISCONNECTED');
    if (command.kind === 'capture') {
      const image = await this.options.capture(signal); signal.throwIfAborted();
      return this.receipt(command, 'completed', true, undefined, image);
    }
    const milliseconds = Math.min(120_000, Date.parse(command.deadlineAt) - this.now());
    if (milliseconds <= 0) throw Error('BODY_DEADLINE');
    let capability: string, work: () => Promise<{ success: boolean; result: string; failureType?: string }>;
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
    return this.receipt(command, outcome, released, result.result);
  }
  private receipt(command: Command, outcome: Receipt['outcome'], inputsReleased: boolean, result?: string, image?: Receipt['image']): Receipt {
    const observedAt = new Date(this.now()).toISOString();
    return { id: command.id, connectionId: command.connectionId, outcome, inputsReleased, observedAt,
      ...(result ? { result: result.slice(0, 16_000) } : {}), ...(image ? { image } : {}),
      ...(command.operation ? { action: { schemaVersion: 1, operationId: command.operation.operationId, bodyId: command.context.bodyId,
        sessionId: command.context.sessionId, generation: command.context.generation, outcome, inputsReleased, observedAt,
        evidenceId: command.id, observation: this.observe() } } : {}) };
  }
  async release(signal: AbortSignal): Promise<boolean> {
    cancelNonSurvivalActions(this.bot, 'common_fca_release');
    // Critical air reflex owns the same arbiter; never acknowledge stopped while it is moving.
    while (physicalActionBusy(this.bot)) { if (signal.aborted) return false; await delay(10); }
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
  async dispose(): Promise<void> {
    this.bot.removeListener('end', this.onEnd); this.bot.removeListener('minebotActionProgress', this.onProgress);
    await this.options.disposeCapture?.();
  }
}
