import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AIMessage, AIMessageChunk, HumanMessage, ToolMessage } from '@langchain/core/messages';

const fakes = vi.hoisted(() => ({ invoke: vi.fn(), stream: vi.fn(), utilityInvoke: vi.fn(), publish: vi.fn(), memoryReads: [] as any[], memoryWrites: [] as any[] }));
vi.mock('../../src/config/env.js', () => ({ config: { anthropic: { apiKey: '' }, openaiApiKey: 'mock' } }));
vi.mock('../../src/config/modelManager.js', () => ({ modelManager: { get: () => 'mock-model' } }));
vi.mock('../../src/utils/logger.js', () => ({ logger: Object.fromEntries(['info','warn','error','success','debug'].map(k => [k, vi.fn()])) }));
vi.mock('../../src/services/eventBus/index.js', () => ({ getEventBus: () => ({ publish: fakes.publish }) }));
vi.mock('../../src/services/minebot/config/MinebotConfig.js', () => ({ CONFIG: { UI_MOD_BASE_URL: 'http://unused.invalid' } }));
vi.mock('../../src/services/minebot/knowledge/WorldKnowledgeService.js', () => ({ WorldKnowledgeService: {} }));
vi.mock('../../src/services/minebot/knowledge/RecipeDependencyResolver.js', () => ({ RecipeDependencyResolver: {} }));
vi.mock('../../src/services/llm/utils/langfuse.js', () => ({ createTracedModel: () => ({ bindTools: () => ({}), invoke: fakes.utilityInvoke }) }));
vi.mock('../../src/services/llm/utils/tokenTracker.js', () => ({ tokenTracker: { record: async () => {} } }));
vi.mock('../../src/services/llm/utils/contextManager.js', () => ({ trimContext: (messages: unknown[]) => messages }));
vi.mock('../../src/services/llm/graph/nodes/prompt/PromptBuilder.js', () => ({
  PromptBuilder: class { buildSystemPrompt() { return 'mock system'; } getDisabledOutputTools() { return []; } setRoutineManager() {} },
}));
vi.mock('../../src/services/llm/graph/nodes/EmotionNode.js', () => ({ EmotionNode: class {} }));
vi.mock('../../src/services/llm/graph/cognitive/ModelSelector.js', () => ({
  ModelSelector: class {
    modelName = 'mock-model'; timeoutMs = 5000; stats = { currentModel: 'mock-model', escalations: 0, deescalations: 0 };
    bindTools() { return { invoke: fakes.invoke, stream: fakes.stream }; } setMaxEscalationLevel() {} escalate() { return false; }
  },
}));
vi.mock('../../src/services/llm/graph/cognitive/TaskEpisodeMemory.js', () => ({
  TaskEpisodeMemory: { buildEpisodeFromResult: () => ({}), getInstance: () => ({
    recallRelevantEpisodes: async () => [], formatForPrompt: () => '', saveEpisode: async () => {},
  }) },
}));
vi.mock('../../src/services/llm/graph/cognitive/EmotionLoop.js', () => ({ EmotionLoop: class {} }));
vi.mock('../../src/services/llm/graph/cognitive/MetaCognitionLoop.js', () => ({ MetaCognitionLoop: class {} }));
vi.mock('../../src/services/llm/graph/cognitive/MemoryAgent.js', () => ({
  MemoryAgent: class {
    constructor(_blackboard: unknown, private envelope: any) {}
    async initialize() { return `memory-${this.envelope.sourceUserId}`; }
    async run(signal: AbortSignal) { await new Promise<void>(resolve => {
      if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true });
    }); }
    async query(question: string) { fakes.memoryReads.push({ owner: this.envelope.sourceUserId, question }); return `answer-${this.envelope.sourceUserId}`; }
    async save(content: string) { fakes.memoryWrites.push({ owner: this.envelope.sourceUserId, content }); return { saved: true, message: "saved" }; }
  },
}));
vi.mock('../../src/services/llm/graph/cognitive/selfImprove/index.js', () => ({ SelfImprovementDaemon: { getInstance: () => ({ onEpisodeSaved: async () => {} }) } }));
vi.mock('../../src/services/minebot/routines/RoutineRecorder.js', () => ({ RoutineRecorder: { getInstance: () => undefined } }));

