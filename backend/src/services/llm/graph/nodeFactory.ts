/**
 * Node Factory
 *
 * Standalone initialization of EmotionNode, FunctionCallingAgent, and tools.
 * Unified graph 専用のノード初期化。
 */

import { StructuredTool } from '@langchain/core/tools';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { loadToolsFromDirectory } from '../../../utils/toolLoader.js';
import { EmotionNode } from './nodes/EmotionNode.js';
import { FunctionCallingAgent } from './nodes/FunctionCallingAgent.js';
import { createMemoryTools } from '../tools/memory/memoryToolFactory.js';
import { MemoryNode } from './nodes/MemoryNode.js';
import { ScopedMemoryService } from '../../memory/scopedMemoryService.js';
import { logger } from '../../../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface ShannonNodes {
  emotionNode?: EmotionNode;
  fca: FunctionCallingAgent;
  tools: StructuredTool[];
}

/**
 * Initialize all nodes needed by the unified Shannon graph.
 *
 * - Loads tools from the tools directory
 * - Creates memory tools
 * - Initializes EmotionNode
 * - Initializes MemoryNode (for maintenance scheduling only)
 * - Creates FunctionCallingAgent with all tools
 * - Warms up ScopedMemoryService
 */
export async function initializeNodes(): Promise<ShannonNodes> {
  // 1. Load tools
  const toolsDir = join(__dirname, '../tools');
  const tools = await loadToolsFromDirectory(toolsDir, {
    label: 'LLM',
    excludeDirs: ['memory'],
  });

  // 2. Add memory tools
  const memoryTools = createMemoryTools();
  tools.push(...memoryTools);

  // 3. EmotionNode (Phase 4: simplified graph では不要だが、full graph フォールバック用に保持)
  const emotionNode = process.env.SHANNON_GRAPH_VERSION === 'full'
    ? new EmotionNode()
    : undefined;

  // 4. MemoryNode — initialize for background maintenance (backfill, consolidation)
  const memoryNode = new MemoryNode();
  await memoryNode.initialize();

  // 5. ScopedMemoryService singleton warm-up
  ScopedMemoryService.getInstance();

  // 6. FunctionCallingAgent
  const fca = new FunctionCallingAgent(tools);

  const graphMode = process.env.SHANNON_GRAPH_VERSION === 'full' ? 'full' : 'simplified';
  logger.info(`Nodes initialized (FCA + tools, graph: ${graphMode})`);

  return { emotionNode, fca, tools };
}
