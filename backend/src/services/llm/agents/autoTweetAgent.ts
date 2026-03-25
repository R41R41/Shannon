import { TwitterTrendData, AutoTweetMode } from '@shannon/common';
import { createTracedModel } from '../utils/langfuse.js';
import {
  AIMessage,
  BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages';
import { StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import axios from 'axios';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { config } from '../../../config/env.js';
import { models } from '../../../config/models.js';
import { loadPrompt } from '../config/prompts.js';
import { logger } from '../../../utils/logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AutoTweetOutput {
  type: 'tweet' | 'quote_rt';
  text: string;
  quoteUrl?: string;
  topic?: string;
}

interface ExplorationResult {
  type: 'tweet' | 'quote_rt';
  topic: string;
  context: string;
  quoteUrl?: string;
  quotedText?: string;
}

interface ReviewResult {
  approved: boolean;
  issues: string[];
  viewer_perception: string;
  suggestion: string;
}

interface WatchlistConfig {
  accounts: Array<{ userName: string; label: string; category: string }>;
  topicBias: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_TOOL_CALLS = 12;
const MAX_EXPLORATION_ITERATIONS = 18;
const MAX_REVIEW_RETRIES = 3;
const MAX_GENERATE_RETRIES = 3;
const API_BASE = 'https://api.twitterapi.io';
const WATCHLIST_PATH = resolve('saves/watchlist.json');

const BIG_ACCOUNTS = [
  'sama', 'elonmusk', 'GoogleDeepMind', 'OpenAI', 'AnthropicAI',
  'xaborsa', 'nvidia', 'Shizuku_AItuber', 'cumulo_autumn',
];

const GENRE_SEARCH_QUERIES = [
  { genre: 'AI・テクノロジー', query: '"AI" OR "LLM" OR "ChatGPT" OR "GPT" min_faves:100 lang:ja' },
  { genre: 'ゲーム', query: '"Minecraft" OR "マイクラ" OR "Nintendo" OR "ゲーム" min_faves:100 lang:ja' },
  { genre: 'アニメ・漫画', query: '"アニメ" OR "漫画" OR "今期アニメ" min_faves:200 lang:ja' },
  { genre: '食・グルメ', query: '"マクドナルド" OR "新商品" OR "期間限定" min_faves:100 lang:ja filter:media' },
  { genre: '音楽', query: '"新曲" OR "MV" OR "ライブ" min_faves:150 lang:ja' },
  { genre: 'VTuber', query: '"VTuber" OR "ホロライブ" OR "にじさんじ" OR "配信" min_faves:100 lang:ja' },
  { genre: '科学・宇宙', query: '"科学" OR "宇宙" OR "NASA" OR "研究" min_faves:100 lang:ja' },
  { genre: 'スポーツ', query: '"サッカー" OR "野球" OR "大谷" OR "オリンピック" min_faves:200 lang:ja' },
];

// ---------------------------------------------------------------------------
// Twitter API helpers
// ---------------------------------------------------------------------------

function getHeaders(): Record<string, string> {
  return { 'x-api-key': config.twitter.twitterApiIoKey };
}

function extractMediaUrls(t: Record<string, unknown>): string[] {
  const media: string[] = [];
  const entities = t.entities as Record<string, unknown> | undefined;
  const extEntities = t.extended_entities as Record<string, unknown> | undefined;
  const sources = [
    entities?.media,
    extEntities?.media,
    t.media,
    t.photos,
  ];
  for (const src of sources) {
    if (Array.isArray(src)) {
      for (const m of src as Record<string, unknown>[]) {
        const url = m.media_url_https || m.url || m.media_url || m.fullUrl;
        if (url && typeof url === 'string') media.push(url);
      }
    }
  }
  return [...new Set(media)];
}

function isQuoteRTWorthy(t: Record<string, unknown>): boolean {
  const likes = (t.likeCount as number) ?? 0;
  const rts = (t.retweetCount as number) ?? 0;
  const views = (t.viewCount as number) ?? 0;
  const author = t.author as Record<string, unknown> | undefined;
  const verified = !!(author?.isBlueVerified || author?.isVerified);
  return verified || likes >= 20 || rts >= 5 || views >= 2000;
}

function formatTweet(t: Record<string, unknown>): string {
  const a = (t.author as Record<string, unknown>) || {};
  const mediaUrls = extractMediaUrls(t);
  const mediaInfo = mediaUrls.length > 0
    ? `  Images(${mediaUrls.length}): ${mediaUrls.join(', ')}`
    : '';
  const engagementLabel = isQuoteRTWorthy(t) ? '' : '  [⚠️低エンゲージメント: 引用RT不可]';
  return [
    `@${a.userName || '?'} (${a.name || '?'})`,
    `  "${(t.text as string)?.slice(0, 200) || ''}"`,
    `  URL: ${t.url || ''}`,
    `  Likes: ${(t.likeCount as number) ?? 0} | RT: ${(t.retweetCount as number) ?? 0} | Replies: ${(t.replyCount as number) ?? 0} | Views: ${(t.viewCount as number) ?? 0}`,
    `  Date: ${t.createdAt || ''}`,
    engagementLabel,
    mediaInfo,
  ].filter(Boolean).join('\n');
}

// ---------------------------------------------------------------------------
// Tools (unchanged)
// ---------------------------------------------------------------------------

class SearchTweetsTool extends StructuredTool {
  name = 'search_tweets';
  description = `キーワードでツイートを検索する（人気順）。Twitterの高度検索構文をフルサポート。
使用例:
  "AI" OR "LLM" min_faves:100 lang:ja  → AI関連で100いいね以上の日本語ツイート
  "Minecraft" min_faves:50 lang:ja      → マイクラ関連でバズってるやつ
  from:elonmusk min_faves:1000          → イーロンの人気ツイート
演算子: min_faves:N, min_retweets:N, lang:ja, since:YYYY-MM-DD, until:YYYY-MM-DD, from:user, to:user, filter:media, OR, AND, -（除外）`;
  schema = z.object({
    query: z.string().describe('検索クエリ（Twitter高度検索構文対応）'),
    count: z.number().optional().describe('取得件数（デフォルト10、最大20）'),
  });
  async _call(data: z.infer<typeof this.schema>): Promise<string> {
    try {
      const res = await axios.get(`${API_BASE}/twitter/tweet/advanced_search`, {
        headers: getHeaders(),
        params: { queryType: 'Top', query: data.query },
      });
      const allTweets = res.data?.tweets || res.data?.data?.tweets || [];
      const worthy = allTweets.filter(isQuoteRTWorthy);
      const base = worthy.length >= 3 ? worthy : allTweets;
      const tweets = base.slice(0, data.count || 10);
      if (tweets.length === 0) return '検索結果なし';
      return tweets.map(formatTweet).join('\n---\n');
    } catch (e: unknown) {
      return `検索エラー: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
}

class GetTweetRepliesTool extends StructuredTool {
  name = 'get_tweet_replies';
  description = '特定ツイートへの返信一覧を取得する。会話の流れや反応を確認するのに使う。';
  schema = z.object({
    tweetId: z.string().describe('ツイートID'),
    count: z.number().optional().describe('取得件数（デフォルト10、最大20）'),
  });
  async _call(data: z.infer<typeof this.schema>): Promise<string> {
    try {
      const res = await axios.get(`${API_BASE}/twitter/tweet/replies`, {
        headers: getHeaders(),
        params: { tweetId: data.tweetId },
      });
      const replies = (res.data?.replies || res.data?.data?.replies || []).slice(0, data.count || 10);
      if (replies.length === 0) return '返信なし';
      return replies.map(formatTweet).join('\n---\n');
    } catch (e: unknown) {
      return `返信取得エラー: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
}

class GetTweetDetailsTool extends StructuredTool {
  name = 'get_tweet_details';
  description = 'ツイートIDから詳細情報（本文、著者、エンゲージメント）を取得する。';
  schema = z.object({ tweetId: z.string().describe('ツイートID') });
  async _call(data: z.infer<typeof this.schema>): Promise<string> {
    try {
      const res = await axios.get(`${API_BASE}/twitter/tweets`, {
        headers: getHeaders(),
        params: { tweet_ids: data.tweetId },
      });
      const tweets = res.data?.tweets || res.data?.data?.tweets || [];
      if (tweets.length === 0) return 'ツイートが見つかりません';
      return formatTweet(tweets[0]);
    } catch (e: unknown) {
      return `詳細取得エラー: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
}

class GetUserTweetsTool extends StructuredTool {
  name = 'get_user_tweets';
  description = '特定ユーザーの最新ツイートを取得する。';
  schema = z.object({
    userName: z.string().describe('Twitterユーザー名（@なし）'),
    count: z.number().optional().describe('取得件数（デフォルト5、最大10）'),
  });
  async _call(data: z.infer<typeof this.schema>): Promise<string> {
    try {
      const res = await axios.get(`${API_BASE}/twitter/user/last_tweets`, {
        headers: getHeaders(),
        params: { userName: data.userName },
      });
      const tweets = (res.data?.data?.tweets || res.data?.tweets || []).slice(0, data.count || 5);
      if (tweets.length === 0) return `@${data.userName} のツイートが見つかりません`;
      return tweets.map(formatTweet).join('\n---\n');
    } catch (e: unknown) {
      return `ユーザーツイート取得エラー: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
}

class GetUserProfileTool extends StructuredTool {
  name = 'get_user_profile';
  description = 'ユーザーのプロフィール情報を取得する。';
  schema = z.object({ userName: z.string().describe('Twitterユーザー名（@なし）') });
  async _call(data: z.infer<typeof this.schema>): Promise<string> {
    try {
      const [profileRes, tweetsRes] = await Promise.all([
        axios.get(`${API_BASE}/twitter/user/info`, { headers: getHeaders(), params: { userName: data.userName } }),
        axios.get(`${API_BASE}/twitter/user/last_tweets`, { headers: getHeaders(), params: { userName: data.userName } }),
      ]);
      const u = profileRes.data?.data;
      if (!u) return `@${data.userName} が見つかりません`;
      const recentTweets = (tweetsRes.data?.data?.tweets || tweetsRes.data?.tweets || []).slice(0, 3);
      const lines = [
        `## @${u.userName} (${u.name})`,
        `Bio: ${u.description || '(なし)'}`,
        `Followers: ${(u.followers ?? 0).toLocaleString()} | Following: ${(u.following ?? 0).toLocaleString()} | Tweets: ${(u.statusesCount ?? 0).toLocaleString()}`,
        `Verified: ${u.isBlueVerified ? 'Yes' : 'No'} | Created: ${u.createdAt || '?'}`,
      ];
      if (recentTweets.length > 0) {
        lines.push('', '### 直近のツイート');
        for (const t of recentTweets) { lines.push(formatTweet(t), '---'); }
      }
      return lines.join('\n');
    } catch (e: unknown) {
      return `プロフィール取得エラー: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
}

class GoogleSearchTool extends StructuredTool {
  name = 'google_search';
  description = 'Googleでキーワード検索する。トレンドの背景情報をWeb上から調べるのに使う。';
  schema = z.object({
    query: z.string().describe('検索クエリ'),
    count: z.number().optional().describe('取得件数（デフォルト5、最大10）'),
  });
  async _call(data: z.infer<typeof this.schema>): Promise<string> {
    const apiKey = config.google.apiKey;
    const cx = config.google.searchEngineId;
    if (!apiKey || !cx) return 'Google Search APIが設定されていません';
    try {
      const res = await axios.get('https://www.googleapis.com/customsearch/v1', {
        params: { key: apiKey, cx, q: data.query, num: Math.min(data.count || 5, 10) },
      });
      const items: Array<{ title?: string; link?: string; snippet?: string }> = res.data?.items || [];
      if (items.length === 0) return '検索結果なし';
      return items.map((item) =>
        [`タイトル: ${item.title}`, `URL: ${item.link}`, `概要: ${item.snippet}`].join('\n'),
      ).join('\n---\n');
    } catch (e: unknown) {
      return `Google検索エラー: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
}

class ExploreTrendTweetsTool extends StructuredTool {
  name = 'explore_trend_tweets';
  description = 'トレンドキーワードの最新ツイートをリアルタイムで探索する。最新順で取得。';
  schema = z.object({
    keyword: z.string().describe('トレンドキーワードまたは検索クエリ'),
    count: z.number().optional().describe('取得件数（デフォルト15、最大30）'),
  });
  async _call(data: z.infer<typeof this.schema>): Promise<string> {
    try {
      const res = await axios.get(`${API_BASE}/twitter/tweet/advanced_search`, {
        headers: getHeaders(),
        params: { queryType: 'Latest', query: data.keyword },
      });
      const allTweets = res.data?.tweets || res.data?.data?.tweets || [];
      const worthyTweets = allTweets.filter(isQuoteRTWorthy);
      const base = worthyTweets.length >= 3 ? worthyTweets : allTweets;
      const tweets = base.slice(0, data.count || 15);
      if (tweets.length === 0) return `"${data.keyword}" のツイートなし`;
      const filteredNote = worthyTweets.length < allTweets.length
        ? `（低エンゲージメントポストは除外済み: ${allTweets.length - worthyTweets.length}件）`
        : '';
      return `"${data.keyword}" の最新ツイート ${tweets.length}件${filteredNote}:\n` +
        tweets.map(formatTweet).join('\n---\n');
    } catch (e: unknown) {
      return `トレンド探索エラー: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
}

class AnalyzeTweetImageTool extends StructuredTool {
  name = 'analyze_tweet_image';
  description = 'ツイートに添付された画像をAIで解析する。';
  schema = z.object({ tweetId: z.string().describe('解析するツイートのID') });
  async _call(data: z.infer<typeof this.schema>): Promise<string> {
    try {
      const res = await axios.get(`${API_BASE}/twitter/tweets`, {
        headers: getHeaders(),
        params: { tweet_ids: data.tweetId },
      });
      const tweet = (res.data?.tweets || res.data?.data?.tweets || [])[0];
      if (!tweet) return 'ツイートが見つかりません';
      const imageUrls = extractMediaUrls(tweet);
      if (imageUrls.length === 0) return 'このツイートには画像がありません';
      const model = createTracedModel({ modelName: 'gpt-4o', temperature: 0 });
      const result = await model.invoke([
        new HumanMessage({
          content: [
            { type: 'text', text: `以下のツイートの画像を分析して日本語で説明してください。\nツイート本文: "${tweet.text?.slice(0, 300) || ''}"` },
            ...imageUrls.slice(0, 4).map((url) => ({ type: 'image_url' as const, image_url: { url, detail: 'low' as const } })),
          ],
        }),
      ]);
      return `画像解析結果 (${imageUrls.length}枚):\n${result.content}`;
    } catch (e: unknown) {
      return `画像解析エラー: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
}

// ---------------------------------------------------------------------------
// Tool: submit_exploration (replaces submit_tweet for FCA)
// ---------------------------------------------------------------------------

class SubmitExplorationTool extends StructuredTool {
  name = 'submit_exploration';
  description = '探索が完了したら、このツールで探索結果を提出する。ツイート文を書く必要はない。素材だけ返せ。';
  schema = z.object({
    type: z.enum(['tweet', 'quote_rt']).describe('"tweet" = オリジナル, "quote_rt" = 引用RT'),
    topic: z.string().describe('何についてか（3〜5語のキーワード）'),
    context: z.string().describe('探索で得た情報の要約（200文字以内。面白いポイントを簡潔に）'),
    quoteUrl: z.string().optional().describe('引用RTの場合のみ: 元ツイートのURL'),
    quotedText: z.string().optional().describe('引用RTの場合のみ: 元ツイートの本文'),
  });
  async _call(data: z.infer<typeof this.schema>): Promise<string> {
    return JSON.stringify(data);
  }
}

// ---------------------------------------------------------------------------
// AutoTweetAgent (4-phase: mode -> explore -> generate -> review)
// ---------------------------------------------------------------------------

export class AutoTweetAgent {
  private explorePrompt: string;
  private generatePrompt: string;
  private reviewPrompt: string;
  private tools: StructuredTool[];
  private toolMap: Map<string, StructuredTool>;
  private watchlist: WatchlistConfig;

  private constructor(
    explorePrompt: string,
    generatePrompt: string,
    reviewPrompt: string,
    watchlist: WatchlistConfig,
  ) {
    this.explorePrompt = explorePrompt;
    this.generatePrompt = generatePrompt;
    this.reviewPrompt = reviewPrompt;
    this.watchlist = watchlist;

    this.tools = [
      new SearchTweetsTool(),
      new GetTweetRepliesTool(),
      new GetTweetDetailsTool(),
      new GetUserTweetsTool(),
      new GetUserProfileTool(),
      new GoogleSearchTool(),
      new ExploreTrendTweetsTool(),
      new AnalyzeTweetImageTool(),
      new SubmitExplorationTool(),
    ];
    this.toolMap = new Map(this.tools.map((t) => [t.name, t]));
  }

  public static async create(): Promise<AutoTweetAgent> {
    const explorePrompt = await loadPrompt('auto_tweet_explore');
    if (!explorePrompt) throw new Error('Failed to load auto_tweet_explore prompt');

    const generatePrompt = await loadPrompt('auto_tweet');
    if (!generatePrompt) throw new Error('Failed to load auto_tweet prompt');

    const reviewPrompt = await loadPrompt('auto_tweet_review');
    if (!reviewPrompt) throw new Error('Failed to load auto_tweet_review prompt');

    let watchlist: WatchlistConfig;
    try {
      watchlist = JSON.parse(readFileSync(WATCHLIST_PATH, 'utf-8'));
    } catch {
      logger.warn('ウォッチリスト読み込み失敗、空のリストを使用');
      watchlist = { accounts: [], topicBias: [] };
    }

    return new AutoTweetAgent(explorePrompt, generatePrompt, reviewPrompt, watchlist);
  }

  // =========================================================================
  // Public: メインエントリポイント
  // =========================================================================

  public async generateTweet(
    trends: TwitterTrendData[],
    todayInfo: string,
    recentPosts?: string[],
    recentQuoteUrls?: string[],
    mode: AutoTweetMode = 'trend',
    recentTopics?: string[],
  ): Promise<AutoTweetOutput | null> {

    logger.info(`[AutoTweet] モード: ${mode}`, 'cyan');

    // Phase 1: 探索 (original モードはスキップ)
    let exploration: ExplorationResult | null = null;

    {
      for (let attempt = 1; attempt <= 2; attempt++) {
        logger.info(`[AutoTweet] 探索 (試行 ${attempt}/2)`, 'cyan');
        exploration = await this.explore(mode, trends, todayInfo, recentPosts, recentQuoteUrls, recentTopics);
        if (exploration) break;
        logger.warn('[AutoTweet] 探索結果なし、リトライ');
      }
      if (!exploration) {
        logger.warn('[AutoTweet] 探索失敗、originalモードにフォールバック');
        exploration = {
          type: 'tweet',
          topic: 'オリジナル',
          context: `今日の情報:\n${todayInfo}`,
        };
      }
    }

    logger.info(`[AutoTweet] 探索結果: type=${exploration.type} topic="${exploration.topic}"`, 'cyan');

    // Phase 2 & 3: 生成 -> レビュー (最大3回リトライ)
    let feedback: string | undefined;

    for (let attempt = 1; attempt <= MAX_REVIEW_RETRIES; attempt++) {
      logger.info(`[AutoTweet] 生成+レビュー (試行 ${attempt}/${MAX_REVIEW_RETRIES})`, 'cyan');

      const draft = await this.generate(exploration, todayInfo, recentTopics, feedback);
      if (!draft) {
        logger.warn('[AutoTweet] 生成失敗');
        feedback = '前回は生成に失敗した。別のアプローチで。';
        continue;
      }

      logger.info(`[AutoTweet] ドラフト: "${draft.text.slice(0, 60)}..."`, 'cyan');

      const review = await this.review(draft);
      if (review.approved) {
        logger.info('[AutoTweet] レビュー合格', 'green');
        return { ...draft, topic: exploration.topic };
      }

      logger.warn(`[AutoTweet] レビュー不合格: ${review.issues.join(', ')}`);
      feedback = [
        `前回のツイート「${draft.text}」は以下の理由で不合格:`,
        ...review.issues.map((i) => `- ${i}`),
        review.suggestion ? `提案: ${review.suggestion}` : '',
        '別のアプローチでもう一度。',
      ].join('\n');
    }

    logger.warn('[AutoTweet] 3回リトライ失敗、投稿スキップ');
    return null;
  }

  // =========================================================================
  // Phase 1: 探索 (FCA with gpt-4.1-mini)
  // =========================================================================

  private async explore(
    mode: AutoTweetMode,
    trends: TwitterTrendData[],
    todayInfo: string,
    recentPosts?: string[],
    recentQuoteUrls?: string[],
    recentTopics?: string[],
  ): Promise<ExplorationResult | null> {
    const model = createTracedModel({
      modelName: models.autoTweetExplore,
      temperature: 0.7,
    });
    const modelWithTools = model.bindTools(this.tools);

    const userContent = await this.buildExploreUserContent(
      mode, trends, todayInfo, recentPosts, recentQuoteUrls, recentTopics,
    );

    const messages: BaseMessage[] = [
      new SystemMessage(this.explorePrompt),
      new HumanMessage(userContent),
    ];

    let toolCallCount = 0;

    for (let i = 0; i < MAX_EXPLORATION_ITERATIONS; i++) {
      let response: AIMessage;
      try {
        response = (await modelWithTools.invoke(messages)) as AIMessage;
      } catch (e: unknown) {
        logger.error(`[AutoTweet] 探索LLMエラー: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }
      messages.push(response);

      const toolCalls = response.tool_calls || [];

      if (toolCalls.length === 0) return null;

      for (const tc of toolCalls) {
        if (tc.name === 'submit_exploration') {
          try {
            const result = await this.toolMap.get(tc.name)!.invoke(tc.args);
            return JSON.parse(result) as ExplorationResult;
          } catch {
            return null;
          }
        }

        if (toolCallCount >= MAX_TOOL_CALLS) {
          messages.push(new ToolMessage({
            content: 'ツール呼び出し上限に達しました。submit_exploration で探索結果を提出してください。',
            tool_call_id: tc.id || `call_${Date.now()}`,
          }));
          continue;
        }

        const tool = this.toolMap.get(tc.name);
        if (!tool) {
          messages.push(new ToolMessage({
            content: `ツール "${tc.name}" は存在しません`,
            tool_call_id: tc.id || `call_${Date.now()}`,
          }));
          continue;
        }

        try {
          logger.debug(`[AutoTweet] Tool: ${tc.name}(${JSON.stringify(tc.args).slice(0, 100)})`);
          const result = await tool.invoke(tc.args);
          const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
          messages.push(new ToolMessage({
            content: resultStr.slice(0, 4000),
            tool_call_id: tc.id || `call_${Date.now()}`,
          }));
          toolCallCount++;
        } catch (e: unknown) {
          messages.push(new ToolMessage({
            content: `ツール実行エラー: ${e instanceof Error ? e.message : String(e)}`,
            tool_call_id: tc.id || `call_${Date.now()}`,
          }));
        }
      }
    }

    logger.warn('[AutoTweet] 探索イテレーション上限到達');
    return null;
  }

  private async fetchGenreBuzzTweets(): Promise<string> {
    const shuffled = [...GENRE_SEARCH_QUERIES].sort(() => Math.random() - 0.5);
    const selected = shuffled.slice(0, 3);
    const searchTool = this.toolMap.get('search_tweets')!;
    const results: string[] = [];

    for (const { genre, query } of selected) {
      try {
        const result = await searchTool.invoke({ query, count: 5 });
        if (typeof result === 'string' && !result.includes('エラー') && result !== '検索結果なし') {
          results.push(`## ${genre}\n${result}`);
        }
      } catch { /* skip */ }
    }

    return results.length > 0
      ? `# ジャンル別バズツイート（素材候補）\n\n${results.join('\n\n')}`
      : '';
  }

  private async buildExploreUserContent(
    mode: AutoTweetMode,
    trends: TwitterTrendData[],
    todayInfo: string,
    recentPosts?: string[],
    recentQuoteUrls?: string[],
    recentTopics?: string[],
  ): Promise<string> {
    const parts: string[] = [
      `# モード: ${mode}`,
      '',
      `# 今日の情報`,
      todayInfo,
      '',
    ];

    if (mode === 'trend') {
      const trendsText = trends
        .map((t) => `${t.rank}. ${t.name}${t.metaDescription ? ` - ${t.metaDescription}` : ''}`)
        .join('\n');
      const topicBiasText = this.watchlist.topicBias.length > 0
        ? `\n特に注目すべきジャンル: ${this.watchlist.topicBias.join(', ')}`
        : '';
      parts.push(`# 現在のトレンド (日本)\n${trendsText}${topicBiasText}`, '');
    }

    if (mode === 'trend' || mode === 'original') {
      const genreBuzz = await this.fetchGenreBuzzTweets();
      if (genreBuzz) {
        parts.push(genreBuzz, '');
      }
    }

    if (mode === 'watchlist' || mode === 'trend') {
      let accountsToShow = this.watchlist.accounts;
      if (mode === 'watchlist' && accountsToShow.length > 6) {
        const shuffled = [...accountsToShow].sort(() => Math.random() - 0.5);
        accountsToShow = shuffled.slice(0, 6);
      }
      const watchlistAccounts = accountsToShow.length > 0
        ? accountsToShow.map((a) => `- @${a.userName} (${a.label})`).join('\n')
        : '';
      parts.push(
        `# ウォッチリスト（get_user_tweets で最新投稿を取得して面白いものを探せ）`,
        `**必ず複数アカウントを確認すること。1人目で決めるな。全員チェックしてから選べ。**`,
        watchlistAccounts || 'ウォッチリストの投稿は get_user_tweets ツールで取得できます。',
        '',
      );
    }

    if (mode === 'big_account_quote') {
      const shuffled = [...BIG_ACCOUNTS].sort(() => Math.random() - 0.5);
      const selected = shuffled.slice(0, 5);
      parts.push(
        `# 大物アカウントリスト（以下の全アカウントの最新投稿を get_user_tweets で確認し、最もバズっているものを引用RT素材にせよ）`,
        `**必ず複数アカウントを確認すること。1人目で決めるな。全員チェックしてから選べ。**`,
        selected.map((a) => `- @${a}`).join('\n'),
        '',
      );
    }

    if (mode === 'original') {
      parts.push(
        '# originalモード: ジャンル別バズツイートからインスピレーションを得て、オリジナルツイートの素材を提出せよ。',
        'search_tweets で自由にトピックを探索してもよい。',
        '',
      );
    }

    if (recentPosts && recentPosts.length > 0) {
      parts.push(
        `# 直近の自分のポスト（同じ話題・同じ角度は厳禁）`,
        recentPosts.slice(-10).map((p, i) => `${i + 1}. ${p}`).join('\n'),
        '',
      );
    }

    if (recentQuoteUrls && recentQuoteUrls.length > 0) {
      parts.push(
        `# 既に引用RTしたURL（再引用禁止）`,
        recentQuoteUrls.map((u, i) => `${i + 1}. ${u}`).join('\n'),
        '',
      );
    }

    if (recentTopics && recentTopics.length > 0) {
      parts.push(
        `# 直近で触れたトピック（これらと同じ話題は厳禁）`,
        recentTopics.map((t, i) => `${i + 1}. ${t}`).join('\n'),
        '',
      );
    }

    parts.push('ツールを使って探索し、submit_exploration で素材を提出してください。');

    return parts.filter(Boolean).join('\n');
  }

  // =========================================================================
  // Phase 2: 生成 (Gemini)
  // =========================================================================

  private async generate(
    exploration: ExplorationResult,
    todayInfo: string,
    recentTopics?: string[],
    feedback?: string,
  ): Promise<AutoTweetOutput | null> {
    const isGemini = models.autoTweetGenerate.startsWith('gemini');
    const isO1Style = models.autoTweetGenerate.startsWith('gpt-5') || models.autoTweetGenerate.startsWith('o');
    const model = createTracedModel({
      modelName: models.autoTweetGenerate,
      ...(isO1Style
        ? { modelKwargs: { max_completion_tokens: 4096 } }
        : { temperature: 0.9 }),
      ...(isGemini
        ? {
            maxTokens: 8192,
            timeout: 300000,
            configuration: {
              baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
              apiKey: config.google.geminiApiKey,
            },
            apiKey: config.google.geminiApiKey,
          }
        : {
            apiKey: config.openaiApiKey,
          }),
    });

    const userParts: string[] = [];

    if (exploration.type === 'quote_rt' && exploration.quoteUrl) {
      userParts.push(
        `# 引用RTモード`,
        `引用元URL: ${exploration.quoteUrl}`,
        `引用元本文: "${exploration.quotedText || ''}"`,
        `トピック: ${exploration.topic}`,
        `コンテキスト: ${exploration.context}`,
        '',
        'この投稿を引用RTするシャノンらしいコメントを1つ書いて。',
      );
    } else {
      userParts.push(
        `# オリジナルツイートモード`,
        `トピック: ${exploration.topic}`,
        `コンテキスト: ${exploration.context}`,
        '',
        `今日の情報: ${todayInfo}`,
        '',
        'このテーマでシャノンらしいツイートを1つ書いて。',
      );
    }

    if (recentTopics && recentTopics.length > 0) {
      userParts.push('', `直近で触れたトピック（被り禁止）: ${recentTopics.join(', ')}`);
    }

    if (feedback) {
      userParts.push('', `# フィードバック\n${feedback}`);
    }

    userParts.push(
      '',
      `文字数目安: ${exploration.type === 'quote_rt' ? '60〜100' : '60〜140'}文字。短いほど刺さる。1〜2文で。`,
      'ツイート本文のみ出力。前置き不要。',
    );

    try {
      const response = await model.invoke([
        new SystemMessage(this.generatePrompt),
        new HumanMessage(userParts.join('\n')),
      ]);

      let text = typeof response.content === 'string'
        ? response.content.trim()
        : '';

      text = text.replace(/^["「]|["」]$/g, '').trim();

      if (!text) return null;

      return {
        type: exploration.type,
        text,
        quoteUrl: exploration.quoteUrl,
      };
    } catch (e: unknown) {
      logger.error(`[AutoTweet] Gemini生成エラー: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  // =========================================================================
  // Phase 3: レビュー (gpt-4.1-mini)
  // =========================================================================

  private async review(draft: AutoTweetOutput): Promise<ReviewResult> {
    const model = createTracedModel({
      modelName: models.autoTweetReview,
      temperature: 0,
    });

    const draftDescription = draft.type === 'quote_rt'
      ? `引用RT:\nコメント: "${draft.text}"\n引用元URL: ${draft.quoteUrl}`
      : `ツイート: "${draft.text}"`;

    const messages = [
      new SystemMessage(this.reviewPrompt),
      new HumanMessage(`以下のツイート案を審査してください。JSON形式で結果を返してください。\n\n${draftDescription}`),
    ];

    try {
      const response = await model.invoke(messages);
      const text = typeof response.content === 'string' ? response.content.trim() : '';

      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        logger.warn(`[AutoTweet] レビューJSON解析失敗: ${text.slice(0, 200)}`);
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
      logger.error(`[AutoTweet] レビューエラー: ${e instanceof Error ? e.message : String(e)}`);
      return { approved: true, issues: [], viewer_perception: '', suggestion: '' };
    }
  }

  // =========================================================================
  // ウォッチリスト事前取得
  // =========================================================================

  private async fetchWatchlistContext(): Promise<string> {
    if (this.watchlist.accounts.length === 0) return '';

    const categories = new Map<string, typeof this.watchlist.accounts>();
    for (const acc of this.watchlist.accounts) {
      if (!categories.has(acc.category)) categories.set(acc.category, []);
      categories.get(acc.category)!.push(acc);
    }

    const selected: typeof this.watchlist.accounts = [];
    for (const [, accounts] of categories) {
      const shuffled = [...accounts].sort(() => Math.random() - 0.5);
      selected.push(...shuffled.slice(0, 2));
    }

    const results: string[] = [];
    const getUserTweets = this.toolMap.get('get_user_tweets')!;

    for (const acc of selected.slice(0, 6)) {
      try {
        const result = await getUserTweets.invoke({ userName: acc.userName, count: 3 });
        if (typeof result === 'string' && !result.includes('エラー') && !result.includes('見つかりません')) {
          results.push(`## ${acc.label} (@${acc.userName})\n${result}`);
        }
      } catch { /* skip */ }
    }

    return results.join('\n\n');
  }
}
