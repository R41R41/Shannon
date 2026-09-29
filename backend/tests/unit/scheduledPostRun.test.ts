import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  looksLikePostMetaLeak,
  looksLikeStaleNews,
  runScheduledPost,
  type ScheduledPostSpec,
} from '../../src/services/llm/agents/scheduledPostRun.js';
import type { ScheduledPostSearchPorts } from '../../src/services/llm/agents/scheduledPostSkills.js';

const control = vi.hoisted(() => ({ next: null as null | ((input: any) => Promise<any>), created: 0 }));

vi.mock('../../src/services/fca/openAiFcaModel.js', () => ({
  createOpenAiFcaModel: () => {
    control.created += 1;
    let turn = 0;
    return {
      next: async (input: any) => {
        if (control.next) return control.next(input);
        turn += 1;
        if (turn === 1) {
          return {
            content: '',
            toolCalls: [{
              id: 'search1',
              name: 'google-search',
              arguments: { query: 'AI ニュース', dateRestrict: 'd1', gl: 'jp', lr: 'lang_ja' },
            }],
          };
        }
        return {
          content: '',
          toolCalls: [{
            id: 'submit1',
            name: 'submit_post',
            arguments: {
              text: 'OpenAIがGPT-6 Astraを発表しました。高度なPC操作能力が特徴です。ボクとしても実用化の速度に注目しています。',
              imagePrompt: 'photorealistic, high quality photograph of a modern data center, no people, no text',
            },
          }],
        };
      },
    };
  },
}));

vi.mock('../../src/services/llm/utils/langfuse.js', () => ({
  createTracedModel: () => ({
    invoke: async () => ({ content: JSON.stringify({ approved: true, issues: [], suggestion: '' }) }),
  }),
}));

const ports: ScheduledPostSearchPorts = {
  web: async () => '【1. GPT-6 Astra 発表】\nOpenAI latest\nURL: https://example.com',
  wikipedia: async () => 'Wikipedia summary',
};

const spec: ScheduledPostSpec = {
  kind: 'news',
  systemPrompt: 'test',
  reviewPrompt: 'test',
  header: '【今日のAIニュース】',
  logLabel: '[NewsTest]',
  temperature: 0.7,
  maxToolCalls: 14,
  toolBudgets: { maxWebCalls: 8, maxWikiCalls: 5 },
  fallbackText: 'fallback',
  reviewHuman: 'review',
  userPrompt: today => `date ${today}`,
};

describe('scheduledPostRun guards', () => {
  it('flags stale GPT-4 Turbo framed as new news', () => {
    expect(looksLikeStaleNews('OpenAIが新たに発表したGPT-4 Turboは高速です')).toBe('GPT-4 Turbo');
    expect(looksLikeStaleNews('GPT-6 Astraが本日発表されました')).toBeNull();
  });

  it('flags post meta leaks', () => {
    expect(looksLikePostMetaLeak('申し訳ありません。投稿時にエラーが続いています')).toBe(true);
    expect(looksLikePostMetaLeak('OpenAIがGPT-6 Astraを発表しました')).toBe(false);
  });
});

