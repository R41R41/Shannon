import { describe, expect, it } from 'vitest';
import {
  DISCORD_ARTIFACT_ALLOWED_TOOLS,
  isDiscordArtifactTask,
  resolveTaskToolPolicy,
} from '../../../src/services/llm/graph/policies/taskToolPolicy.js';

describe('taskToolPolicy', () => {
  it('limits Discord travel PDF work to the artifact tool chain', () => {
    const policy = resolveTaskToolPolicy(
      '公式情報と雨天案、移動ルートの地図を含むPDFを作って',
      'discord',
    );

    expect(policy).toEqual([...DISCORD_ARTIFACT_ALLOWED_TOOLS]);
    expect(policy).toContain('compute-route');
    expect(policy).toContain('create-travel-brief');
    expect(policy).not.toContain('manage-routine');
    expect(policy).not.toContain('post-on-twitter');
  });

  it('does not constrain unrelated Discord conversations', () => {
    expect(resolveTaskToolPolicy('今日はどうしたの？', 'discord')).toBeUndefined();
    expect(isDiscordArtifactTask('今日はどうしたの？', 'discord')).toBe(false);
  });

  it('honors an explicit per-request policy and removes duplicates', () => {
    expect(resolveTaskToolPolicy('PDFを作って', 'discord', ['fetch-url', 'fetch-url']))
      .toEqual(['fetch-url']);
  });

  it('does not classify the same words outside Discord', () => {
    expect(resolveTaskToolPolicy('旅行資料PDFを作って', 'web')).toBeUndefined();
  });
});
