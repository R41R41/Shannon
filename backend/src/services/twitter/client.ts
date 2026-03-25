import {
  TwitterActionResult,
  TwitterClientInput,
  TwitterClientOutput,
  TwitterReplyOutput,
} from '@shannon/common';
import { config } from '../../config/env.js';
import { classifyError, formatErrorForLog } from '../../errors/index.js';
import { createLogger } from '../../utils/logger.js';
const logger = createLogger('Twitter:Client');
import { BaseClient } from '../common/BaseClient.js';
import { getEventBus } from '../eventBus/index.js';
import { TwitterAuthManager } from './api/TwitterAuthManager.js';
import { TwitterApiClient } from './api/TwitterApiClient.js';
import { AutoPostManager } from './scheduling/AutoPostManager.js';
import { TweetMonitor, MonitoredAccountConfig } from './monitoring/TweetMonitor.js';

// Re-export for external consumers
export type { TweetData } from './api/TwitterApiClient.js';

// ---------------------------------------------------------------------------
// TwitterClient (Orchestrator)
// ---------------------------------------------------------------------------

export class TwitterClient extends BaseClient {
  public isTest: boolean = false;
  private static instance: TwitterClient;

  // Sub-modules
  private authManager: TwitterAuthManager;
  private apiClient: TwitterApiClient;
  private autoPostManager: AutoPostManager;
  private monitor: TweetMonitor;

  /** ポーリング間隔 (ミリ秒) */
  private monitorIntervalMs: number;

  public static getInstance(isTest: boolean = false) {
    const eventBus = getEventBus();
    if (!TwitterClient.instance) {
      TwitterClient.instance = new TwitterClient('twitter', isTest);
    }
    TwitterClient.instance.isTest = isTest;
    return TwitterClient.instance;
  }

  private constructor(serviceName: 'twitter', isTest: boolean) {
    const eventBus = getEventBus();
    super(serviceName, eventBus);

    this.monitorIntervalMs = config.twitter.monitorIntervalMs;

    // --- Auth ---
    this.authManager = new TwitterAuthManager();

    // --- API Client ---
    this.apiClient = new TwitterApiClient(this.authManager);

    // --- Monitored accounts ---
    const officialAccountUserName = config.twitter.usernames.aiminelab;
    const allUserNames = [
      config.twitter.usernames.rai,
      config.twitter.usernames.yummy,
      config.twitter.usernames.guriko,
      config.twitter.usernames.aiminelab,
    ].filter(Boolean) as string[];

    const monitoredAccounts: MonitoredAccountConfig[] = allUserNames.map((userName) => {
      const isOfficial = userName === officialAccountUserName;
      return {
        userName,
        alwaysLike: true,
        reply: isOfficial,
        alwaysQuoteRT: isOfficial,
        memberFCA: !isOfficial,
      };
    });

    // --- Tweet Monitor ---
    this.monitor = new TweetMonitor(this.apiClient, this.eventBus, {
      myUserId: config.twitter.userId || null,
      maxRepliesPerDay: config.twitter.maxRepliesPerDay,
      replyProbability: config.twitter.replyProbability,
      monitoredAccounts,
    });

    // --- Auto Post Manager ---
    this.autoPostManager = new AutoPostManager(
      this.apiClient,
      this.eventBus,
      () => this.status,
      {
        minAutoPostsPerDay: config.twitter.minAutoPostsPerDay,
        maxAutoPostsPerDay: config.twitter.maxAutoPostsPerDay,
        autoPostStartHour: config.twitter.autoPostStartHour,
        autoPostEndHour: config.twitter.autoPostEndHour,
      },
    );

    // Restore persistent state in constructor (webhook may arrive before initialize())
    this.monitor.loadProcessedIds();
    this.monitor.loadDailyReplyCount();
    this.autoPostManager.loadRecentPosts();
  }

  // =========================================================================
  // Public API — delegated to sub-modules
  // =========================================================================

  /** 処理済みツイートID (重複アクション防止) */
  public get processedTweetIds() {
    return this.monitor.processedTweetIds;
  }
  public set processedTweetIds(val) {
    this.monitor.processedTweetIds = val;
  }

  public saveProcessedIds(): void {
    this.monitor.saveProcessedIds();
  }

  public isReplyLimitReached(): boolean {
    return this.monitor.isReplyLimitReached();
  }

  public incrementReplyCount(): void {
    this.monitor.incrementReplyCount();
  }

