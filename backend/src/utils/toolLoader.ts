/**
 * Shared tool loader utility.
 *
 * Dynamically loads StructuredTool classes from a directory.
 * Each .ts/.js file in the directory should have a default export
 * that is a StructuredTool class constructor.
 *
 * Supports nested subdirectories — tool files placed in child folders
 * (e.g., tools/image/, tools/search/) are discovered automatically.
 *
 * Usage:
 *   import { loadToolsFromDirectory } from '../../utils/toolLoader.js';
 *   const tools = await loadToolsFromDirectory(join(__dirname, '../tools'));
 */
import { readdirSync, statSync } from 'fs';
import { join, basename } from 'path';
import { StructuredTool } from '@langchain/core/tools';
import { logger } from './logger.js';

/**
 * Recursively collects .ts/.js tool file paths from a directory tree.
 *
 * @param dir          Directory to scan.
 * @param excludeDirs  Set of directory base-names to skip (e.g., 'memory').
 */
function collectToolFiles(dir: string, excludeDirs: Set<string>): string[] {
  const results: string[] = [];

  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      if (excludeDirs.has(entry)) continue;
      results.push(...collectToolFiles(fullPath, excludeDirs));
    } else if (
      stat.isFile() &&
      (entry.endsWith('.ts') || entry.endsWith('.js')) &&
      !entry.includes('.d.ts') &&
      entry !== 'index.ts' &&
      entry !== 'index.js'
    ) {
      results.push(fullPath);
    }
  }

  return results;
}

export interface LoadToolsOptions {
  /** Optional label for log messages (e.g., 'LLM', 'Minebot'). */
  label?: string;
  /** Directory base-names to skip during recursive scan (e.g., ['memory']). */
  excludeDirs?: string[];
}

/**
 * Dynamically loads tool classes from a directory (and its subdirectories).
 *
 * @param toolsDir  Absolute path to the directory containing tool files.
 * @param labelOrOptions  Label string or options object.
 * @returns         Array of instantiated StructuredTool objects.
 */
export async function loadToolsFromDirectory(
  toolsDir: string,
  labelOrOptions: string | LoadToolsOptions = 'Tools'
): Promise<StructuredTool[]> {
  const opts: LoadToolsOptions =
    typeof labelOrOptions === 'string'
      ? { label: labelOrOptions }
      : labelOrOptions;

  const label = opts.label ?? 'Tools';
  const excludeDirs = new Set(opts.excludeDirs ?? []);

  const toolFiles = collectToolFiles(toolsDir, excludeDirs);

  const tools: StructuredTool[] = [];

  for (const filePath of toolFiles) {
    try {
      const toolModule = await import(filePath);
      const ToolClass = toolModule.default;
      if (ToolClass?.prototype?.constructor) {
        tools.push(new ToolClass());
      }
    } catch (error) {
      logger.error(`[${label}] Tool loading error: ${filePath}`, error);
    }
  }

  logger.success(`[${label}] ${tools.length} tools loaded`);
  return tools;
}
