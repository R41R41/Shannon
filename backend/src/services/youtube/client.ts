import {
  YoutubeCommentOutput,
  YoutubeLiveChatMessageOutput,
  YoutubeSubscriberUpdateOutput,
} from '@shannon/common';
import { OAuth2Client } from 'google-auth-library';
import { google, youtube_v3 } from 'googleapis';
import { BaseClient } from '../common/BaseClient.js';
import { config } from '../../config/env.js';
import { getDiscordOutboundPort } from '../runtime/discordOutboundGateway.js';
import { deliverYoutubeMessageToLlm, deliverYoutubeReplyToLlm } from '../runtime/llmInboundDispatch.js';
import { registerYoutubeToolPort } from '../runtime/platformToolGateway.js';
import { registerServiceCommandHandler } from '../runtime/serviceCommandRegistry.js';
import { emitWebServiceStatus } from '../web/webNotificationHub.js';
import { logger } from '../../utils/logger.js';

export class YoutubeClient extends BaseClient {
  private static instance: YoutubeClient;
  private client: youtube_v3.Youtube | null = null;
  private oauth2Client: OAuth2Client | null = null;
  private channelId: string | null = null;
  public isTest: boolean = false;
  private authCode: string | null = null;
  private refreshToken: string | null = null;
  private lastSubscriberCount: number = 0;
  private liveChatPolling: NodeJS.Timeout | null = null;
  private liveChatId: string | null = null;
  private lastRepliedMessageIds: Set<string> = new Set();
  private liveChatStatus: 'running' | 'stopped' = 'stopped';
  private liveTitle: string | null = null;
  private liveDescription: string | null = null;
  private liveStartTime: Date | null = null;
  private chatHistory: { minutes: number; author: string; message: string }[] =
    [];
  private liveChatWatchStartTime: Date | null = null;
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

