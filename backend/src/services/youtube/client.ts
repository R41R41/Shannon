import {
  YoutubeCommentOutput,
  YoutubeSubscriberUpdateOutput,
} from '@shannon/common';
import { OAuth2Client } from 'google-auth-library';
import { google, youtube_v3 } from 'googleapis';
import { BaseClient } from '../common/BaseClient.js';
import { config } from '../../config/env.js';
import { getDiscordOutboundPort } from '../runtime/discordOutboundGateway.js';
import { deliverYoutubeReplyToLlm } from '../runtime/llmInboundDispatch.js';
import { registerYoutubeToolPort } from '../runtime/platformToolGateway.js';
import { registerServiceCommandHandler } from '../runtime/serviceCommandRegistry.js';
import { emitWebServiceStatus } from '../web/webNotificationHub.js';
import { logger } from '../../utils/logger.js';
import { HeadStreamClient } from './ear/headStreamClient.js';
import { oauthTokenProvider } from './ear/oauthTokenProvider.js';
import { StreamEar, type EarStatus } from './ear/streamEar.js';
import { YoutubeLiveApi } from './ear/youtubeLiveApi.js';

export class YoutubeClient extends BaseClient {
  private static instance: YoutubeClient;
  private client: youtube_v3.Youtube | null = null;
  private oauth2Client: OAuth2Client | null = null;
  private channelId: string | null = null;
  public isTest: boolean = false;
  private authCode: string | null = null;
  private refreshToken: string | null = null;
  private lastSubscriberCount: number = 0;
  /** The ear of the AI VTuber: reads the live chat for the head while a stream is started (ear/streamEar.ts). */
  private ear: StreamEar | null = null;
  private gatewaysRegistered = false;

  private constructor(serviceName: 'youtube', isTest: boolean) {
    super(serviceName);
    this.client = null;
    this.oauth2Client = null;
    this.channelId = config.youtube.channelId || null;
    this.authCode = config.youtube.authCode || null;
    this.lastSubscriberCount = 0;
  }

  public static getInstance(isTest: boolean = false) {
    if (!YoutubeClient.instance) {
      YoutubeClient.instance = new YoutubeClient('youtube', isTest);
    }
    YoutubeClient.instance.isTest = isTest;
    return YoutubeClient.instance;
  }

  private registerGateways() {
    if (this.gatewaysRegistered) return;
    this.gatewaysRegistered = true;

    registerYoutubeToolPort({
      getVideoInfo: (videoId) => this.getVideoInfo(videoId),
    });

    registerServiceCommandHandler('youtube', async (command) => {
      if (command === 'start') {
        await this.start();
      } else if (command === 'stop') {
        await this.stop();
      } else if (command === 'status') {
        emitWebServiceStatus({
          service: 'youtube',
          status: this.status,
        });
      }
    });

    // The live chat is the ear (ear/streamEar.ts): it runs while the youtube service runs and the head's bridge is set, and does
    // something only while a stream is started. start/stop here switch the ear itself; status reports it.
    registerServiceCommandHandler('youtube:live_chat', async (command) => {
      if (command === 'start') {
        const result = await this.startLiveChat();
        if (!result.success) logger.warn(`YouTube ear: ${result.message}`);
      } else if (command === 'stop') {
        await this.stopLiveChat();
      } else if (command === 'status') {
        this.emitLiveChatStatus();
        logger.info(`YouTube ear: ${JSON.stringify(this.liveChatSnapshot())}`);
      }
    });
  }

  public async checkComments(): Promise<void> {
    if (this.status !== 'running') return;
    try {
      const unrepliedComments = await this.getUnrepliedComments();
      for (const comment of unrepliedComments) {
        deliverYoutubeReplyToLlm(comment as YoutubeCommentOutput);
      }
    } catch (error) {
      logger.error(`Check comments error: ${error}`);
    }
  }

  public async checkSubscribers(): Promise<void> {
    if (this.status !== 'running') return;
    try {
      const subscriberCount = await this.getSubscriberCount();
      if (subscriberCount > this.lastSubscriberCount) {
        this.lastSubscriberCount = subscriberCount;
        await this.announceSubscriberUpdate({ subscriberCount });
      }
    } catch (error) {
      logger.error(`Check subscribers error: ${error}`);
    }
  }

  public async announceSubscriberUpdate(data: YoutubeSubscriberUpdateOutput): Promise<void> {
    try {
      await getDiscordOutboundPort().announceSubscriberUpdate(data);
    } catch {
      // Discord outbound port not registered yet
    }
  }

