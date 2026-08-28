import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { loadPrompt } from '../config/prompts.js';
import { models } from '../../../config/models.js';
import { config } from '../../../config/env.js';
import { logger } from '../../../utils/logger.js';
import { createTracedModel } from '../utils/langfuse.js';

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
export interface FortuneOutput {
  text: string;
  imagePrompt?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_REVIEW_RETRIES = 3;

/** 日本語の星座名 → Unicode 星座記号（♈〜♓） */
const ZODIAC_SYMBOLS: Readonly<Record<string, string>> = {
  牡羊座: '♈',
  牡牛座: '♉',
  双子座: '♊',
  蟹座: '♋',
  獅子座: '♌',
  乙女座: '♍',
  天秤座: '♎',
  蠍座: '♏',
  射手座: '♐',
  山羊座: '♑',
  水瓶座: '♒',
  魚座: '♓',
};

// ---------------------------------------------------------------------------
// Schema – top3(詳細) + middle8(簡易) + last1(丁寧)
// ---------------------------------------------------------------------------

const DetailedFortuneSchema = z.object({
  rank: z.number(),
  sign: z.string(),
  description: z.string().describe('全体運の説明（2〜3文）'),
  topics: z.array(
    z.object({
      topic: z.string(),
      description: z.string(),
    }),
  ),
  luckyItem: z.string(),
});

const SimpleFortuneSchema = z.object({
  rank: z.number(),
  sign: z.string(),
  oneLiner: z.string().describe('一行の運勢コメント'),
});

const LastFortuneSchema = z.object({
  rank: z.number().describe('必ず 12'),
  sign: z.string(),
  apology: z.string().describe('「ごめんなさい！最下位は〇〇座のあなた」的な導入'),
  description: z.string().describe('なぜ最下位か＋前向きなアドバイス（2〜3文）'),
  luckyItem: z.string(),
});

const FortuneSchema = z.object({
  greeting: z.string().describe('朝の挨拶（ですます調）'),
  topFortunes: z.array(DetailedFortuneSchema).describe('1〜3位の星座（詳細）'),
  middleFortunes: z.array(SimpleFortuneSchema).describe('4〜11位の星座（一行ずつ）'),
  lastFortune: LastFortuneSchema.describe('12位（最下位）の星座（丁寧に）'),
  closing: z.string().describe('締めの一言（ですます調）'),
  imagePrompt: z.string().describe(
    '画像生成用プロンプト（英語）。photorealistic style。星座や宇宙の風景。',
  ),
});

type FortuneResult = z.infer<typeof FortuneSchema>;

// ---------------------------------------------------------------------------
// PostFortuneAgent
// ---------------------------------------------------------------------------

export class PostFortuneAgent {
  private keywords: string[];
  private zodiacSigns: string[];
  private model: ChatOpenAI;
  private systemPrompt: string;
  private reviewPrompt: string;
  private lastGenerationRateLimited = false;

  constructor(systemPrompt: string, reviewPrompt: string) {
    this.systemPrompt = systemPrompt;
    this.reviewPrompt = reviewPrompt;
    this.zodiacSigns = [
      '牡羊座', '牡牛座', '双子座', '蟹座',
      '獅子座', '乙女座', '天秤座', '蠍座',
      '射手座', '山羊座', '水瓶座', '魚座',
    ];
    this.keywords = [
      '創造性', '忍耐力', '直感', '協調性',
      '情熱', '計画性', 'バランス', '変化',
      '冒険', '責任感', '革新', '共感',
      '自信', '細部', '決断力', '感受性',
      'リーダーシップ', '分析力', '調和', '洞察力',
      '自由', '安定', '適応力', '思いやり',
      '活力', '実用性', '公平さ', '深さ',
      '拡大', '規律', '独創性', '受容性',
      '行動力', '堅実さ', '好奇心', '保護',
      '表現力', '効率', '社交性', '神秘',
      '挑戦', '伝統', '友情', '直感',
      '競争', '忠実', '知性', '夢',
    ];
    const isGemini = models.contentGeneration.startsWith('gemini');
    const isReasoning = models.contentGeneration.startsWith('gpt-5') || models.contentGeneration.startsWith('o');
    this.model = createTracedModel({
      modelName: models.contentGeneration,
      ...(isReasoning
        ? { modelKwargs: { max_completion_tokens: 8192 } }
        : isGemini
          ? { maxTokens: 8192 }
          : { temperature: 1, maxTokens: 8192 }),
      ...(isGemini
        ? {
            timeout: 300000,
            configuration: {
              baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
              apiKey: config.google.geminiApiKey,
            },
            apiKey: config.google.geminiApiKey,
          }
        : { apiKey: config.openaiApiKey }),
    });
  }

  public static async create(): Promise<PostFortuneAgent> {
    const prompt = await loadPrompt('fortune');
    if (!prompt) throw new Error('Failed to load fortune prompt');

    const reviewPrompt = await loadPrompt('fortune_review');
    if (!reviewPrompt) throw new Error('Failed to load fortune_review prompt');

    return new PostFortuneAgent(prompt, reviewPrompt);
  }

