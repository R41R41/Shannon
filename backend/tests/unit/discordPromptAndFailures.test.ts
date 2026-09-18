import { describe, expect, it } from 'vitest';
import { PromptBuilder } from '../../src/services/llm/graph/nodes/prompt/PromptBuilder';
import { ToolExecutor } from '../../src/services/llm/graph/nodes/execution/ToolExecutor';

describe('Discord task guidance', () => {
  it('asks for Markdown output and avoids unnecessary clarification', () => {
    const prompt = new PromptBuilder().buildSystemPrompt(
      { current: null, history: [] } as any,
      {
        platform: 'discord',
        discord: {
          guildId: 'guild', channelId: 'channel', userId: 'user',
          guildName: 'test', channelName: 'dev', userName: 'Rai',
        },
      },
      null,
    );

    expect(prompt).toContain('Discord Markdownを積極的に使う');
    expect(prompt).toContain('必要条件が揃っている場合は');
    expect(prompt).toContain('質問しない');
    expect(prompt).toContain('空オブジェクトで呼ばない');
    expect(prompt).toContain('5行以内');
  });

  it('classifies fetch failures as recoverable metadata', () => {
    const parsed = ToolExecutor.parseToolFailureMetadata(
      'URLを取得できませんでした [failure_type=http_fetch_failed recoverable=true]',
    );
    expect(parsed).toEqual({ isError: true, failureType: 'http_fetch_failed', recoverable: true });
  });
});
