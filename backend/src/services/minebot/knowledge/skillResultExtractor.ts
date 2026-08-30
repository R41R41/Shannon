/**
 * スキル実行結果から構造化データを抽出して WorldKnowledgeService に保存する。
 * InstantSkill.run() の後処理として呼ばれる。
 */
import { WorldKnowledgeService } from './WorldKnowledgeService.js';
import { createLogger } from '../../../utils/logger.js';

const log = createLogger('Minebot:SkillExtractor');

interface Position { x: number; y: number; z: number }

interface SkillResult {
  success: boolean;
  result: string;
  duration?: number;
}

type Extractor = (args: string[], result: SkillResult, service: WorldKnowledgeService) => Promise<void>;

const EXTRACTORS: Record<string, Extractor> = {
  'find-blocks': async (args, result, service) => {
    if (!result.success) return;
    const blockName = args[0];
    if (!blockName) return;
    const posRegex = /\((-?\d+),\s*(-?\d+),\s*(-?\d+)\)/g;
    const positions: Position[] = [];
    let match;
    while ((match = posRegex.exec(result.result)) !== null) {
      positions.push({ x: parseInt(match[1]), y: parseInt(match[2]), z: parseInt(match[3]) });
    }
    if (positions.length > 0) {
      await service.recordBlocks(blockName, positions);
    }
  },

  'find-structure': async (args, result, service) => {
    if (!result.success) return;
    const structureType = args[0] || 'unknown';
    const posMatch = result.result.match(/\((-?\d+),\s*(-?\d+),\s*(-?\d+)\)/);
    if (posMatch) {
      await service.recordStructure(structureType, {
        x: parseInt(posMatch[1]), y: parseInt(posMatch[2]), z: parseInt(posMatch[3]),
      });
    }
  },

  'check-container': async (args, result, service) => {
    if (!result.success) return;
    const posMatch = result.result.match(/\((-?\d+),\s*(-?\d+),\s*(-?\d+)\)/);
    if (!posMatch) return;
    const position = { x: parseInt(posMatch[1]), y: parseInt(posMatch[2]), z: parseInt(posMatch[3]) };
    const containerType = result.result.match(/^(\w+)の中身/)?.[1] || 'chest';
    const contents: Array<{ name: string; count: number }> = [];
    const itemRegex = /(\w+)\s*x(\d+)/g;
    let itemMatch;
    while ((itemMatch = itemRegex.exec(result.result)) !== null) {
      contents.push({ name: itemMatch[1], count: parseInt(itemMatch[2]) });
    }
    await service.recordContainer(containerType, position, contents);
  },

  'get-position': async (args, result, service) => {
    // Position is extracted by the snapshot system, not here
  },

  'dig-block-at': async (args, result, service) => {
    if (!result.success) return;
    // Block has been removed — record as danger-free zone or remove from block cache
  },

  'attack-nearest': async (args, result, service) => {
    if (!result.success) return;
    const posMatch = result.result.match(/\((-?\d+),\s*(-?\d+),\s*(-?\d+)\)/);
    if (posMatch) {
      await service.recordDanger('hostile_mob', {
        x: parseInt(posMatch[1]), y: parseInt(posMatch[2]), z: parseInt(posMatch[3]),
      }, 6, `${args[0] || 'unknown'} が出現`);
    }
  },
};

/**
 * スキル結果からワールド知識を抽出して保存する。
 * 失敗しても例外を投げない（fire-and-forget）。
 */
export async function extractAndSaveKnowledge(
  skillName: string,
  args: string[],
  result: SkillResult,
  serverName: string,
): Promise<void> {
  const extractor = EXTRACTORS[skillName];
  if (!extractor) return;
  try {
    const service = WorldKnowledgeService.forServer(serverName);
    if (!service) return;
    await extractor(args, result, service);
  } catch (err) {
    log.debug(`知識抽出エラー (${skillName}): ${err}`);
  }
}