  public hasRecentlyQuoted(url: string): boolean {
    return this.autoPostManager.hasRecentlyQuoted(url);
  }

  public async uploadMedia(imageBuffer: Buffer, filename?: string, isRetry?: boolean): Promise<string | null> {
    return this.apiClient.uploadMedia(imageBuffer, filename, isRetry);
  }

  public async callWithRetry<T>(fn: () => Promise<T>, label?: string): Promise<T> {
    return this.apiClient.callWithRetry(fn, label);
  }

  public async setupWebhookRule(): Promise<void> {
    return this.apiClient.setupWebhookRule(this.isTest);
  }

  public async setupQuoteRTWebhookRule(): Promise<void> {
    return this.apiClient.setupQuoteRTWebhookRule(this.isTest);
  }

  public async deactivateWebhookRule(): Promise<void> {
    return this.apiClient.deactivateWebhookRule(this.isTest);
  }

  // =========================================================================
  // Event Handlers
  // =========================================================================

  private setupEventHandlers() {
    this.eventBus.subscribe('twitter:status', async (event) => {
      const { serviceCommand } = event.data as TwitterClientInput;
      if (serviceCommand === 'start') {
        await this.start();
      } else if (serviceCommand === 'stop') {
        await this.stop();
      } else if (serviceCommand === 'status') {
        this.eventBus.publish({
          type: 'web:status',
          memoryZone: 'web',
          data: {
            service: 'twitter',
            status: this.status,
          },
        });
      }
    });

    this.eventBus.subscribe('twitter:post_scheduled_message', async (event) => {
      if (this.status !== 'running') return;
      const { text, quoteTweetUrl, imageUrl, topic } = event.data as TwitterClientInput;
      try {
        if (text && quoteTweetUrl) {
          if (this.hasRecentlyQuoted(quoteTweetUrl)) {
            logger.warn(`🐦 引用RT重複ブロック: ${quoteTweetUrl} は既に引用済み`);
            return;
          }
          await this.apiClient.postQuoteTweet(text, quoteTweetUrl);
          this.autoPostManager.saveRecentPost(text, quoteTweetUrl, topic ?? undefined);
        } else if (text) {
          await this.apiClient.postTweet(text, imageUrl ?? null, null, this.isTest);
          this.autoPostManager.saveRecentPost(text, undefined, topic ?? undefined);
        }
      } catch (error) {
        const sErr = classifyError(error, 'twitter');
        logger.debug(`Twitter post error (auto): ${formatErrorForLog(sErr)}`);
      }
    });

    this.eventBus.subscribe('twitter:post_message', async (event) => {
      if (this.status !== 'running') {
        logger.warn(`[twitter:post_message] status="${this.status}" のためスキップ`);
        this.eventBus.publish({
          type: 'tool:post_tweet_result',
          memoryZone: 'twitter:post',
          data: { isSuccess: false, errorMessage: 'Twitter service is not running' },
        });
        return;
      }
      const { replyId, text, imageUrl, quoteTweetUrl } = event.data as TwitterClientInput;
      logger.info(`[twitter:post_message] 受信: text="${text?.slice(0, 50)}" replyId=${replyId}`, 'cyan');
      try {
        if (quoteTweetUrl) {
          await this.apiClient.postQuoteTweet(text, quoteTweetUrl);
        } else {
          await this.apiClient.postTweet(text, null, replyId ?? null, this.isTest);
        }
        this.eventBus.publish({
          type: 'tool:post_tweet_result',
          memoryZone: 'twitter:post',
          data: { isSuccess: true, errorMessage: '' },
        });
      } catch (error) {
        const sErr = classifyError(error, 'twitter');
        logger.debug(`Twitter post error (tool): ${formatErrorForLog(sErr)}`);
        this.eventBus.publish({
          type: 'tool:post_tweet_result',
          memoryZone: 'twitter:post',
          data: { isSuccess: false, errorMessage: sErr.message },
        });
      }
    });

    this.eventBus.subscribe('twitter:get_tweet_content', async (event) => {
      if (this.status !== 'running') return;
      const { tweetId } = event.data as TwitterClientInput;
      try {
        if (tweetId) {
          const tweetContent = await this.apiClient.fetchTweetContent(tweetId);
          this.eventBus.publish({
            type: 'tool:get_tweet_content',
            memoryZone: 'twitter:get',
            data: tweetContent as TwitterClientOutput,
          });
        }
      } catch (error) {
        logger.error('Twitter get tweet content error:', error);
      }
    });

    // --- LLM ツール用エンドポイント ---

    this.eventBus.subscribe('twitter:like_tweet', async (event) => {
      if (this.status !== 'running') return;
      const { tweetId } = event.data as TwitterClientInput;
      try {
        if (tweetId) {
          await this.apiClient.likeTweet(tweetId);
          this.eventBus.publish({
            type: 'tool:like_tweet',
            memoryZone: 'twitter:post',
            data: { success: true, message: `ツイート ${tweetId} にいいねしました` } as TwitterActionResult,
          });
        }
      } catch (error) {
        this.eventBus.publish({
          type: 'tool:like_tweet',
          memoryZone: 'twitter:post',
          data: { success: false, message: `いいね失敗: ${error instanceof Error ? error.message : String(error)}` } as TwitterActionResult,
        });
      }
    });

    this.eventBus.subscribe('twitter:retweet_tweet', async (event) => {
      if (this.status !== 'running') return;
      const { tweetId } = event.data as TwitterClientInput;
      try {
        if (tweetId) {
          await this.apiClient.retweetTweet(tweetId);
          this.eventBus.publish({
            type: 'tool:retweet_tweet',
            memoryZone: 'twitter:post',
            data: { success: true, message: `ツイート ${tweetId} をリツイートしました` } as TwitterActionResult,
          });
        }
      } catch (error) {
        this.eventBus.publish({
          type: 'tool:retweet_tweet',
          memoryZone: 'twitter:post',
          data: { success: false, message: `リツイート失敗: ${error instanceof Error ? error.message : String(error)}` } as TwitterActionResult,
        });
      }
    });

    this.eventBus.subscribe('twitter:quote_retweet', async (event) => {
      if (this.status !== 'running') return;
      const { text, quoteTweetUrl } = event.data as TwitterClientInput;
      try {
        if (text && quoteTweetUrl) {
          await this.apiClient.postQuoteTweet(text, quoteTweetUrl);
          this.eventBus.publish({
            type: 'tool:quote_retweet',
            memoryZone: 'twitter:post',
            data: { success: true, message: `引用リツイートしました` } as TwitterActionResult,
          });
        }
      } catch (error) {
        this.eventBus.publish({
          type: 'tool:quote_retweet',
          memoryZone: 'twitter:post',
          data: { success: false, message: `引用リツイート失敗: ${error instanceof Error ? error.message : String(error)}` } as TwitterActionResult,
        });
      }
    });
  }

