import { StructuredTool } from '@langchain/core/tools';
import type { DiscordClarificationInput, TaskContext } from '@shannon/common';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { DiscordConversationPort } from '../../../../modules/conversation/discordConversation.js';

const questionSchema = z.object({
  id: z.string().min(1).max(40).describe('Stable snake_case answer key'),
  // Discord itself applies tighter display limits below. Accept slightly verbose
  // model output here and normalize it instead of aborting the whole task.
  label: z.string().min(1).max(300).transform((value) => value.slice(0, 100))
    .describe('Short question shown to the user'),
  kind: z.enum(['single_select', 'multi_select', 'number', 'text', 'confirm']),
  description: z.string().max(1000).transform((value) => value.slice(0, 300)).optional(),
  required: z.boolean().default(true),
  options: z.array(z.string().min(1).max(200))
    .transform((values) => values.slice(0, 8).map((value) => value.slice(0, 80)))
    .optional(),
  defaultValue: z.string().max(1000).transform((value) => value.slice(0, 200)).optional(),
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
    originalRequest: z.string().min(1).max(4000).transform((value) => value.slice(0, 1500))
      .describe('元の依頼を簡潔に保持したもの'),
    proposal: z.string().max(4000).transform((value) => value.slice(0, 1000)).optional()
      .describe('推奨する仮定・進め方。妥当ならワンクリックで承認できる'),
    // The model occasionally emits six closely-related questions even though
    // the prompt asks for five. Preserve the first five rather than failing the
    // clarification tool and prematurely completing the task.
    questions: z.array(questionSchema).min(1).max(10).transform((questions) => questions.slice(0, 5)),
  });

  private context: TaskContext | null = null;
  private taskId = '';
  private discordConversation: DiscordConversationPort | null = null;

  createForRun(): AskUserOnDiscordTool {
    return new AskUserOnDiscordTool();
  }

  setContext(context: TaskContext | null, taskId: string | null): void {
    this.context = context;
    this.taskId = taskId ?? '';
  }

  setDiscordConversationPort(port: DiscordConversationPort): void {
    this.discordConversation = port;
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

    if (!this.discordConversation) {
      return '現在のDiscord会話への送信権限がありません。 [failure_type=conversation_denied recoverable=false]';
    }
    const result = await this.discordConversation.requestClarification({ clarification: payload });
    if (result.status !== 'sent') {
      return `${result.message} [failure_type=delivery_failed recoverable=false]`;
    }

    return `SHANNON_AWAITING_USER ${JSON.stringify({ clarificationId, questionCount: data.questions.length })}`;
  }
}