  // =========================================================================
  // Public
  // =========================================================================

  public async createPost(): Promise<FortuneOutput> {
    let feedback: string | undefined;

    for (let attempt = 1; attempt <= MAX_REVIEW_RETRIES; attempt++) {
      logger.info(
        `[Fortune] 生成 (試行 ${attempt}/${MAX_REVIEW_RETRIES})`,
        'cyan',
      );

      const result = await this.generate(feedback);
      if (!result) {
        if (this.lastGenerationRateLimited) {
          logger.warn('[Fortune] レート制限のためローカルフォールバックへ切り替え');
          const localFallback = this.createLocalFallbackFortune();
          return {
            text: this.formatFortuneResult(localFallback),
            imagePrompt: localFallback.imagePrompt,
          };
        }
        logger.warn('[Fortune] 生成失敗、リトライ');
        feedback = '前回は生成に失敗した。もう一度やり直して。';
        if (attempt < MAX_REVIEW_RETRIES) {
          await new Promise((r) => setTimeout(r, 2000));
        }
        continue;
      }

      const formatted = this.formatFortuneResult(result);
      logger.info(`[Fortune] ドラフト: "${formatted.slice(0, 80)}..."`, 'cyan');

      const review = await this.review(formatted);
      if (review.approved) {
        logger.info('[Fortune] レビュー合格', 'green');
        return {
          text: formatted,
          imagePrompt: result.imagePrompt,
        };
      }

      logger.warn(`[Fortune] レビュー不合格: ${review.issues.join(', ')}`);
      feedback = [
        `前回の投稿は以下の理由で不合格:`,
        ...review.issues.map((i) => `- ${i}`),
        review.suggestion ? `提案: ${review.suggestion}` : '',
        'もう一度生成してください。',
      ].join('\n');
    }

    logger.warn('[Fortune] 3回リトライ失敗、フォールバック');
    const fallback = await this.generate();
    if (fallback) {
      return {
        text: this.formatFortuneResult(fallback),
        imagePrompt: fallback.imagePrompt,
      };
    }
    logger.warn('[Fortune] LLM生成に失敗したためローカルフォールバックを使用');
    const localFallback = this.createLocalFallbackFortune();
    return {
      text: this.formatFortuneResult(localFallback),
      imagePrompt: localFallback.imagePrompt,
    };
  }

  // =========================================================================
  // Generation
  // =========================================================================

  private async generate(feedback?: string): Promise<FortuneResult | null> {
    this.lastGenerationRateLimited = false;
    const humanContent = this.getFortuneInfo();
    const structuredLLM = this.model.withStructuredOutput(FortuneSchema);

    const messages = [
      new SystemMessage(this.systemPrompt),
      new HumanMessage(
        feedback
          ? `${humanContent}\n\n# 前回のフィードバック\n${feedback}`
          : humanContent,
      ),
    ];

    try {
      return await structuredLLM.invoke(messages);
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      this.lastGenerationRateLimited = this.isRateLimitError(error);
      logger.error(`[Fortune] 生成エラー: ${detail}`, error);
      return null;
    }
  }

  // =========================================================================
  // Review
  // =========================================================================

  private async review(draft: string): Promise<ReviewResult> {
    const model = createTracedModel({
      modelName: models.autoTweet,
      temperature: 0,
    });

    const messages = [
      new SystemMessage(this.reviewPrompt),
      new HumanMessage(
        `以下の占いツイート案を審査してください。JSON形式で結果を返してください。\n\nツイート: "${draft}"`,
      ),
    ];

    try {
      const response = await model.invoke(messages);
      const text =
        typeof response.content === 'string' ? response.content.trim() : '';

      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        logger.warn(`[Fortune] レビューJSON解析失敗: ${text.slice(0, 200)}`);
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
      logger.error(`[Fortune] レビューエラー: ${e instanceof Error ? e.message : String(e)}`);
      return { approved: true, issues: [], viewer_perception: '', suggestion: '' };
    }
  }

  // =========================================================================
  // Helpers
  // =========================================================================

