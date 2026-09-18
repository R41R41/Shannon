import { beforeAll, describe, expect, it } from 'vitest';

describe('Discord progress card', () => {
  let bot: any;

  beforeAll(async () => {
    process.env.OPENAI_API_KEY ||= 'test-key';
    process.env.MONGODB_URI ||= 'mongodb://127.0.0.1:27017/test';
    const { DiscordBot } = await import('../../../src/services/discord/client');
    bot = DiscordBot.getInstance(true);
  });

  const planning = {
    goal: '友人3人で浜松へ日帰り旅行する計画を作成する',
    strategy: '公式情報を並列に調査しています',
    currentThinking: '3件を並列実行中',
    status: 'in_progress',
    hierarchicalSubTasks: [
      { id: '1', goal: '観光スポットを検索', status: 'completed', result: '詳細な検索結果' },
      { id: '2', goal: '雨天案を検索', status: 'in_progress' },
      { id: '3', goal: 'ルートを作成', status: 'pending' },
    ],
  };

  it('keeps the collapsed card compact', () => {
    const json = bot.buildProgressEmbed(planning, Date.now(), false).toJSON();
    expect(json.description).toContain('雨天案を検索');
    expect(json.description).not.toContain('詳細な検索結果');
    expect(bot.buildProgressControls('task', false).toJSON().components[0].label).toBe('詳細を表示');
  });

  it('renders details inside the same card and offers collapse', () => {
    const json = bot.buildProgressEmbed(planning, Date.now(), true).toJSON();
    expect(json.description).toContain('詳細な検索結果');
    expect(bot.buildProgressControls('task', true).toJSON().components[0].label).toBe('詳細を隠す');
  });
});
