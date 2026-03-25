import axios, { isAxiosError } from 'axios';
import { config } from '../../../config/env.js';
import { createLogger } from '../../../utils/logger.js';
const logger = createLogger('Twitter:API');
import { retryWithBackoff } from '../../../utils/retryWithBackoff.js';
import { TwitterAuthManager } from './TwitterAuthManager.js';

/** advanced_search から返されるツイートの型 */
export interface TweetData {
  id: string;
  text: string;
  url: string;
  createdAt: string;
  created_at?: string;
  likeCount: number;
  retweetCount: number;
  replyCount: number;
  quoteCount: number;
  isReply: boolean;
  inReplyToId?: string;
  inReplyToUserId?: string;
  in_reply_to_status_id?: string;
  in_reply_to_tweet_id?: string;
  in_reply_to_user_id?: string;
  author: {
    id: string;
    userName: string;
    name: string;
  };
}

export class TwitterApiClient {
  private auth: TwitterAuthManager;

  constructor(auth: TwitterAuthManager) {
    this.auth = auth;
  }

  // =========================================================================
  // Tweet Fetching
  // =========================================================================

  public async fetchTweetContent(tweetId: string) {
    const endpoint = 'https://api.twitterapi.io/twitter/tweets';

    try {
      const options = {
        method: 'GET' as const,
        headers: { 'X-API-Key': this.auth.getApiKey() },
        params: { tweet_ids: tweetId },
      };

      const response = await axios.get(endpoint, options);
      const tweet = response.data.tweets?.[0];
      return {
        text: tweet?.text,
        createdAt: tweet?.createdAt,
        retweetCount: tweet?.retweetCount,
        replyCount: tweet?.replyCount,
        likeCount: tweet?.likeCount,
        authorId: tweet?.author?.id,
        authorName: tweet?.author?.name,
        mediaUrl: tweet?.extendedEntities?.media?.[0]?.media_url_https,
      };
    } catch (error: unknown) {
      const errMsg = isAxiosError(error)
        ? (error.response?.data ?? error.message)
        : error instanceof Error ? error.message : String(error);
      logger.error('API呼び出しエラー:', errMsg);
      throw error;
    }
  }

  // =========================================================================
  // Tweet Posting
  // =========================================================================

  /** twitter-api-v2 (OAuth 1.0a) 経由でツイート (返信対応) */
  public async postTweetByApi(content: string, replyToId?: string | null) {
    try {
      const options: { text: string; reply?: { in_reply_to_tweet_id: string } } = {
        text: content,
      };
      if (replyToId) {
        options.reply = { in_reply_to_tweet_id: replyToId };
      }
      const response = await this.auth.client.v2.tweet(options);
      logger.success(`[postTweetByApi] 投稿成功: ${response.data.id}`);
    } catch (error: unknown) {
      const errObj = error as Record<string, unknown>;
      const detail = errObj?.data ? ` data=${JSON.stringify(errObj.data).slice(0, 300)}` : '';
      const errDetail = errObj?.errors ? ` errors=${JSON.stringify(errObj.errors).slice(0, 300)}` : '';
      logger.error(`[postTweetByApi] エラー: ${error instanceof Error ? error.message : String(error)}${detail}${errDetail}`);
      throw error;
    }
  }

