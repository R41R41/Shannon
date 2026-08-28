import { StructuredTool } from '@langchain/core/tools';
import { MemoryPlatform } from '../../../../models/PersonMemory.js';
import SaveExperienceTool from './saveExperience.js';
import SaveKnowledgeTool from './saveKnowledge.js';
import RecallExperienceTool from './recallExperience.js';
import RecallKnowledgeTool from './recallKnowledge.js';
import RecallPersonTool from './recallPerson.js';
import RecallMemoryTool from './recallMemory.js';
import SaveMemoryTool from './saveMemory.js';

/**
 * 記憶ツールを作成するファクトリ関数
 *
 * v2: recall-memory / save-memory (統合版、MemoryAgent 連携)
 * 旧: save-experience, save-knowledge, recall-experience, recall-knowledge, recall-person
 *     → 後方互換のため残しているが、将来廃止予定
 */
export function createMemoryTools(
  platform: MemoryPlatform = 'discord',
  source: string = 'discord',
): StructuredTool[] {

  return [
    // v2 統合ツール (MemoryAgent 連携)
    new RecallMemoryTool(),
    new SaveMemoryTool(),
    // 旧ツール (後方互換、将来廃止予定)
    new SaveExperienceTool(),
    new SaveKnowledgeTool(),
    new RecallExperienceTool(),
    new RecallKnowledgeTool(),
    new RecallPersonTool(),
  ];
}
