/** Fix acceptance: previously characterized unsafe behavior must not return.
 * No game server, provider credential, database or full Shannon runtime is used.
 */
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureWorldObservation } from '../../src/services/minebot/cognition/worldFrame.js';
import { TaskWorkspace } from '../../src/services/minebot/cognition/TaskWorkspace.js';
import { ExecutionSupervisor } from '../../src/services/minebot/cognition/ExecutionSupervisor.js';
import { JevExecutionCritic, formatCriticFeedback } from '../../src/services/minebot/cognition/JevExecutionCritic.js';
import { JevReflexPolicy } from '../../src/services/minebot/cognition/JevReflexPolicy.js';
import { executeAction, createMotorPort } from '../../src/services/minebot/execution/ActionExecution.js';
import { actionDelay } from '../../src/services/minebot/execution/observedWait.js';

const fakes = vi.hoisted(() => ({ stream: vi.fn() }));
vi.mock('@anthropic-ai/sdk', () => ({ default: class {
  messages = { stream: fakes.stream, create: vi.fn() };
} }));
vi.mock('../../src/config/env.js', () => ({ config: { anthropic: { apiKey: 'test-only', model: 'test-model' } } }));
vi.mock('../../src/services/minebot/config/MinebotConfig.js', () => ({ CONFIG: { UI_MOD_BASE_URL: 'http://example.invalid' } }));
import { ShannonExecutor } from '../../src/services/llm/graph/ShannonExecutor.js';
import AutoEat from '../../src/services/minebot/constantSkills/autoEat.js';
import { CombatController } from '../../src/services/minebot/combat/CombatController.js';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); fakes.stream.mockReset(); });
function botFixture(): any {
  return Object.assign(new EventEmitter(), {
    entity: { position: { x: 0, y: 64, z: 0 } }, entities: {}, health: 20, food: 20,
    inventory: { items: () => [] }, activeFurnaces: [], game: { dimension: 'overworld' },
    executingSkill: false, interruptExecution: false,
    pathfinder: { stop: vi.fn(), setGoal: vi.fn(), isMoving: () => false },
    clearControlStates: vi.fn(), constantSkills: { getSkills: () => [] },
  });
}
function assessment(input: any, overrides = {}): any {
  return { id: 'audit', runId: input.runId, evaluatedRevision: input.evaluatedRevision,
    receivedAt: new Date().toISOString(), elapsedMilliseconds: 0, source: 'jev', stale: false,
    progressState: 'ON_TRACK', continueProbability: 0.9, needsObservationProbability: 0,
    needsReplanProbability: 0, failureCause: 'NONE', nextControl: 'CONTINUE', confidence: 0.9, ...overrides };
}
function activeProgress(): any {
  return { actionId: 'audit-action', executionSessionId: 'audit-session', generation: 1,
    sequence: 1, capability: 'withdraw-from-furnace', physical: true,
    phase: 'wait_external', status: 'waiting_external', startedAt: Date.now(),
    updatedAt: Date.now(), lastProgressAt: Date.now(), elapsedMs: 0, evidence: { kind: 'smelting' } };
}

