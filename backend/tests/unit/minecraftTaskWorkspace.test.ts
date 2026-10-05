import { describe, expect, it } from 'vitest';
import { TaskWorkspace } from '../../src/services/minebot/cognition/TaskWorkspace.js';
import { diffWorldFrames } from '../../src/services/minebot/cognition/worldFrame.js';
import type {
  ActionReceipt,
  CriticAssessment,
  WorldObservation,
} from '../../src/services/minebot/cognition/types.js';

const observation = (overrides: Partial<WorldObservation> = {}): WorldObservation => ({
  observedAt: '2026-09-27T00:00:00.000Z',
  dimension: 'minecraft:overworld',
  position: { x: 0, y: 64, z: 0 },
  health: 20,
  food: 20,
  oxygen: 300,
  isInWater: false,
  weather: 'clear',
  time: 'day',
  biome: 'plains',
  heldItem: 'stone_pickaxe',
  inventory: [{ name: 'cobblestone', count: 2 }],
  activeEffects: [],
  nearbyEntities: [],
  ...overrides,
});

describe('TaskWorkspace', () => {
  it('rejects out-of-order progress but accepts a new bot execution session', () => {
    const workspace = new TaskWorkspace({ runId: 'run-a', goal: 'goal' });
    const progress = { actionId: 'action-1', executionSessionId: 'session-1', generation: 5, sequence: 2,
      capability: 'mine-block', physical: true, phase: 'dig' as const, status: 'running' as const,
      startedAt: 1, updatedAt: 2, lastProgressAt: 2, elapsedMs: 1, evidence: {} };
    workspace.recordActionProgress(progress);
    workspace.recordActionProgress({ ...progress, sequence: 1, phase: 'search' });
    expect(workspace.criticInput().activeAction?.phase).toBe('dig');
    workspace.recordActionProgress({ ...progress, actionId: 'action-2', executionSessionId: 'session-2', generation: 1 });
    expect(workspace.criticInput().activeAction?.actionId).toBe('action-2');
  });
  it('keeps an isolated append-only world/action projection for one run', () => {
    const workspace = new TaskWorkspace({ runId: 'run-a', goal: 'collect stone' });
    const before = workspace.observeWorld(observation());
    const after = workspace.observeWorld(observation({
      position: { x: 2, y: 64, z: 0 },
      inventory: [{ name: 'cobblestone', count: 3 }],
    }));
    const receipt: ActionReceipt = {
      id: 'receipt-1',
      runId: 'run-a',
      iteration: 1,
      actionKind: 'instant_skill',
      capability: 'mine-block',
      args: { block: 'stone' },
      intendedEffect: 'mine stone',
      startedAt: before.observedAt,
      finishedAt: after.observedAt,
      durationMs: 100,
      beforeRevision: before.revision,
      afterRevision: after.revision,
      success: true,
      failureType: null,
      recoverable: null,
      resultSummary: 'ok',
      observedDelta: diffWorldFrames(before, after),
      meaningfulWorldAction: true,
    };
    workspace.recordReceipt(receipt);

    const snapshot = workspace.snapshot();
    expect(snapshot.runId).toBe('run-a');
    expect(snapshot.worldRevision).toBe(2);
    expect(snapshot.receipts).toHaveLength(1);
    expect(snapshot.receipts[0].observedDelta.inventoryDelta).toEqual([
      { name: 'cobblestone', count: 1 },
    ]);
    expect(snapshot.events.map(event => event.type)).toEqual([
      'workspace_created', 'world_observed', 'world_observed', 'action_finished',
    ]);

    // Snapshots are copies, not a mutable back door into the workspace.
    snapshot.receipts.length = 0;
    expect(workspace.snapshot().receipts).toHaveLength(1);
  });

  it('marks a critic result stale when the world advanced during assessment', () => {
    const workspace = new TaskWorkspace({ runId: 'run-a', goal: 'survive' });
    workspace.observeWorld(observation());
    const evaluatedRevision = workspace.criticInput().evaluatedRevision;
    workspace.observeWorld(observation({ health: 10 }));
    const assessment: CriticAssessment = {
      id: 'assessment-1',
      runId: 'run-a',
      evaluatedRevision,
      receivedAt: '2026-09-27T00:00:01.000Z',
      elapsedMilliseconds: 100,
      source: 'jev',
      stale: false,
      progressState: 'REGRESSING',
      continueProbability: 0.1,
      needsObservationProbability: 0.9,
      needsReplanProbability: 0.8,
      failureCause: 'UNSAFE',
      nextControl: 'ABORT_UNSAFE',
      confidence: 0.9,
    };

    expect(workspace.recordAssessment(assessment).stale).toBe(true);
    expect(workspace.snapshot().assessments[0].stale).toBe(true);
  });

  it('rejects data from another run', () => {
    const workspace = new TaskWorkspace({ runId: 'run-a', goal: 'goal' });
    const before = workspace.observeWorld(observation());
    const after = workspace.observeWorld(observation());
    expect(() => workspace.recordReceipt({
      id: 'wrong-run', runId: 'run-b', iteration: 1, actionKind: 'instant_skill',
      capability: 'move-to', args: {}, intendedEffect: 'move',
      startedAt: before.observedAt, finishedAt: after.observedAt, durationMs: 1,
      beforeRevision: before.revision, afterRevision: after.revision,
      success: true, failureType: null, recoverable: null, resultSummary: 'ok',
      observedDelta: diffWorldFrames(before, after), meaningfulWorldAction: true,
    })).toThrow('TASK_WORKSPACE_RUN_MISMATCH');
  });
});
