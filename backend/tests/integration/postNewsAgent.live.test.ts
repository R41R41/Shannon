import { describe, expect, it } from 'vitest';
import { PostNewsAgent } from '../../src/services/llm/agents/postNewsAgent.js';

const live = process.env.RUN_LIVE_NEWS_TEST === '1';

describe.runIf(live)('PostNewsAgent live', () => {
  it('creates a real news post without fallback text', async () => {
    const agent = await PostNewsAgent.create();
    const result = await agent.createPost(AbortSignal.timeout(180000));
    expect(result.text).toContain('【今日のAIニュース】');
    expect(result.text).not.toContain('うまく見つけられなかった');
    expect(result.text.length).toBeGreaterThan(80);
  }, 180000);
});
