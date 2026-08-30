import { describe, expect, it } from 'vitest';
import { fcaHistoryToLangChain } from '../../src/services/fca/openAiFcaModel.js';

describe('fcaHistoryToLangChain', () => {
  it('keeps a single leading system message when ephemeral system turns exist', () => {
    const messages = fcaHistoryToLangChain('base system', [
      { role: 'user', content: '明日の東京の天気は？' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'request-tools', arguments: { names: ['weather'] } }] },
      { role: 'tool', content: '{"requested":["weather"]}', toolCallId: 'call_1' },
      { role: 'system', content: '【初期記憶コンテキスト】none' },
    ]);
    const types = messages.map(message => message._getType());
    expect(types[0]).toBe('system');
    expect(types.slice(1).includes('system')).toBe(false);
    expect(messages[0].content).toContain('base system');
    expect(messages[0].content).toContain('【初期記憶コンテキスト】none');
  });
});
