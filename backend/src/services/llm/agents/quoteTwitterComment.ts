import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';
import { config } from '../../../config/env.js';
import { models } from '../../../config/models.js';
import { createTracedModel } from '../utils/langfuse.js';
import { BaseAgent } from './BaseAgent.js';

const OPENAI_API_KEY = config.openaiApiKey;
if (!OPENAI_API_KEY) {
  throw new Error('OPENAI_API_KEY is not set');
}

/**
 * 引用リツイート用のコメントを生成するエージェント。
 *
 * ReplyTwitterCommentAgent と同様に LLM でテキストを生成するが、
 * 引用RTに適した短めのコメントを出力する。
 */
export class QuoteTwitterCommentAgent extends BaseAgent {
  private model: ChatOpenAI;

  private static readonly SYSTEM_PROMPT = `あなたはシャノンというAIアシスタントです。
友達やチームメンバーのツイートを引用リツイートする際のコメントを生成してください。

ルール:
- 日本語で書く
- 親しみを込めた短めのコメント (1〜2文、80文字以内が理想)
- 元ツイートの内容に対する感想、共感、応援、補足情報などを書く
- ハッシュタグは不要
- 絵文字は控えめに (0〜2個)
- 宣伝っぽくならないようにする
- 自然で人間らしい文章にする`;

  private constructor() {
    super(QuoteTwitterCommentAgent.SYSTEM_PROMPT);
    const isGemini = models.contentGeneration.startsWith('gemini');
    const isReasoning = models.contentGeneration.startsWith('gpt-5') || models.contentGeneration.startsWith('o');
    this.model = createTracedModel({
      modelName: models.contentGeneration,
      ...(isReasoning
        ? { modelKwargs: { max_completion_tokens: 4096 } }
        : isGemini
          ? { maxTokens: 8192 }
          : { temperature: 1 }),
      ...(isGemini
        ? {
            timeout: 300000,
            configuration: {
              baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
              apiKey: config.google.geminiApiKey,
            },
            apiKey: config.google.geminiApiKey,
          }
        : { apiKey: OPENAI_API_KEY }),
    });
  }

  public static create(): QuoteTwitterCommentAgent {
    return new QuoteTwitterCommentAgent();
  }

  public async generateQuote(
    tweetText: string,
    authorName: string,
    authorUserName: string
  ): Promise<string> {
    const humanContent = `以下のツイートに対する引用リツイートのコメントを生成してください。

ツイート内容: ${tweetText}
投稿者の表示名: ${authorName}
投稿者のユーザー名: @${authorUserName}`;

    const response = await this.model.invoke([
      new SystemMessage(QuoteTwitterCommentAgent.SYSTEM_PROMPT),
      new HumanMessage(humanContent),
    ]);
    return response.content.toString();
  }
}
