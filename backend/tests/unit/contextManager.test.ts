import { AIMessageChunk, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import { trimContext } from '../../src/services/llm/utils/contextManager';

describe('trimContext', () => {
  it('AIMessageChunkのtool_useとToolMessageを分離しない', () => {
    const toolCallId = 'tool-call-1';
    const messages = [
      new SystemMessage('system'),
      new HumanMessage('old context'),
      new AIMessageChunk({
        content: 'x'.repeat(700),
        tool_calls: [{ id: toolCallId, name: 'google-search', args: { query: '浜松' }, type: 'tool_call' }],
      }),
      new ToolMessage({ content: 'short result', tool_call_id: toolCallId }),
      new HumanMessage('continue'),
    ];

    const trimmed = trimContext(messages, { maxContextTokens: 120, reservedForResponse: 0 });
    const hasToolResult = trimmed.some((message) => message.getType() === 'tool');
    const hasToolCall = trimmed.some(
      (message) => message.getType() === 'ai' && (message.tool_calls?.length ?? 0) > 0,
    );

    expect(hasToolResult).toBe(hasToolCall);
  });
});
