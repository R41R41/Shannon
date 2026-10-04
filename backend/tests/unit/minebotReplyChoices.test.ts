import { describe, expect, it, vi } from 'vitest';
import {
  FALLBACK_REPLY_CHOICES,
  parseReplyChoices,
  suggestReplyChoices,
} from '../../src/services/minebot/uiMod/replyChoices.js';

const input = { question: '30ターン使いました（進捗: 原木 12/32）。続けますか？', goal: '木材を32個集める', progress: '原木 12/32' };

describe('parseReplyChoices', () => {
  it('reads a JSON array, even with text around it', () => {
    expect(parseReplyChoices('候補です: ["続けて", "やめて", "鉄を先に集めて"]')).toEqual(['続けて', 'やめて', '鉄を先に集めて']);
  });

  it('drops non-strings, blanks, duplicates, long and multi-line items, and a leading call to Shannon', () => {
    const output = JSON.stringify(['シャノン、続けて', 1, '', '続けて', 'あ'.repeat(17), 'や\nめて', 'やめて']);
    expect(parseReplyChoices(output)).toEqual(['続けて', 'やめて']);
  });

  it('keeps at most four', () => {
    expect(parseReplyChoices('["a","b","c","d","e"]')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('needs at least two usable choices', () => {
    expect(parseReplyChoices('["続けて"]')).toBeNull();
    expect(parseReplyChoices('続けてください')).toBeNull();
    expect(parseReplyChoices('[broken')).toBeNull();
  });
});

describe('suggestReplyChoices', () => {
  it('asks the model with the question, goal and progress', async () => {
    const model = vi.fn(async () => '["続けて","いったんやめて","家に帰って"]');
    await expect(suggestReplyChoices(input, model)).resolves.toEqual(['続けて', 'いったんやめて', '家に帰って']);
    const [, user] = model.mock.calls[0] as unknown as [string, string];
    expect(user).toContain(input.question);
    expect(user).toContain(input.goal);
    expect(user).toContain(input.progress);
  });

  it('falls back when the model fails, answers badly or is too slow', async () => {
    await expect(suggestReplyChoices(input, async () => { throw new Error('rate limited'); })).resolves.toEqual([...FALLBACK_REPLY_CHOICES]);
    await expect(suggestReplyChoices(input, async () => 'はい')).resolves.toEqual([...FALLBACK_REPLY_CHOICES]);
    const slow = () => new Promise<string>((resolve) => setTimeout(() => resolve('["a","b"]'), 200));
    await expect(suggestReplyChoices(input, slow, 20)).resolves.toEqual([...FALLBACK_REPLY_CHOICES]);
  });
});
