import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeAction, reportActionProgress } from '../../src/services/minebot/execution/ActionExecution.js';
import { actionDelay } from '../../src/services/minebot/execution/observedWait.js';

const fakes = vi.hoisted(() => ({ stream: vi.fn() }));
vi.mock('@anthropic-ai/sdk', () => ({ default: class {
  messages = { stream: fakes.stream, create: vi.fn() };
} }));
vi.mock('../../src/config/env.js', () => ({ config: { anthropic: { apiKey: 'test-only', model: 'test-model' } } }));
vi.mock('../../src/services/minebot/config/MinebotConfig.js', () => ({ CONFIG: { UI_MOD_BASE_URL: 'http://example.invalid' } }));
import { ShannonExecutor } from '../../src/services/llm/graph/ShannonExecutor.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); fakes.stream.mockReset(); });

describe('native executor supervision wiring', () => {
  it('preserves tool-result protocol order and invalidates the rest of an outdated action batch', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
    const calls: any[] = [];
    let turn = 0;
    fakes.stream.mockImplementation((request: any) => {
      calls.push(structuredClone(request));
      const content = turn++ === 0 ? [
        { type: 'tool_use', id: 'mine-1', name: 'mine-block', input: {} },
        { type: 'tool_use', id: 'place-1', name: 'place-block-at', input: {} },
        { type: 'tool_use', id: 'done-old', name: 'task-complete', input: { summary: 'old plan' } },
      ] : [{ type: 'tool_use', id: 'done-new', name: 'task-complete', input: { summary: 'new plan' } }];
      return { finalMessage: async () => ({ content, usage: {} }) };
    });
    const bot: any = Object.assign(new EventEmitter(), { executingSkill: false, interruptExecution: false,
      health: 20, food: 20, activeFurnaces: [], entities: {}, inventory: { items: () => [] },
      entity: { position: { x: 0, y: 64, z: 0 } }, game: { dimension: 'overworld' },
      pathfinder: { stop: vi.fn(), setGoal: vi.fn() }, clearControlStates: vi.fn() });
    const place = { params: [], run: vi.fn(async () => ({ success: true, result: 'placed' })) };
    const mine = { params: [], run: () => executeAction(bot, 'mine-block', 1000, async () => {
      reportActionProgress(bot, 'recovery', { reason: 'no_path' }, false, 'blocked');
      await actionDelay(bot, 800); return { success: true, result: 'mined' };
    }) };
    const critic: any = { source: 'jev', assess: async (input: any) => ({
      id: 'active-assessment', runId: input.runId, evaluatedRevision: input.evaluatedRevision,
      receivedAt: new Date().toISOString(), elapsedMilliseconds: 1, source: 'jev', stale: false,
      progressState: 'STALLED', continueProbability: 0.1, needsObservationProbability: 0.1,
      needsReplanProbability: 0.9, failureCause: 'BLOCKED_PATH', nextControl: 'REPLAN', confidence: 0.9,
    }) };
    const executor = new ShannonExecutor({ bot, instantSkills: { getSkill: (name: string) => name === 'mine-block' ? mine : name === 'place-block-at' ? place : undefined } as any,
      executionCritic: critic, criticMode: 'off', executionSupervisionMode: 'feedback' });
    // The next planner turn can satisfy this fixed contract independently of the aborted tool.
    fakes.stream.mockImplementationOnce((request: any) => { calls.push(structuredClone(request)); turn++; return { finalMessage: async () => ({ content: [
      { type: 'tool_use', id: 'mine-1', name: 'mine-block', input: {} },
      { type: 'tool_use', id: 'place-1', name: 'place-block-at', input: {} },
      { type: 'tool_use', id: 'done-old', name: 'task-complete', input: { summary: 'old plan' } },
    ], usage: {} }) }; });
    const result = await executor.run({ runId: 'test', goal: '石を集める', context: null, systemPrompt: 'test', tools: [],
      goalContract: { goal: '石を集める', predicates: [{ kind: 'position', dimension: 'overworld', position: { x: 0, y: 64, z: 0 }, radius: 1 }] } });
    expect(place.run).not.toHaveBeenCalled();
    expect(result.lastContent).toBe('new plan');
    const messages = calls[1].messages;
    const toolsAt = messages.findIndex((message: any) => message.role === 'assistant' && Array.isArray(message.content));
    const results = messages[toolsAt + 1];
    expect(Array.isArray(results.content)).toBe(true);
    expect(results.content.map((block: any) => block.tool_use_id)).toEqual(['mine-1', 'place-1', 'done-old']);
    expect(results.content[1].content).toContain('未実行');
    expect(messages.slice(toolsAt + 2).some((message: any) => String(message.content).includes('Fast Execution Critic'))).toBe(true);
    expect(result.cognitiveWorkspace.receipts[0].execution).toBeDefined();
    expect(bot.listenerCount('minebotActionProgress')).toBe(0);
    vi.unstubAllGlobals();
  });
});
