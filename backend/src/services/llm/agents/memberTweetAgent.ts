import {
  AIMessage,
  BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages';
import { StructuredTool } from '@langchain/core/tools';
import { TaskContext } from '@shannon/common';
import { z } from 'zod';
import { config } from '../../../config/env.js';
import { models } from '../../../config/models.js';
import { createTracedModel } from '../utils/langfuse.js';
import { IExchange } from '../../../models/PersonMemory.js';
import { logger } from '../../../utils/logger.js';
import { MemoryNode } from '../graph/nodes/MemoryNode.js';
import { BaseAgent } from './BaseAgent.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MemberTweetResult {
  type: 'reply' | 'quote_rt';
  text: string;
}

// ---------------------------------------------------------------------------
// Tool 1: submit_reply
// ---------------------------------------------------------------------------

class SubmitReplyTool extends StructuredTool {
  name = 'submit_reply';
  description =
    '個人的な会話・雑談・ツッコミなど、直接返信が適切な場合に使う。';
  schema = z.object({
    text: z.string().describe('返信テキスト（140文字以内）'),
  });

  async _call(data: z.infer<typeof this.schema>): Promise<string> {
    return JSON.stringify({ type: 'reply', text: data.text });
  }
}

// ---------------------------------------------------------------------------
// Tool 2: submit_quote_rt
// ---------------------------------------------------------------------------

class SubmitQuoteRTTool extends StructuredTool {
  name = 'submit_quote_rt';
  description =
    '成果報告・告知・フォロワーに共有したい話題など、引用リツイートが適切な場合に使う。';
  schema = z.object({
    text: z.string().describe('引用RTのコメント（140文字以内）'),
  });

  async _call(data: z.infer<typeof this.schema>): Promise<string> {
    return JSON.stringify({ type: 'quote_rt', text: data.text });
  }
}

// ---------------------------------------------------------------------------
// MemberTweetAgent
// ---------------------------------------------------------------------------

const MAX_ITERATIONS = 3;

export class MemberTweetAgent extends BaseAgent {
  private constructor(systemPrompt: string) {
    super(systemPrompt, [new SubmitReplyTool(), new SubmitQuoteRTTool()]);
  }

  public static async create(): Promise<MemberTweetAgent> {
    const systemPrompt = await BaseAgent.loadPrompt('respond_member_tweet');
    const agent = new MemberTweetAgent(systemPrompt);
    agent.memoryNode = new MemoryNode();
    await agent.memoryNode.initialize();
    return agent;
  }

  // =========================================================================
  // Public: メインエントリポイント
  // =========================================================================

  public async respond(params: {
    text: string;
    authorName: string;
    authorUserName: string;
    authorId?: string | null;
    repliedTweet?: string | null;
    repliedTweetAuthorName?: string | null;
    conversationThread?: Array<{ authorName: string; text: string }> | null;
  }): Promise<MemberTweetResult | null> {
    const {
      text,
      authorName,
      authorUserName,
      authorId,
      repliedTweet,
      repliedTweetAuthorName,
      conversationThread,
    } = params;

    // === 記憶 preProcess ===
    let memoryContext = '';
    const taskContext: TaskContext = {
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
          context: taskContext,
        });
        const sections: string[] = [];
        if (memState.person) {
          const p = memState.person;
          if (p.traits.length > 0)
            sections.push(`この人の特徴: ${p.traits.join(', ')}`);
          if (p.conversationSummary)
            sections.push(`過去のやりとり: ${p.conversationSummary}`);
        }
        if (memState.experiences.length > 0) {
          sections.push(
            '関連する体験: ' +
              memState.experiences.map((e) => e.content).join('; '),
          );
        }
        if (sections.length > 0) {
          memoryContext = `\n\n【ボクの記憶】\n${sections.join('\n')}`;
        }
      } catch (error) {
        logger.error('❌ MemberTweet: 記憶取得エラー:', error);
      }
    }

    // === LLM呼び出し (FCA) ===
    const isGemini = models.contentGeneration.startsWith('gemini');
    const isReasoning = models.contentGeneration.startsWith('gpt-5') || models.contentGeneration.startsWith('o');
    const model = createTracedModel({
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
        : {}),
    });

    const systemContent = this.systemPrompt + memoryContext;

    const lines: string[] = [];
    if (conversationThread && conversationThread.length > 0) {
      lines.push('【会話の流れ】');
      for (const msg of conversationThread) {
        lines.push(`${msg.authorName}: ${msg.text}`);
      }
      lines.push('');
      lines.push(
        `【これに対する ${authorName} (@${authorUserName}) の最新投稿（↓あなたが反応する対象）】`,
      );
      lines.push(text);
    } else if (repliedTweet) {
      lines.push(
        `【元ツイート（${repliedTweetAuthorName ?? '不明'}の投稿）】`,
      );
      lines.push(repliedTweet);
      lines.push('');
      lines.push(`【${authorName} (@${authorUserName}) の返信/投稿】`);
      lines.push(text);
    } else {
      lines.push(`【${authorName} (@${authorUserName}) のツイート】`);
      lines.push(text);
    }

    lines.push('');
    lines.push(
      '上記のツイートに対して、submit_reply か submit_quote_rt のどちらかのツールを使って反応してください。',
    );

    const messages: BaseMessage[] = [
      new SystemMessage(systemContent),
      new HumanMessage(lines.join('\n')),
    ];

    const raw = await this.runToolLoop(messages, this.tools, model, {
      maxIterations: MAX_ITERATIONS,
      maxToolCalls: 0, // no non-submit tools
      submitToolNames: ['submit_reply', 'submit_quote_rt'],
      logLabel: '[MemberTweet]',
      returnPlainText: true,
    });

    let result: MemberTweetResult | null = null;

    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        result = { type: parsed.type, text: parsed.text || '' };
      } catch {
        // Plain text fallback
        result = { type: 'reply', text: raw };
      }
    }

    // === 記憶 postProcess (fire-and-forget) ===
    if (result && this.memoryNode) {
      const exchanges: IExchange[] = [
        { role: 'user', content: text, timestamp: new Date() },
        { role: 'assistant', content: result.text, timestamp: new Date() },
      ];
      this.memoryNode
        .postProcess({
          context: taskContext,
          conversationText: `${authorName}: ${text}\nシャノン: ${result.text}`,
          exchanges,
        })
        .catch((err) => {
          logger.error('❌ MemberTweet: 記憶保存エラー:', err);
        });
    }

    return result;
  }
}