describe('runScheduledPost', () => {
  beforeEach(() => { control.next = null; control.created = 0; });
  afterEach(() => { control.next = null; });
  const submit = (text = '確認済みの技術ニュースです。' + '背景を解説します。'.repeat(35)) => ({
    content: '', toolCalls: [{ id: 'submit', name: 'submit_post', arguments: {
      text, imagePrompt: 'photorealistic, high quality photograph of servers, no people, no text',
    } }],
  });

  it('retains evidence and submits when every search budget is exhausted', async () => {
    let searches = 0;
    control.next = async input => {
      const search = input.tools.find((tool: any) => tool.name !== 'submit_post');
      if (search) return { content: '', toolCalls: [{ id: `s${++searches}`, name: search.name,
        arguments: { query: 'bounded research' } }] };
      expect(input.messages.filter((message: any) => message.role === 'tool')).toHaveLength(2);
      expect(input.messages.some((message: any) => message.content === 'verified source')).toBe(true);
      return submit();
    };
    const web = vi.fn(async () => 'verified source');
    const wiki = vi.fn(async () => 'verified wiki');
    const result = await runScheduledPost({ ...spec, toolBudgets: { maxWebCalls: 1, maxWikiCalls: 1 } }, { web, wikipedia: wiki });
    expect(web).toHaveBeenCalledTimes(1);
    expect(wiki).toHaveBeenCalledTimes(1);
    expect(control.created).toBe(1);
    expect(result.text).not.toContain('fallback');
    expect(result.imagePrompt).toContain('photorealistic');
  });

  it('reserves submission calls before the total FCA call limit', async () => {
    let searches = 0;
    control.next = async input => input.tools.length > 1
      ? { content: '', toolCalls: [{ id: `s${++searches}`, name: 'google-search', arguments: { query: 'test' } }] }
      : submit();
    const web = vi.fn(async () => 'verified source');
    const result = await runScheduledPost({ ...spec, maxToolCalls: 4 }, { ...ports, web });
    expect(web).toHaveBeenCalledTimes(2);
    expect(control.created).toBe(1);
    expect(result.text).not.toContain('fallback');
  });

  it('reserves final model turns after repeated search calls', async () => {
    let searches = 0;
    control.next = async input => input.tools.length > 1
      ? { content: '', toolCalls: [{ id: `s${++searches}`, name: 'google-search', arguments: { query: 'test' } }] }
      : submit();
    const web = vi.fn(async () => 'verified source');
    const result = await runScheduledPost({ ...spec, maxToolCalls: 30, toolBudgets: { maxWebCalls: 20, maxWikiCalls: 20 } }, { ...ports, web });
    expect(web).toHaveBeenCalledTimes(12);
    expect(control.created).toBe(1);
    expect(result.text).not.toContain('fallback');
  });

  it('handles one stale removed-tool call without discarding search history', async () => {
    let turn = 0;
    control.next = async input => {
      if (++turn <= 2) return { content: '', toolCalls: [{ id: `s${turn}`, name: 'google-search', arguments: { query: 'test' } }] };
      expect(input.messages.some((message: any) => message.content === 'verified source')).toBe(true);
      expect(input.messages.some((message: any) => message.content.includes('検索上限です'))).toBe(true);
      return submit();
    };
    const web = vi.fn(async () => 'verified source');
    const result = await runScheduledPost({ ...spec, toolBudgets: { maxWebCalls: 1, maxWikiCalls: 0 } }, { ...ports, web });
    expect(web).toHaveBeenCalledTimes(1);
    expect(control.created).toBe(1);
    expect(result.text).not.toContain('fallback');
  });

  it('accepts a 450-character post matching the maintained prompt', async () => {
    control.next = async () => submit('あ'.repeat(450));
    const result = await runScheduledPost(spec, ports);
    expect(result.text).toBe(spec.header + '\n' + 'あ'.repeat(450));
    expect(result.imagePrompt).toBeTruthy();
    expect(control.created).toBe(1);
  });

  it('keeps the image submission step after a prose-only response', async () => {
    let turn = 0;
    control.next = async () => ++turn === 1 ? { content: 'あ'.repeat(300), toolCalls: [] } : submit();
    const result = await runScheduledPost(spec, ports);
    expect(result.imagePrompt).toBeTruthy();
    expect(turn).toBe(2);
  });

  it('still rejects unknown tool names', async () => {
    control.next = async () => ({ content: '', toolCalls: [{ id: 'bad', name: 'post-on-twitter', arguments: {} }] });
    const result = await runScheduledPost(spec, ports);
    expect(result.text).toBe(spec.header + '\n' + spec.fallbackText);
    expect(result.imagePrompt).toBeUndefined();
  });

  it('completes news exploration via submit_post instead of falling back', async () => {
    const result = await runScheduledPost(spec, ports);
    expect(result.text).toContain('【今日のAIニュース】');
    expect(result.text).toContain('GPT-6 Astra');
    expect(result.text).not.toContain('fallback');
    expect(result.text).not.toContain('GPT-4 Turbo');
    expect(result.imagePrompt).toContain('photorealistic');
  });
});