describe('architecture root-cause fix acceptance', () => {
  it('captures native water/effects/weather/time and only open-window player inventory', () => {
    const bot = botFixture();
    bot.entity.isInWater = true;
    bot.entity.effects = { 19: { id: 19, amplifier: 1, duration: 200 } };
    bot.time = { timeOfDay: 18000 }; bot.isRaining = true;
    bot.inventory.items = () => [{ name: 'raw_iron', count: 3 }];
    bot.currentWindow = { inventoryStart: 3, inventoryEnd: 5,
      slots: [null, null, { name: 'iron_ingot', count: 2 }, { name: 'coal', count: 1 }, null] };
    const observed = captureWorldObservation(bot);
    expect(observed).toMatchObject({ isInWater: true, activeEffects: [{ name: 'effect_19', amplifier: 1 }], time: '18000', weather: 'rain',
      inventory: [{ name: 'coal', count: 1 }] });
  });

  it('keeps hostile observations visible outside the nearest-16 general crowd', () => {
    const bot = botFixture();
    for (let i = 1; i <= 16; i++) bot.entities[i] = { name: 'item', type: 'other', position: { x: i / 20, y: 64, z: 0 } };
    bot.entities[17] = { name: 'zombie', type: 'hostile', position: { x: 2, y: 64, z: 0 } };
    expect(captureWorldObservation(bot).nearbyEntities).toHaveLength(16);
    expect(captureWorldObservation(bot).nearbyThreats).toMatchObject([{ name: 'zombie' }]);
  });

  it('same world content retains its revision and accepts a fresh result', () => {
    const workspace = new TaskWorkspace({ runId: 'audit', goal: 'test' });
    const observation = captureWorldObservation(botFixture());
    workspace.observeWorld(observation); const input = workspace.criticInput();
    workspace.observeWorld(observation);
    expect(workspace.recordAssessment(assessment(input)).stale).toBe(false);
  });

  it('critical HP loss bypasses the ordinary four-second assessment cooldown', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-29T00:00:00Z'));
    const bot = botFixture(); const workspace = new TaskWorkspace({ runId: 'audit', goal: 'test' });
    const calls: number[] = [];
    const critic: any = { assess: async (input: any) => { calls.push(Date.now()); return assessment(input); } };
    const supervisor = new ExecutionSupervisor({ bot, workspace, critic, mode: 'shadow' });
    supervisor.start();
    try {
      bot.emit('minebotActionProgress', activeProgress()); supervisor.sample(); await supervisor.drain();
      await vi.advanceTimersByTimeAsync(100); bot.health = 2;
      supervisor.sample(); await supervisor.drain(); expect(calls).toHaveLength(2);
      expect(calls[1] - calls[0]).toBe(100);
    } finally { supervisor.stop(); }
  });

  it('rejects old in-flight evidence, queues fresh evaluation, and keeps request timing immutable', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-29T00:00:00Z'));
    const bot = botFixture(); const workspace = new TaskWorkspace({ runId: 'audit', goal: 'test' });
    const timings: any[] = []; bot.on('minebotSupervisorTiming', timing => timings.push(timing));
    let resolve: (value: any) => void = () => {}; let captured: any;
    const critic: any = { assess: vi.fn((input: any) => { if (captured) return Promise.resolve(assessment(input)); captured = input; return new Promise(r => { resolve = r; }); }) };
    const supervisor = new ExecutionSupervisor({ bot, workspace, critic, mode: 'shadow' });
    supervisor.start();
    try {
      bot.emit('minebotActionProgress', activeProgress()); supervisor.sample();
      await vi.advanceTimersByTimeAsync(10); bot.health = 2; supervisor.sample();
      await vi.advanceTimersByTimeAsync(10); resolve(assessment(captured)); await supervisor.drain();
      expect(supervisor.assessments[0].rejected).toBe('critical_facts_changed');
      expect(critic.assess).toHaveBeenCalledTimes(2);
      expect(timings).toHaveLength(2);
      for (const timing of timings) { expect(timing.detectedAt).toBeLessThanOrEqual(timing.requestedAt); expect(timing.requestedAt).toBeLessThanOrEqual(timing.receivedAt); }
    } finally { supervisor.stop(); }
  });

  it('does not control from weak actual choice evidence even with a MEDIUM label', async () => {
    const critic = new JevExecutionCritic({ apiKey: 'mock', fetcher: vi.fn(async () => ({ ok: true,
      json: async () => ({ answers: { progress_state: { choice: 'ON_TRACK' }, continue_now: { noul: 0.99 },
        needs_observation: { noul: 0.01 }, needs_replan: { noul: 0.01 },
        failure_cause: { choice: 'WRONG_ASSUMPTION' }, next_control: { choice: 'SWITCH_SUBTASK', confidence: 0.02,
          probabilities: { CONTINUE: 0.2, OBSERVE: 0.19, RETRY_ONCE: 0.19, SWITCH_SUBTASK: 0.21, REPLAN: 0.11, ABORT_UNSAFE: 0.1 } },
        confidence: { choice: 'MEDIUM' } } }) } as Response)) });
    const workspace = new TaskWorkspace({ runId: 'audit', goal: 'normal smelting' });
    const result = await critic.assess(workspace.criticInput());
    expect(result.confidence).toBe(0.02);
    expect(result.confidenceKind).toBe('provider_distribution');
    expect(formatCriticFeedback(result)).toBeNull();
  });

  it.each(['SURFACE', 'SEEK_SHELTER'])('delegates unavailable %s instead of inventing a capability', async immediateAction => {
    const policy = new JevReflexPolicy({ apiKey: 'mock', fetcher: (async () => ({ ok: true,
      json: async () => ({ answers: { should_preempt: { noul: 0.9 }, immediate_action: { choice: immediateAction, confidence: 0.9,
        probabilities: Object.fromEntries(['FLEE', 'EAT', 'SURFACE', 'STOP_MOVEMENT', 'SEEK_SHELTER', 'OBSERVE', 'DELEGATE_SYSTEM2'].map(action => [action, action === immediateAction ? 1 : 0])) },
        urgency: { choice: 'CRITICAL' }, confidence: { choice: 'HIGH' } } }) } as Response)) as typeof fetch });
    const result = await policy.decide({ event: { eventType: 'suffocation' }, world: captureWorldObservation(botFixture()),
      currentTaskActive: true, availableCapabilities: [] });
    expect(result.immediateAction).toBe('DELEGATE_SYSTEM2'); expect(result.capabilityAvailable).toBe(false);
  });

  it('actual AutoEat consumes only after the hazardous mining owner is cancelled', async () => {
    const bot = botFixture(); bot.health = 6; bot.food = 6;
    bot.inventory.items = () => [{ name: 'bread', count: 1 }];
    bot.equip = vi.fn(async () => {}); bot.consume = vi.fn(async () => { bot.food = 11; });
    let entered: () => void = () => {}; let release: () => void = () => {};
    const enteredPromise = new Promise<void>(r => { entered = r; });
    const mining = executeAction(bot, 'mine-block', 1000, async () => { entered(); await actionDelay(bot, 800); return { success: true, result: 'done' }; });
    await enteredPromise;
    try {
      await new AutoEat(bot).run();
      expect(bot.executingSkill).toBe(false); expect((await mining).success).toBe(false);
      expect(bot.equip).toHaveBeenCalledWith({ name: 'bread', count: 1 }, 'hand');
      expect(bot.consume).toHaveBeenCalledOnce();
    } finally { release(); await mining; }
  });

  it('combat action timeout fences delayed writes after combat ends', async () => {
    vi.useFakeTimers();
    const bot = botFixture(); const writes: string[] = [];
    bot.setControlState = vi.fn(() => writes.push('motor write'));
    const port = createMotorPort(bot);
    const controller: any = new CombatController(bot, { maxDurationMs: 10000, tickIntervalMs: 500 });
    let scans = 0;
    controller.scanner = { scan: () => ({ hostiles: scans++ === 0 ? [{}] : [], hp: 20,
      armorPoints: 0, totalThreat: 1, attackCooldownReady: true, isBlocking: false }) };
    controller.scorer = { score: () => [{ type: 'tower', score: 1 }] };
    controller.executor = { cleanup: vi.fn(), execute: async () => {
      await new Promise(r => setTimeout(r, 4500)); port.setControlState('forward', true); return { attacked: false };
    } };
    const result = controller.engage();
    await vi.advanceTimersByTimeAsync(4000);
    expect((await result).success).toBe(false); expect(controller.isRunning).toBe(false); expect(writes).toEqual([]);
    await vi.advanceTimersByTimeAsync(500); expect(writes).toEqual([]);
  });

  it('native executor rejects completion without inventory proof and preserves pending nodes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
    fakes.stream.mockReturnValue({ finalMessage: async () => ({ content: [
      { type: 'tool_use', id: 'done', name: 'task-complete', input: { summary: '鉄つるはし完成' } },
    ], usage: {} }) });
    const bot = botFixture();
    const result = await new ShannonExecutor({ bot, instantSkills: { getSkill: () => undefined } as any }).run({
      runId: 'audit', goal: '鉄つるはしを作る', context: null, systemPrompt: 'audit', tools: [],
      previousTaskNodes: [{ id: 'iron', goal: '鉄を集める', status: 'pending', children: [] }],
      goalContract: { goal: '鉄つるはしを作る', predicates: [{ kind: 'inventory', item: 'iron_pickaxe', count: 1 }] },
    });
    expect(result.taskTree?.status).not.toBe('completed'); expect(result.taskNodes?.[0].status).toBe('pending');
    expect(result.cognitiveWorkspace.goalProof?.status).toBe('mismatch');
    expect(bot.inventory.items()).toEqual([]);
    // Repeated unsupported completion requests must never fabricate success.
    expect(fakes.stream).toHaveBeenCalledTimes(30); expect(result.iterations).toBe(30);
  });

  it('native executor skips sibling tools after verified completion in the same model batch', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
    fakes.stream.mockReturnValue({ finalMessage: async () => ({ content: [
      { type: 'tool_use', id: 'done', name: 'task-complete', input: { summary: '完了' } },
      { type: 'tool_use', id: 'place', name: 'place-block-at', input: {} },
    ], usage: {} }) });
    const place = { params: [], run: vi.fn(async () => ({ success: true, result: 'placed' })) };
    const bot = botFixture(); bot.blockAt = () => ({ name: 'chest' });
    const result = await new ShannonExecutor({ bot, instantSkills: { getSkill: () => place } as any }).run({
      runId: 'audit', goal: 'チェストを置く', context: null, systemPrompt: 'audit', tools: [],
      goalContract: { goal: 'チェストを置く', predicates: [{ kind: 'block', dimension: 'overworld', position: { x: 1, y: 64, z: 0 }, block: 'chest' }] },
    });
    expect(result.taskTree?.status).toBe('completed'); expect(place.run).not.toHaveBeenCalled();
    expect(result.iterations).toBe(1);
  });

  it('task-tree rejects duplicate IDs and unknown parents without partial edits or false completion', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
    fakes.stream.mockReturnValue({ finalMessage: async () => ({ content: [
      { type: 'tool_use', id: 'tree', name: 'manage-task-tree', input: { operations: [
        { action: 'create', id: 'iron', goal: 'collect iron' },
        { action: 'create', id: 'iron', goal: 'smelt iron', parentId: 'missing' },
        { action: 'update', id: 'iron', status: 'completed' },
      ] } },
      { type: 'tool_use', id: 'done', name: 'task-complete', input: { summary: 'done' } },
    ], usage: {} }) });
    const result = await new ShannonExecutor({ bot: botFixture(), instantSkills: { getSkill: () => undefined } as any }).run({
      runId: 'audit', goal: '鉄つるはしを作る', context: null, systemPrompt: 'audit', tools: [],
    });
    expect(result.taskNodes).toBeUndefined();
    expect(result.taskTree?.status).not.toBe('completed');
    expect(result.cognitiveWorkspace.receipts.some(r => r.meaningfulWorldAction)).toBe(false);
  });
});