  // =========================================================================
  // Initialization
  // =========================================================================

  public async initialize() {
    try {
      // V2 ログイン: まずファイルから login_cookies を復元、なければ新規ログイン
      const cookiesRestored = this.authManager.restoreCookiesFromFile();
      if (!cookiesRestored) {
        try {
          await this.authManager.loginV2();
        } catch (loginError) {
          logger.warn(`[initialize] V2ログイン失敗（投稿時に再試行します）: ${loginError instanceof Error ? loginError.message : String(loginError)}`);
        }
      }

      // Webhook ルールをセットアップ
      await this.setupWebhookRule();
      await this.setupQuoteRTWebhookRule();

      if (!this.isTest) {
        // リプライ検知: Webhook がメイン。ポーリングはフォールバック (2時間間隔)
        setInterval(() => this.monitor.checkRepliesAndRespond(), 2 * 60 * 60 * 1000);

        // 統合監視: 全アカウントの新着ツイートを一括チェック
        setInterval(
          () => this.monitor.autoMonitorAccounts(),
          this.monitorIntervalMs
        );

        // 初回実行
        this.monitor.autoMonitorAccounts();
      }

      // 自動投稿カウンタをファイルから復元
      this.autoPostManager.loadAutoPostCount();

      // 当日の投稿スケジュールをファイルから復元（なければ新規生成）
      this.autoPostManager.loadDailySchedule();

      // 自動投稿スケジューラ起動
      this.autoPostManager.scheduleDailyReset();
      this.autoPostManager.logInitialization();

      // スケジュール済み時刻から次回タイマーをセット
      this.autoPostManager.scheduleFromDailyPlan();
      this.setupEventHandlers();
    } catch (error) {
      const sErr = classifyError(error, 'twitter');
      logger.error(`Twitter initialization error: ${formatErrorForLog(sErr)}`);
      throw sErr;
    }
  }
}
