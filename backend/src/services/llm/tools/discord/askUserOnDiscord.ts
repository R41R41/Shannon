import { StructuredTool } from '@langchain/core/tools';
import type { DiscordClarificationInput, TaskContext } from '@shannon/common';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getEventBus } from '../../../eventBus/index.js';

const questionSchema = z.object({
  id: z.string().min(1).max(40).describe('Stable snake_case answer key'),
  label: z.string().min(1).max(100).describe('Short question shown to the user'),
  kind: z.enum(['single_select', 'multi_select', 'number', 'text', 'confirm']),
  description: z.string().max(300).optional(),
  required: z.boolean().default(true),
  options: z.array(z.string().min(1).max(80)).max(8).optional(),
  defaultValue: z.string().max(200).optional(),
});

/**
 * Pauses a Discord task and presents a structured requirement form.
 * The Discord client resumes the request as a new graph turn after submission.
 */
export default class AskUserOnDiscordTool extends StructuredTool {
  name = 'ask-user-on-discord';
  description = [
    'Discord上で不足要件を構造化して質問し、回答まで現在のタスクを安全に一時停止する。',
    '影響が小さく高確度で仮定できる項目には使わず、そのまま進める。',
    '中程度の影響なら proposal に推奨条件をまとめ「この条件で進める」を最短経路にする。',
    '高影響または必須情報が欠ける場合だけ質問する。選択式にも必ず自由入力を許容する。',
    '同時に聞く質問は重要なものだけ最大5件にまとめる。Discord以外では使わない。',
  ].join(' ');

  schema = z.object({
    originalRequest: z.string().min(1).max(1500).describe('元の依頼を簡潔に保持したもの'),
    proposal: z.string().max(1000).optional().describe('推奨する仮定・進め方。妥当ならワンクリックで承認できる'),
    questions: z.array(questionSchema).min(1).max(5),
  });

  private context: TaskContext | null = null;
  private taskId = '';

  setContext(context: TaskContext | null, taskId: string | null): void {
    this.context = context;
    this.taskId = taskId ?? '';
  }

  async _call(data: z.infer<typeof this.schema>): Promise<string> {
    const discord = this.context?.discord;
    if (this.context?.platform !== 'discord' || !discord?.guildId || !discord.channelId || !discord.userId) {
      return 'ask-user-on-discord はDiscord上の依頼でのみ利用できます。 [failure_type=unsupported_channel recoverable=false]';
    }

    for (const question of data.questions) {
      if ((question.kind === 'single_select' || question.kind === 'multi_select') && !question.options?.length) {
        return `質問 ${question.id} には options が必要です。 [failure_type=invalid_arguments recoverable=true]`;
      }
    }
    if (new Set(data.questions.map((question) => question.id)).size !== data.questions.length) {
      return '質問IDは重複できません。 [failure_type=invalid_arguments recoverable=true]';
    }

    const clarificationId = randomUUID();
    const payload: DiscordClarificationInput = {
      clarificationId,
      taskId: this.taskId,
      guildId: discord.guildId,
      channelId: discord.channelId,
      requesterUserId: discord.userId,
      requesterUserName: discord.userName,
      originalRequest: data.originalRequest,
      proposal: data.proposal,
      questions: data.questions,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    };

    getEventBus().publish({
      type: 'discord:request_clarification',
      memoryZone: 'web',
      data: payload,
    });

    return `SHANNON_AWAITING_USER ${JSON.stringify({ clarificationId, questionCount: data.questions.length })}`;
  }
}
