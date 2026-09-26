import { ToolMessage } from '@langchain/core/messages';
import { StructuredTool } from '@langchain/core/tools';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  attachRouteMapToTravelBrief,
  extractEncodedRoutePolyline,
  ToolExecutor,
} from '../../../src/services/llm/graph/nodes/execution/ToolExecutor';

class DelayTool extends StructuredTool {
  schema = z.object({ delay: z.number() });
  constructor(
    public name: string,
    private readonly onStart: () => void,
    private readonly onEnd: () => void,
  ) { super(); }
  description = 'test tool';
  async _call({ delay }: { delay: number }): Promise<string> {
    this.onStart();
    await new Promise((resolve) => setTimeout(resolve, delay));
    this.onEnd();
    return `done:${this.name}`;
  }
}

describe('ToolExecutor parallel scheduling', () => {
  it('carries a computed route into the travel brief call', () => {
    const encodedPolyline = 'abc123_polyline';
    expect(extractEncodedRoutePolyline(JSON.stringify({
      provider: 'google_routes',
      polyline: { encodedPolyline },
    }))).toBe(encodedPolyline);

    const call = attachRouteMapToTravelBrief({
      name: 'create-travel-brief',
      args: { title: '浜松日帰り旅' },
    }, encodedPolyline);
    expect(call.args.routeMap).toEqual({
      encodedPolyline,
      caption: 'Google Routes APIで算出した移動ルート',
    });
  });

  it('read-only calls run concurrently while results stay in model call order', async () => {
    let active = 0;
    let maxActive = 0;
    const start = () => { active++; maxActive = Math.max(maxActive, active); };
    const end = () => { active--; };
    const tools = [
      new DelayTool('google-search', start, end),
      new DelayTool('fetch-url', start, end),
    ];
    const executor = new ToolExecutor({ publishTaskTree() {} } as any);
    const messages: ToolMessage[] = [];
    const output = await executor.executeToolCalls([
      { id: 'first', name: 'google-search', args: { delay: 35 } },
      { id: 'second', name: 'fetch-url', args: { delay: 5 } },
    ], new Map(tools.map((tool) => [tool.name, tool])), messages, {
      goal: 'test', platform: 'discord', channelId: 'channel', taskId: 'task',
      context: { platform: 'discord' }, steps: [], stepCounter: 0, lastThinkingContent: null,
    });

    expect(maxActive).toBe(2);
    expect(output.results.map((result) => result.toolName)).toEqual(['google-search', 'fetch-url']);
    expect(messages.map((message) => message.tool_call_id)).toEqual(['first', 'second']);
  });

  it('unknown mutating tools remain a sequential barrier', async () => {
    const order: string[] = [];
    const make = (name: string) => new DelayTool(name, () => order.push(`start:${name}`), () => order.push(`end:${name}`));
    const tools = [make('google-search'), make('write-tool'), make('fetch-url')];
    const executor = new ToolExecutor({ publishTaskTree() {} } as any);
    await executor.executeToolCalls([
      { name: 'google-search', args: { delay: 1 } },
      { name: 'write-tool', args: { delay: 1 } },
      { name: 'fetch-url', args: { delay: 1 } },
    ], new Map(tools.map((tool) => [tool.name, tool])), [], {
      goal: 'test', platform: 'discord', channelId: 'channel', taskId: 'task',
      context: { platform: 'discord' }, steps: [], stepCounter: 0, lastThinkingContent: null,
    });

    expect(order).toEqual([
      'start:google-search', 'end:google-search',
      'start:write-tool', 'end:write-tool',
      'start:fetch-url', 'end:fetch-url',
    ]);
  });
});
