import { StructuredTool } from '@langchain/core/tools';
import { MemoryPlatform } from '../../../../models/PersonMemory.js';
import RecallMemoryTool from './recallMemory.js';
import SaveMemoryTool from './saveMemory.js';
import SavePersonMemoryTool from './savePersonMemory.js';

/** 記憶ツール: recall-memory / save-memory / save-person-memory（実行ごとに MemoryPort を注入） */
export function createMemoryTools(
  _platform: MemoryPlatform = 'discord',
  _source: string = 'discord',
): StructuredTool[] {
  return [
    new RecallMemoryTool(),
    new SaveMemoryTool(),
    new SavePersonMemoryTool(),
  ];
}
