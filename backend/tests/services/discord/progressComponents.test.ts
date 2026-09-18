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

  it('replaces verbose progress with one concise failure summary', () => {
    const json = bot.buildProgressFailureEmbed({
      ...planning,
      status: 'error',
      strategy: 'エラー: LLM timeout (120s)',
    }, Date.now() - 120_000).toJSON();
    expect(json.title).toBe('処理を完了できませんでした');
    expect(json.description).toContain('AIモデルが120秒以内に応答を完了できませんでした');
    expect(json.description).toContain('1/3ステップ完了');
  });

  it('hides provider protocol details and explains post-processing failures', () => {
    const allCompleted = {
      ...planning,
      status: 'error',
      hierarchicalSubTasks: planning.hierarchicalSubTasks.map((task) => ({ ...task, status: 'completed' })),
      strategy: "400 An assistant message with 'tool_calls' must be followed by tool messages.\nTroubleshooting URL: https://example.invalid",
    };
    const json = bot.buildProgressFailureEmbed(allCompleted, Date.now() - 13_000).toJSON();
    expect(json.description).toContain('内部のツール実行履歴に不整合が発生しました');
    expect(json.description).toContain('3件の処理は完了しましたが、結果の生成中に停止しました');
    expect(json.description).not.toContain('Troubleshooting URL');
    expect(json.description).not.toContain('tool_calls');
  });

  it('keeps recovered tool failures out of the compact active view', () => {
    const recovering = {
      ...planning,
      hierarchicalSubTasks: [
        {
          id: '1', goal: 'create-travel-brief()', status: 'error', recoverable: true,
          failureReason: '入力形式を自動調整して再試行します。',
        },
        { id: '2', goal: 'create-travel-brief(title=浜松旅行)', status: 'in_progress' },
      ],
    };
    const compact = bot.buildProgressEmbed(recovering, Date.now(), false).toJSON();
    expect(compact.description).toContain('旅行PDFを作成');
    expect(compact.description).not.toContain('別の方法で続行');

    const expanded = bot.buildProgressEmbed(recovering, Date.now(), true).toJSON();
    expect(expanded.description).toContain('↻ 旅行PDFを作成（別の方法で続行）');
  });
});
