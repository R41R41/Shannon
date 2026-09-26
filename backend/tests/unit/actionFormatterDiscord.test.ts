import { describe, expect, it } from 'vitest';
import { actionFormatterNode } from '../../src/services/common/adapters/actionFormatter.js';

function discordState(overrides: Record<string, unknown> = {}): any {
  return {
    envelope: {
      requestId: 'request-1',
      channel: 'discord',
      text: '旅行資料を作って',
      tags: [],
      discord: { guildId: 'guild', channelId: 'channel', userId: 'user' },
    },
    relevantMemories: [],
    toolCalls: [],
    retrievedFacts: [],
    trace: [],
    warnings: [],
    finalAnswer: 'Discordで追加情報を確認しています。回答後に自動で再開します。',
    ...overrides,
  };
}

describe('Discord action formatting', () => {
  it('does not duplicate a structured clarification form with a text reply', async () => {
    const result = await actionFormatterNode(discordState({
      taskTree: {
        goal: '旅行資料を作って',
        strategy: '回答待ち',
        status: 'in_progress',
        recoveryStatus: 'awaiting_user',
      },
    }));

    expect(result.actionPlan?.message).toBe('');
    expect(result.actionPlan?.discordActions).toBeUndefined();
  });

  it('keeps normal completed replies', async () => {
    const result = await actionFormatterNode(discordState({
      finalAnswer: '完了しました。',
      taskTree: { goal: '旅行資料', strategy: '完了', status: 'completed', recoveryStatus: 'idle' },
    }));

    expect(result.actionPlan?.message).toBe('完了しました。');
    expect(result.actionPlan?.discordActions).toEqual([{ type: 'reply', text: '完了しました。' }]);
  });
});
