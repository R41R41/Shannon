import { StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { runFcaLoop, type FcaBoundTool, type FcaModel, type FcaRunResult } from '../../../../modules/fca/index.js';
import type { ExecutionResult } from '../../types.js';

export const REQUEST_TOOLS_NAME = 'request-tools';

function asArgs(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function requestedNames(args: unknown): string[] {
  const obj = asArgs(args);
  const raw = obj.names ?? obj.name;
  const list = Array.isArray(raw) ? raw : raw != null ? [raw] : [];
  return list
    .flatMap(value => String(value).split(','))
    .map(name => name.trim())
    .filter(name => name.length > 0);
}

export function catalogLinesForPrompt(tools: readonly { name: string; description?: string }[]): string {
  return tools
    .filter(tool => tool.name !== 'task-complete' && tool.name !== REQUEST_TOOLS_NAME)
    .map(tool => {
      const line = (tool.description || tool.name).split(/\n/)[0].trim().slice(0, 160);
      return `- ${tool.name}: ${line}`;
    })
    .join('\n');
}

export function conversationLoadPrompt(catalog: string): string {
  return `
## 会話の進め方（この節を優先。上の「テキストだけでは完了しない」「毎ターン思考を述べよ」「update-plan」「check-inventory」は会話では無視）
今呼べるのは ${REQUEST_TOOLS_NAME} と task-complete だけ。実体の道具はまだ bind されていない。

カタログ（名前はここからだけ）:
${catalog || '(なし)'}

道具なしで返せる（挨拶、お礼、意見、一般知識、作問、計算、証明、説明）なら ${REQUEST_TOOLS_NAME} を使わず、完成した返信を本文か task-complete の summary に書く。途中の計画や「次に解きます」だけで終わるな。
カタログにない道具（電卓、Python、Wolfram、コード実行）は存在しない。計算は自分でやれ。
使える道具を聞かれたら ${REQUEST_TOOLS_NAME} を使わず、上のカタログを本文で列挙する。
天気・ニュース・URL・画像・この場の履歴などカタログの実体が要るときだけ ${REQUEST_TOOLS_NAME} を1回呼び、names にカタログの名前を入れる。同じ names を繰り返すな。本文は空でよい。
挨拶と調べものが同じ文でも、調べものが要るなら ${REQUEST_TOOLS_NAME} だけ呼ぶ。挨拶は結果と一緒に後で書く。`;
}

export class RequestToolsTool extends StructuredTool {
  name = REQUEST_TOOLS_NAME;
  description = 'Load catalog tools by name for later turns. Call only when live data or an action is required.';
  schema = z.object({
    names: z.any().optional(),
    name: z.any().optional(),
  }).passthrough();
  async _call(data: Record<string, unknown>): Promise<string> {
    return JSON.stringify({ requested: requestedNames(data) });
  }
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
      try {
        const content = await tool.invoke(asArgs(args), { signal });
        const text = typeof content === 'string' ? content : JSON.stringify(content);
        return { content: text };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: `結果: 失敗 詳細: ${tool.name}: ${message}` };
      }
    },
  }));
}

