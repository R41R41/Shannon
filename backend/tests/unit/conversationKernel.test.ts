import { describe, expect, it } from 'vitest';
import { StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import {
  catalogLinesForPrompt,
  REQUEST_TOOLS_NAME,
  RequestToolsTool,
  runConversationFca,
} from '../../src/services/llm/graph/nodes/conversationKernel.js';
import type { FcaModel } from '../../src/modules/fca/index.js';

class SearchTool extends StructuredTool {
  name = 'google-search';
  description = 'Search the public web for current facts.';
  schema = z.object({ query: z.string() });
  async _call(): Promise<string> { return 'sunny'; }
}

class DoneTool extends StructuredTool {
  name = 'task-complete';
  description = 'Finish';
  schema = z.object({ summary: z.string() });
  async _call(data: { summary: string }): Promise<string> { return data.summary; }
}

describe('conversation catalog lines', () => {
  it('maps tool descriptions instead of a hardcoded name list', () => {
    const lines = catalogLinesForPrompt([
      new RequestToolsTool(),
      new SearchTool(),
      new DoneTool(),
    ]);
    expect(lines).toContain('google-search: Search the public web for current facts.');
    expect(lines).not.toContain('request-tools');
    expect(lines).not.toContain('task-complete');
  });
});

describe('deferred conversation FCA', () => {
  it('answers a greeting on turn 1 with request-tools and task-complete bound', async () => {
    const seen: string[][] = [];
    const model: FcaModel = {
      next: async (input) => {
        seen.push(input.tools.map(tool => tool.name).sort());
        return { content: 'こんにちは', toolCalls: [] };
      },
    };
    const result = await runConversationFca({
      system: 's', goal: 'こんにちは', tools: [new SearchTool(), new DoneTool()], model,
      signal: new AbortController().signal, maxTurns: 4, maxElapsedMs: 10_000,
      deferToolLoad: true, needsTools: false,
    });
    expect(result.stop).toBe('complete');
    expect(result.turns).toBe(1);
    expect(result.content).toBe('こんにちは');
    expect(seen).toEqual([[REQUEST_TOOLS_NAME, 'task-complete'].sort()]);
  });

  it('loads a requested catalog tool on the next turn', async () => {
    const seen: string[][] = [];
    let turn = 0;
    const model: FcaModel = {
      next: async (input) => {
        seen.push(input.tools.map(tool => tool.name).sort());
        turn += 1;
        if (turn === 1) {
          return { content: '', toolCalls: [{ id: 'r1', name: REQUEST_TOOLS_NAME, arguments: { names: 'google-search' } }] };
        }
        if (turn === 2) {
          return { content: '', toolCalls: [{ id: 's1', name: 'google-search', arguments: { query: 'weather' } }] };
        }
        return { content: '', toolCalls: [{ id: 'd1', name: 'task-complete', arguments: { summary: '晴れ' } }] };
      },
    };
    const result = await runConversationFca({
      system: 's', goal: '明日の天気は？', tools: [new SearchTool(), new DoneTool()], model,
      signal: new AbortController().signal, maxTurns: 6, maxElapsedMs: 10_000,
      deferToolLoad: true, needsTools: false,
    });
    expect(result.stop).toBe('terminal');
    expect(seen[0]).toEqual([REQUEST_TOOLS_NAME, 'task-complete'].sort());
    expect(seen[1]).toEqual(['google-search', REQUEST_TOOLS_NAME, 'task-complete'].sort());
    expect(result.value).toEqual({ summary: '晴れ' });
  });

  it('rejects unknown catalog names and answers without looping request-tools', async () => {
    const seen: string[][] = [];
    const toolResults: string[] = [];
    let turn = 0;
    const model: FcaModel = {
      next: async (input) => {
        seen.push(input.tools.map(tool => tool.name).sort());
        turn += 1;
        if (turn === 1) {
          return { content: '', toolCalls: [{ id: 'r1', name: REQUEST_TOOLS_NAME, arguments: { names: ['calculator'] } }] };
        }
        return { content: '', toolCalls: [{ id: 'd1', name: 'task-complete', arguments: { summary: '面積は 8' } }] };
      },
    };
    const result = await runConversationFca({
      system: 's', goal: '二次不等式の面積', tools: [new SearchTool(), new DoneTool()], model,
      signal: new AbortController().signal, maxTurns: 6, maxElapsedMs: 10_000,
      deferToolLoad: true, needsTools: false,
      onTools: (rows) => { toolResults.push(...rows.map(row => `${row.toolName}:${row.success}:${row.message}`)); },
    });
    expect(result.stop).toBe('terminal');
    expect(result.value).toEqual({ summary: '面積は 8' });
    expect(seen[0]).toEqual([REQUEST_TOOLS_NAME, 'task-complete'].sort());
    expect(seen[1]).toEqual([REQUEST_TOOLS_NAME, 'task-complete'].sort());
    expect(toolResults[0]).toContain('calculator');
    expect(toolResults[0]).toContain('失敗');
  });

  it('returns a tool error instead of crashing the session when schema does not match', async () => {
    let turn = 0;
    const model: FcaModel = {
      next: async () => {
        turn += 1;
        if (turn === 1) {
          return { content: '', toolCalls: [{ id: 'r1', name: REQUEST_TOOLS_NAME, arguments: { names: ['google-search'] } }] };
        }
        if (turn === 2) {
          return { content: '', toolCalls: [{ id: 's1', name: 'google-search', arguments: { wrong: true } }] };
        }
        return { content: '', toolCalls: [{ id: 'd1', name: 'task-complete', arguments: { summary: '検索できなかった' } }] };
      },
    };
    const result = await runConversationFca({
      system: 's', goal: '調べて', tools: [new SearchTool(), new DoneTool()], model,
      signal: new AbortController().signal, maxTurns: 6, maxElapsedMs: 10_000,
      deferToolLoad: true, needsTools: false,
    });
    expect(result.stop).toBe('terminal');
    expect(result.messages.some(message => message.role === 'tool' && String(message.content).includes('did not match expected schema'))).toBe(true);
  });
});
