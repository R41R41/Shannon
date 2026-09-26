import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import {
  normalizeAIMessageToolCalls,
  repairMissingToolResults,
} from '../../src/services/llm/utils/toolCallMessages';

describe('tool call message compatibility', () => {
  it('promotes legacy OpenAI tool calls into normalized LangChain calls', () => {
    const message = new AIMessage({
      content: '調査します',
      additional_kwargs: {
        tool_calls: [
          {
            id: 'call_places',
            type: 'function',
            function: { name: 'search-places', arguments: '{"query":"浜松"}' },
          },
          {
            id: 'call_route',
            type: 'function',
            function: { name: 'compute-route', arguments: '{"origin":"浜松駅"}' },
          },
        ],
      },
    });

    const normalized = normalizeAIMessageToolCalls(message);

    expect(normalized.tool_calls).toEqual([
      { id: 'call_places', name: 'search-places', args: { query: '浜松' } },
      { id: 'call_route', name: 'compute-route', args: { origin: '浜松駅' } },
    ]);
    expect(normalized.additional_kwargs.tool_calls).toBeUndefined();
  });

  it('adds only the missing result when a parallel tool batch is incomplete', () => {
    const assistant = new AIMessage({
      content: '',
      tool_calls: [
        { id: 'call_a', name: 'search-places', args: { query: 'A' }, type: 'tool_call' },
        { id: 'call_b', name: 'search-places', args: { query: 'B' }, type: 'tool_call' },
      ],
    });
    const existingResult = new ToolMessage({ tool_call_id: 'call_a', content: 'A result' });
    const nextTurn = new HumanMessage('continue');

    const result = repairMissingToolResults([assistant, existingResult, nextTurn]);

    expect(result.repairedCallIds).toEqual(['call_b']);
    expect(result.messages).toHaveLength(4);
    expect((result.messages[2] as ToolMessage).tool_call_id).toBe('call_b');
    expect(result.messages[3]).toBe(nextTurn);
  });

  it('does not modify a complete parallel tool batch', () => {
    const assistant = new AIMessage({
      content: '',
      tool_calls: [{ id: 'call_a', name: 'search-places', args: {}, type: 'tool_call' }],
    });
    const toolResult = new ToolMessage({ tool_call_id: 'call_a', content: 'ok' });

    const result = repairMissingToolResults([assistant, toolResult]);

    expect(result.repairedCallIds).toEqual([]);
    expect(result.messages).toEqual([assistant, toolResult]);
  });
});
