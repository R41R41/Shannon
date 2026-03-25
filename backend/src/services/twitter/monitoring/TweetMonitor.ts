import {
  MemberTweetInput,
  TwitterQuoteRTOutput,
  TwitterReplyOutput,
} from '@shannon/common';
import { isAxiosError } from 'axios';
import { format } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';
import fs from 'fs';
import path from 'path';
import { LRUSet } from '../../../utils/LRUSet.js';
import { createLogger } from '../../../utils/logger.js';
const logger = createLogger('Twitter:Monitor');
import { TwitterApiClient, TweetData } from '../api/TwitterApiClient.js';
import { EventBus } from '../../eventBus/eventBus.js';

// 処理済みツイートID の永続化ファイルパス
const PROCESSED_IDS_FILE = path.resolve('saves/processed_tweet_ids.json');
// 日次返信カウンタの永続化ファイルパス
const DAILY_REPLY_COUNT_FILE = path.resolve('saves/daily_reply_count.json');

/** 監視対象アカウントの設定 */
export interface MonitoredAccountConfig {
  userName: string;
  alwaysLike: boolean;
  reply: boolean;
  alwaysQuoteRT: boolean;
  memberFCA: boolean;
}

export class TweetMonitor {
  /** 処理済みツイートID (重複アクション防止、ファイル永続化) */
  public processedTweetIds: LRUSet<string> = new LRUSet(1000);

  /** 自分のツイートへの返信チェック用 (既存機能) */
  private lastCheckedReplyIds: Set<string> = new Set();

  /** 1日あたりの返信カウンタ */
  private dailyReplyCount = 0;
  /** カウンタの日付 (YYYY-MM-DD JST) */
  private dailyReplyDate = '';
  /** 1日の返信上限 */
  private maxRepliesPerDay: number;

  /** advanced_search 用の最終チェック時刻 */
  private lastCheckedTime: Date = new Date(Date.now() - 2 * 60 * 60 * 1000);

  /** 返信確率 (0.0〜1.0) */
  private replyProbability: number;

  /** 監視対象アカウント設定 */
  private monitoredAccounts: MonitoredAccountConfig[];

  private myUserId: string | null;
  private apiClient: TwitterApiClient;
  private eventBus: EventBus;

  constructor(
    apiClient: TwitterApiClient,
    eventBus: EventBus,
    opts: {
      myUserId: string | null;
      maxRepliesPerDay: number;
      replyProbability: number;
      monitoredAccounts: MonitoredAccountConfig[];
    },
  ) {
    this.apiClient = apiClient;
    this.eventBus = eventBus;
    this.myUserId = opts.myUserId;
    this.maxRepliesPerDay = opts.maxRepliesPerDay;
    this.replyProbability = opts.replyProbability;
    this.monitoredAccounts = opts.monitoredAccounts;
  }

  // =========================================================================
  // Processed IDs persistence
  // =========================================================================

  /** 処理済みIDをファイルから読み込む */
  public loadProcessedIds(): void {
    try {
      if (fs.existsSync(PROCESSED_IDS_FILE)) {
        const data = JSON.parse(fs.readFileSync(PROCESSED_IDS_FILE, 'utf-8'));
        if (Array.isArray(data)) {
          this.processedTweetIds = LRUSet.fromArray(data.slice(-1000), 1000);
          logger.info(`📋 処理済みID: ${this.processedTweetIds.size}件をファイルから復元 (LRU max=1000)`, 'cyan');
        }
      }
    } catch (err) {
      logger.warn(`📋 処理済みIDファイル読み込み失敗: ${err}`);
    }
  }