import { FunctionCallingAgent } from '../../src/services/llm/graph/nodes/FunctionCallingAgent.js';
import { ParallelExecutor } from '../../src/services/llm/graph/cognitive/ParallelExecutor.js';
import UpdatePlanTool from '../../src/services/llm/tools/utility/updatePlan.js';
import RecallMemoryTool from '../../src/services/llm/tools/memory/recallMemory.js';
import SaveMemoryTool from '../../src/services/llm/tools/memory/saveMemory.js';
import PlanCraftTool from '../../src/services/llm/tools/utility/planCraft.js';
import RecallKnowledgeTool from '../../src/services/llm/tools/memory/recallKnowledge.js';
import { ShannonMemoryService } from '../../src/services/memory/shannonMemoryService.js';
import { deriveMemoryScope } from '../../src/modules/memory/index.js';
import { RequestExecutionCoordinator } from '../../src/services/llm/graph/requestExecutionCoordinator.js';

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function state(owner: string) {
  const requestEnvelope = { requestId: `request-${owner}`, sourceUserId: owner, channel: 'discord', conversationId: `channel-${owner}`, threadId: `thread-${owner}`, tags: [], timestampIso: '2026-08-28T00:00:00Z' };
  return { taskId: requestEnvelope.requestId, userMessage: owner, messages: [], emotionState: { current: null }, context: { platform: 'discord', metadata: { envelope: requestEnvelope } }, channelId: `channel-${owner}`, environmentState: null, isEmergency: false, onToolsExecuted: () => {}, requestEnvelope } as any;
}
beforeEach(() => { vi.clearAllMocks(); fakes.memoryReads.length = 0; fakes.memoryWrites.length = 0; vi.stubEnv('SHANNON_COGNITIVE_LOOPS', 'false'); });
afterEach(() => vi.unstubAllEnvs());

async function overlap(tool: 'update-plan' | 'recall-memory') {
  const entered = { A: deferred(), B: deferred() }; const release = { A: deferred(), B: deferred() }; const turns = { A: 0, B: 0 };
  fakes.invoke.mockImplementation(async (messages: any[]) => {
    const owner = messages.find(m => m instanceof HumanMessage && ['A', 'B'].includes(m.content))!.content as 'A' | 'B';
    if (turns[owner]++ === 0) {
      entered[owner].resolve(); await release[owner].promise;
      return new AIMessage({ content: `thought-${owner}`, tool_calls: [{ id: `call-${owner}`, name: tool, args: tool === 'update-plan' ? { goal: `plan-${owner}`, strategy: 'test' } : { question: `query-${owner}` } }] });
    }
    return new AIMessage({ content: '', tool_calls: [{ id: `done-${owner}`, name: 'task-complete', args: { summary: `done-${owner}` } }] });
  });
  const fca = new FunctionCallingAgent([new UpdatePlanTool(), new RecallMemoryTool(), new SaveMemoryTool(), { name: 'task-complete', invoke: async () => 'done' } as any]);
  const runner = tool === 'recall-memory' ? new ParallelExecutor({ fca }) : fca;
  const a = runner.run(state('A')); await entered.A.promise;
  const b = runner.run(state('B')); await entered.B.promise;
  release.A.resolve(); const resultA = await a; release.B.resolve(); const resultB = await b;
  return { resultA, resultB };
}

