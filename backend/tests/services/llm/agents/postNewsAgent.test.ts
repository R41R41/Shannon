import { describe, expect, it, vi } from 'vitest';
import { PostNewsAgent } from '../../../../src/services/llm/agents/postNewsAgent.js';
import type { ScheduledPostSearchPorts } from '../../../../src/services/llm/agents/scheduledPostSkills.js';

vi.mock('../../../../src/services/fca/openAiFcaModel.js', () => ({
  createOpenAiFcaModel: () => ({
    next: async () => ({
      content: '',
      toolCalls: [{
        id: 'submit1',
        name: 'submit_post',
        arguments: {
          text: 'OpenAIが新機能を発表しました。開発者向けAPIの改善が中心です。今後の展開が注目されます。ボクとしても使いやすくなるのは嬉しいです。',
          imagePrompt: 'photorealistic, high quality photograph of computer servers, no people, no text',
        },
      }],
    }),
  }),
}));

vi.mock('../../../../src/services/llm/utils/langfuse.js', () => ({
  createTracedModel: () => ({
    invoke: async () => ({ content: JSON.stringify({ approved: true, issues: [], suggestion: '' }) }),
  }),
}));

describe('PostNewsAgent', () => {
  it('createPost() returns a news object without fallback text', async () => {
    const ports: ScheduledPostSearchPorts = {
      web: async () => 'search ok',
      wikipedia: async () => 'wiki ok',
    };
    const agent = await PostNewsAgent.create(ports);
    const result = await agent.createPost();
    expect(result.text).toContain('【今日のAIニュース】');
    expect(result.text).toContain('OpenAIが新機能を発表');
    expect(result.text).not.toContain('うまく見つけられなかった');
    expect(result.imagePrompt).toBeTruthy();
  });
});
