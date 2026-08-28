import express from 'express';
import { protectHttpSurface } from './routes/httpSurface.js';
import { createWebAccess } from './bootstrap/webAccess.js';
import http from 'http';
import mongoose from 'mongoose';
import { config } from './config/env.js';
import { DiscordBot } from './services/discord/client.js';
import { LLMService } from './services/llm/client.js';
import { MinebotClient } from './services/minebot/client.js';
import { MinecraftClient } from './services/minecraft/client.js';
import { NotionClient } from './services/notion/client.js';
import { Scheduler } from './services/scheduler/client.js';
import { TwitterClient } from './services/twitter/client.js';
import { WebClient } from './services/web/client.js';
import { YoutubeClient } from './services/youtube/client.js';
import { logger, initFileLogging } from './utils/logger.js';
import { getBackendRoot } from './utils/backendRoot.js';
import { join } from 'path';
import { shutdownLangfuse } from './services/llm/utils/langfuse.js';
import { registerHealthRoutes } from './routes/healthRoutes.js';
import { registerModelRoutes } from './routes/modelRoutes.js';
import { registerTokenRoutes } from './routes/tokenRoutes.js';
import { registerTestRoutes } from './routes/testRoutes.js';
import { registerWebhookRoutes } from './routes/webhookRoutes.js';
import { registerPublicRoutes } from './routes/publicRoutes.js';
import { startNightlySelfImproveScheduler } from './services/llm/graph/cognitive/selfImprove/NightlySelfImproveScheduler.js';

class Server {
  private readonly webAccess = createWebAccess(config.webAuth.firebaseProjectId);
  private llmService: LLMService;
  private discordBot: DiscordBot | null = null;
  private webClient: WebClient;
  private twitterClient: TwitterClient | null = null;
  private scheduler: Scheduler;
  private youtubeClient: YoutubeClient;
  private minecraftClient: MinecraftClient;
  private minebotClient: MinebotClient;
  private notionClient: NotionClient | null = null;
  private httpServer: http.Server | null = null;
  private coreReady = false;

  /**
   * サービスを安全に初期化するヘルパー。
   * 認証情報の不足などでコンストラクタが例外を投げた場合は
   * 警告ログを出して null を返す（サーバー起動を妨げない）。
   */
  private static tryCreate<T>(
    name: string,
    factory: () => T,
  ): T | null {
    try {
      return factory();
    } catch (error) {
      logger.warn(`[Server] ${name} の初期化をスキップ: ${error instanceof Error ? error.message : error}`);
      return null;
    }
  }

  constructor() {
    const isDevMode = process.argv.includes('--dev');

    // --- 必須サービス (失敗時はサーバー起動を中断) ---
    this.llmService = LLMService.getInstance(isDevMode);
    this.webClient = WebClient.getInstance(false, this.webAccess.access);
    this.scheduler = Scheduler.getInstance(isDevMode);
    this.youtubeClient = YoutubeClient.getInstance(isDevMode);
    this.minecraftClient = MinecraftClient.getInstance(isDevMode);
    this.minebotClient = MinebotClient.getInstance(isDevMode);

    // --- オプショナルサービス (認証情報不足時はスキップ) ---
    this.discordBot = Server.tryCreate('Discord', () => DiscordBot.getInstance(isDevMode));
    if (config.twitter.disabled) {
      logger.warn('[Server] Twitter は TWITTER_DISABLED=true のため起動しません');
      this.twitterClient = null;
    } else {
      this.twitterClient = Server.tryCreate('Twitter', () => TwitterClient.getInstance(isDevMode));
    }
    this.notionClient = Server.tryCreate('Notion', () => NotionClient.getInstance(isDevMode));
  }

