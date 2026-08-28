import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEnvelope } from '@shannon/common';

const fakes = vi.hoisted(() => ({
  run: vi.fn(), parallel: vi.fn(), format: vi.fn(), writeback: vi.fn(),
  saveEpisode: vi.fn(),
}));
vi.mock('../../src/config/env.js', () => ({ config: { anthropic: { apiKey: '' } } }));
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
  fakes.run.mockResolvedValue(result); fakes.parallel.mockResolvedValue(result);
  fakes.writeback.mockResolvedValue(undefined); fakes.saveEpisode.mockResolvedValue(undefined);
  fakes.format.mockResolvedValue({ actionPlan: { actions: [] } });
});

describe('real graph with mocked external services', () => {
  it.each([false, true])('passes the caller signal through the graph (parallel=%s)', async parallel => {
    const controller = new AbortController();
    const response = await invokeShannonGraph(graph(parallel), envelope, [], { abortSignal: controller.signal });
    expect((parallel ? fakes.parallel : fakes.run).mock.calls[0][1]).toBe(controller.signal);
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
});
