import { describe, expect, it, vi } from 'vitest';
import AskUserOnDiscordTool from '../../../src/services/llm/tools/discord/askUserOnDiscord';

function configuredTool() {
  const tool = new AskUserOnDiscordTool();
  tool.setContext({ platform: 'discord', discord: { guildId: '2', channelId: '10', userId: '1', userName: 'Rai' } }, 'task');
  return tool;
}

describe('ask-user-on-discord', () => {
  it('uses the request-bound conversation and returns the pause marker', async () => {
    const tool = configuredTool();
    const requestClarification = vi.fn().mockResolvedValue({ status: 'sent', message: 'ok' });
    tool.setDiscordConversationPort({ requestClarification } as any);
    const result = await tool.invoke({
      originalRequest: '旅行計画を作って', proposal: '浜松駅に10時集合で進める',
      questions: [{ id: 'budget', label: '予算', kind: 'number', required: true }],
    });
    expect(String(result)).toContain('SHANNON_AWAITING_USER');
    expect(requestClarification.mock.calls[0][0].clarification.requesterUserId).toBe('1');
  });

  it('rejects use outside Discord', async () => {
    const tool = new AskUserOnDiscordTool();
    tool.setContext({ platform: 'web' }, 'task');
    const result = await tool.invoke({ originalRequest: 'test', questions: [{ id: 'choice', label: '選択', kind: 'single_select', options: ['A'] }] });
    expect(String(result)).toContain('unsupported_channel');
  });

  it('normalizes verbose model output before request-bound delivery', async () => {
    const tool = configuredTool();
    let clarification: any;
    tool.setDiscordConversationPort({ requestClarification: vi.fn(async input => { clarification = input.clarification; return { status: 'sent', message: 'ok' }; }) } as any);
    const result = await tool.invoke({
      originalRequest: '旅行計画を作って'.repeat(300), proposal: '推奨条件'.repeat(1000),
      questions: Array.from({ length: 6 }, (_, index) => ({ id: `question_${index}`, label: `質問${index}`.repeat(40), kind: 'text' as const, description: '説明'.repeat(400) })),
    });
    expect(String(result)).toContain('SHANNON_AWAITING_USER');
    expect(clarification.originalRequest.length).toBeLessThanOrEqual(1500);
    expect(clarification.questions).toHaveLength(5);
  });
});