    registerServiceCommandHandler('youtube:live_chat', async (command) => {
      if (command === 'start') {
        const result = await this.startLiveChat();
        if (result.success) {
          this.liveChatStatus = 'running';
        }
      } else if (command === 'stop') {
        await this.stopLiveChat();
        this.liveChatStatus = 'stopped';
      } else if (command === 'status') {
        emitWebServiceStatus({
          service: 'youtube:live_chat',
          status: this.liveChatStatus,
        });
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

  public async startLiveChat() {
    if (!this.client) {
      logger.error('YouTube client is not initialized');
      return { success: false, message: 'YouTube client is not initialized' };
    }
    const videoId = await this.getCurrentLiveVideoId();
    logger.debug(`取得したvideoId: ${videoId}`);
    logger.debug(`YOUTUBE_LIVE_URL: ${process.env.YOUTUBE_LIVE_URL}`);
    if (!videoId) {
      logger.error('ライブ配信中の動画が見つかりません');
      return { success: false, message: 'ライブ配信中の動画が見つかりません' };
    }
    if (this.liveChatPolling) {
      clearInterval(this.liveChatPolling);
      this.liveChatPolling = null;
    }
    let liveChatId: string | null = null;
    try {
      const videoResponse = await this.client.videos.list({
        part: ['liveStreamingDetails', 'snippet'],
        id: [videoId],
      });
      const video = videoResponse.data.items?.[0];
      logger.debug(`動画情報: ${JSON.stringify({
        title: video?.snippet?.title,
        liveBroadcastContent: video?.snippet?.liveBroadcastContent,
        liveStreamingDetails: video?.liveStreamingDetails,
      }, null, 2)}`);
      liveChatId = (video?.liveStreamingDetails as { activeLiveChatId?: string })?.activeLiveChatId ?? null;
      if (!liveChatId) {
        logger.error('liveChatIdが取得できませんでした');
        return { success: false, message: 'liveChatIdが取得できませんでした' };
      }
      this.liveChatId = liveChatId;
      this.liveTitle = video?.snippet?.title || null;
      this.liveDescription = video?.snippet?.description || null;
      this.liveStartTime = video?.liveStreamingDetails?.actualStartTime
        ? new Date(video.liveStreamingDetails.actualStartTime)
        : null;
      this.chatHistory = [];
      this.liveChatWatchStartTime = new Date();
      this.liveChatPolling = setInterval(() => {
        this.fetchLiveChatMessages();
      }, 60 * 1000);
      this.fetchLiveChatMessages();
      logger.info('ライブチャット監視を開始しました');
      return { success: true, message: 'ライブチャット監視を開始しました' };
    } catch (error) {
      logger.error('ライブチャット監視開始エラー', error);
      return { success: false, message: 'ライブチャット監視開始エラー' };
    }
  }

  public async stopLiveChat() {
    if (this.liveChatPolling) {
      clearInterval(this.liveChatPolling);
      this.liveChatPolling = null;
      this.liveChatId = null;
      logger.info('ライブチャット監視を停止しました');
    }
  }

  private async fetchLiveChatMessages() {
    if (!this.client || !this.liveChatId) return;
    try {
      const chatResponse = await this.client.liveChatMessages.list({
        liveChatId: this.liveChatId,
        part: ['snippet', 'authorDetails'],
        maxResults: 200,
      });
      const messages = chatResponse.data.items || [];
      const unrepliedMessages = messages.filter(
        (msg) =>
          msg.id &&
          !this.lastRepliedMessageIds.has(msg.id ?? '') &&
          msg.authorDetails?.channelId !== this.channelId &&
          (
            !this.liveChatWatchStartTime ||
            (msg.snippet?.publishedAt && new Date(msg.snippet.publishedAt) >= this.liveChatWatchStartTime)
          ) &&
          (msg.snippet?.displayMessage?.startsWith('シャノン、') ?? false)
      );
      if (unrepliedMessages.length > 0) {
        const randomIndex = Math.floor(Math.random() * unrepliedMessages.length);
        const msg = unrepliedMessages[randomIndex];
        this.lastRepliedMessageIds.add(msg.id ?? '');
        const author = msg.authorDetails?.displayName ?? '';
        const message = msg.snippet?.displayMessage ?? '';
        if (author !== '' && message !== '') {
          this.chatHistory.push({
            minutes: 0,
            author,
            message,
          });
          const formattedHistory = this.chatHistory.map(
            (h) => `${h.minutes}：${h.author}「${h.message}」`
          );
          deliverYoutubeMessageToLlm({
            message,
            author,
            jstNow: new Date().toISOString(),
            minutesSinceStart: 0,
            history: formattedHistory,
            liveTitle: this.liveTitle ?? '',
            liveDescription: this.liveDescription ?? '',
          } as YoutubeLiveChatMessageOutput);
        }
      }
    } catch (error) {
      logger.error('ライブチャット取得エラー', error);
    }
  }

  public async sendLiveChatMessage(message: string) {
    if (!this.client || !this.liveChatId) return;
    try {
      await this.client.liveChatMessages.insert({
        part: ['snippet'],
        requestBody: {
          snippet: {
            liveChatId: this.liveChatId,
            type: 'textMessageEvent',
            textMessageDetails: {
              messageText: message,
            },
          },
        },
      });
      logger.info(`ライブチャットにコメントを投稿: ${message}`);
    } catch (error) {
      logger.error('ライブチャットコメント投稿エラー', error);
    }
  }

  async getCurrentLiveVideoId(): Promise<string | null> {
    const liveUrl = config.youtube.liveUrl;
    if (liveUrl) {
      const match = liveUrl.match(/(?:v=|\/(?:video|live)\/|youtu\.be\/|watch\?v=)([a-zA-Z0-9_-]{11})/);
      if (match && match[1]) {
        return match[1];
      }
    }
    if (!this.client || !this.channelId) return null;
    const res = await this.client.search.list({
      part: ['id'],
      channelId: this.channelId,
      eventType: 'live',
      type: ['video'],
      maxResults: 1,
    });
    const videoId = res.data.items?.[0]?.id?.videoId;
    return videoId || null;
  }
}