  /** 処理済みIDをファイルに保存する */
  public saveProcessedIds(): void {
    try {
      const dir = path.dirname(PROCESSED_IDS_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(PROCESSED_IDS_FILE, JSON.stringify(this.processedTweetIds.toArray(), null, 2));
    } catch (err) {
      logger.warn(`📋 処理済みIDファイル保存失敗: ${err}`);
    }
  }

  // =========================================================================
  // Daily reply count
  // =========================================================================

  /** 日次返信カウンタをファイルから読み込む */
  public loadDailyReplyCount(): void {
    try {
      if (fs.existsSync(DAILY_REPLY_COUNT_FILE)) {
        const data = JSON.parse(fs.readFileSync(DAILY_REPLY_COUNT_FILE, 'utf-8'));
        const todayJST = this.getTodayJST();
        if (data.date === todayJST) {
          this.dailyReplyCount = data.count ?? 0;
          this.dailyReplyDate = data.date;
          logger.info(`📋 日次返信カウンタ: ${this.dailyReplyCount}/${this.maxRepliesPerDay} (${todayJST})`, 'cyan');
        } else {
          this.dailyReplyCount = 0;
          this.dailyReplyDate = todayJST;
          logger.info(`📋 日次返信カウンタ: 新しい日付のためリセット (${todayJST})`, 'cyan');
        }
      } else {
        this.dailyReplyDate = this.getTodayJST();
      }
    } catch (err) {
      logger.warn(`📋 日次返信カウンタ読み込み失敗: ${err}`);
      this.dailyReplyDate = this.getTodayJST();
    }
  }

  /** 日次返信カウンタをファイルに保存する */
  private saveDailyReplyCount(): void {
    try {
      const dir = path.dirname(DAILY_REPLY_COUNT_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        DAILY_REPLY_COUNT_FILE,
        JSON.stringify({ date: this.dailyReplyDate, count: this.dailyReplyCount }, null, 2)
      );
    } catch (err) {
      logger.warn(`📋 日次返信カウンタ保存失敗: ${err}`);
    }
  }

  /**
   * 返信上限チェック。上限に達していたら true を返す。
   * 日付が変わっていたら自動リセット。
   */
  public isReplyLimitReached(): boolean {
    const todayJST = this.getTodayJST();
    if (this.dailyReplyDate !== todayJST) {
      this.dailyReplyCount = 0;
      this.dailyReplyDate = todayJST;
      this.saveDailyReplyCount();
    }
    return this.dailyReplyCount >= this.maxRepliesPerDay;
  }

  /**
   * 返信カウンタをインクリメントして保存する。
   */
  public incrementReplyCount(): void {
    const todayJST = this.getTodayJST();
    if (this.dailyReplyDate !== todayJST) {
      this.dailyReplyCount = 0;
      this.dailyReplyDate = todayJST;
    }
    this.dailyReplyCount++;
    this.saveDailyReplyCount();
    logger.info(`📋 返信カウンタ: ${this.dailyReplyCount}/${this.maxRepliesPerDay}`, 'cyan');
  }

  // =========================================================================
  // Reply checking (self-tweets)
  // =========================================================================

  public async checkRepliesAndRespond() {
    try {
      const tweets = await this.apiClient.getLatestTweets('I_am_Shannon');
      if (tweets.length === 0) return;

      const replies: { reply: TweetData; myTweet: string }[] = [];
      for (const tweet of tweets) {
        const { reply, myTweet } = await this.apiClient.getReplies(tweet, this.myUserId);
        if (reply && myTweet) {
          replies.push({ reply, myTweet });
        }
      }
      if (replies.length === 0) return;

      if (this.isReplyLimitReached()) {
        logger.info(`📋 [Polling] 日次返信上限に到達。スキップ`, 'yellow');
        return;
      }

      this.incrementReplyCount();
      this.eventBus.publish({
        type: 'llm:post_twitter_reply',
        memoryZone: 'twitter:post',
        data: {
          replyId: replies[0].reply.id,
          text: replies[0].reply.text,
          authorName: replies[0].reply.author.name,
          repliedTweet: replies[0].myTweet,
          repliedTweetAuthorName: replies[0].reply.author.name,
        } as TwitterReplyOutput,
      });
    } catch (err: unknown) {
      const errMsg = isAxiosError(err)
        ? (err.response?.data ?? err.message)
        : err instanceof Error ? err.message : String(err);
      logger.error(`リプライ検知エラー: ${JSON.stringify(errMsg)}`);
    }
  }

  // =========================================================================
  // Unified monitoring (advanced_search)
  // =========================================================================

  /**
   * UTC形式の時刻文字列を返す (advanced_search の since/until 用)
   */
  private formatTimeForSearch(date: Date): string {
    const y = date.getUTCFullYear();
    const mo = String(date.getUTCMonth() + 1).padStart(2, '0');
    const d = String(date.getUTCDate()).padStart(2, '0');
    const h = String(date.getUTCHours()).padStart(2, '0');
    const mi = String(date.getUTCMinutes()).padStart(2, '0');
    const s = String(date.getUTCSeconds()).padStart(2, '0');
    return `${y}-${mo}-${d}_${h}:${mi}:${s}_UTC`;
  }

  /**
   * 全監視対象アカウントの新着ツイートを advanced_search で一括取得し、
   * アカウントごとのルールに従ってアクションを実行する。
   */
  public async autoMonitorAccounts() {
    if (this.monitoredAccounts.length === 0) return;

    try {
      const now = new Date();
      const sinceStr = this.formatTimeForSearch(this.lastCheckedTime);
      const untilStr = this.formatTimeForSearch(now);

      const fromClauses = this.monitoredAccounts
        .map((a) => `from:${a.userName}`)
        .join(' OR ');
      const query = `(${fromClauses}) since:${sinceStr} until:${untilStr}`;

      logger.info(`🔍 Twitter監視: ${query}`, 'cyan');

      const allTweets = await this.apiClient.advancedSearch(query);

      // 最終チェック時刻を更新
      this.lastCheckedTime = now;

      if (allTweets.length === 0) {
        logger.debug('📭 新着ツイートなし');
        return;
      }

      logger.info(`📬 ${allTweets.length}件の新着ツイートを検出`, 'green');

      // 各メンバーにつき最新1件のみ処理するため、著者ごとにグループ化
      const latestByAuthor = new Map<string, TweetData>();
      let skippedDuplicate = 0;
      let skippedNoAuthor = 0;
      let skippedNoConfig = 0;

      for (const tweet of allTweets) {
        if (this.processedTweetIds.has(tweet.id)) {
          skippedDuplicate++;
          continue;
        }

        const authorUserName = tweet.author?.userName;
        if (!authorUserName) {
          skippedNoAuthor++;
          continue;
        }

        const authorKey = authorUserName.toLowerCase();
        const accountConfig = this.monitoredAccounts.find(
          (a) => a.userName.toLowerCase() === authorKey
        );
        if (!accountConfig) {
          skippedNoConfig++;
          continue;
        }

        const existing = latestByAuthor.get(authorKey);
        if (!existing || new Date(tweet.createdAt ?? 0) > new Date(existing.createdAt ?? 0)) {
          latestByAuthor.set(authorKey, tweet);
        }
      }

      // 全ツイートを処理済みとしてマーク
      for (const tweet of allTweets) {
        this.processedTweetIds.add(tweet.id);
      }
      this.saveProcessedIds();

      let processed = 0;
      for (const [, tweet] of latestByAuthor) {
        const authorUserName = tweet.author!.userName;
        const accountConfig = this.monitoredAccounts.find(
          (a) => a.userName.toLowerCase() === authorUserName.toLowerCase()
        )!;
        processed++;

        logger.info(
          `📝 @${authorUserName}: "${tweet.text.slice(0, 50)}..."`,
          'cyan'
        );

        // 1) 必ずいいね
        if (accountConfig.alwaysLike) {
          await this.apiClient.likeTweet(tweet.id);
        }

        // 2) 必ず引用RT (ai_mine_lab のみ)
        if (accountConfig.alwaysQuoteRT) {
          const tweetUrl = tweet.url || `https://x.com/${authorUserName}/status/${tweet.id}`;
          this.eventBus.publish({
            type: 'llm:post_twitter_quote_rt',
            memoryZone: 'twitter:post',
            data: {
              tweetId: tweet.id,
              tweetUrl,
              text: tweet.text,
              authorName: tweet.author.name,
              authorUserName,
            } as TwitterQuoteRTOutput,
          });
        }

        // 3) 確率で返信 (ai_mine_lab 用)
        if (accountConfig.reply && Math.random() < this.replyProbability) {
          let repliedTweetText = '';
          let repliedTweetAuthorName = '';

          if (tweet.inReplyToId || tweet.in_reply_to_status_id || tweet.in_reply_to_tweet_id) {
            const originalTweetId =
              tweet.inReplyToId ||
              tweet.in_reply_to_status_id ||
              tweet.in_reply_to_tweet_id;
            if (originalTweetId) {
              try {
                const original = await this.apiClient.fetchTweetContent(originalTweetId);
                repliedTweetText = original.text ?? '';
                repliedTweetAuthorName = original.authorName ?? '';
              } catch {
                // 元ツイート取得失敗は無視
              }
            }
          }

          this.eventBus.publish({
            type: 'llm:post_twitter_reply',
            memoryZone: 'twitter:post',
            data: {
              replyId: tweet.id,
              text: tweet.text,
              authorName: tweet.author.name,
              repliedTweet: repliedTweetText,
              repliedTweetAuthorName,
            } as TwitterReplyOutput,
          });
        }

        // 4) メンバーFCA: LLMが返信/引用RTを自動判断
        if (accountConfig.memberFCA) {
          const tweetUrl = tweet.url || `https://x.com/${authorUserName}/status/${tweet.id}`;
          let repliedTweetText = '';
          let repliedTweetAuthorName = '';

          if (tweet.inReplyToId || tweet.in_reply_to_status_id || tweet.in_reply_to_tweet_id) {
            const originalTweetId =
              tweet.inReplyToId ||
              tweet.in_reply_to_status_id ||
              tweet.in_reply_to_tweet_id;
            if (originalTweetId) {
              try {
                const original = await this.apiClient.fetchTweetContent(originalTweetId);
                repliedTweetText = original.text ?? '';
                repliedTweetAuthorName = original.authorName ?? '';
              } catch {
                // 元ツイート取得失敗は無視
              }
            }
          }

          this.eventBus.publish({
            type: 'llm:respond_member_tweet',
            memoryZone: 'twitter:post',
            data: {
              tweetId: tweet.id,
              tweetUrl,
              text: tweet.text,
              authorName: tweet.author.name,
              authorUserName,
              repliedTweet: repliedTweetText,
              repliedTweetAuthorName,
            } as MemberTweetInput,
          });
        }
      }

      logger.info(
        `📊 Twitter監視結果: 検出=${allTweets.length}, 著者数=${latestByAuthor.size}, 処理=${processed}, 重複スキップ=${skippedDuplicate}, 著者不明=${skippedNoAuthor}, 設定なし=${skippedNoConfig}`,
        'cyan',
      );
    } catch (e) {
      logger.error('Twitter監視エラー:', e);
    }
  }

  // =========================================================================
  // Utility
  // =========================================================================

  /** JST の今日の日付文字列を返す (YYYY-MM-DD) */
  private getTodayJST(): string {
    const now = new Date();
    const jst = toZonedTime(now, 'Asia/Tokyo');
    return format(jst, 'yyyy-MM-dd');
  }
}
