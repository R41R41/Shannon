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

export class ReplyTwitterCommentAgent extends BaseAgent {
  private model: ChatOpenAI;

  private constructor(systemPrompt: string) {
    super(systemPrompt);
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

  public static async create(): Promise<ReplyTwitterCommentAgent> {
    const prompt = await BaseAgent.loadPrompt('reply_twitter_comment');
    return new ReplyTwitterCommentAgent(prompt);
  }

  public async reply(
    text: string,
    authorName: string,
    repliedTweet?: string | null,
    repliedTweetAuthorName?: string | null,
    conversationThread?: Array<{ authorName: string; text: string }> | null,
    _authorId?: string | null,
  ): Promise<string> {
    if (!this.systemPrompt) {
      throw new Error('systemPrompt is not set');
    }

    const systemContent = this.systemPrompt;

    // 文脈を構築
    const lines: string[] = [];

    if (conversationThread && conversationThread.length > 0) {
      lines.push('【会話の流れ】');
      for (const msg of conversationThread) {
        lines.push(`${msg.authorName}: ${msg.text}`);
      }
      lines.push('');
      lines.push(`【これに対する ${authorName} の最新返信（↓あなたが返信する対象）】`);
      lines.push(text);
    } else if (repliedTweet) {
      lines.push(`【元ツイート（${repliedTweetAuthorName ?? '不明'}の投稿）】`);
      lines.push(repliedTweet);
      lines.push('');
      lines.push(`【${authorName} からの返信】`);
      lines.push(text);
    } else {
      lines.push(`【${authorName} からのリプライ】`);
      lines.push(text);
    }

    const humanContent = lines.join('\n');
    const response = await this.model.invoke([
      new SystemMessage(systemContent),
      new HumanMessage(humanContent),
    ]);
    const replyText = response.content.toString();

    return replyText;
  }
}