export async function runConversationFca(input: {
  system: string; goal: string; tools: StructuredTool[]; model: FcaModel; signal: AbortSignal;
  maxTurns: number; maxElapsedMs: number; needsTools?: boolean; deferToolLoad?: boolean;
  filterCalls?: (calls: readonly { id: string; name: string; arguments: unknown }[]) => readonly { id: string; name: string; arguments: unknown }[];
  onTools?: (results: ExecutionResult[]) => void;
  ephemeral?: (turn: number) => readonly { role: 'system' | 'user'; content: string }[] | Promise<readonly { role: 'system' | 'user'; content: string }[]>;
}): Promise<FcaRunResult> {
  const inputTools = input.deferToolLoad && !input.tools.some(tool => tool.name === REQUEST_TOOLS_NAME)
    ? [new RequestToolsTool(), ...input.tools]
    : input.tools;
  const registered = inputTools.find(tool => tool.name === 'task-complete');
  const catalog = [...langchainToolsForFca(inputTools), registered ? {
    ...completeTool,
    async execute(args, signal) {
      try {
        const content = await registered.invoke(asArgs(args), { signal });
        return { content: typeof content === 'string' ? content : JSON.stringify(content), done: true, value: asArgs(args) };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: `結果: 失敗 詳細: task-complete: ${message}` };
      }
    },
  } : completeTool];
  const allowed = new Set(catalog.map(tool => tool.name).filter(name => name !== REQUEST_TOOLS_NAME && name !== 'task-complete'));
  const loaded = new Set<string>();
  const requestBase = catalog.find(tool => tool.name === REQUEST_TOOLS_NAME);
  const catalogForRun = catalog.map(tool => {
    if (tool.name !== REQUEST_TOOLS_NAME || !requestBase) return tool;
    return {
      ...requestBase,
      async execute(args: unknown) {
        const names = requestedNames(args);
        const added: string[] = [];
        const unknown: string[] = [];
        const already: string[] = [];
        for (const name of names) {
          if (!allowed.has(name)) unknown.push(name);
          else if (loaded.has(name)) already.push(name);
          else {
            loaded.add(name);
            added.push(name);
          }
        }
        if (added.length === 0) {
          const reason = names.length === 0
            ? 'names が空です。'
            : unknown.length
              ? `カタログにない: ${unknown.join(', ')}。電卓やコード実行器はない。計算・作問・説明は道具なしで答えよ。`
              : `すでに読み込み済み: ${already.join(', ')}。次は実体の道具を使うか、本文/task-complete で完成した答えを出せ。`;
          return { content: `結果: 失敗 詳細: ${reason}` };
        }
        return { content: JSON.stringify({ loaded: added, already, unknown }) };
      },
    };
  });
  const requestTool = catalogForRun.find(tool => tool.name === REQUEST_TOOLS_NAME);
  const completeBound = catalogForRun.find(tool => tool.name === 'task-complete');

  const toolsForTurn = (): FcaBoundTool[] => {
    if (!input.deferToolLoad || !requestTool) return catalogForRun;
    if (loaded.size === 0) {
      return completeBound ? [requestTool, completeBound] : [requestTool];
    }
    return catalogForRun.filter(tool =>
      tool.name === REQUEST_TOOLS_NAME || tool.name === 'task-complete' || loaded.has(tool.name),
    );
  };

  let textOnly = 0; let worked = false;
  return runFcaLoop({
    system: input.system, messages: [{ role: 'user', content: input.goal }], tools: catalogForRun, model: input.model,
    signal: input.signal, now: () => Date.now(),
    limits: { maxTurns: input.maxTurns, maxToolCalls: 64, maxToolCallsPerTurn: 8, maxElapsedMs: input.maxElapsedMs },
    policy: { kind: 'terminal-tool', name: 'task-complete', drain: 'all' },
    hooks: {
      beforeModel: async ({ turn }) => ({
        ephemeral: [...(await input.ephemeral?.(turn) ?? [])],
        ...(input.deferToolLoad ? { tools: toolsForTurn() } : {}),
      }),
      planCalls: (calls) => {
        const filtered = input.filterCalls ? [...input.filterCalls(calls)] : [...calls];
        const allowedIds = new Set(filtered.map(call => call.id));
        const synthetic = calls.filter(call => !allowedIds.has(call.id)).map(call => ({
          call, content: `結果: 失敗 詳細: ⚠️ ${call.name} の実行がブロックされました。別のアプローチを試してください。 [failure_type=loop_blocked recoverable=true]`,
        }));
        const complete = filtered.find(call => call.name === 'task-complete');
        const onlyComplete = filtered.length === 1 && complete;
        if (complete && input.needsTools !== false && onlyComplete && !worked) {
          return { execute: filtered.filter(call => call.name !== 'task-complete'), synthetic: [...synthetic, { call: complete, content: 'Rejected: you have not used any tools yet. This task requires tool use (e.g., search, fetch). Gather the needed information first, then call task-complete with the full answer in summary.' }] };
        }
        if (filtered.some(call => call.name !== 'task-complete' && call.name !== 'update-plan' && call.name !== REQUEST_TOOLS_NAME)) worked = true;
        return { execute: filtered, synthetic };
      },
      onTextOnly: ({ turn, content }) => {
        const text = content.trim();
        if (input.deferToolLoad && loaded.size === 0 && text) return 'complete';
        if (input.needsTools === false && turn === 1 && text) return 'complete';
        textOnly += 1;
        return textOnly >= 3 ? 'complete' : 'continue';
      },
      afterTools: (event) => {
        if (event.results.some(row => row.call.name !== 'task-complete' && row.call.name !== 'update-plan' && row.call.name !== REQUEST_TOOLS_NAME)) worked = true;
        input.onTools?.(event.results.map(row => ({
          toolName: row.call.name, args: asArgs(row.call.arguments), success: !row.content.includes('失敗'),
          message: row.content, duration: 0,
        })));
        return 'continue';
      },
    },
  });
}
