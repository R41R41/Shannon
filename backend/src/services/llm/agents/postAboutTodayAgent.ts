import { format } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';
import {
  BaseMessage,
  HumanMessage,
  SystemMessage,
} from '@langchain/core/messages';
import { StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { models } from '../../../config/models.js';
import { createTracedModel } from '../utils/langfuse.js';
import GoogleSearchTool from '../tools/search/googleSearch.js';
import SearchByWikipediaTool from '../tools/search/searchByWikipedia.js';
import { logger } from '../../../utils/logger.js';
import { BaseAgent } from './BaseAgent.js';

const jst = 'Asia/Tokyo';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_TOOL_CALLS = 8;
const MAX_EXPLORATION_ITERATIONS = 15;
const MAX_REVIEW_RETRIES = 3;

// ---------------------------------------------------------------------------
// Tool: submit_post (output tool - signals the agent to stop)
// ---------------------------------------------------------------------------

/** エージェントの出力 */
export interface AboutTodayOutput {
  text: string;
  imagePrompt?: string;
}

class SubmitPostTool extends StructuredTool {
  name = 'submit_post';
  description =
    '調査が完了したら、このツールで最終的な「今日は何の日」ツイートを提出する。画像プロンプトも添えること。';
  schema = z.object({
    text: z.string().describe('ツイート本文（【今日は何の日？】ヘッダーは不要）'),
    imagePrompt: z
      .string()
      .describe(
        'ツイート内容に合った画像を生成するためのプロンプト（英語）。例: "A cute anime-style AI character looking at diamond dust sparkling in the cold winter air, northern Hokkaido landscape, soft pastel colors, illustration style" 【禁止事項】恐怖症トリガーとなる表現を絶対に含めないこと: 血液・傷口、注射器・針・尖った物、小さな穴や突起の集合体、蜘蛛・蛇・虫のアップ、不気味なピエロや人形、歯科・外科処置。医療系・生物系トピックでも建物の外観・人々の笑顔・抽象的シンボル・風景などポジティブで万人向けの表現に置き換えること。',
      ),
  });

  async _call(data: z.infer<typeof this.schema>): Promise<string> {
    return JSON.stringify(data);
  }
}

// ---------------------------------------------------------------------------
// PostAboutTodayAgent
// ---------------------------------------------------------------------------

export class PostAboutTodayAgent extends BaseAgent {
  private reviewPrompt: string;

  private constructor(systemPrompt: string, reviewPrompt: string) {
    super(systemPrompt, [
      new GoogleSearchTool(),
      new SearchByWikipediaTool(),
      new SubmitPostTool(),
    ]);
    this.reviewPrompt = reviewPrompt;
  }

  public static async create(): Promise<PostAboutTodayAgent> {
    const systemPrompt = await BaseAgent.loadPrompt('about_today');
    const reviewPrompt = await BaseAgent.loadPrompt('about_today_review');
    return new PostAboutTodayAgent(systemPrompt, reviewPrompt);
  }

  // =========================================================================
  // Public: メインエントリポイント（後方互換のインターフェース）
  // =========================================================================

  public async createPost(): Promise<AboutTodayOutput> {
    const today = this.getTodayDate();
    let feedback: string | undefined;

    for (let attempt = 1; attempt <= MAX_REVIEW_RETRIES; attempt++) {
      logger.info(
        `[AboutToday] 探索+生成 (試行 ${attempt}/${MAX_REVIEW_RETRIES})`,
        'cyan',
      );

      const draft = await this.explore(today, feedback);
      if (!draft) {
        logger.warn('[AboutToday] 探索結果なし、リトライ');
        feedback = '前回は調査に失敗した。別のトピックを選んでもっと詳しく調べて。';
        continue;
      }

      logger.info(
        `[AboutToday] ドラフト: "${draft.text.slice(0, 80)}..."`,
        'cyan',
      );

      const reviewResult = await this.review(
        draft.text,
        this.reviewPrompt,
        '以下の「今日は何の日」ツイート案を審査してください。JSON形式で結果を返してください。\n\nツイート:',
        { logLabel: '[AboutToday]' },
      );
      if (reviewResult.approved) {
        logger.info('[AboutToday] レビュー合格', 'green');
        return {
          text: `【今日は何の日？】\n${draft.text}`,
          imagePrompt: draft.imagePrompt,
        };
      }

      logger.warn(
        `[AboutToday] レビュー不合格: ${reviewResult.issues.join(', ')}`,
      );
      feedback = [
        `前回の投稿「${draft.text.slice(0, 100)}...」は以下の理由で不合格:`,
        ...reviewResult.issues.map((i) => `- ${i}`),
        reviewResult.suggestion ? `提案: ${reviewResult.suggestion}` : '',
        '別のアプローチでもう一度書いてください。',
      ].join('\n');
    }

    logger.warn('[AboutToday] 3回リトライ失敗、フォールバック');
    const fallback = await this.explore(today);
    return {
      text: `【今日は何の日？】\n${fallback?.text || '今日も何かの記念日かも…調べてみたけどうまく見つけられなかった'}`,
      imagePrompt: fallback?.imagePrompt,
    };
  }

  // =========================================================================
  // Phase 1: 探索 (Function Calling Agent)
  // =========================================================================

  private async explore(
    today: string,
    feedback?: string,
  ): Promise<AboutTodayOutput | null> {
    const model = createTracedModel({
      modelName: models.autoTweet,
      temperature: 0.8,
    });

    const [year, month, day] = today.split('-');
    const dateText = `${parseInt(month)}月${parseInt(day)}日`;

    const userContent = [
      `# 今日の日付`,
      `${today}（${dateText}）`,
      '',
      `まず「${dateText} 何の日」で Google 検索して候補を把握し、`,
      `面白そうなトピックを1つ選んだら Wikipedia で詳しく調べてください。`,
      `十分に調べたら submit_post でツイートを提出してください。`,
      feedback ? `\n# 前回のフィードバック\n${feedback}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    const messages: BaseMessage[] = [
      new SystemMessage(this.systemPrompt),
      new HumanMessage(userContent),
    ];

    const raw = await this.runToolLoop(messages, this.tools, model, {
      maxIterations: MAX_EXPLORATION_ITERATIONS,
      maxToolCalls: MAX_TOOL_CALLS,
      submitToolNames: ['submit_post'],
      logLabel: '[AboutToday]',
      maxResultLength: 6000,
    });

    if (!raw) return null;

    // If it came from submit_post it's JSON; otherwise plain text
    try {
      const parsed = JSON.parse(raw);
      if (!parsed.text) return null;
      return { text: parsed.text, imagePrompt: parsed.imagePrompt };
    } catch {
      // Plain text response
      return { text: raw };
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
