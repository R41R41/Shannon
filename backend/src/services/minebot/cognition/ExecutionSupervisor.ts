import type { ActionProgress } from '../execution/actionTypes.js';
import { cancelAction } from '../execution/ActionExecution.js';
import { captureWorldObservation } from './worldFrame.js';
import { TaskWorkspace } from './TaskWorkspace.js';
import { formatCriticFeedback } from './JevExecutionCritic.js';
import type { CognitiveRuntimeMode, CriticAssessment, ExecutionCritic, WorldObservation } from './types.js';

const budgets = new WeakMap<TaskWorkspace, { ordinaryAt: number; criticalAt: number }>();
const CRITICAL_EVENTS = ['health', 'entityMoved', 'entitySpawn', 'entityGone', 'entityEffect', 'entityEffectEnd', 'breath'];
export interface SupervisorBot {
  on(event: string, listener: (...args: any[]) => void): unknown;
  removeListener(event: string, listener: (...args: any[]) => void): unknown;
  emit(event: string, ...args: any[]): unknown;
}

/** Event-driven, one request in flight. The model judges; timers only sample. */
export class ExecutionSupervisor {
  private current: ActionProgress | null = null;
  private pending: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private debounce: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private queuedCritical = false;
  private detectedAt = 0;
  private readonly budget: { ordinaryAt: number; criticalAt: number };
  private lastWorld: WorldObservation | null = null;
  private readonly feedback: string[] = [];
  readonly assessments: Array<{ assessment: CriticAssessment; actionId: string; applied: boolean; rejected: string | null }> = [];

  constructor(private readonly options: {
    bot: SupervisorBot;
    workspace: TaskWorkspace;
    critic?: ExecutionCritic;
    mode: CognitiveRuntimeMode;
    sampleMs?: number;
    minimumRequestMs?: number;
    onAssessment?: (result: { assessment: CriticAssessment; actionId: string; applied: boolean; rejected: string | null }) => void;
  }) {
    this.budget = budgets.get(options.workspace) ?? { ordinaryAt: -Infinity, criticalAt: -Infinity };
    budgets.set(options.workspace, this.budget);
  }
  private onCriticalEvent = () => this.sample();

  private onProgress = (progress: ActionProgress) => {
    if (!progress.physical || this.closed) return;
    if (this.current && progress.generation < this.current.generation) return;
    if (!this.current) this.lastWorld = captureWorldObservation(this.options.bot);
    this.current = structuredClone(progress);
    this.options.workspace.recordActionProgress(progress);
    if (progress.status === 'blocked') this.sample();
  };
  start(): void {
    if (this.timer || this.closed) return;
    this.options.bot.on('minebotActionProgress', this.onProgress);
    for (const event of CRITICAL_EVENTS) this.options.bot.on(event, this.onCriticalEvent);
    this.timer = setInterval(() => this.sample(), this.options.sampleMs ?? 500);
  }
  private criticalFacts(world: WorldObservation): string {
    return JSON.stringify([world.dimension, world.health, world.food, world.oxygen, world.isInWater,
      (world.nearbyThreats ?? world.nearbyEntities.filter(e => e.kind === 'hostile')).map(e => [e.name, Math.floor(e.distance)]), world.activeEffects]);
  }
  sample(): void {
    const { bot, workspace, critic, mode } = this.options;
    const action = this.current;
    if (this.closed || !critic || mode === 'off' || !action
      || !['running', 'waiting_external', 'blocked'].includes(action.status)) return;
    const now = Date.now();
    const world = captureWorldObservation(bot);
    const changed = this.lastWorld && this.criticalFacts(world) !== this.criticalFacts(this.lastWorld);
    if (changed && !this.queuedCritical) this.detectedAt = now;
    if (this.pending) { this.queuedCritical ||= Boolean(changed); return; }
    const critical = Boolean(changed || this.queuedCritical);
    if (critical && now - this.budget.criticalAt < 100) {
      this.queuedCritical = true;
      if (!this.debounce) this.debounce = setTimeout(() => { this.debounce = undefined; this.sample(); }, 100 - (now - this.budget.criticalAt));
      return;
    }
    if (!critical && now - this.budget.ordinaryAt < (this.options.minimumRequestMs ?? 4000)) return;
    if (!changed && action.status !== 'blocked' && action.phase !== 'wait_external'
      && now - action.lastProgressAt < 2500) return;
    this.queuedCritical = false;
    if (critical) this.budget.criticalAt = now;
    else this.budget.ordinaryAt = now;
    this.lastWorld = world;
    workspace.observeWorld(world);
    const input = workspace.criticInput();
    const evaluatedAction = structuredClone(action);
    const criticalFacts = this.criticalFacts(world);
    const detectedAt = critical ? this.detectedAt : now;
    this.pending = critic.assess(input).then(raw => {
      const assessment = workspace.recordAssessment(raw);
      const current = this.current;
      let rejected: string | null = null;
      if (this.closed || current?.actionId !== evaluatedAction.actionId
        || !['running', 'waiting_external', 'blocked'].includes(current.status)) rejected = 'action_replaced_or_settled';
      else if (assessment.stale) rejected = 'world_revision_changed';
      else if (this.criticalFacts(captureWorldObservation(bot)) !== criticalFacts) {
        rejected = 'critical_facts_changed'; this.queuedCritical = true; this.detectedAt = Date.now();
      }
      else if (Date.now() - now > 3000) rejected = 'decision_expired';
      else if (current.lastProgressAt > evaluatedAction.lastProgressAt && !['CONTINUE', 'ABORT_UNSAFE'].includes(assessment.nextControl)) rejected = 'progress_resumed';
      else if (assessment.source === 'fallback' || !Number.isFinite(assessment.confidence) || assessment.confidence < 0.66) rejected = 'non_controlling_or_low_confidence';
      const text = rejected ? null : formatCriticFeedback(assessment);
      let applied = false;
      if (mode === 'feedback' && text) {
        this.feedback.push(text);
        // Bounded fast controls only. No replay of an irreversible skill and
        // no generated commands/arguments. System 2 selects the replacement.
        if (['ABORT_UNSAFE', 'REPLAN', 'SWITCH_SUBTASK'].includes(assessment.nextControl)) {
          applied = cancelAction(bot, evaluatedAction.actionId, 'execution_critic');
        } else if (assessment.nextControl === 'OBSERVE') {
          workspace.observeWorld(captureWorldObservation(bot));
          applied = true;
        }
      }
      this.assessments.push({ assessment, actionId: evaluatedAction.actionId, applied, rejected });
      bot.emit('minebotSupervisorTiming', { actionId: evaluatedAction.actionId, detectedAt,
        requestedAt: now, receivedAt: Date.now(), appliedAt: applied ? Date.now() : null, rejected, source: assessment.source });
      this.options.onAssessment?.(this.assessments[this.assessments.length - 1]);
      this.assessments.splice(0, Math.max(0, this.assessments.length - 32));
    }).catch(() => { /* provider failure never controls the bot */ }).finally(() => {
      this.pending = null;
      if (!this.closed && this.queuedCritical) this.sample();
    });
  }
  takeFeedback(): string[] { return this.feedback.splice(0); }
  stop(): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
    this.timer = undefined;
    this.options.bot.removeListener('minebotActionProgress', this.onProgress);
    for (const event of CRITICAL_EVENTS) this.options.bot.removeListener(event, this.onCriticalEvent);
  }
  async drain(): Promise<void> { while (this.pending) await this.pending; }
}