  /**
   * twitterapi.io v2 経由でツイート (返信含む)
   * create_tweet_v2 + login_cookies を使用（226エラー回避）
   */
  public async postTweet(
    content: string,
    mediaUrl: string | null,
    replyId: string | null,
    isTest: boolean = false,
    _retried: boolean = false,
  ): Promise<import('axios').AxiosResponse | undefined> {
    // login_cookies が未取得なら自動ログイン
    await this.auth.ensureLoginCookies();

    try {
      const endpoint = 'https://api.twitterapi.io/twitter/create_tweet_v2';
      const data: Record<string, unknown> = {
        login_cookies: this.auth.login_cookies,
        tweet_text: content,
        proxy: this.auth.getProxy1(),
      };
      // Premium プランは長文ツイート対応
      if (!isTest && content.length > 280) {
        data.is_note_tweet = true;
      }
      if (replyId) {
        data.reply_to_tweet_id = replyId;
      }
      if (mediaUrl) {
        data.media_ids = [mediaUrl];
      }
      const reqConfig = { headers: { 'X-API-Key': this.auth.getApiKey() } };
      logger.info(`[postTweet] 投稿中 (v2)... replyId=${replyId}`, 'cyan');
      const response = await axios.post(endpoint, data, reqConfig);
      const resData = response.data;
      logger.info(`[postTweet] レスポンス: ${JSON.stringify(resData).slice(0, 200)}`, 'cyan');

      // --- エラー判定 ---
      if (resData?.status === 'error') {
        const errMsg = resData?.message || resData?.msg || 'Unknown error';
        const errLower = errMsg.toLowerCase();

        // Note Tweet: twitterapi.io が tweet_id をパースできないが投稿自体は成功している
        if (errLower.includes('could not extract tweet_id')) {
          logger.warn(`[postTweet] Note Tweet投稿: tweet_id取得失敗（投稿自体は成功の可能性あり）`);
          return response;
        }

        logger.error(`[postTweet] APIエラー: ${errMsg}`);

        // セッション切れ → 再ログインしてリトライ（1回のみ）
        if (!_retried && (errLower.includes('cookie') || errLower.includes('login') || errLower.includes('auth'))) {
          logger.warn('[postTweet] セッション無効の可能性。再ログインしてリトライします...');
          await this.auth.loginV2();
          return this.postTweet(content, mediaUrl, replyId, isTest, true);
        }
        throw new Error(`Twitter API error: ${errMsg}`);
      }

      // GraphQL 形式のエラー
      if (resData?.errors && Array.isArray(resData.errors) && resData.errors.length > 0) {
        const err = resData.errors[0];
        const errCode = err?.code ?? err?.extensions?.code;
        const errMsg = err?.message || err?.kind || 'Unknown';
        logger.error(`[postTweet] APIエラー: code=${errCode} ${errMsg}`);
        throw new Error(`Twitter API error: code=${errCode} - ${errMsg}`);
      }

      // --- 成功判定 ---
      const tweetId = resData?.tweet_id;
      if (tweetId) {
        logger.success(`[postTweet] 成功: tweet_id=${tweetId}`);
      } else if (resData?.status === 'success') {
        logger.success(`[postTweet] 成功（tweet_idなし）`);
      } else {
        logger.warn(`[postTweet] 成功判定不明: ${JSON.stringify(resData).slice(0, 300)}`);
      }
      return response;
    } catch (error: unknown) {
      const respDetail = isAxiosError(error) ? ` resp=${JSON.stringify(error.response?.data).slice(0, 300)}` : '';
      logger.error(`[postTweet] エラー: ${error instanceof Error ? error.message : String(error)}${respDetail}`);
      throw error;
    }
  }

