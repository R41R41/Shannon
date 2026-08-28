import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fakes = vi.hoisted(() => ({ initialize: vi.fn(), memory: vi.fn(), save: vi.fn() }));
vi.mock('../../src/utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../../src/services/llm/graph/nodes/EmotionNode.js', () => ({ EmotionNode: class {} }));
vi.mock('../../src/services/llm/graph/nodes/FunctionCallingAgent.js', () => ({ FunctionCallingAgent: class {} }));
vi.mock('../../src/services/llm/graph/cognitive/EmotionLoop.js', () => ({ EmotionLoop: class {} }));
vi.mock('../../src/services/llm/graph/cognitive/MetaCognitionLoop.js', () => ({ MetaCognitionLoop: class {} }));
vi.mock('../../src/services/llm/graph/cognitive/MemoryAgent.js', () => ({
  MemoryAgent: class { initialize = fakes.initialize; run = fakes.memory },
}));
vi.mock('../../src/services/llm/graph/cognitive/ModelSelector.js', () => ({
  ModelSelector: class {
    modelName = 'mock-model';
    stats = { currentModel: 'mock-model', escalations: 0, deescalations: 0 };
  },
}));
vi.mock('../../src/services/llm/graph/cognitive/TaskEpisodeMemory.js', () => ({
  TaskEpisodeMemory: { buildEpisodeFromResult: () => ({}), getInstance: () => ({ saveEpisode: fakes.save }) },
}));
vi.mock('../../src/services/llm/graph/cognitive/selfImprove/index.js', () => ({
  SelfImprovementDaemon: { getInstance: () => ({ onEpisodeSaved: async () => {} }) },
}));
vi.mock('../../src/services/minebot/routines/RoutineRecorder.js', () => ({
  RoutineRecorder: { getInstance: () => undefined },
}));

import { ParallelExecutor } from '../../src/services/llm/graph/cognitive/ParallelExecutor.js';

const state = {
  taskId: 'test', userMessage: 'test', messages: [], selectedModel: 'mock-model',
  context: { platform: 'discord' }, emotionState: { current: null },
} as any;
const result = { taskTree: { status: 'completed' }, messages: [], forceStop: false };
function fixture(run: (...args: any[]) => any) {
  const fca = { getTools: () => [], setBlackboardAccessor: vi.fn(), run: vi.fn(run) };
  return { fca, executor: new ParallelExecutor({ fca: fca as any }) };
}

beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers(); vi.stubEnv('SHANNON_COGNITIVE_LOOPS', 'false');
  fakes.initialize.mockResolvedValue(''); fakes.save.mockResolvedValue(undefined);
  fakes.memory.mockImplementation((signal: AbortSignal) => new Promise<void>(resolve => {
    if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true });
  }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('ParallelExecutor teardown with mocked cognitive services', () => {
  it('does not start memory or task execution when already cancelled', async () => {
    const controller = new AbortController(); controller.abort();
    const { executor, fca } = fixture(async () => result);
    await expect(executor.run(state, controller.signal)).rejects.toThrow();
    expect(fakes.initialize).not.toHaveBeenCalled(); expect(fca.run).not.toHaveBeenCalled();
  });

  it('stops auxiliary work and removes listener/timer after success', async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const { executor, fca } = fixture(async () => result);
    await expect(executor.run(state, controller.signal)).resolves.toMatchObject(result);
    expect((fakes.memory.mock.calls[0][0] as AbortSignal).aborted).toBe(true);
    expect(fca.setBlackboardAccessor).toHaveBeenLastCalledWith(null);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('observes auxiliary rejection while preserving the task cancellation error', async () => {
    const controller = new AbortController(); const error = new Error('cancelled task');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    fakes.memory.mockImplementation((signal: AbortSignal) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('cancelled memory')), { once: true });
    }));
    const { executor, fca } = fixture(async (_state, signal: AbortSignal) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(error), { once: true });
    }));
    const running = executor.run(state, controller.signal);
    const assertion = expect(running).rejects.toBe(error);
    controller.abort(); await assertion;
    expect(fca.setBlackboardAccessor).toHaveBeenLastCalledWith(null);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(fakes.save).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds teardown when an auxiliary service ignores cancellation', async () => {
    fakes.memory.mockImplementation(() => new Promise(() => {}));
    const { executor, fca } = fixture(async () => { throw new Error('task failed'); });
    const assertion = expect(executor.run(state)).rejects.toThrow('task failed');
    await vi.advanceTimersByTimeAsync(3000); await assertion;
    expect(fca.setBlackboardAccessor).toHaveBeenLastCalledWith(null);
    expect(vi.getTimerCount()).toBe(0);
  });
});