describe('actual FCA and tools with external services mocked', () => {
  it('keeps update-plan delivery bound to its own request during overlapping calls', async () => {
    await overlap('update-plan');
    const plans = fakes.publish.mock.calls.map(([event]) => event).filter(e => e.type === 'discord:planning' && e.data.planning.goal.startsWith('plan-'));
    expect(plans.map(e => [e.data.planning.goal, e.data.channelId, e.data.taskId])).toEqual([
      ['plan-A', 'channel-A', 'request-A'], ['plan-B', 'channel-B', 'request-B'],
    ]);
  });

  it('does not replace the first conversation memory reference with the second one', async () => {
    const { resultA, resultB } = await overlap('recall-memory');
    expect(fakes.memoryReads).toEqual([{ owner: 'A', question: 'query-A' }, { owner: 'B', question: 'query-B' }]);
    expect(resultA.messages.filter(m => m instanceof ToolMessage).map(m => m.content)).toContain('answer-A');
    expect(resultB.messages.filter(m => m instanceof ToolMessage).map(m => m.content)).toContain('answer-B');
  });

  it('keeps thoughts, feedback, plan notices and blackboard state local across interleaved tools', async () => {
    const entered = { A: deferred(), B: deferred() }; const release = { A: deferred(), B: deferred() };
    const turns = { A: 0, B: 0 }; const contexts = {} as Record<string, string>;
    fakes.invoke.mockImplementation(async (messages: any[]) => {
      const owner = messages.find(m => m instanceof HumanMessage && ['A','B'].includes(m.content))!.content as 'A' | 'B';
      if (turns[owner]++ === 0) return new AIMessage({ content: `thought-${owner}`, tool_calls: [{ name: 'pause', id: `pause-${owner}`, args: { owner } }] });
      contexts[owner] = messages.map(m => m.content).join('\n');
      return new AIMessage({ content: '', tool_calls: [{ name: 'task-complete', id: `done-${owner}`, args: { summary: `done-${owner}` } }] });
    });
    const pause = { name: 'pause', invoke: async ({ owner }: { owner: 'A' | 'B' }) => { entered[owner].resolve(); await release[owner].promise; return 'ok'; } };
    const agent = new FunctionCallingAgent([pause as any]);
    const a = agent.createSession(); const b = agent.createSession();
    a.setBlackboardAccessor(() => ({ activeEffects: [{ name: 'effect-A', amplifier: 0 }] }) as any);
    b.setBlackboardAccessor(() => ({ activeEffects: [{ name: 'effect-B', amplifier: 0 }] }) as any);
    const runningA = a.run(state('A')); await entered.A.promise;
    const runningB = b.run(state('B')); await entered.B.promise;
    a.addFeedback('feedback-A'); b.addFeedback('feedback-B');
    a.notifyPlanUpdated('notice-A'); b.notifyPlanUpdated('notice-B');
    release.A.resolve(); await runningA; release.B.resolve(); await runningB;
    for (const owner of ['A','B']) for (const prefix of ['thought','feedback','notice','effect']) {
      expect(contexts[owner]).toContain(`${prefix}-${owner}`);
      expect(contexts[owner]).not.toContain(`${prefix}-${owner === 'A' ? 'B' : 'A'}`);
    }
  });

  it('snapshots the tool catalog and never inherits catalog memory or plan context', async () => {
    const original = new RecallMemoryTool(); original.setMemoryAgent({ query: async () => 'catalog-secret' } as any);
    const input = [original] as any[]; const agent = new FunctionCallingAgent(input); const session = agent.createSession();
    agent.addTools([new SaveMemoryTool()]); input.push(new UpdatePlanTool());
    expect(session.getTools().map(t => t.name)).toEqual(['recall-memory']);
    expect(agent.getToolNames()).toEqual(['recall-memory', 'save-memory']);
    expect(await session.getTools()[0].invoke({ question: 'test' })).not.toContain('catalog-secret');
    const externalList = session.getTools(); externalList.length = 0;
    expect(session.getTools()).toHaveLength(1);
  });

  it('does not allow a session to run twice, including during its first run', async () => {
    const entered = deferred(); const release = deferred();
    fakes.invoke.mockImplementation(async () => { entered.resolve(); await release.promise; return new AIMessage('A sufficiently long completed answer for the test.'); });
    const agent = new FunctionCallingAgent([]); const session = agent.createSession();
    const running = session.run({ ...state('A'), needsTools: false }); await entered.promise;
    await expect(session.run(state('B'))).rejects.toThrow('single-use');
    release.resolve(); await running;
    session.addFeedback('late-feedback'); session.notifyPlanUpdated('late-plan');
    await expect(session.run(state('B'))).rejects.toThrow('single-use');
    fakes.invoke.mockImplementation(async messages => {
      expect(messages.map((m: any) => m.content).join('\n')).not.toContain('late-');
      return new AIMessage('Another sufficiently long completed answer for the test.');
    });
    await agent.run({ ...state('B'), needsTools: false });
  });

  it('keeps save-memory and plan-craft dependencies local to each tool set', async () => {
    const agent = new FunctionCallingAgent([new SaveMemoryTool(), new PlanCraftTool()]);
    const a = agent.createToolsForRun(); const b = agent.createToolsForRun();
    const saveA = vi.fn(async () => ({ saved: true, message: "saved A" })); const saveB = vi.fn(async () => ({ saved: true, message: "saved B" })); const planA = vi.fn(); const planB = vi.fn();
    (a[0] as SaveMemoryTool).setMemoryAgent({ save: saveA } as any);
    (b[0] as SaveMemoryTool).setMemoryAgent({ save: saveB } as any);
    await a[0].invoke({ content: 'only-A' }); await b[0].invoke({ content: 'only-B' });
    expect(saveA.mock.calls).toEqual([['only-A', undefined]]); expect(saveB.mock.calls).toEqual([['only-B', undefined]]);
    (a[1] as PlanCraftTool).setBlackboard({ selfState: { inventory: [{ name: 'inventory-A', count: 1 }] }, updatePlan: planA } as any);
    (b[1] as PlanCraftTool).setBlackboard({ selfState: { inventory: [{ name: 'inventory-B', count: 2 }] }, updatePlan: planB } as any);
    fakes.utilityInvoke.mockImplementation(async messages => ({ content: JSON.stringify({ strategy: messages[1].content, subtasks: [] }) }));
    await a[1].invoke({ target: 'target-A' }); await b[1].invoke({ target: 'target-B' });
    expect(planA.mock.calls[0][0].strategy).toContain('inventory-A'); expect(planA.mock.calls[0][0].strategy).not.toContain('inventory-B');
    expect(planB.mock.calls[0][0].strategy).toContain('inventory-B'); expect(planB.mock.calls[0][0].strategy).not.toContain('inventory-A');
  });

  it('does not treat a Web conversation ID as a Discord delivery channel', async () => {
    const tool = new UpdatePlanTool(); tool.setContext('web-conversation', 'web-task', 'web');
    await tool.invoke({ goal: 'web-plan', strategy: 'test' });
    expect(fakes.publish.mock.calls.some(([event]) => event.type === 'discord:planning')).toBe(false);
  });

  it('rejects missing or mismatched canonical envelopes before starting parallel work', async () => {
    const runner = new ParallelExecutor({ fca: new FunctionCallingAgent([]) });
    await expect(runner.run({ ...state('A'), requestEnvelope: undefined })).rejects.toThrow('canonical request');
    await expect(runner.run({ ...state('A'), requestEnvelope: state('B').requestEnvelope })).rejects.toThrow('canonical request');
    expect(fakes.invoke).not.toHaveBeenCalled();
  });

  it('preempts an actual FCA without publishing its late result or aborting the emergency session', async () => {
    const entered = { A: deferred(), B: deferred() }; const release = { A: deferred(), B: deferred() }; const signals: AbortSignal[] = [];
    fakes.invoke.mockImplementation(async (messages, options) => {
      const owner = messages.find((m: any) => m instanceof HumanMessage)!.content as 'A' | 'B';
      signals.push(options.signal); entered[owner].resolve(); await release[owner].promise;
      return new AIMessage(`Completed answer for ${owner} with enough text for the fast path.`);
    });
    const agent = new FunctionCallingAgent([]); const coordinator = new RequestExecutionCoordinator();
    const envelope = state('A').requestEnvelope;
    const a = coordinator.run(envelope, signal => agent.run({ ...state('A'), needsTools: false }, signal));
    const rejected = expect(a).rejects.toThrow(); await entered.A.promise;
    const b = coordinator.run({ ...envelope, requestId: 'emergency', tags: ['emergency'] }, signal => agent.run({ ...state('B'), needsTools: false }, signal));
    await entered.B.promise; expect(signals[0].aborted).toBe(true); expect(signals[1].aborted).toBe(false);
    release.A.resolve(); await rejected;
    expect(fakes.publish.mock.calls.some(([e]) => e.type === 'discord:planning' && e.data.taskId === 'request-A' && e.data.planning.status === 'completed')).toBe(false);
    release.B.resolve(); await expect(b).resolves.toMatchObject({ lastAssistantContent: expect.stringContaining('for B') });
  });

  it('does not emit later stream sentences after caller cancellation', async () => {
    const controller = new AbortController(); const sentences: string[] = [];
    fakes.stream.mockImplementation(async function* () { yield new AIMessageChunk('first。'); yield new AIMessageChunk('second。'); });
    const agent = new FunctionCallingAgent([]);
    await expect(agent.run({ ...state('A'), onStreamSentence: async (sentence: string) => { sentences.push(sentence); controller.abort(); } }, controller.signal)).rejects.toThrow();
    expect(sentences).toEqual(['first。']);
  });

  it('does not retarget memory when the caller later mutates its envelope', async () => {
    const entered = deferred(); const release = deferred(); let turn = 0;
    fakes.invoke.mockImplementation(async () => {
      if (turn++ === 0) {
        entered.resolve(); await release.promise;
        return new AIMessage({ content: '', tool_calls: [{ name: 'recall-memory', id: 'recall', args: { question: 'query-A' } }] });
      }
      return new AIMessage({ content: '', tool_calls: [{ name: 'task-complete', id: 'done', args: { summary: 'done' } }] });
    });
    const input = state('A');
    const runner = new ParallelExecutor({ fca: new FunctionCallingAgent([new RecallMemoryTool()]) });
    const running = runner.run(input); await entered.promise;
    input.requestEnvelope.sourceUserId = 'B'; release.resolve(); await running;
    expect(fakes.memoryReads).toEqual([{ owner: 'A', question: 'query-A' }]);
  });

  it('does not start a model after cancellation while initial memory is pending', async () => {
    const entered = deferred(); const release = deferred(); const controller = new AbortController();
    const agent = new FunctionCallingAgent([]);
    const running = agent.run({ ...state('A'), getInitialMemory: async () => { entered.resolve(); await release.promise; return 'old memory'; } }, controller.signal);
    const rejected = expect(running).rejects.toThrow();
    await entered.promise; controller.abort(); release.resolve(); await rejected;
    expect(fakes.invoke).not.toHaveBeenCalled();
  });
});

it('binds the canonical memory port in standalone FCA, without a MemoryAgent', async () => {
  const request = { ...state('A').requestEnvelope, sourceUserId: '100', discord: { guildId: '200', channelId: '300', isDM: false } };
  const search = vi.spyOn(ShannonMemoryService.getInstance(), 'searchKnowledge').mockResolvedValue([]);
  try {
    fakes.invoke.mockResolvedValueOnce(new AIMessage({ content: '', tool_calls: [{ id: 'r', name: 'recall-knowledge', args: { query: 'fixture' } }] }))
      .mockResolvedValueOnce(new AIMessage({ content: '', tool_calls: [{ id: 'done', name: 'task-complete', args: { summary: 'done' } }] }));
    const agent = new FunctionCallingAgent([new RecallKnowledgeTool(), { name: 'task-complete', invoke: async () => 'done' } as any]);
    await agent.run({ ...state('A'), requestEnvelope: request });
    expect(search).toHaveBeenCalledOnce();
    expect(search.mock.calls[0][2]?.scopeKey).toBe(deriveMemoryScope(request)!.scopeKey);
  } finally { search.mockRestore(); }
});
