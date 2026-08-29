import { describe, expect, it } from 'vitest';
import { FcaError, runFcaLoop, type FcaModel } from '../../src/modules/fca/index.js';
import { scheduledPostTools } from '../../src/services/llm/agents/scheduledPostSkills.js';

describe('scheduled post FCA catalog', () => {
  it('searches through injected ports and finishes on submit_post without sending', async () => {
    const web = async () => 'untrusted web';
    const wikipedia = async () => 'untrusted wiki';
    const tools = scheduledPostTools({ web, wikipedia });
    expect(tools.map(t => t.name)).toEqual(['google-search', 'search-by-wikipedia', 'submit_post']);
    let turn = 0;
    const model: FcaModel = { next: async input => {
      turn += 1;
      expect(input.tools.map(t => t.name)).toEqual(['google-search', 'search-by-wikipedia', 'submit_post']);
      if (turn === 1) return { content: '', toolCalls: [{ id: 's1', name: 'google-search', arguments: { query: 'ai news' } }] };
      return { content: '', toolCalls: [{ id: 's2', name: 'submit_post', arguments: { text: 'draft', imagePrompt: 'cute landscape' } }] };
    } };
    const result = await runFcaLoop({
      system: 'write a scheduled post',
      messages: [{ role: 'user', content: 'today' }],
      tools, model, signal: new AbortController().signal,
      limits: { maxTurns: 6, maxToolCalls: 8, maxToolCallsPerTurn: 2 },
      policy: { kind: 'terminal-tool', name: 'submit_post', drain: 'until-terminal' },
    });
    expect(result.stop).toBe('terminal');
    expect(result.value).toEqual({ text: 'draft', imagePrompt: 'cute landscape' });
    expect(result.messages.some(m => m.role === 'tool' && m.content.includes('untrusted web'))).toBe(true);
  });

  it('does not register a Twitter send tool', async () => {
    const tools = scheduledPostTools({ web: async () => '', wikipedia: async () => '' });
    const model: FcaModel = { next: async () => ({ content: '', toolCalls: [{ id: 'x', name: 'post-on-twitter', arguments: {} }] }) };
    await expect(runFcaLoop({
      system: 's', messages: [], tools, model, signal: new AbortController().signal,
      limits: { maxTurns: 2, maxToolCalls: 4, maxToolCallsPerTurn: 2 },
      policy: { kind: 'terminal-tool', name: 'submit_post', drain: 'until-terminal' },
    })).rejects.toMatchObject({ code: 'FCA_TOOL_NOT_ALLOWED' });
    expect(new FcaError('FCA_TOOL_NOT_ALLOWED').name).toBe('FcaError');
  });
});
