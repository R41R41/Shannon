import { beforeAll, describe, expect, it } from 'vitest';

describe('Discord clarification components', () => {
  let bot: any;

  beforeAll(async () => {
    process.env.OPENAI_API_KEY ||= 'test-key';
    process.env.MONGODB_URI ||= 'mongodb://127.0.0.1:27017/test';
    const { DiscordBot } = await import('../../../src/services/discord/client');
    bot = DiscordBot.getInstance(true);
  });

  it('uses native selects, always offers free input, and stays within five rows', () => {
    const components = bot.buildClarificationComponents({
      clarificationId: '12345678-1234-1234-1234-123456789012',
      taskId: 'task', guildId: 'guild', channelId: 'channel', requesterUserId: 'user',
      originalRequest: '旅行計画', expiresAt: new Date(Date.now() + 60_000).toISOString(),
      createdAt: new Date().toISOString(), status: 'pending',
      questions: [
        { id: 'transport', label: '移動手段', kind: 'single_select', options: ['車', '公共交通'] },
        { id: 'interests', label: '興味', kind: 'multi_select', options: ['食', '音楽', '景色'] },
        { id: 'budget', label: '予算', kind: 'number' },
      ],
    });
    const json = components.map((row: { toJSON(): any }) => row.toJSON());

    expect(json).toHaveLength(3);
    expect(json[0].components[0].options.at(-1).label).toContain('自由入力');
    expect(json[1].components[0].max_values).toBeGreaterThan(1);
    expect(json[2].components[0].label).toBe('回答を送信');
  });
});
