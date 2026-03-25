import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';
import { TaskContext } from '@shannon/common';
import { config } from '../../../config/env.js';
import { models } from '../../../config/models.js';
import { createTracedModel } from '../utils/langfuse.js';
import { MemoryNode } from '../graph/nodes/MemoryNode.js';
import { IExchange } from '../../../models/PersonMemory.js';
import { logger } from '../../../utils/logger.js';
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
    const agent = new ReplyTwitterCommentAgent(prompt);
    agent.memoryNode = new MemoryNode();
    await agent.memoryNode.initialize();
    return agent;
  }

  public async reply(
    text: string,
    authorName: string,
    repliedTweet?: string | null,
    repliedTweetAuthorName?: string | null,
    conversationThread?: Array<{ authorName: string; text: string }> | null,
    authorId?: string | null,
  ): Promise<string> {
    if (!this.systemPrompt) {
      throw new Error('systemPrompt is not set');
    }

    // === 記憶 preProcess ===
    let memoryContext = '';
    const context: TaskContext = {
      platform: 'twitter',
      twitter: {
        authorId: authorId ?? authorName,
        authorName,
      },
    };

    if (this.memoryNode) {
      try {
        const memState = await this.memoryNode.preProcess({
          userMessage: text,
          context,
        });
        const sections: string[] = [];
        if (memState.person) {
          const p = memState.person;
          if (p.traits.length > 0) sections.push(`この人の特徴: ${p.traits.join(', ')}`);
          if (p.conversationSummary) sections.push(`過去のやりとり: ${p.conversationSummary}`);
        }
        if (memState.experiences.length > 0) {
          sections.push('関連する体験: ' + memState.experiences.map((e) => e.content).join('; '));
        }
        if (sections.length > 0) {
          memoryContext = `\n\n【ボクの記憶】\n${sections.join('\n')}`;
        }
      } catch (error) {
        logger.error('❌ Twitter Reply: 記憶取得エラー:', error);
      }
    }

    const systemContent = this.systemPrompt + memoryContext;

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

    // === 記憶 postProcess (fire-and-forget) ===
    if (this.memoryNode) {
      const exchanges: IExchange[] = [
        { role: 'user', content: text, timestamp: new Date() },
        { role: 'assistant', content: replyText, timestamp: new Date() },
      ];
      this.memoryNode.postProcess({
        context,
        conversationText: `${authorName}: ${text}\nシャノン: ${replyText}`,
        exchanges,
      }).catch((err) => {
        logger.error('❌ Twitter Reply: 記憶保存エラー:', err);
      });
    }

    return replyText;
  }
}
