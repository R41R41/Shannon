import {
  TwitterActionResult,
  TwitterClientInput,
  TwitterClientOutput,
} from '@shannon/common';
import { config } from '../../config/env.js';
import { classifyError, formatErrorForLog } from '../../errors/index.js';
import { createLogger } from '../../utils/logger.js';
const logger = createLogger('Twitter:Client');
import { BaseClient } from '../common/BaseClient.js';
import { emitWebServiceStatus } from '../web/webNotificationHub.js';
import {
  registerTwitterToolPort,
  type PostTweetResult,
} from '../runtime/platformToolGateway.js';
import { registerServiceCommandHandler } from '../runtime/serviceCommandRegistry.js';
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

  private runtimeRegistered = false;

  public static getInstance(isTest: boolean = false) {
    if (!TwitterClient.instance) {
      TwitterClient.instance = new TwitterClient(isTest);
    }
    TwitterClient.instance.isTest = isTest;
    return TwitterClient.instance;
  }

  private constructor(isTest: boolean) {
    super('twitter');

    this.isTest = isTest;
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
    this.monitor = new TweetMonitor(this.apiClient, {
      myUserId: config.twitter.userId || null,
      maxRepliesPerDay: config.twitter.maxRepliesPerDay,
      replyProbability: config.twitter.replyProbability,
      monitoredAccounts,
    });

    // --- Auto Post Manager ---
    this.autoPostManager = new AutoPostManager(
      this.apiClient,
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
  // TwitterToolPort
  // =========================================================================

  public async postMessage(
    input: Pick<TwitterClientInput, 'text' | 'replyId' | 'quoteTweetUrl' | 'imageUrl'>,
  ): Promise<PostTweetResult> {
    if (this.status !== 'running') {
      logger.warn(`[postMessage] status="${this.status}" のためスキップ`);
      return { isSuccess: false, errorMessage: 'Twitter service is not running' };
    }
    const { replyId, text, imageUrl, quoteTweetUrl } = input;
    logger.info(`[postMessage] 受信: text="${text?.slice(0, 50)}" replyId=${replyId}`, 'cyan');
    try {
      if (quoteTweetUrl) {
        await this.apiClient.postQuoteTweet(text, quoteTweetUrl);
      } else {
        await this.apiClient.postTweet(text, imageUrl ?? null, replyId ?? null, this.isTest);
      }
      return { isSuccess: true, errorMessage: '' };
    } catch (error) {
      const sErr = classifyError(error, 'twitter');
      logger.debug(`Twitter post error (tool): ${formatErrorForLog(sErr)}`);
      return { isSuccess: false, errorMessage: sErr.message };
    }
  }

  public async likeTweet(tweetId: string): Promise<TwitterActionResult> {
    if (this.status !== 'running') {
      return { success: false, message: 'Twitter service is not running' };
    }
    try {
      await this.apiClient.likeTweet(tweetId);
      return { success: true, message: `ツイート ${tweetId} にいいねしました` };
    } catch (error) {
      return {
        success: false,
        message: `いいね失敗: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  public async retweetTweet(tweetId: string): Promise<TwitterActionResult> {
    if (this.status !== 'running') {
      return { success: false, message: 'Twitter service is not running' };
    }
    try {
      await this.apiClient.retweetTweet(tweetId);
      return { success: true, message: `ツイート ${tweetId} をリツイートしました` };
    } catch (error) {
      return {
        success: false,
        message: `リツイート失敗: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  public async quoteRetweet(text: string, quoteTweetUrl: string): Promise<TwitterActionResult> {
    if (this.status !== 'running') {
      return { success: false, message: 'Twitter service is not running' };
    }
    try {
      await this.apiClient.postQuoteTweet(text, quoteTweetUrl);
      return { success: true, message: '引用リツイートしました' };
    } catch (error) {
      return {
        success: false,
        message: `引用リツイート失敗: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  public async getTweetContent(tweetId: string): Promise<TwitterClientOutput | null> {
    if (this.status !== 'running') return null;
    try {
      return await this.apiClient.fetchTweetContent(tweetId);
    } catch (error) {
      logger.error('Twitter get tweet content error:', error);
      return null;
    }
  }

  public async postScheduledMessage(
    input: Pick<TwitterClientInput, 'text' | 'quoteTweetUrl' | 'imageUrl' | 'topic'>,
  ): Promise<void> {
    if (this.status !== 'running') return;
    const { text, quoteTweetUrl, imageUrl, topic } = input;
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
  }

  public async checkReplies(): Promise<void> {
    await this.monitor.checkRepliesAndRespond();
  }

  private registerRuntime(): void {
    if (this.runtimeRegistered) return;
    registerTwitterToolPort(this);
    registerServiceCommandHandler('twitter', async (command) => {
      if (command === 'start') {
        await this.start();
      } else if (command === 'stop') {
        await this.stop();
      } else if (command === 'status') {
        emitWebServiceStatus({
          service: 'twitter',
          status: this.status,
        });
      }
    });
    this.runtimeRegistered = true;
  }

  // =========================================================================
  // Initialization
  // =========================================================================

  public async initialize() {
    try {
      this.registerRuntime();

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
    } catch (error) {
      const sErr = classifyError(error, 'twitter');
      logger.error(`Twitter initialization error: ${formatErrorForLog(sErr)}`);
      throw sErr;
    }
  }
}
