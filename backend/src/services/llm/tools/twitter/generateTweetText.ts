import { StructuredTool } from '@langchain/core/tools';
import { ChatOpenAI } from '@langchain/openai';
import { createTracedModel } from '../../utils/langfuse.js';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { config } from '../../../../config/env.js';
import { models } from '../../../../config/models.js';
import { loadPrompt } from '../../config/prompts.js';
import { logger } from '../../../../utils/logger.js';

const isPremium = !config.isDev;
const charLimit = isPremium ? null : 140; // prod(Premium): 制限なし, dev: 140文字

/**
 * プロンプト + few-shot例でシャノンらしいツイート文を生成するツール。
 * AutoTweet（自動投稿）や FCA（Discord経由の手動投稿）で使用する。
 *
 * 生成するだけで投稿はしない。投稿は post-on-twitter ツールで行う。
 */
export default class GenerateTweetTextTool extends StructuredTool {
  name = 'generate-tweet-text';
  description = isPremium
    ? 'シャノンのキャラクターでTwitter投稿文を生成するツール。人間のツイッタラーっぽい自然な文章を生成する。Premium対応のため長文も可能。投稿はしない（投稿は post-on-twitter で行う）。topicに「テーマ」や「こんな感じで」という指示を渡す。'
    : 'シャノンのキャラクターでTwitter投稿文を生成するツール。人間のツイッタラーっぽい自然な文章を生成する。投稿はしない（投稿は post-on-twitter で行う）。topicに「テーマ」や「こんな感じで」という指示を渡す。';
  schema = z.object({
    topic: z
      .string()
      .describe(
        'ツイートのテーマや指示。例: "時報", "マイクラについて", "今日のトレンドに絡めて", "眠いっていうつぶやき"'
      ),
  });

  private model: ChatOpenAI;
  private systemPromptCache: string | null = null;

  constructor() {
    super();
    this.model = createTracedModel({
      modelName: models.autoTweet,
      temperature: 1,
    });
  }

  private async getSystemPrompt(): Promise<string> {
    if (this.systemPromptCache) return this.systemPromptCache;
    const prompt = await loadPrompt('auto_tweet');
    this.systemPromptCache = prompt || '';
    return this.systemPromptCache;
  }

  async _call(data: z.infer<typeof this.schema>): Promise<string> {
    try {
      const systemPrompt = await this.getSystemPrompt();
      const charInstruction = charLimit
        ? `${charLimit}文字以内。`
        : '文字数制限なし（長文OK）。';
      const messages = [
        new SystemMessage(systemPrompt),
        new HumanMessage(
          `以下のテーマでシャノンらしいツイートを1つ書いて。${charInstruction}前置き不要、ツイート本文のみ出力。\n\nテーマ: ${data.topic}`
        ),
      ];

      const response = await this.model.invoke(messages);
      const text =
        typeof response.content === 'string'
          ? response.content.trim()
          : '';

      if (!text) {
        return 'ツイート生成に失敗しました。もう一度試してください。';
      }

      // dev（140文字制限あり）の場合のみ超過チェック
      if (charLimit && text.length > charLimit) {
        return `[生成結果 (${text.length}文字 - ${charLimit}文字超過のため要編集)]\n${text}`;
      }

      return `[生成結果]\n${text}`;
    } catch (error) {
      return `ツイート生成エラー: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
}

/**
 * AutoTweet から直接呼び出す用の関数（ツールとして呼ぶオーバーヘッドなし）
 */
export async function generateTweetForAutoPost(
  topic: string,
  systemPrompt?: string
): Promise<string> {
  const model = createTracedModel({
    modelName: models.autoTweet,
    temperature: 1,
  });

  const prompt = systemPrompt || (await loadPrompt('auto_tweet')) || '';
  const messages = [
    new SystemMessage(prompt),
    new HumanMessage(topic),
  ];

  const response = await model.invoke(messages);
  const text =
    typeof response.content === 'string'
      ? response.content.trim()
      : '';

  // dev（140文字制限あり）の場合のみ切り詰め
  if (charLimit && text.length > charLimit) {
    logger.warn(`🐦 generateTweetForAutoPost: ${text.length}文字 → ${charLimit}文字に切り詰め`);
    return text.slice(0, charLimit);
  }

  return text;
}