  private createLocalFallbackFortune(): FortuneResult {
    const shuffledSigns = [...this.zodiacSigns].sort(() => Math.random() - 0.5);
    const shuffledKeywords = [...this.keywords].sort(() => Math.random() - 0.5);
    const topTopics = ['仕事', '恋愛', '金運'];
    const middleTemplates = [
      '小さな確認が流れを整えてくれます。',
      '無理に急がず、手元のことから進めると良さそうです。',
      '周りの一言にヒントがありそうです。',
      '予定を少しだけ見直すと余裕が生まれます。',
      '気になっていたことを片づけるのに向いた日です。',
      '新しい情報を取り入れると視界が広がります。',
      'いつも通りを丁寧にすると運気が安定します。',
      '人に頼ることで思ったより早く進みそうです。',
    ];

    return {
      greeting: 'おはようございます。今日の12星座占いをお届けします。',
      topFortunes: shuffledSigns.slice(0, 3).map((sign, index) => {
        const keyword = shuffledKeywords[index] ?? '直感';
        return {
          rank: index + 1,
          sign,
          description: `${keyword}が味方になって、朝から前向きに動ける日です。迷ったら少しだけ明るい方を選ぶと、良い流れをつかめます。`,
          topics: topTopics.map((topic, topicIndex) => ({
            topic,
            description: [
              '段取りを先に決めると成果につながります。',
              '素直な言葉が相手に届きやすいです。',
              '小さな節約や見直しが後で効いてきます。',
            ][topicIndex],
          })),
          luckyItem: ['青いペン', '温かいお茶', '小さなメモ帳'][index],
        };
      }),
      middleFortunes: shuffledSigns.slice(3, 11).map((sign, index) => ({
        rank: index + 4,
        sign,
        oneLiner: middleTemplates[index],
      })),
      lastFortune: {
        rank: 12,
        sign: shuffledSigns[11],
        apology: `ごめんなさい！今日の最下位は${shuffledSigns[11]}のあなたです。`,
        description: '少し空回りしやすい日ですが、焦らず休憩を挟めば大丈夫です。予定を詰め込みすぎず、できたことを一つずつ数えていきましょう。',
        luckyItem: '白いハンカチ',
      },
      closing: '今日もあなたの一日が、少しでも楽しく穏やかなものになりますように。',
      imagePrompt:
        'photorealistic, high quality photograph, beautiful zodiac constellations over a calm sunrise sky, soft morning light, no people, no characters, no anime, no illustration, no text, no letters, no words, no watermarks',
    };
  }

  private isRateLimitError(error: unknown): boolean {
    if (typeof error === 'object' && error !== null) {
      const maybeStatus = (error as { status?: unknown; code?: unknown }).status;
      const maybeCode = (error as { status?: unknown; code?: unknown }).code;
      if (maybeStatus === 429 || maybeCode === 429 || maybeCode === 'rate_limit_exceeded') {
        return true;
      }
    }

    const message = error instanceof Error ? error.message : String(error);
    return message.includes('429') || message.includes('rate limit');
  }

  private getFortuneInfo(): string {
    const shuffledSigns = [...this.zodiacSigns]
      .sort(() => Math.random() - 0.5);
    const zodiacSignsMessage = `星座の順位:\n${shuffledSigns
      .map((sign, index) => `${index + 1}位: ${sign}`)
      .join('\n')}`;
    const selectedKeywords = this.keywords
      .sort(() => Math.random() - 0.5)
      .slice(0, 12);
    const keywordsMessage = `キーワード: ${selectedKeywords.join(', ')}`;
    return `${zodiacSignsMessage}\n\n${keywordsMessage}`;
  }

  private formatFortuneResult(result: FortuneResult): string {
    let out = `【今日の運勢】\n\n${result.greeting}\n\n`;

    // --- Top 3 (詳細) ---
    for (const f of result.topFortunes) {
      const medal = f.rank === 1 ? '🥇' : f.rank === 2 ? '🥈' : '🥉';
      out += `${f.rank}位 ${medal} ${this.formatSignLabel(f.sign)}\n`;
      out += `${f.description}\n`;
      for (const t of f.topics) {
        const emoji = this.getTopicEmoji(t.topic);
        out += `${t.topic}${emoji}：${t.description}\n`;
      }
      out += `ラッキーアイテム：${f.luckyItem} ✨\n\n`;
    }

    // --- Middle 4〜11 (簡易一行) ---
    for (const f of result.middleFortunes) {
      out += `${f.rank}位 ${this.formatSignLabel(f.sign)}：${f.oneLiner}\n`;
    }
    out += '\n';

    // --- Last (最下位・丁寧) ---
    const last = result.lastFortune;
    out += `${this.decorateSignNames(last.apology)}\n`;
    out += `${this.decorateSignNames(last.description)}\n`;
    out += `ラッキーアイテム：${last.luckyItem} ✨\n\n`;

    out += result.closing;
    return out;
  }

  /** 星座名の直前にシンボルを付ける（例: ♈ 牡羊座） */
  private formatSignLabel(sign: string): string {
    const symbol = ZODIAC_SYMBOLS[sign];
    return symbol ? `${symbol} ${sign}` : sign;
  }

  /** 文中の星座名にもシンボルを付ける（最下位の導入文など） */
  private decorateSignNames(text: string): string {
    let out = text;
    for (const [sign, symbol] of Object.entries(ZODIAC_SYMBOLS)) {
      const labeled = `${symbol} ${sign}`;
      if (out.includes(labeled)) continue;
      out = out.replaceAll(sign, labeled);
    }
    return out;
  }

  private getTopicEmoji(topic: string): string {
    const emojiMap: Record<string, string> = {
      '仕事': ' 💼',
      '恋愛': ' ❤️',
      '金運': ' 💰',
      '健康': ' 🏥',
      '学業': ' 📚',
      '趣味': ' 🎨',
      '友情': ' 👫',
      '家庭': ' 🏠',
      '旅行': ' ✈️',
    };
    return emojiMap[topic] || ' ⭐';
  }
}
