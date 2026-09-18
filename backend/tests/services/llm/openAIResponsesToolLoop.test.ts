import { describe, expect, it, vi } from 'vitest';
import {
  OpenAIResponsesToolLoop,
  parseFunctionArguments,
  type ResponsesFunctionCall,
} from '../../../src/services/llm/responses/OpenAIResponsesToolLoop.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('OpenAIResponsesToolLoop', () => {
  it('pairs every function output with its call_id in a stateless typed-item chain', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        id: 'resp_1',
        output: [
          { type: 'function_call', call_id: 'call_a', name: 'google-search', arguments: '{"query":"Hamamatsu"}' },
          { type: 'function_call', call_id: 'call_b', name: 'search-weather', arguments: '{"location":"Hamamatsu"}' },
        ],
      }))
      .mockResolvedValueOnce(jsonResponse({
        id: 'resp_2',
        output_text: '調査が完了しました。',
        output: [],
      }));
    const execute = vi.fn(async (calls: ResponsesFunctionCall[]) => ({
      outputs: calls.map((call) => ({ callId: call.call_id, output: `${call.name}: ok` })),
    }));
    const loop = new OpenAIResponsesToolLoop('test-key', 'gpt-test', fetchMock as typeof fetch);

    const result = await loop.run({
      instructions: 'test',
      input: '旅行資料を作成',
      tools: [],
      execute,
      maxTurns: 3,
    });

    expect(result.outputText).toBe('調査が完了しました。');
    expect(result.turns).toBe(2);
    expect(execute).toHaveBeenCalledTimes(1);
    const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    expect(secondBody.previous_response_id).toBeUndefined();
    expect(secondBody.input).toEqual([
      { role: 'user', content: '旅行資料を作成' },
      { type: 'function_call', call_id: 'call_a', name: 'google-search', arguments: '{"query":"Hamamatsu"}' },
      { type: 'function_call', call_id: 'call_b', name: 'search-weather', arguments: '{"location":"Hamamatsu"}' },
      { type: 'function_call_output', call_id: 'call_a', output: 'google-search: ok' },
      { type: 'function_call_output', call_id: 'call_b', output: 'search-weather: ok' },
    ]);
    expect(secondBody.instructions).toBe('test');
    expect(secondBody.store).toBe(false);
  });

  it('can stop immediately on an orchestration terminal state', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      id: 'resp_pause',
      output: [{ type: 'function_call', call_id: 'call_pause', name: 'ask-user-on-discord', arguments: '{}' }],
    }));
    const loop = new OpenAIResponsesToolLoop('test-key', 'gpt-test', fetchMock as typeof fetch);

    const result = await loop.run({
      instructions: 'test',
      input: 'test',
      tools: [],
      execute: async () => ({ outputs: [], terminal: { status: 'awaiting_user' } }),
    });

    expect(result.terminal).toEqual({ status: 'awaiting_user' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('parses function arguments and rejects malformed JSON', () => {
    expect(parseFunctionArguments({
      type: 'function_call', call_id: '1', name: 'tool', arguments: '{"value":1}',
    })).toEqual({ value: 1 });
    expect(() => parseFunctionArguments({
      type: 'function_call', call_id: '2', name: 'tool', arguments: '{',
    })).toThrow(/Invalid JSON arguments/);
  });
});
