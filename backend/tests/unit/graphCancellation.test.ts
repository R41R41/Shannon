import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEnvelope } from '@shannon/common';

const fakes = vi.hoisted(() => ({
  run: vi.fn(), parallel: vi.fn(), format: vi.fn(), writeback: vi.fn(),
  saveEpisode: vi.fn(), native: vi.fn(), nativeDeps: undefined as any, nativeEnabled: false,
}));
vi.mock('../../src/config/env.js', () => ({ config: { anthropic: { get apiKey() { return fakes.nativeEnabled ? 'mock' : ''; } } } }));
vi.mock('../../src/utils/logger.js', () => ({ createLogger: () => ({ info: vi.fn(), error: vi.fn() }) }));
vi.mock('../../src/services/llm/graph/nodes/EmotionNode.js', () => ({ EmotionNode: class {} }));
vi.mock('../../src/services/llm/graph/nodes/FunctionCallingAgent.js', () => ({ FunctionCallingAgent: class {} }));
vi.mock('../../src/services/memory/scopedMemoryService.js', () => ({
  ScopedMemoryService: { getInstance: () => ({ writeback: fakes.writeback }) },
}));
vi.mock('../../src/services/llm/graph/cognitive/ModelSelector.js', () => ({
  ModelSelector: { selectInitialModel: () => 'mock-model' },
}));
vi.mock('../../src/services/llm/graph/cognitive/ParallelExecutor.js', () => ({
  ParallelExecutor: class { run = fakes.parallel },
}));
vi.mock('../../src/services/llm/graph/cognitive/TaskEpisodeMemory.js', () => ({
  TaskEpisodeMemory: { buildEpisodeFromResult: () => ({}), getInstance: () => ({ saveEpisode: fakes.saveEpisode }) },
}));
vi.mock('../../src/services/common/adapters/actionFormatter.js', () => ({ actionFormatterNode: fakes.format }));
vi.mock('../../src/services/llm/graph/ShannonExecutor.js', () => ({
  ShannonExecutor: class { constructor(deps: any) { fakes.nativeDeps = deps; } run = fakes.native; },
  skillToAnthropicTool: vi.fn(), routineToAnthropicTool: vi.fn(),
}));
vi.mock('../../src/services/llm/graph/nodes/prompt/PromptBuilder.js', () => ({ PromptBuilder: class { buildSystemPrompt() { return 'mock prompt'; } } }));
vi.mock('../../src/services/minebot/utils/minebotToolPolicy.js', () => ({ resolveMinebotToolPolicy: () => 'all', filterToolsByMinebotPolicy: (tools: any[]) => tools }));

import { buildShannonGraph, invokeShannonGraph } from '../../src/services/llm/graph/shannonGraph.js';

