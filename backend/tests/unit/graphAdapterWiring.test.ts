import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEnvelope } from '@shannon/common';

const fakes = vi.hoisted(() => ({
  run: vi.fn(),
  format: vi.fn(),
  writeback: vi.fn(),
  saveEpisode: vi.fn(),
}));
vi.mock('../../src/utils/logger.js', () => ({ createLogger: () => ({ info: vi.fn(), error: vi.fn() }) }));
vi.mock('../../src/services/llm/graph/nodes/FunctionCallingAgent.js', () => ({ FunctionCallingAgent: class {} }));
vi.mock('../../src/services/memory/scopedMemoryService.js', () => ({
  ScopedMemoryService: {
    getInstance: () => ({
      writeback: fakes.writeback,
      recall: async () => ({
        person: null,
        personStatements: [],
        memories: [],
        userProfile: null,
        relationshipModel: null,
        selfModel: null,
        strategyUpdates: [],
        internalState: null,
        worldModelPatterns: [],
        relationshipPrompt: '',
        selfModelPrompt: '',
        strategyPrompt: '',
        internalStatePrompt: '',
        worldModelPrompt: '',
        formattedPrompt: '',
      }),
    }),
  },
}));
vi.mock('../../src/services/llm/graph/cognitive/ModelSelector.js', () => ({
  ModelSelector: { selectInitialModel: () => 'mock-model' },
}));
vi.mock('../../src/services/llm/graph/cognitive/TaskEpisodeMemory.js', () => ({
  TaskEpisodeMemory: {
    buildEpisodeFromResult: () => ({}),
    loadPromptForRun: async () => undefined,
    saveEpisodeForRun: fakes.saveEpisode,
  },
}));
vi.mock('../../src/services/common/adapters/actionFormatter.js', () => ({ actionFormatterNode: fakes.format }));
vi.mock('../../src/services/llm/graph/nodes/prompt/PromptBuilder.js', () => ({
  PromptBuilder: class { buildSystemPrompt() { return 'mock prompt'; } },
}));
vi.mock('../../src/config/env.js', () => ({ config: { anthropic: { apiKey: '' } } }));

import { buildShannonGraph, invokeShannonGraph } from '../../src/services/llm/graph/shannonGraph.js';

const envelope: RequestEnvelope = {
  requestId: 'graph-adapter',
  channel: 'discord',
  sourceUserId: 'user',
  conversationId: 'conversation',
  threadId: 'thread',
  tags: [],
  timestampIso: '2026-08-28T00:00:00Z',
  text: 'hello',
};
const result = { taskTree: { status: 'completed', strategy: 'done' }, lastAssistantContent: 'answer' };

function graph() {
  return buildShannonGraph({ fca: { run: fakes.run } as any });
}

beforeEach(() => {
  vi.resetAllMocks();
  fakes.run.mockResolvedValue(result);
  fakes.writeback.mockResolvedValue(undefined);
  fakes.saveEpisode.mockResolvedValue(undefined);
  fakes.format.mockResolvedValue({ actionPlan: { actions: [] } });
});

describe('invokeShannonGraph adapter wiring', () => {
  it('forwards channel adapter hooks into fca.run state', async () => {
    const onToolStarting = vi.fn();
    const onTaskTreeUpdate = vi.fn();
    const onStreamSentence = vi.fn(async () => {});
    const onRequestSkillInterrupt = vi.fn();
    const getLiveInventory = vi.fn(() => [{ name: 'iron_ingot', count: 3 } as any]);
    const getActiveEffects = vi.fn(() => [{ name: 'speed', amplifier: 1 }]);
    const getInventoryDiff = vi.fn(() => '+3 iron');
    const getInitialMemory = vi.fn(async () => 'initial');

    await invokeShannonGraph(graph(), envelope, [], {
      onToolStarting,
      onTaskTreeUpdate,
      onStreamSentence,
      onRequestSkillInterrupt,
      getLiveInventory,
      getActiveEffects,
      getInventoryDiff,
      getInitialMemory,
    });

    const fcaState = fakes.run.mock.calls[0][0];
    expect(fcaState.channel.onToolStarting).toBe(onToolStarting);
    expect(fcaState.channel.onTaskTreeUpdate).toBe(onTaskTreeUpdate);
    expect(fcaState.channel.onStreamSentence).toBe(onStreamSentence);
    expect(fcaState.channel.onRequestSkillInterrupt).toBe(onRequestSkillInterrupt);
    expect(fcaState.channel.getLiveInventory).toBe(getLiveInventory);
    expect(fcaState.channel.getActiveEffects).toBe(getActiveEffects);
    expect(fcaState.channel.getInventoryDiff).toBe(getInventoryDiff);
    expect(fcaState.channel.getInitialMemory).toBe(getInitialMemory);
    expect(fcaState.composition.requestEnvelope).toMatchObject(envelope);
  });

  it('leaves adapter hooks undefined when the caller does not supply them', async () => {
    await invokeShannonGraph(graph(), envelope, []);

    const fcaState = fakes.run.mock.calls[0][0];
    expect(fcaState.channel.onToolStarting).toBeUndefined();
    expect(fcaState.channel.onStreamSentence).toBeUndefined();
    expect(fcaState.channel.getLiveInventory).toBeUndefined();
    expect(fcaState.channel.getInitialMemory).toBeUndefined();
  });
});