  /**
   * twitterapi.io v2 経由でメディアをアップロードし media_id を返す
   */
  public async uploadMedia(imageBuffer: Buffer, filename: string = 'image.png', isRetry: boolean = false): Promise<string | null> {
    await this.auth.ensureLoginCookies();

    try {
      const FormData = (await import('form-data')).default;
      const form = new FormData();
      form.append('file', imageBuffer, { filename, contentType: 'image/png' });
      form.append('login_cookies', this.auth.login_cookies);
      form.append('proxy', this.auth.getProxy1());

      const endpoint = 'https://api.twitterapi.io/twitter/upload_media_v2';
      logger.info(`[uploadMedia] アップロード中... (${(imageBuffer.length / 1024).toFixed(1)} KB)${isRetry ? ' [リトライ]' : ''}`, 'cyan');

      const response = await axios.post(endpoint, form, {
        headers: {
          ...form.getHeaders(),
          'X-API-Key': this.auth.getApiKey(),
        },
        maxContentLength: 10 * 1024 * 1024,
        maxBodyLength: 10 * 1024 * 1024,
      });

      const resData = response.data;
      if (resData?.status === 'success' && resData?.media_id) {
        logger.info(`[uploadMedia] 成功: media_id=${resData.media_id}`, 'green');
        return resData.media_id;
      }

      const errDetail = resData?.msg || resData?.message || JSON.stringify(resData).slice(0, 200);
      logger.error(`[uploadMedia] エラー: ${errDetail}`);

      if (!isRetry) {
        logger.warn('[uploadMedia] セッション無効の可能性。再ログインしてリトライします...');
        await this.auth.loginV2();
        return this.uploadMedia(imageBuffer, filename, true);
      }
      return null;
    } catch (error: unknown) {
      const errMsg = isAxiosError(error)
        ? error.response?.data?.message || error.message
        : error instanceof Error ? error.message : String(error);
      logger.error(`[uploadMedia] 失敗: ${errMsg}`);

      if (!isRetry) {
        logger.warn('[uploadMedia] 再ログインしてリトライします...');
        try {
          await this.auth.loginV2();
          return this.uploadMedia(imageBuffer, filename, true);
        } catch {
          return null;
        }
      }
      return null;
    }
  }

