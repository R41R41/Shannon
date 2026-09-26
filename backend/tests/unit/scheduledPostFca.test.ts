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
      if (turn === 1) return { content: '', toolCalls: [{ id: 's1', name: 'google-search', arguments: { query: 'ai news', dateRestrict: 'd1', gl: 'jp', lr: 'lang_ja' } }] };
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

  it('passes dateRestrict and locale to the web port', async () => {
    const seen: unknown[] = [];
    const tools = scheduledPostTools({
      web: async input => { seen.push(input); return 'ok'; },
      wikipedia: async () => 'wiki',
    });
    await tools[0].execute({ query: 'AI news', dateRestrict: 'd1', gl: 'jp', lr: 'lang_ja' }, new AbortController().signal);
    expect(seen[0]).toEqual({ query: 'AI news', dateRestrict: 'd1', gl: 'jp', lr: 'lang_ja' });
  });

  it('enforces per-tool budgets without crashing the FCA kernel', async () => {
    const tools = scheduledPostTools({ web: async () => 'ok', wikipedia: async () => 'wiki' }, { maxWebCalls: 1, maxWikiCalls: 1 });
    await tools[0].execute({ query: 'one' }, new AbortController().signal);
    await expect(tools[0].execute({ query: 'two' }, new AbortController().signal)).rejects.toThrow('SCHEDULED_POST_TOOL_BUDGET');
  });

  it('rejects malformed optional search controls instead of silently dropping them', async () => {
    const tools = scheduledPostTools({ web: async () => 'ok', wikipedia: async () => 'wiki' });
    await expect(tools[0].execute({ query: 'news', dateRestrict: 'y1' }, new AbortController().signal))
      .rejects.toThrow('SCHEDULED_POST_TOOL_INPUT');
    await expect(tools[0].execute({ query: 'news', gl: 'Japan' }, new AbortController().signal))
      .rejects.toThrow('SCHEDULED_POST_TOOL_INPUT');
    await expect(tools[0].execute({ query: 'news', unexpected: true }, new AbortController().signal))
      .rejects.toThrow('SCHEDULED_POST_TOOL_INPUT');
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
