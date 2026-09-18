import { describe, expect, it } from 'vitest';
import { getEventBus } from '../../../src/services/eventBus';
import AskUserOnDiscordTool from '../../../src/services/llm/tools/discord/askUserOnDiscord';

describe('ask-user-on-discord', () => {
  it('publishes a requester-scoped clarification and returns the pause marker', async () => {
    const tool = new AskUserOnDiscordTool();
    tool.setContext({
      platform: 'discord',
      discord: { guildId: 'guild', channelId: 'channel', userId: 'user', userName: 'Rai' },
    }, 'task');
    let published: any;
    const unsubscribe = getEventBus().subscribe('discord:request_clarification', (event) => { published = event.data; });
    const result = await tool.invoke({
      originalRequest: '旅行計画を作って',
      proposal: '浜松駅に10時集合で進める',
      questions: [{ id: 'budget', label: '予算', kind: 'number', required: true }],
    });
    unsubscribe();

    expect(String(result)).toContain('SHANNON_AWAITING_USER');
    expect(published.requesterUserId).toBe('user');
    expect(published.questions).toHaveLength(1);
  });

  it('rejects use outside Discord', async () => {
    const tool = new AskUserOnDiscordTool();
    tool.setContext({ platform: 'web' }, 'task');
    const result = await tool.invoke({
      originalRequest: 'test',
      questions: [{ id: 'choice', label: '選択', kind: 'single_select', options: ['A'] }],
    });
    expect(String(result)).toContain('unsupported_channel');
  });

  it('normalizes verbose model output instead of aborting clarification', async () => {
    const tool = new AskUserOnDiscordTool();
    tool.setContext({
      platform: 'discord',
      discord: { guildId: 'guild', channelId: 'channel', userId: 'user', userName: 'Rai' },
    }, 'task');
    let published: any;
    const unsubscribe = getEventBus().subscribe('discord:request_clarification', (event) => { published = event.data; });
    const result = await tool.invoke({
      originalRequest: '旅行計画を作って'.repeat(300),
      proposal: '推奨条件'.repeat(1000),
      questions: Array.from({ length: 6 }, (_, index) => ({
        id: `question_${index}`,
        label: `質問${index}`.repeat(40),
        kind: 'text' as const,
        description: '説明'.repeat(400),
      })),
    });
    unsubscribe();

    expect(String(result)).toContain('SHANNON_AWAITING_USER');
    expect(published.originalRequest.length).toBeLessThanOrEqual(1500);
    expect(published.proposal.length).toBeLessThanOrEqual(1000);
    expect(published.questions).toHaveLength(5);
    expect(published.questions[0].label.length).toBeLessThanOrEqual(100);
    expect(published.questions[0].description.length).toBeLessThanOrEqual(300);
  });
});
