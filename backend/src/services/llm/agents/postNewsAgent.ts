import { format } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';
import {
  AIMessage,
  BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages';
import { StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { models } from '../../../config/models.js';
import { loadPrompt } from '../config/prompts.js';
import { createTracedModel } from '../utils/langfuse.js';
import GoogleSearchTool from '../tools/search/googleSearch.js';
import SearchByWikipediaTool from '../tools/search/searchByWikipedia.js';
import { logger } from '../../../utils/logger.js';

const jst = 'Asia/Tokyo';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ReviewResult {
  approved: boolean;
  issues: string[];
  viewer_perception: string;
  suggestion: string;
}

/** エージェントの出力 */
export interface NewsOutput {
  text: string;
  imagePrompt?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_TOOL_CALLS = 10;
const MAX_EXPLORATION_ITERATIONS = 15;
const MAX_REVIEW_RETRIES = 3;

// ---------------------------------------------------------------------------
// Tool: submit_post
// ---------------------------------------------------------------------------

class SubmitPostTool extends StructuredTool {
  name = 'submit_post';
  description =
    '調査が完了したら、このツールで最終的なAIニュースツイートを提出する。画像プロンプトも添えること。';
  schema = z.object({
    text: z.string().describe('ツイート本文（【今日のAIニュース】ヘッダーは不要）'),
    imagePrompt: z
      .string()
      .describe(
        'ツイート内容に合った画像を生成するためのプロンプト（英語）。photorealistic style。【禁止事項】恐怖症トリガーとなる表現を絶対に含めないこと: 血液・傷口、注射器・針・尖った物、小さな穴/突起の集合体、蜘蛛・蛇・虫のアップ、不気味なピエロや人形、歯科・外科処置。ポジティブで万人向けの表現にすること。',
      ),
  });

  async _call(data: z.infer<typeof this.schema>): Promise<string> {
    return JSON.stringify(data);
  }
}

// ---------------------------------------------------------------------------
// PostNewsAgent
// ---------------------------------------------------------------------------

export class PostNewsAgent {
  private systemPrompt: string;
  private reviewPrompt: string;
  private tools: StructuredTool[];
  private toolMap: Map<string, StructuredTool>;

  private constructor(systemPrompt: string, reviewPrompt: string) {
    this.systemPrompt = systemPrompt;
    this.reviewPrompt = reviewPrompt;

    this.tools = [
      new GoogleSearchTool(),
      new SearchByWikipediaTool(),
      new SubmitPostTool(),
    ];
    this.toolMap = new Map(this.tools.map((t) => [t.name, t]));
  }

  public static async create(): Promise<PostNewsAgent> {
    const systemPrompt = await loadPrompt('news_today');
    if (!systemPrompt) throw new Error('Failed to load news_today prompt');

    const reviewPrompt = await loadPrompt('news_today_review');
    if (!reviewPrompt) throw new Error('Failed to load news_today_review prompt');

    return new PostNewsAgent(systemPrompt, reviewPrompt);
  }

  // =========================================================================
  // Public
  // =========================================================================

  public async createPost(): Promise<NewsOutput> {
    const today = this.getTodayDate();
    let feedback: string | undefined;

    for (let attempt = 1; attempt <= MAX_REVIEW_RETRIES; attempt++) {
      logger.info(
        `[News] 探索+生成 (試行 ${attempt}/${MAX_REVIEW_RETRIES})`,
        'cyan',
      );

      const draft = await this.explore(today, feedback);
      if (!draft) {
        logger.warn('[News] 探索結果なし、リトライ');
        feedback = '前回は調査に失敗した。別のニュースを選んでもっと詳しく調べて。';
        continue;
      }

      logger.info(`[News] ドラフト: "${draft.text.slice(0, 80)}..."`, 'cyan');

      const review = await this.review(draft.text);
      if (review.approved) {
        logger.info('[News] レビュー合格', 'green');
        return {
          text: `【今日のAIニュース】\n${draft.text}`,
          imagePrompt: draft.imagePrompt,
        };
      }

      logger.warn(`[News] レビュー不合格: ${review.issues.join(', ')}`);
      feedback = [
        `前回の投稿「${draft.text.slice(0, 100)}...」は以下の理由で不合格:`,
        ...review.issues.map((i) => `- ${i}`),
        review.suggestion ? `提案: ${review.suggestion}` : '',
        '別のアプローチでもう一度書いてください。',
      ].join('\n');
    }

    logger.warn('[News] 3回リトライ失敗、フォールバック');
    const fallback = await this.explore(today);
    const dateStr = format(toZonedTime(new Date(), jst), 'M月d日');
    return {
      text: `【今日のAIニュース】\n${fallback?.text || `今日${dateStr}のAIニュース、うまく見つけられなかった…また明日チェックするね`}`,
      imagePrompt: fallback?.imagePrompt,
    };
  }

  // =========================================================================
  // Phase 1: 探索 (FCA)
  // =========================================================================

  private async explore(
    today: string,
    feedback?: string,
  ): Promise<NewsOutput | null> {
    const model = createTracedModel({
      modelName: models.autoTweet,
      temperature: 0.7,
    });
    const modelWithTools = model.bindTools(this.tools);

    const userContent = [
      `# 今日の日付`,
      today,
      '',
      `まず Google 検索で今日の最新 AI ニュースを調べてください。`,
      `注目度の高い1件を選び、Wikipedia や追加検索で背景を深掘りしてください。`,
      `十分に調べたら submit_post でツイートを提出してください。`,
      feedback ? `\n# 前回のフィードバック\n${feedback}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    const messages: BaseMessage[] = [
      new SystemMessage(this.systemPrompt),
      new HumanMessage(userContent),
    ];

    let toolCallCount = 0;

    for (let i = 0; i < MAX_EXPLORATION_ITERATIONS; i++) {
      let response: AIMessage;
      try {
        response = (await modelWithTools.invoke(messages)) as AIMessage;
      } catch (e: unknown) {
        logger.error(`[News] LLM呼び出しエラー: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }
      messages.push(response);

      const toolCalls = response.tool_calls || [];

      if (toolCalls.length === 0) {
        const text =
          typeof response.content === 'string'
            ? response.content.trim()
            : '';
        if (text) return { text };
        return null;
      }

      for (const tc of toolCalls) {
        if (tc.name === 'submit_post') {
          try {
            const result = await this.toolMap.get(tc.name)!.invoke(tc.args);
            const parsed = JSON.parse(result);
            if (!parsed.text) return null;
            return {
              text: parsed.text,
              imagePrompt: parsed.imagePrompt,
            };
          } catch {
            return null;
          }
        }

        if (toolCallCount >= MAX_TOOL_CALLS) {
          messages.push(
            new ToolMessage({
              content:
                'ツール呼び出し上限に達しました。submit_post で最終的なツイートを提出してください。',
              tool_call_id: tc.id || `call_${Date.now()}`,
            }),
          );
          continue;
        }

        const tool = this.toolMap.get(tc.name);
        if (!tool) {
          messages.push(
            new ToolMessage({
              content: `ツール "${tc.name}" は存在しません`,
              tool_call_id: tc.id || `call_${Date.now()}`,
            }),
          );
          continue;
        }

        try {
          logger.debug(
            `[News] Tool: ${tc.name}(${JSON.stringify(tc.args).slice(0, 120)})`,
          );
          const result = await tool.invoke(tc.args);
          const resultStr =
            typeof result === 'string' ? result : JSON.stringify(result);
          messages.push(
            new ToolMessage({
              content: resultStr.slice(0, 6000),
              tool_call_id: tc.id || `call_${Date.now()}`,
            }),
          );
          toolCallCount++;
        } catch (e: unknown) {
          messages.push(
            new ToolMessage({
              content: `ツール実行エラー: ${e instanceof Error ? e.message : String(e)}`,
              tool_call_id: tc.id || `call_${Date.now()}`,
            }),
          );
        }
      }
    }

    logger.warn('[News] 探索イテレーション上限到達');
    return null;
  }

  // =========================================================================
  // Phase 2: レビュー
  // =========================================================================

  private async review(draft: string): Promise<ReviewResult> {
    const model = createTracedModel({
      modelName: models.autoTweet,
      temperature: 0,
    });

    const messages = [
      new SystemMessage(this.reviewPrompt),
      new HumanMessage(
        `以下のAIニュースツイート案を審査してください。JSON形式で結果を返してください。\n\nツイート: "${draft}"`,
      ),
    ];

    try {
      const response = await model.invoke(messages);
      const text =
        typeof response.content === 'string' ? response.content.trim() : '';

      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        logger.warn(`[News] レビューJSON解析失敗: ${text.slice(0, 200)}`);
        return { approved: true, issues: [], viewer_perception: '', suggestion: '' };
      }

      const parsed = JSON.parse(jsonMatch[0]) as ReviewResult;
      return {
        approved: parsed.approved ?? true,
        issues: parsed.issues ?? [],
        viewer_perception: parsed.viewer_perception ?? '',
        suggestion: parsed.suggestion ?? '',
      };
    } catch (e: unknown) {
      logger.error(`[News] レビューエラー: ${e instanceof Error ? e.message : String(e)}`);
      return { approved: true, issues: [], viewer_perception: '', suggestion: '' };
    }
  }

  // =========================================================================
  // Helpers
  // =========================================================================

  private getTodayDate(): string {
    const today = new Date();
    return format(toZonedTime(today, jst), 'yyyy-MM-dd');
  }
}
