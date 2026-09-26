import { describe, expect, it, vi } from 'vitest';
import {
  looksLikePostMetaLeak,
  looksLikeStaleNews,
  runScheduledPost,
  type ScheduledPostSpec,
} from '../../src/services/llm/agents/scheduledPostRun.js';
import type { ScheduledPostSearchPorts } from '../../src/services/llm/agents/scheduledPostSkills.js';

vi.mock('../../src/services/fca/openAiFcaModel.js', () => ({
  createOpenAiFcaModel: () => {
    let turn = 0;
    return {
      next: async () => {
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
  it('completes news exploration via submit_post instead of falling back', async () => {
    const result = await runScheduledPost(spec, ports);
    expect(result.text).toContain('【今日のAIニュース】');
    expect(result.text).toContain('GPT-6 Astra');
    expect(result.text).not.toContain('fallback');
    expect(result.text).not.toContain('GPT-4 Turbo');
    expect(result.imagePrompt).toContain('photorealistic');
  });
});