  private async getAuthUrl() {
    try {
      const oauth2Client = new google.auth.OAuth2(
        config.youtube.clientId,
        config.youtube.clientSecret,
        'http://localhost'
      );
      const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: ['https://www.googleapis.com/auth/youtube.force-ssl'],
      });

      logger.info('以下のURLにアクセスして認証してください:');
      logger.info(authUrl);
    } catch (error) {
      logger.error(`YouTube getClient error: ${error}`);
      throw error;
    }
  }

  private async getRefreshToken() {
    try {
      const oauth2Client = new google.auth.OAuth2(
        config.youtube.clientId,
        config.youtube.clientSecret,
        'http://localhost'
      );

      if (!this.authCode) {
        throw new Error('認証コードが設定されていません');
      }
      logger.debug(`authCode: ${this.authCode ? '***' : '(empty)'}`);

      const { tokens } = await oauth2Client.getToken(this.authCode);
      this.refreshToken = tokens.refresh_token || null;
      logger.debug(`Refresh token obtained: ${tokens.refresh_token ? '***' : '(empty)'}`);
    } catch (error) {
      logger.error(`YouTube getRefreshToken error: ${error}`);
      throw error;
    }
  }

  public async getUnrepliedComments() {
    if (this.status !== 'running' || !this.channelId) return [];

    try {
      if (!this.client) {
        throw new Error('YouTube client is not initialized');
      }
      const videos = await this.client.search.list({
        part: ['id', 'snippet'],
        channelId: this.channelId,
        order: 'date',
        type: ['video'],
        maxResults: 3,
      });
      const unrepliedComments = [];
      for (const video of videos.data.items || []) {
        const videoId = video.id?.videoId;
        const title = video.snippet?.title;
        const description = video.snippet?.description;
        if (!videoId) continue;
        logger.debug(`Checking comments for video: ${videoId} ${title}`);
        const comments = await this.client.commentThreads.list({
          part: ['snippet', 'replies'],
          videoId: videoId,
          maxResults: 100,
        });
        for (const thread of comments.data.items || []) {
          const topComment = thread.snippet?.topLevelComment?.snippet;
          const hasReplies = thread.replies?.comments || [];
          if (
            topComment &&
            topComment.authorChannelId?.value !== this.channelId &&
            !hasReplies.some(
              (reply) =>
                reply.snippet?.authorChannelId?.value === this.channelId
            )
          ) {
            unrepliedComments.push({
              videoId,
              commentId: thread.id,
              text: topComment.textDisplay,
              authorName: topComment.authorDisplayName,
              publishedAt: topComment.publishedAt,
              videoTitle: title,
              videoDescription: description,
            });
          }
        }
      }
      return unrepliedComments;
    } catch (error) {
      logger.error(`YouTube comments fetch error: ${error}`);
      throw error;
    }
  }

  public async getSubscriberCount() {
    if (this.status !== 'running' || !this.channelId) return 0;
    if (!this.client) {
      throw new Error('YouTube client is not initialized');
    }
    try {
      const response = await this.client.channels.list({
        part: ['statistics'],
        id: [this.channelId],
      });
      logger.debug(`subscriberCount: ${response.data.items?.[0]?.statistics?.subscriberCount}`);
      return parseInt(
        response.data.items?.[0]?.statistics?.subscriberCount || '0'
      );
    } catch (error) {
      logger.error(`YouTube subscriber count fetch error: ${error}`);
      throw error;
    }
  }

  public async replyComment(videoId: string, commentId: string, reply: string) {
    if (this.status !== 'running') return;
    if (!this.client) {
      throw new Error('YouTube client is not initialized!');
    }
    try {
      await this.client.comments.insert({
        part: ['snippet'],
        requestBody: {
          snippet: {
            textOriginal: reply,
            parentId: commentId,
            videoId: videoId,
          },
        },
      });
      logger.success(`Replied to comment ${commentId} on video ${videoId}`);
    } catch (error) {
      logger.error(`YouTube reply error: ${error}`);
      throw error;
    }
  }

  public async initialize() {
    try {
      try {
        await this.setUpConnection();
        this.registerGateways();
        await this.startLiveChat();
        this.lastSubscriberCount = await this.getSubscriberCount();
        logger.debug(`lastSubscriberCount: ${this.lastSubscriberCount}`);
      } catch (error) {
        logger.error(`YouTube initialization error: ${error}`);
        logger.warn('YouTube initialization failed, but continuing without YouTube functionality!');
        this.status = 'stopped';
      }
    } catch (error) {
      logger.error(`YouTube initialization outer error: ${error}`);
      logger.warn('YouTube initialization failed, but continuing without YouTube functionality');
      this.status = 'stopped';
    }
  }

  private async setUpConnection() {
    try {
      const clientId = config.youtube.clientId;
      const clientSecret = config.youtube.clientSecret;
      this.refreshToken = config.youtube.refreshToken || null;
      logger.debug(`YouTube OAuth2: clientId=${clientId ? '***' : '(empty)'}, refreshToken=${this.refreshToken ? '***' : '(empty)'}`);

      if (!clientId || !clientSecret || !this.refreshToken) {
        logger.warn('YouTube OAuth2認証情報が設定されていません。YouTube機能は無効化されます。');
        this.status = 'stopped';
        return;
      }

      this.oauth2Client = new google.auth.OAuth2(
        clientId,
        clientSecret,
        'http://localhost'
      );

      this.oauth2Client.setCredentials({
        refresh_token: this.refreshToken,
      });

      this.client = google.youtube({
        version: 'v3',
        auth: this.oauth2Client,
      });
    } catch (error) {
      logger.error(`YouTube setUpConnection error: ${error}`);
      logger.warn('YouTube connection failed, but continuing without YouTube functionality');
      this.status = 'stopped';
    }
  }

  public async getVideoInfo(videoId: string) {
    if (!this.client) {
      throw new Error('YouTube client is not initialized');
    }
    try {
      const response = await this.client.videos.list({
        part: ['snippet', 'statistics'],
        id: [videoId],
      });
      const video = response.data.items?.[0];
      if (!video) {
        throw new Error('動画が見つかりません');
      }
      const title = video.snippet?.title || '';
      const author = video.snippet?.channelTitle || '';
      const thumbnail =
        video.snippet?.thumbnails?.high?.url ||
        video.snippet?.thumbnails?.default?.url ||
        '';
      const description = video.snippet?.description || '';
      const publishedAt = video.snippet?.publishedAt || '';
      const viewCount = Number(video.statistics?.viewCount || 0);
      const likeCount = Number(video.statistics?.likeCount || 0);
      const commentCount = Number(video.statistics?.commentCount || 0);
      logger.info(`videoInfo: ${JSON.stringify({ title, author, thumbnail, description, publishedAt, viewCount, likeCount, commentCount })}`);

      return {
        title,
        author,
        thumbnail,
        description,
        publishedAt,
        viewCount,
        likeCount,
        commentCount,
      };
    } catch (error) {
      logger.error(`YouTube getVideoInfo error: ${error}`);
      throw error;
    }
  }

  public async stop() {
    await this.stopLiveChat();
    await super.stop();
  }

  /** Starts the ear. It needs the OAuth connection and the head's bridge (SHANNON_CORE_PLATFORM_URL and _TOKEN). */
  public async startLiveChat(): Promise<{ success: boolean; message: string }> {
    if (this.ear) return { success: true, message: 'the ear is already running' };
    if (!this.client || !this.oauth2Client) return { success: false, message: 'YouTube client is not initialized' };
    const bridge = config.shannonCoreBridge;
    if (!bridge.url || !bridge.token) {
      return { success: false, message: 'SHANNON_CORE_PLATFORM_URL and SHANNON_CORE_PLATFORM_TOKEN are not set; there is no head to listen for' };
    }
    try {
      const ear = new StreamEar({
        head: new HeadStreamClient({ url: bridge.url, token: bridge.token, timeoutMs: Math.max(5_000, bridge.timeoutMs) }),
        youtube: new YoutubeLiveApi({ getAccessToken: oauthTokenProvider(this.oauth2Client) }),
        liveUrl: config.youtube.liveUrl,
        channelId: this.channelId ?? undefined,
      });
      ear.start();
      this.ear = ear;
      this.emitLiveChatStatus();
      logger.info('YouTube ear started (it works only while the head has a stream started)');
      return { success: true, message: 'the ear started' };
    } catch (error) {
      logger.error('YouTube ear could not start', error);
      return { success: false, message: 'the ear could not start' };
    }
  }

  public async stopLiveChat() {
    const ear = this.ear;
    this.ear = null;
    if (ear) {
      await ear.stop();
      logger.info('YouTube ear stopped');
    }
    this.emitLiveChatStatus();
  }

  public liveChatSnapshot(): EarStatus | { running: false } {
    return this.ear ? this.ear.status() : { running: false };
  }

  private emitLiveChatStatus() {
    emitWebServiceStatus({
      service: 'youtube:live_chat',
      status: this.ear ? 'running' : 'stopped',
    });
  }
}
