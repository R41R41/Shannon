import { describe, expect, it } from 'vitest';
import { buildAcceptedClarificationAnswers } from '../../../src/services/discord/clarificationSessionStore';

describe('buildAcceptedClarificationAnswers', () => {
  it('keeps selected answers when the proposal is accepted', () => {
    expect(buildAcceptedClarificationAnswers({
      proposal: '公式情報と雨天案を含むPDFを作成する',
      draftAnswers: {
        travel_mode: '車（レンタカー含む）',
        budget: '5,000〜10,000円',
      },
    })).toEqual({
      travel_mode: '車（レンタカー含む）',
      budget: '5,000〜10,000円',
      推奨条件: '公式情報と雨天案を含むPDFを作成する',
    });
  });
});
