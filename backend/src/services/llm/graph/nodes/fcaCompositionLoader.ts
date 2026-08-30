import type { RequestEnvelope, TaskContext } from '@shannon/common';
import { WorldKnowledgeService } from '../../../minebot/knowledge/WorldKnowledgeService.js';
import type { ScopedRecallResult } from '../../../memory/scopedMemoryService.js';
import { TaskEpisodeMemory } from '../cognitive/TaskEpisodeMemory.js';
import type { FcaComposition } from './fcaState.js';

export async function loadWorldKnowledgePrompt(
  environmentState: string | null | undefined,
  serverId: string | undefined,
): Promise<string | undefined> {
  if (!environmentState) return undefined;
  try {
    const envObj = JSON.parse(environmentState) as { botPosition?: { x: number; y: number; z: number } };
    if (!envObj?.botPosition) return undefined;
    const wk = WorldKnowledgeService.forServer(serverId);
    if (!wk) return undefined;
    const pos = envObj.botPosition;
    const prompt = await wk.buildContextForPosition(
      { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) },
      64,
    );
    return prompt || undefined;
  } catch {
    return undefined;
  }
}

export function memoryFieldsFromRecall(recall: ScopedRecallResult): Pick<
  FcaComposition,
  | 'memoryPrompt'
  | 'relationshipPrompt'
  | 'selfModelPrompt'
  | 'strategyPrompt'
  | 'internalStatePrompt'
  | 'worldModelPrompt'
> {
  return {
    memoryPrompt: recall.formattedPrompt || undefined,
    relationshipPrompt: recall.relationshipPrompt || undefined,
    selfModelPrompt: recall.selfModelPrompt || undefined,
    strategyPrompt: recall.strategyPrompt || undefined,
    internalStatePrompt: recall.internalStatePrompt || undefined,
    worldModelPrompt: recall.worldModelPrompt || undefined,
  };
}

export async function loadFcaCompositionExtras(input: {
  goal: string;
  platform: string;
  memoryEnvelope: RequestEnvelope;
  environmentState: string | null;
  serverId?: string;
  lightweightMemory?: boolean;
  recall?: ScopedRecallResult;
}): Promise<Pick<FcaComposition, 'episodePrompt' | 'worldKnowledgePrompt'> & ReturnType<typeof memoryFieldsFromRecall>> {
  const [episodePrompt, worldKnowledgePrompt] = await Promise.all([
    TaskEpisodeMemory.loadPromptForRun(input.goal, input.platform, input.memoryEnvelope),
    input.lightweightMemory
      ? Promise.resolve(undefined)
      : loadWorldKnowledgePrompt(input.environmentState, input.serverId),
  ]);
  return {
    ...(input.recall ? memoryFieldsFromRecall(input.recall) : {}),
    episodePrompt,
    worldKnowledgePrompt,
  };
}
