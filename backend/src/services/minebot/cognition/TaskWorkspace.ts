import type {
  ActionReceipt,
  CriticAssessment,
  CriticInput,
  GoalNodeProjection,
  ReflexDecision,
  TaskWorkspaceEvent,
  TaskWorkspaceEventType,
  TaskWorkspaceSnapshot,
  WorldFrame,
  WorldObservation,
} from './types.js';
import type { ActionProgress } from '../execution/actionTypes.js';
import { worldContentDigest } from './worldFrame.js';
import { receiptOutcome } from './decisionEvidence.js';

const MAX_EVENTS = 256;
const MAX_RECEIPTS = 64;
const MAX_ASSESSMENTS = 32;
const MAX_REFLEX_DECISIONS = 16;

function clone<T>(value: T): T {
  return structuredClone(value);
}

export interface TaskWorkspaceOptions {
  runId: string;
  goal: string;
  initialSnapshot?: TaskWorkspaceSnapshot;
  now?: () => Date;
}

/**
 * Run-scoped, append-only cognitive state.
 *
 * It is intentionally not a singleton: two bots/worlds can never observe each
 * other's task state. The bounded projection is safe to persist for continuation.
 */
export class TaskWorkspace {
  private readonly now: () => Date;
  private snapshotState: TaskWorkspaceSnapshot;

  constructor(options: TaskWorkspaceOptions) {
    this.now = options.now ?? (() => new Date());
    if (options.initialSnapshot) {
      if (options.initialSnapshot.schemaVersion !== 1) {
        throw new Error('TASK_WORKSPACE_SCHEMA_UNSUPPORTED');
      }
      this.snapshotState = clone(options.initialSnapshot);
      this.snapshotState.reflexDecisions ??= [];
      return;
    }

    const createdAt = this.now().toISOString();
    this.snapshotState = {
      schemaVersion: 1,
      runId: options.runId,
      goal: options.goal,
      createdAt,
      updatedAt: createdAt,
      nextSequence: 1,
      worldRevision: 0,
      currentWorld: null,
      previousWorld: null,
      plan: [],
      receipts: [],
      assessments: [],
      reflexDecisions: [],
      events: [],
    };
    this.append('workspace_created', { goal: options.goal });
  }

  get runId(): string {
    return this.snapshotState.runId;
  }

  get worldRevision(): number {
    return this.snapshotState.worldRevision;
  }

  observeWorld(observation: WorldObservation): WorldFrame {
    const changed = !this.snapshotState.currentWorld || worldContentDigest(observation) !== worldContentDigest(this.snapshotState.currentWorld);
    const revision = this.snapshotState.worldRevision + (changed ? 1 : 0);
    const frame: WorldFrame = {
      ...clone(observation),
      runId: this.runId,
      revision,
    };
    if (changed) this.snapshotState.previousWorld = this.snapshotState.currentWorld;
    this.snapshotState.currentWorld = frame;
    this.snapshotState.worldRevision = revision;
    this.append('world_observed', { revision });
    return clone(frame);
  }

  projectPlan(plan: GoalNodeProjection[]): void {
    const versions = this.snapshotState.planRevisions ?? [];
    if (JSON.stringify(plan) !== JSON.stringify(this.snapshotState.plan)) {
      versions.push({ revision: (versions.at(-1)?.revision ?? 0) + 1, recordedAt: this.now().toISOString(), plan: clone(plan) });
      this.snapshotState.planRevisions = versions.slice(-16);
    }
    this.snapshotState.plan = clone(plan);
    this.append('plan_projected', { nodeCount: countPlanNodes(plan) });
  }

  recordReceipt(receipt: ActionReceipt): void {
    this.assertRun(receipt.runId);
    this.snapshotState.receipts.push(clone({ ...receipt, outcome: receiptOutcome(receipt) as ActionReceipt['outcome'] }));
    this.snapshotState.receipts = this.snapshotState.receipts.slice(-MAX_RECEIPTS);
    this.append('action_finished', {
      receiptId: receipt.id,
      capability: receipt.capability,
      success: receipt.success,
      beforeRevision: receipt.beforeRevision,
      afterRevision: receipt.afterRevision,
    });
  }

