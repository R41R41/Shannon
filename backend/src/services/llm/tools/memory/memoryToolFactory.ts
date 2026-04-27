import { StructuredTool } from '@langchain/core/tools';
import { MemoryPlatform } from '../../../../models/PersonMemory.js';
import { PersonMemoryService } from '../../../memory/personMemoryService.js';
import { ShannonMemoryService } from '../../../memory/shannonMemoryService.js';
import SaveExperienceTool from './saveExperience.js';
import SaveKnowledgeTool from './saveKnowledge.js';
import RecallExperienceTool from './recallExperience.js';
import RecallKnowledgeTool from './recallKnowledge.js';
import RecallPersonTool from './recallPerson.js';

/**
 * 記憶ツールを作成するファクトリ関数
 *
 * save-experience / save-knowledge / recall-experience / recall-knowledge / recall-person
 * の直接アクセス版のみを提供する。
 */
export function createMemoryTools(
  platform: MemoryPlatform = 'discord',
  source: string = 'discord',
): StructuredTool[] {
  const personService = PersonMemoryService.getInstance();
  const shannonService = ShannonMemoryService.getInstance();

  return [
    new SaveExperienceTool(shannonService, source),
    new SaveKnowledgeTool(shannonService, source),
    new RecallExperienceTool(shannonService),
    new RecallKnowledgeTool(shannonService),
    new RecallPersonTool(personService, platform),
  ];
}
