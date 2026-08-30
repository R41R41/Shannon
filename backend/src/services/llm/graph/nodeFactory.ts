/**
 * Node Factory
 *
 * Standalone initialization of the FunctionCallingAgent and its tools.
 * Unified graph 専用のノード初期化。
 */

import { StructuredTool } from '@langchain/core/tools';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { isTwitterWriteTool } from '../../../modules/access/toolCatalog.js';
import { loadToolsFromDirectory } from '../../../utils/toolLoader.js';
import { FunctionCallingAgent } from './nodes/FunctionCallingAgent.js';
import { createMemoryTools } from '../tools/memory/memoryToolFactory.js';
import { ScopedMemoryService } from '../../memory/scopedMemoryService.js';
import { logger } from '../../../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface ShannonNodes {
  fca: FunctionCallingAgent;
  tools: StructuredTool[];
}

/**
 * Initialize all nodes needed by the unified Shannon graph.
 *
 * - Loads tools from the tools directory
 * - Creates memory tools
 * - Legacy unscoped memory maintenance is disabled until migration.
 * - Creates FunctionCallingAgent with all tools
 * - Warms up ScopedMemoryService
 */
export async function initializeNodes(): Promise<ShannonNodes> {
  // 1. Load tools
  const toolsDir = join(__dirname, '../tools');
  const tools = (await loadToolsFromDirectory(toolsDir, {
    label: 'LLM',
    excludeDirs: ['memory'],
  })).filter(tool => !isTwitterWriteTool(tool.name));

  // 2. Add memory tools
  const memoryTools = createMemoryTools();
  tools.push(...memoryTools);

  // 3. No unscoped backfill/consolidation at startup.

  // 4. ScopedMemoryService singleton warm-up
  ScopedMemoryService.getInstance();

  // 5. FunctionCallingAgent
  const fca = new FunctionCallingAgent(tools);

  logger.info('Nodes initialized (FCA + tools)');

  return { fca, tools };
}