  recordActionProgress(progress: ActionProgress): void {
    const active = this.snapshotState.activeAction;
    if (active && progress.executionSessionId === active.executionSessionId && progress.generation < active.generation) return;
    if (active?.actionId === progress.actionId && progress.sequence <= active.sequence) return;
    this.snapshotState.activeAction = clone(progress);
    this.append('action_progress', { actionId: progress.actionId, generation: progress.generation,
      phase: progress.phase, status: progress.status, evidence: progress.evidence });
  }

  recordAssessment(assessment: CriticAssessment): CriticAssessment {
    this.assertRun(assessment.runId);
    const stored = {
      ...clone(assessment),
      stale: assessment.stale || assessment.evaluatedRevision !== this.snapshotState.worldRevision,
    };
    this.snapshotState.assessments.push(stored);
    this.snapshotState.assessments = this.snapshotState.assessments.slice(-MAX_ASSESSMENTS);
    this.append('critic_assessed', {
      assessmentId: stored.id,
      source: stored.source,
      nextControl: stored.nextControl,
      progressState: stored.progressState,
      stale: stored.stale,
    });
    return clone(stored);
  }

  recordReflexDecision(decision: ReflexDecision): void {
    this.snapshotState.reflexDecisions.push(clone(decision));
    this.snapshotState.reflexDecisions = this.snapshotState.reflexDecisions.slice(-MAX_REFLEX_DECISIONS);
    this.append('reflex_assessed', {
      decisionId: decision.id,
      eventType: decision.eventType,
      source: decision.source,
      immediateAction: decision.immediateAction,
      capabilityAvailable: decision.capabilityAvailable,
    });
  }

  criticInput(): CriticInput {
    const lastAssessment = this.snapshotState.assessments.at(-1) ?? null;
    return clone({
      runId: this.runId,
      goal: this.snapshotState.goal,
      evaluatedRevision: this.snapshotState.worldRevision,
      currentWorld: this.snapshotState.currentWorld,
      previousWorld: this.snapshotState.previousWorld,
      plan: this.snapshotState.plan,
      recentReceipts: this.snapshotState.receipts.slice(-8),
      previousAssessment: lastAssessment,
      activeAction: this.snapshotState.activeAction ?? null,
    });
  }

  snapshot(): TaskWorkspaceSnapshot {
    return clone(this.snapshotState);
  }

  recordGoal(contract: import('./GoalVerifier.js').GoalContract, baseline: WorldObservation): void {
    this.snapshotState.goalContract = clone(contract);
    this.snapshotState.goalBaseline ??= clone(baseline);
  }
  recordGoalProof(proof: import('./GoalVerifier.js').GoalProof): void { this.snapshotState.goalProof = clone(proof); }
  setActiveSubtask(id: string | undefined): void { this.snapshotState.activeSubtaskId = id; }
  recordUsedTaskNodeIds(ids: string[]): void { this.snapshotState.usedTaskNodeIds = [...ids]; }

  private assertRun(runId: string): void {
    if (runId !== this.runId) throw new Error('TASK_WORKSPACE_RUN_MISMATCH');
  }

  private append(type: TaskWorkspaceEventType, payload: Record<string, unknown>): void {
    const occurredAt = this.now().toISOString();
    const event: TaskWorkspaceEvent = {
      sequence: this.snapshotState.nextSequence,
      runId: this.runId,
      type,
      occurredAt,
      worldRevision: this.snapshotState.worldRevision,
      payload: clone(payload),
    };
    this.snapshotState.nextSequence += 1;
    this.snapshotState.updatedAt = occurredAt;
    this.snapshotState.events.push(event);
    this.snapshotState.events = this.snapshotState.events.slice(-MAX_EVENTS);
  }
}

function countPlanNodes(nodes: GoalNodeProjection[]): number {
  return nodes.reduce((count, node) => count + 1 + countPlanNodes(node.children ?? []), 0);
}
