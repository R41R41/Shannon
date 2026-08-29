import type { StructuredTool } from '@langchain/core/tools';
import { runFcaLoop, type FcaBoundTool, type FcaModel, type FcaRunResult } from '../../../../modules/fca/index.js';
import type { ExecutionResult } from '../../types.js';

function asArgs(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

const completeTool: FcaBoundTool = {
  name: 'task-complete', description: 'Finish this conversation turn with a user-visible summary.',
  parameters: { type: 'object', properties: { summary: { type: 'string' } }, additionalProperties: true },
  async execute(args) { return { content: 'done', done: true, value: asArgs(args) }; },
};

export function langchainToolsForFca(tools: StructuredTool[]): FcaBoundTool[] {
  return tools.filter(tool => tool.name !== 'task-complete').map(tool => ({
    name: tool.name,
    description: (tool.description || tool.name).slice(0, 2000),
    parameters: { type: 'object', additionalProperties: true },
    async execute(args, signal) {
      const content = await tool.invoke(asArgs(args), { signal });
      const text = typeof content === 'string' ? content : JSON.stringify(content);
      return { content: text };
    },
  }));
}

export async function runConversationFca(input: {
  system: string; goal: string; tools: StructuredTool[]; model: FcaModel; signal: AbortSignal;
  maxTurns: number; maxElapsedMs: number; needsTools?: boolean;
  filterCalls?: (calls: readonly { id: string; name: string; arguments: unknown }[]) => readonly { id: string; name: string; arguments: unknown }[];
  onTools?: (results: ExecutionResult[]) => void;
  ephemeral?: (turn: number) => readonly { role: 'system' | 'user'; content: string }[] | Promise<readonly { role: 'system' | 'user'; content: string }[]>;
}): Promise<FcaRunResult> {
  const registered = input.tools.find(tool => tool.name === 'task-complete');
  const catalog = [...langchainToolsForFca(input.tools), registered ? {
    ...completeTool,
    async execute(args, signal) {
      const content = await registered.invoke(asArgs(args), { signal });
      return { content: typeof content === 'string' ? content : JSON.stringify(content), done: true, value: asArgs(args) };
    },
  } : completeTool];
  let textOnly = 0; let worked = false;
  return runFcaLoop({
    system: input.system, messages: [{ role: 'user', content: input.goal }], tools: catalog, model: input.model,
    signal: input.signal, now: () => Date.now(),
    limits: { maxTurns: input.maxTurns, maxToolCalls: 64, maxToolCallsPerTurn: 8, maxElapsedMs: input.maxElapsedMs },
    policy: { kind: 'terminal-tool', name: 'task-complete', drain: 'all' },
    hooks: {
      beforeModel: async ({ turn }) => ({ ephemeral: [...(await input.ephemeral?.(turn) ?? [])] }),
      planCalls: (calls) => {
        const filtered = input.filterCalls ? [...input.filterCalls(calls)] : [...calls];
        const allowed = new Set(filtered.map(call => call.id));
        const synthetic = calls.filter(call => !allowed.has(call.id)).map(call => ({
          call, content: `結果: 失敗 詳細: ⚠️ ${call.name} の実行がブロックされました。別のアプローチを試してください。 [failure_type=loop_blocked recoverable=true]`,
        }));
        const complete = filtered.find(call => call.name === 'task-complete');
        const onlyComplete = filtered.length === 1 && complete;
        if (complete && input.needsTools !== false && onlyComplete && !worked) {
          return { execute: filtered.filter(call => call.name !== 'task-complete'), synthetic: [...synthetic, { call: complete, content: 'Rejected: you have not used any tools yet. This task requires tool use (e.g., search, fetch). Gather the needed information first, then call task-complete with the full answer in summary.' }] };
        }
        if (filtered.some(call => call.name !== 'task-complete' && call.name !== 'update-plan')) worked = true;
        return { execute: filtered, synthetic };
      },
      onTextOnly: ({ turn, content }) => {
        const text = content.trim();
        if (input.needsTools === false && turn === 1 && text.length >= 30) return 'complete';
        textOnly += 1;
        return textOnly >= 3 ? 'complete' : 'continue';
      },
      afterTools: (event) => {
        if (event.results.some(row => row.call.name !== 'task-complete' && row.call.name !== 'update-plan')) worked = true;
        input.onTools?.(event.results.map(row => ({
          toolName: row.call.name, args: asArgs(row.call.arguments), success: !row.content.includes('失敗'),
          message: row.content, duration: 0,
        })));
        return 'continue';
      },
    },
  });
}