const envelope: RequestEnvelope = {
  requestId: 'graph-request', channel: 'discord', sourceUserId: 'user',
  conversationId: 'conversation', threadId: 'thread', tags: [], timestampIso: '2026-08-28T00:00:00Z',
};
const result = { taskTree: { status: 'completed', strategy: 'done' }, lastAssistantContent: 'answer' };
function graph(parallel = false) {
  return buildShannonGraph({ fca: { run: fakes.run } as any, emotionNode: parallel ? {} as any : undefined as any });
}
function deferred() {
  let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
beforeEach(() => {
  vi.resetAllMocks();
  fakes.nativeEnabled = false; fakes.nativeDeps = undefined;
  fakes.run.mockResolvedValue(result); fakes.parallel.mockResolvedValue(result);
  fakes.writeback.mockResolvedValue(undefined); fakes.saveEpisode.mockResolvedValue(undefined);
  fakes.format.mockResolvedValue({ actionPlan: { actions: [] } });
});

describe('real graph with mocked external services', () => {
  it.each([false, true])('passes the caller signal through the graph (parallel=%s)', async parallel => {
    const controller = new AbortController();
    const response = await invokeShannonGraph(graph(parallel), envelope, [], { abortSignal: controller.signal });
    expect((parallel ? fakes.parallel : fakes.run).mock.calls[0][1]).toBe(controller.signal);
    expect((parallel ? fakes.parallel : fakes.run).mock.calls[0][0].requestEnvelope).toMatchObject(envelope);
    expect(response.finalAnswer).toBe('answer');
    expect(fakes.writeback).toHaveBeenCalledOnce();
  });

  it('does not invoke any engine for a pre-cancelled request', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(invokeShannonGraph(graph(), envelope, [], { abortSignal: controller.signal })).rejects.toThrow();
    expect(fakes.run).not.toHaveBeenCalled(); expect(fakes.writeback).not.toHaveBeenCalled();
  });

  it.each([false, true])('does not write back an engine result produced after cancellation (parallel=%s)', async parallel => {
    const controller = new AbortController(); const started = deferred(); const gate = deferred();
    (parallel ? fakes.parallel : fakes.run).mockImplementation(async () => {
      started.resolve(); await gate.promise; return result;
    });
    const invocation = invokeShannonGraph(graph(parallel), envelope, [], { abortSignal: controller.signal });
    const rejected = expect(invocation).rejects.toThrow();
    await started.promise; controller.abort(); gate.resolve(); await rejected;
    expect(fakes.format).not.toHaveBeenCalled(); expect(fakes.writeback).not.toHaveBeenCalled();
  });

  it('checks cancellation again after async action formatting, before memory writeback', async () => {
    const controller = new AbortController();
    fakes.format.mockImplementation(async () => { controller.abort(); return { actionPlan: { actions: [] } }; });
    await expect(invokeShannonGraph(graph(), envelope, [], { abortSignal: controller.signal })).rejects.toThrow();
    expect(fakes.writeback).not.toHaveBeenCalled();
  });

  it('builds native executor tools from a fresh per-run catalog and uses invoke with its signal', async () => {
    fakes.nativeEnabled = true;
    const controller = new AbortController(); const invoke = vi.fn(async () => 'native-tool-result');
    const setMemoryPort = vi.fn();
    const setDiscordConversationPort = vi.fn();
    const createToolsForRun = vi.fn(() => [{ name: 'test-tool', description: 'test', invoke, setMemoryPort, setDiscordConversationPort }]);
    fakes.native.mockImplementation(async () => {
      expect(await fakes.nativeDeps.llmTools.get('test-tool')({ value: 1 })).toBe('native-tool-result');
      return { lastContent: 'native answer', taskTree: result.taskTree, toolCallCount: 1, durationMs: 0 };
    });
    const compiled = buildShannonGraph({ fca: { createToolsForRun, run: fakes.run } as any });
    await invokeShannonGraph(compiled, { ...envelope, channel: 'minecraft' }, [], { abortSignal: controller.signal });
    expect(createToolsForRun).toHaveBeenCalledOnce();
    expect(setMemoryPort).toHaveBeenCalledOnce();
    expect(setDiscordConversationPort).toHaveBeenCalledOnce();
    expect((await setDiscordConversationPort.mock.calls[0][0].reply({ message: 'minecraft must not post to Discord' })).status).toBe('denied');
    expect((await setMemoryPort.mock.calls[0][0].save({ content: 'no world identity' })).saved).toBe(false);
    expect(invoke).toHaveBeenCalledWith({ value: 1 }, { signal: controller.signal });
    expect(fakes.run).not.toHaveBeenCalled();
  });

  it('does not start fallback FCA when the native engine throws after cancellation', async () => {
    fakes.nativeEnabled = true;
    const controller = new AbortController();
    fakes.native.mockImplementation(async () => { controller.abort(); throw new Error('native cancelled'); });
    const compiled = buildShannonGraph({ fca: { createToolsForRun: () => [], run: fakes.run } as any });
    await expect(invokeShannonGraph(compiled, { ...envelope, channel: 'minecraft' }, [], { abortSignal: controller.signal })).rejects.toThrow();
    expect(fakes.run).not.toHaveBeenCalled(); expect(fakes.writeback).not.toHaveBeenCalled();
  });
});
