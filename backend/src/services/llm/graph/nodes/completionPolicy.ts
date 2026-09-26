import { isDiscordArtifactTask } from '../policies/taskToolPolicy.js';

const NON_TERMINAL_SUMMARY_PATTERNS = [
  /少々お待ちください/u,
  /しばらくお待ちください/u,
  /別の手段を検討中/u,
  /(?:作業|処理|調査|作成|対応)を続けます/u,
  /これから.{0,24}(?:作成|調査|対応|検討)します/u,
  /今後は.{0,40}(?:まとめ|作成|調査|対応|検討)(?:します|する予定)/u,
];
const DISCORD_ARTIFACT_TOOLS = ['create-travel-brief', 'send-artifact-on-discord'] as const;

export function isDiscordArtifactRequest(goal: string, platform: string | null): boolean {
  return isDiscordArtifactTask(goal, platform);
}

export function validateCompletionClaim(input: {
  goal: string;
  platform: string | null;
  summary: string;
  availableToolNames: ReadonlySet<string>;
  successfulToolNames: ReadonlySet<string>;
}): string | null {
  if (isDiscordArtifactRequest(input.goal, input.platform)
      && DISCORD_ARTIFACT_TOOLS.every(name => input.availableToolNames.has(name))) {
    const missing = DISCORD_ARTIFACT_TOOLS.filter(name => !input.successfulToolNames.has(name));
    if (missing.length) return `依頼されたPDFは未完成です。完了前に次のツールを成功させてください: ${missing.join(', ')}。`;
  }
  if (NON_TERMINAL_SUMMARY_PATTERNS.some(pattern => pattern.test(input.summary))) {
    return '完了文が「後で作業を続ける」と説明しています。作業を続けるか、すでに終えた作業だけを報告してください。';
  }
  return null;
}

export function formatCompletedSummary(summary: string): string {
  const trimmed = summary.trim() || 'タスクを完了しました。';
  const withoutGenericHeading = trimmed.replace(
    /^(?:#{1,3}\s*)?[✅☑️]\s*(?:完了|Completed)\s*(?:\r?\n|$)/iu,
    '',
  ).trim();
  return withoutGenericHeading || 'タスクを完了しました。';
}
