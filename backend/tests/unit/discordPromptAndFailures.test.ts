import { describe, expect, it } from 'vitest';
import { PromptBuilder } from '../../src/services/llm/graph/nodes/prompt/PromptBuilder';
import { ToolExecutor } from '../../src/services/llm/graph/nodes/execution/ToolExecutor';
import {
  formatCompletedSummary,
  validateCompletionClaim,
} from '../../src/services/llm/graph/nodes/FunctionCallingAgent';

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

  it('rejects a PDF completion until creation and Discord delivery both succeeded', () => {
    const common = {
      goal: '浜松の日帰り旅行について公式情報と雨天案を含むPDFを作って',
      platform: 'discord',
      summary: 'PDFを作成しました。',
      availableToolNames: new Set(['create-travel-brief', 'send-artifact-on-discord']),
    };
    expect(validateCompletionClaim({
      ...common,
      successfulToolNames: new Set(['google-search']),
    })).toContain('create-travel-brief');
    expect(validateCompletionClaim({
      ...common,
      successfulToolNames: new Set(['create-travel-brief', 'send-artifact-on-discord']),
    })).toBeNull();
  });

  it('rejects terminal wording that tells the user to keep waiting', () => {
    expect(validateCompletionClaim({
      goal: '調べて',
      platform: 'discord',
      summary: '別の手段を検討中です。少々お待ちください。',
      availableToolNames: new Set(),
      successfulToolNames: new Set(),
    })).toContain('作業を続ける');
  });

  it('marks a successful final answer as visibly complete', () => {
    expect(formatCompletedSummary('PDFを添付しました。')).toBe('## ✅ 完了\nPDFを添付しました。');
  });
});