  /**
   * twitterapi.io v2 経由で引用リツイート
   */
  public async postQuoteTweet(content: string, quoteTweetUrl: string) {
    try {
      const endpoint = 'https://api.twitterapi.io/twitter/create_tweet_v2';
      const tweetText = `${content} ${quoteTweetUrl}`;
      const data = {
        login_cookies: this.auth.login_cookies,
        tweet_text: tweetText,
        proxy: this.auth.getProxy1(),
      };
      const reqConfig = { headers: { 'X-API-Key': this.auth.getApiKey() } };
      const response = await axios.post(endpoint, data, reqConfig);
      const resData = response.data;
      logger.debug(`[postQuoteTweet] API response: ${JSON.stringify(resData).slice(0, 300)}`);
      if (resData?.status === 'error') {
        const errMsg = resData?.msg || resData?.message || JSON.stringify(resData);
        logger.error(`引用RT投稿失敗: ${errMsg}`);
        throw new Error(`Twitter API error: ${errMsg}`);
      }
      logger.success(`引用RT投稿成功: tweet_id=${resData?.tweet_id ?? 'OK'} text_len=${tweetText.length}`);
      return response;
    } catch (error: unknown) {
      logger.error(`引用RT投稿失敗: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  // =========================================================================
  // Tweet Actions (いいね・リツイート)
  // =========================================================================

  /** ツイートにいいね */
  public async likeTweet(tweetId: string) {
    try {
      const endpoint = 'https://api.twitterapi.io/twitter/like_tweet';
      const data = {
        auth_session: this.auth.getAuthSession(),
        tweet_id: tweetId,
        proxy: this.getProxy2(),
      };
      const reqConfig = { headers: { 'X-API-Key': this.auth.getApiKey() } };
      await axios.post(endpoint, data, reqConfig);
      logger.info(`♥ ツイート ${tweetId} にいいねしました`, 'green');
    } catch (e) {
      logger.error('いいね失敗:', e);
    }
  }

  /** ツイートをリツイート */
  public async retweetTweet(tweetId: string) {
    try {
      const endpoint = 'https://api.twitterapi.io/twitter/retweet_tweet';
      const data = {
        auth_session: this.auth.getAuthSession(),
        tweet_id: tweetId,
        proxy: this.getProxy3(),
      };
      const reqConfig = { headers: { 'X-API-Key': this.auth.getApiKey() } };
      await axios.post(endpoint, data, reqConfig);
      logger.info(`🔁 ツイート ${tweetId} をリツイートしました`, 'green');
    } catch (e) {
      logger.error('リツイート失敗:', e);
    }
  }

  // =========================================================================
  // User / Search
  // =========================================================================

  /** 自分の最新ツイートを取得 */
  public async getLatestTweets(userName: string): Promise<TweetData[]> {
    try {
      const endpoint = 'https://api.twitterapi.io/twitter/user/last_tweets';
      const options = {
        method: 'GET' as const,
        headers: { 'X-API-Key': this.auth.getApiKey() },
        params: { userName },
      };
      const res = await axios.get(endpoint, options);
      if (res.data.status === 'success') {
        const tweets = res.data.data.tweets as TweetData[];
        return tweets.filter((tweet) => !tweet.isReply).slice(0, 3);
      } else {
        logger.error(`Tweet error: ${res.data.data?.message}`);
        return [];
      }
    } catch (error: unknown) {
      logger.error(`Tweet error: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  /** ツイートへの返信を取得 */
  public async getReplies(tweet: TweetData, myUserId: string | null) {
    const endpoint = 'https://api.twitterapi.io/twitter/tweet/replies';
    const options = {
      method: 'GET' as const,
      headers: { 'X-API-Key': this.auth.getApiKey() },
      params: { tweetId: tweet.id },
    };
    const res = await axios.get(endpoint, options);
    if (res.data.status === 'success') {
      const replies = res.data.tweets as TweetData[];
      const filteredReplies = replies.filter(
        (reply) =>
          reply.replyCount === 0 && reply.author.id !== myUserId
      );
      return {
        reply: filteredReplies[0],
        myTweet: tweet.text,
      };
    } else {
      logger.error(`Tweet error: ${res.data.data?.message}`);
      return {};
    }
  }

  /** advanced_search でツイートを取得 */
  public async advancedSearch(query: string): Promise<TweetData[]> {
    const allTweets: TweetData[] = [];
    let nextCursor: string | null = null;

    do {
      const params: Record<string, string> = {
        query,
        queryType: 'Latest',
      };
      if (nextCursor) params.cursor = nextCursor;

      const res = await axios.get(
        'https://api.twitterapi.io/twitter/tweet/advanced_search',
        {
          headers: { 'X-API-Key': this.auth.getApiKey() },
          params,
        }
      );

      if (res.data.status && res.data.status !== 'success') {
        logger.error(`advanced_search エラー: ${JSON.stringify(res.data)}`);
        break;
      }

      if (!Array.isArray(res.data.tweets)) {
        logger.error(`advanced_search 予期しないレスポンス形式: ${JSON.stringify(res.data).substring(0, 300)}`);
        break;
      }

      const tweets = res.data.tweets as TweetData[];
      allTweets.push(...tweets);

      if (res.data.has_next_page && res.data.next_cursor) {
        nextCursor = res.data.next_cursor;
      } else {
        nextCursor = null;
      }
    } while (nextCursor);

    return allTweets;
  }

  /** トレンドデータを取得 (日本: woeid=23424856) */
  public async fetchTrends(): Promise<import('@shannon/common').TwitterTrendData[]> {
    try {
      const res = await axios.get(
        'https://api.twitterapi.io/twitter/trends',
        {
          headers: { 'X-API-Key': this.auth.getApiKey() },
          params: { woeid: '23424856' },
        }
      );

      if (res.data?.trends && Array.isArray(res.data.trends)) {
        return res.data.trends.map((t: any, i: number) => {
          const trend = t.trend && typeof t.trend === 'object' ? t.trend : t;
          return {
            name: trend.name ?? '',
            query: trend.target?.query ?? trend.query ?? trend.name ?? '',
            rank: trend.rank ?? i + 1,
            metaDescription: trend.meta_description ?? trend.metaDescription ?? undefined,
          };
        });
      }

      logger.warn('🐦 fetchTrends: 予期しないレスポンス形式');
      return [];
    } catch (error) {
      logger.error('🐦 fetchTrends エラー:', error);
      return [];
    }
  }

  // =========================================================================
  // Webhook ルール管理
  // =========================================================================

  /** 現在のWebhookルールID (起動中のみ保持) */
  private webhookRuleId: string | null = null;
  /** 引用RT検知用WebhookルールID */
  private quoteRTWebhookRuleId: string | null = null;

  /**
   * twitterapi.io の Webhook フィルタルールをセットアップし有効化する。
   */
  public async setupWebhookRule(isTest: boolean): Promise<void> {
    const baseUrl = config.twitter.webhookBaseUrl;
    const userName = config.twitter.userName;
    if (!baseUrl || !userName) {
      logger.warn('🔔 Webhook: webhookBaseUrl または userName が未設定。スキップ');
      return;
    }

    const tag = `shannon-reply-${isTest ? 'dev' : 'prod'}`;
    const filterValue = `to:${userName}`;
    const interval = config.twitter.webhookInterval;

    try {
      const rulesRes = await axios.get(
        'https://api.twitterapi.io/oapi/tweet_filter/get_rules',
        { headers: { 'X-API-Key': this.auth.getApiKey() } }
      );

      const existingRules: Array<{
        rule_id: string;
        tag: string;
        value: string;
        interval_seconds: number;
        is_effect?: number;
      }> = rulesRes.data?.rules ?? [];

      const existing = existingRules.find((r) => r.tag === tag);

      if (existing) {
        this.webhookRuleId = existing.rule_id;
        const alreadyActive = existing.is_effect === 1;
        logger.info(
          `🔔 Webhook: 既存ルールを再利用 (id=${existing.rule_id}, tag=${tag}, active=${alreadyActive})`,
          'cyan'
        );
        if (alreadyActive) {
          logger.info(
            `🔔 Webhook: ルールは既に有効。再有効化スキップ (interval=${interval}秒, filter="${filterValue}")`,
            'green'
          );
          return;
        }
      } else {
        const addRes = await axios.post(
          'https://api.twitterapi.io/oapi/tweet_filter/add_rule',
          { tag, value: filterValue, interval_seconds: interval },
          { headers: { 'X-API-Key': this.auth.getApiKey() } }
        );

        if (addRes.data?.status !== 'success') {
          logger.error(`🔔 Webhook: ルール作成失敗: ${addRes.data?.msg}`);
          return;
        }

        this.webhookRuleId = addRes.data.rule_id;
        logger.info(
          `🔔 Webhook: 新規ルール作成 (id=${this.webhookRuleId}, tag=${tag}, filter="${filterValue}")`,
          'green'
        );
      }

      const updateRes = await axios.post(
        'https://api.twitterapi.io/oapi/tweet_filter/update_rule',
        {
          rule_id: this.webhookRuleId,
          tag,
          value: filterValue,
          interval_seconds: interval,
          is_effect: 1,
        },
        { headers: { 'X-API-Key': this.auth.getApiKey() } }
      );

      if (updateRes.data?.status === 'success') {
        logger.info(
          `🔔 Webhook: ルール有効化完了 (interval=${interval}秒, filter="${filterValue}")`,
          'green'
        );
      } else {
        logger.error(`🔔 Webhook: ルール有効化失敗: ${updateRes.data?.msg}`);
      }
    } catch (error) {
      logger.error('🔔 Webhook: セットアップエラー:', error);
    }
  }

  /**
   * twitterapi.io の Webhook フィルタルールを無効化する (is_effect: 0)。
   */
  public async deactivateWebhookRule(isTest: boolean): Promise<void> {
    if (!this.webhookRuleId) {
      return;
    }

    const tag = `shannon-reply-${isTest ? 'dev' : 'prod'}`;
    const userName = config.twitter.userName;
    const filterValue = userName ? `to:${userName}` : '';
    const interval = config.twitter.webhookInterval;

    try {
      const res = await axios.post(
        'https://api.twitterapi.io/oapi/tweet_filter/update_rule',
        {
          rule_id: this.webhookRuleId,
          tag,
          value: filterValue,
          interval_seconds: interval,
          is_effect: 0,
        },
        { headers: { 'X-API-Key': this.auth.getApiKey() } }
      );

      if (res.data?.status === 'success') {
        logger.info('🔔 Webhook: ルール無効化完了', 'green');
      } else {
        logger.error(`🔔 Webhook: ルール無効化失敗: ${res.data?.msg}`);
      }
    } catch (error) {
      logger.error('🔔 Webhook: 無効化エラー:', error);
    }
  }

  /**
   * 引用RT検知用 Webhook ルールをセットアップ。
   */
  public async setupQuoteRTWebhookRule(isTest: boolean): Promise<void> {
    const baseUrl = config.twitter.webhookBaseUrl;
    const userName = config.twitter.userName;
    if (!baseUrl || !userName) {
      logger.warn('🔔 QuoteRT Webhook: webhookBaseUrl または userName が未設定。スキップ');
      return;
    }

    const tag = `shannon-quote-rt-${isTest ? 'dev' : 'prod'}`;
    const filterValue = `url:"x.com/${userName}/status" -from:${userName}`;
    const interval = config.twitter.webhookInterval;

    try {
      const rulesRes = await axios.get(
        'https://api.twitterapi.io/oapi/tweet_filter/get_rules',
        { headers: { 'X-API-Key': this.auth.getApiKey() } }
      );

      const existingRules: Array<{
        rule_id: string;
        tag: string;
        value: string;
        interval_seconds: number;
        is_effect?: number;
      }> = rulesRes.data?.rules ?? [];

      const existing = existingRules.find((r) => r.tag === tag);

      if (existing) {
        this.quoteRTWebhookRuleId = existing.rule_id;
        const alreadyActive = existing.is_effect === 1;
        logger.info(
          `🔔 QuoteRT Webhook: 既存ルールを再利用 (id=${existing.rule_id}, tag=${tag}, active=${alreadyActive})`,
          'cyan'
        );
        if (alreadyActive) {
          logger.info(
            `🔔 QuoteRT Webhook: ルールは既に有効。スキップ (filter="${filterValue}")`,
            'green'
          );
          return;
        }
      } else {
        const addRes = await axios.post(
          'https://api.twitterapi.io/oapi/tweet_filter/add_rule',
          { tag, value: filterValue, interval_seconds: interval },
          { headers: { 'X-API-Key': this.auth.getApiKey() } }
        );

        if (addRes.data?.status !== 'success') {
          logger.error(`🔔 QuoteRT Webhook: ルール作成失敗: ${addRes.data?.msg}`);
          return;
        }

        this.quoteRTWebhookRuleId = addRes.data.rule_id;
        logger.info(
          `🔔 QuoteRT Webhook: 新規ルール作成 (id=${this.quoteRTWebhookRuleId}, tag=${tag}, filter="${filterValue}")`,
          'green'
        );
      }

      const updateRes = await axios.post(
        'https://api.twitterapi.io/oapi/tweet_filter/update_rule',
        {
          rule_id: this.quoteRTWebhookRuleId,
          tag,
          value: filterValue,
          interval_seconds: interval,
          is_effect: 1,
        },
        { headers: { 'X-API-Key': this.auth.getApiKey() } }
      );

      if (updateRes.data?.status === 'success') {
        logger.info(
          `🔔 QuoteRT Webhook: ルール有効化完了 (filter="${filterValue}")`,
          'green'
        );
      } else {
        logger.error(`🔔 QuoteRT Webhook: ルール有効化失敗: ${updateRes.data?.msg}`);
      }
    } catch (error) {
      logger.error('🔔 QuoteRT Webhook: セットアップエラー:', error);
    }
  }

  // =========================================================================
  // Rate Limit Retry
  // =========================================================================

  /**
   * Rate Limit 対応の API 呼び出しラッパー。
   */
  public async callWithRetry<T>(fn: () => Promise<T>, label = 'Twitter API'): Promise<T> {
    return retryWithBackoff(fn, { maxRetries: 3, label });
  }

  // =========================================================================
  // Private helpers (proxy access)
  // =========================================================================

  private getProxy2(): string {
    return config.twitter.proxy2;
  }

  private getProxy3(): string {
    return config.twitter.proxy3;
  }
}
