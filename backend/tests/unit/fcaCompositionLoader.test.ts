import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/services/minebot/knowledge/WorldKnowledgeService.js', () => ({
  WorldKnowledgeService: {
    forServer: () => ({
      buildContextForPosition: vi.fn(async () => '\n=== ワールド知識 ===\n[既知のブロック] stone x3\n'),
    }),
  },
}));
vi.mock('../../src/services/llm/graph/cognitive/TaskEpisodeMemory.js', () => ({
  TaskEpisodeMemory: {
    loadPromptForRun: vi.fn(async () => '## 過去の類似タスクの経験'),
  },
}));

import { TaskEpisodeMemory } from '../../src/services/llm/graph/cognitive/TaskEpisodeMemory.js';
import {
  loadFcaCompositionExtras,
  loadWorldKnowledgePrompt,
  memoryFieldsFromRecall,
} from '../../src/services/llm/graph/nodes/fcaCompositionLoader.js';

const envelope = {
  requestId: 'request-1',
  channel: 'minecraft' as const,
  sourceUserId: 'user-1',
  conversationId: 'minecraft:server-a:world-a',
  threadId: 'minecraft:server-a:world-a',
  tags: [],
  timestampIso: '2026-08-28T00:00:00Z',
  minecraft: { serverId: 'server-a', worldId: 'world-a', dimension: 'overworld' },
};

describe('fcaCompositionLoader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('maps scoped recall prompts into composition fields', () => {
    expect(memoryFieldsFromRecall({
      formattedPrompt: 'memory block',
      relationshipPrompt: 'rel',
      selfModelPrompt: 'self',
      strategyPrompt: 'strategy',
      internalStatePrompt: 'internal',
      worldModelPrompt: 'world',
    } as any)).toEqual({
      memoryPrompt: 'memory block',
      relationshipPrompt: 'rel',
      selfModelPrompt: 'self',
      strategyPrompt: 'strategy',
      internalStatePrompt: 'internal',
      worldModelPrompt: 'world',
    });
  });

  it('loads world knowledge from environment state outside the FCA loop', async () => {
    const prompt = await loadWorldKnowledgePrompt(
      JSON.stringify({ botPosition: { x: 10.2, y: 64.8, z: -3.1 } }),
      'server-a',
    );
    expect(prompt).toContain('ワールド知識');
  });

  it('loads episode and memory extras for a graph run', async () => {
    const extras = await loadFcaCompositionExtras({
      goal: 'collect iron',
      platform: 'discord',
      memoryEnvelope: envelope,
      environmentState: null,
      recall: {
        formattedPrompt: 'scoped memory',
        relationshipPrompt: '',
        selfModelPrompt: '',
        strategyPrompt: '',
        internalStatePrompt: '',
        worldModelPrompt: '',
      } as any,
    });
    expect(extras.memoryPrompt).toBe('scoped memory');
    expect(extras.episodePrompt).toContain('過去の類似タスク');
    expect(TaskEpisodeMemory.loadPromptForRun).toHaveBeenCalledWith('collect iron', 'discord', envelope);
    expect(extras.worldKnowledgePrompt).toBeUndefined();
  });
});