  private startHTTPServer() {
    const app = express();
    app.use(protectHttpSurface(this.webAccess.access));
    app.use(express.json({ limit: '128kb' }));

    // Register route modules
    registerHealthRoutes(app, () => this.coreReady && mongoose.connection.readyState === 1 &&
      !!config.webAuth.firebaseProjectId && config.webAuth.allowedOrigins.length > 0);
    registerModelRoutes(app, this.webAccess.access, this.webAccess.modelSettings);
    registerTokenRoutes(app);
    registerTestRoutes(app);
    registerWebhookRoutes(app, this.twitterClient);
    registerPublicRoutes(app, this.llmService);

    const port = config.port;
    this.httpServer = app.listen(port, () => {
      logger.info(`HTTP Server listening on port ${port}`, 'blue');
    });
  }

  private async connectDatabase() {
    try {
      const uri = config.mongodbUri;
      logger.info('Connecting to configured MongoDB');
      await mongoose.connect(uri, { autoIndex: false, serverSelectionTimeoutMS: 5000 });
      logger.info(`MongoDB connected to: ${mongoose.connection.db.databaseName}`, 'blue');
    } catch (error) {
      logger.error('MongoDB connection failed');
      throw new Error('DATABASE_UNAVAILABLE');
    }
  }

  /**
   * オプショナルなサービスを安全に起動するヘルパー。
   * サービスが null（初期化スキップ済み）の場合はスキップし、
   * 起動中の例外はログに記録して続行する。
   */
  private async startOptionalService(
    name: string,
    service: { start(): Promise<void> } | null,
  ): Promise<void> {
    if (!service) {
      logger.info(`[Server] ${name}: 初期化されていないためスキップ`, 'cyan');
      return;
    }
    try {
      await service.start();
      logger.info(`${name} started`, 'blue');
    } catch (error) {
      logger.warn(`[Server] ${name} の起動に失敗しました（続行します）: ${error instanceof Error ? error.message : error}`);
    }
  }

  public async start() {
    // ファイルログを有効化（ANSI除去済みのプレーンテキストで保存）
    const logsDir = join(getBackendRoot(), 'logs');
    initFileLogging(logsDir);

    // HTTPサーバーを最初に起動
    this.startHTTPServer();

    // データベース接続
    await this.connectDatabase();

    // --- 必須サービスの起動 ---
    // LLM と Web は失敗時にサーバーを停止する
    try {
      await this.llmService.initialize();
      this.coreReady = true;
      logger.info('LLM Service started', 'blue');
    } catch (error) {
      logger.error(`LLM Service の起動に失敗: ${error}`);
      logger.warn('LLM 機能なしで続行します');
    }

    await this.webClient.start();
    logger.info('Web Client started', 'blue');

    // --- オプショナルサービスの並列起動 ---
    // 個別の失敗がサーバー全体を停止させない
    await Promise.allSettled([
      this.startOptionalService('Discord', this.discordBot),
      this.startOptionalService('Twitter', this.twitterClient),
      this.startOptionalService('Scheduler', this.scheduler),
      this.startOptionalService('Youtube', this.youtubeClient),
      this.startOptionalService('Minecraft', this.minecraftClient),
      this.startOptionalService('Minebot', this.minebotClient),
      this.startOptionalService('Notion', this.notionClient),
    ]);

    logger.success('[Server] 全サービスの起動処理が完了しました');

    startNightlySelfImproveScheduler();
  }

  public async shutdown() {
    this.coreReady = false;
    logger.warn('[Shutdown] グレースフルシャットダウン開始...');

    // 注意: Webhook ルールはシャットダウン時に無効化しない。
    // deactivate → reactivate するとカーソル (last_tweet_id) がリセットされ、
    // 古いツイートが再配信されて無駄な課金が発生するため。
    // ルールは常時有効のままにしておく。

    // 各サービスのクリーンアップ処理
    await this.webClient.stop();
    await shutdownLangfuse();
    await mongoose.disconnect();
    logger.error('MongoDB disconnected');
    process.exit(process.exitCode ?? 0);
  }
}

// サーバーのインスタンス化と起動
const server = new Server();
void server.start().catch(() => { logger.error('Server startup failed'); process.exitCode = 1; void server.shutdown(); });

// グレースフルシャットダウンの処理
process.on('SIGTERM', () => server.shutdown());
process.on('SIGINT', () => server.shutdown());
