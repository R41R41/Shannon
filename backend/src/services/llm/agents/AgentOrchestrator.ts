import {
  DiscordScheduledPostInput,
  MemberTweetInput,
  TwitterAutoTweetInput,
  TwitterClientInput,
  TwitterQuoteRTOutput,
  TwitterReplyOutput,
  YoutubeClientInput,
  YoutubeCommentOutput,
  YoutubeLiveChatMessageInput,
  YoutubeLiveChatMessageOutput,
} from '@shannon/common';
import { HumanMessage } from '@langchain/core/messages';
import type { RequestEnvelope, ShannonGraphState } from '@shannon/common';
import { EventBus } from '../../eventBus/eventBus.js';
import { AutoTweetAgent } from './autoTweetAgent.js';
import { MemberTweetAgent } from './memberTweetAgent.js';
import { PostAboutTodayAgent } from './postAboutTodayAgent.js';
import { PostFortuneAgent } from './postFortuneAgent.js';
import { PostNewsAgent } from './postNewsAgent.js';
import { PostWeatherAgent } from './postWeatherAgent.js';
import { QuoteTwitterCommentAgent } from './quoteTwitterComment.js';
import { ReplyTwitterCommentAgent } from './replyTwitterComment.js';
import { ReplyYoutubeCommentAgent } from './replyYoutubeComment.js';
import { ReplyYoutubeLiveCommentAgent } from './replyYoutubeLiveCommentAgent.js';
import { generateImage } from '../utils/generateImage.js';
import { xAdapter } from '../../common/adapters/index.js';
import { logger } from '../../../utils/logger.js';

export type InvokeGraphFn = (
  envelope: RequestEnvelope,
  legacyMessages?: import('@langchain/core/messages').BaseMessage[],
) => Promise<ShannonGraphState>;

export interface AgentOrchestratorDeps {
  eventBus: EventBus;
  isDevMode: boolean;
  invokeGraph: InvokeGraphFn;
}

export class AgentOrchestrator {
  private eventBus: EventBus;
  private isDevMode: boolean;
  private invokeGraph: InvokeGraphFn;

  private aboutTodayAgent!: PostAboutTodayAgent;
  private weatherAgent!: PostWeatherAgent;
  private fortuneAgent!: PostFortuneAgent;
  private newsAgent!: PostNewsAgent;
  private replyTwitterCommentAgent!: ReplyTwitterCommentAgent;
  private quoteTwitterCommentAgent!: QuoteTwitterCommentAgent;
  private replyYoutubeCommentAgent!: ReplyYoutubeCommentAgent;
  private replyYoutubeLiveCommentAgent!: ReplyYoutubeLiveCommentAgent;
  private autoTweetAgent!: AutoTweetAgent;
  private memberTweetAgent!: MemberTweetAgent;

  constructor(deps: AgentOrchestratorDeps) {
    this.eventBus = deps.eventBus;
    this.isDevMode = deps.isDevMode;
    this.invokeGraph = deps.invokeGraph;
  }

  async initializeAgents() {
    this.aboutTodayAgent = await PostAboutTodayAgent.create();
    this.weatherAgent = await PostWeatherAgent.create();
    this.fortuneAgent = await PostFortuneAgent.create();
    this.replyTwitterCommentAgent = await ReplyTwitterCommentAgent.create();
    this.quoteTwitterCommentAgent = QuoteTwitterCommentAgent.create();
    this.replyYoutubeCommentAgent = await ReplyYoutubeCommentAgent.create();
    this.replyYoutubeLiveCommentAgent = await ReplyYoutubeLiveCommentAgent.create();
    this.newsAgent = await PostNewsAgent.create();
    this.autoTweetAgent = await AutoTweetAgent.create();
    this.memberTweetAgent = await MemberTweetAgent.create();
  }

  async processYoutubeReply(data: YoutubeCommentOutput) {
    const comment = data.text;
    const videoTitle = data.videoTitle;
    const videoDescription = data.videoDescription;
    const authorName = data.authorName;
    const reply = await this.replyYoutubeCommentAgent.reply(
      comment,
      videoTitle,
      videoDescription,
      authorName,
      data.authorChannelId,
    );
    this.eventBus.publish({
      type: 'youtube:reply_comment',
      memoryZone: 'youtube',
      data: {
        videoId: data.videoId,
        commentId: data.commentId,
        reply: reply + ' by シャノン',
      } as YoutubeClientInput,
    });
  }

  async processYoutubeMessage(data: YoutubeLiveChatMessageOutput) {
    const message = data.message;
    const author = data.author;
    const jstNow = data.jstNow;
    const minutesSinceStart = data.minutesSinceStart;
    const history = data.history;
    const liveTitle = data.liveTitle;
    const liveDescription = data.liveDescription;

    const response = await this.replyYoutubeLiveCommentAgent.reply(
      message,
      author,
      jstNow,
      minutesSinceStart,
      history,
      liveTitle,
      liveDescription,
      data.authorChannelId,
    );
    this.eventBus.publish({
      type: 'youtube:live_chat:post_message',
      memoryZone: 'youtube',
      data: {
        response: response,
      } as YoutubeLiveChatMessageInput,
    });
  }

  async processTwitterReply(data: TwitterReplyOutput) {
    const text = data.text;
    const replyId = data.replyId;
    const authorName = data.authorName;
    const repliedTweet = data.repliedTweet;
    const repliedTweetAuthorName = data.repliedTweetAuthorName;
    const conversationThread = data.conversationThread;

    if (!text || !replyId || !authorName) {
      logger.error('Twitter reply data is invalid:', { text, replyId, authorName });
      return;
    }

    try {
      logger.info(`[Twitter Reply] Unified graph開始: @${authorName} "${text.slice(0, 50)}" (スレッド: ${conversationThread?.length ?? 0}件)`);
      const envelope = xAdapter.toEnvelope({
        replyId,
        text,
        authorName,
        authorId: data.authorId ?? undefined,
        repliedTweet: repliedTweet ?? undefined,
        repliedTweetAuthorName: repliedTweetAuthorName ?? undefined,
      });
      const history = (conversationThread ?? []).map(
        (entry) => new HumanMessage(`${entry.authorName}: ${entry.text}`),
      );
      await this.invokeGraph(envelope, history);
    } catch (error) {
      logger.error('[Twitter Reply] エラー:', error);
    }
  }

  async processTwitterQuoteRT(data: TwitterQuoteRTOutput) {
    const { tweetId, tweetUrl, text, authorName, authorUserName } = data;

    if (!tweetId || !tweetUrl || !text || !authorName) {
      logger.error('Twitter quote RT data is invalid');
      return;
    }

    const quoteText = await this.quoteTwitterCommentAgent.generateQuote(
      text,
      authorName,
      authorUserName
    );
    this.eventBus.publish({
      type: 'twitter:post_message',
      memoryZone: 'twitter:post',
      data: {
        text: quoteText,
        quoteTweetUrl: tweetUrl,
      } as TwitterClientInput,
    });
  }

  async processMemberTweet(data: MemberTweetInput) {
    const { tweetId, text, authorName } = data;

    if (!tweetId || !text || !authorName) {
      logger.error('MemberTweet data is invalid:', { tweetId, text, authorName });
      return;
    }

    try {
      logger.info(
        `[MemberTweet] Unified graph開始: @${data.authorUserName} "${text.slice(0, 50)}"`,
        'cyan',
      );
      const envelope = xAdapter.toEnvelope({
        tweetId,
        text,
        authorName,
        authorId: data.authorId ?? authorName,
      });
      const history = (data.conversationThread ?? []).map(
        (entry) => new HumanMessage(`${entry.authorName}: ${entry.text}`),
      );
      await this.invokeGraph(envelope, history);
    } catch (error) {
      logger.error('[MemberTweet] エラー:', error);
    }
  }

  private isQuoteUrlDuplicate(quoteUrl: string, urls: string[]): boolean {
    const resultId = quoteUrl.match(/status\/(\d+)/)?.[1];
    return urls.some((u) => {
      if (u === quoteUrl) return true;
      const existingId = u.match(/status\/(\d+)/)?.[1];
      return resultId && existingId && resultId === existingId;
    });
  }

  async processAutoTweet(data: TwitterAutoTweetInput) {
    const MAX_DUPLICATE_RETRIES = 2;
    try {
      const { trends, todayInfo, recentPosts, recentQuoteUrls: originalQuoteUrls, mode, recentTopics } = data;
      const blockedUrls = [...(originalQuoteUrls || [])];

      logger.info(`🐦 AutoTweet: ツイート生成中 (mode=${mode}, トレンド${trends.length}件, 直近ポスト${recentPosts?.length ?? 0}件, トピック${recentTopics?.length ?? 0}件)...`);

      for (let attempt = 0; attempt <= MAX_DUPLICATE_RETRIES; attempt++) {
        const result = await this.autoTweetAgent.generateTweet(
          trends, todayInfo, recentPosts, blockedUrls, mode, recentTopics,
        );

        if (!result) {
          logger.warn('🐦 AutoTweet: ツイート生成失敗（レビュー不合格 or 空の結果）');
          return;
        }

        if (result.type === 'quote_rt' && result.quoteUrl) {
          if (this.isQuoteUrlDuplicate(result.quoteUrl, blockedUrls)) {
            if (attempt < MAX_DUPLICATE_RETRIES) {
              blockedUrls.push(result.quoteUrl);
              logger.warn(`🐦 AutoTweet: 引用RT重複検出、リトライ ${attempt + 1}/${MAX_DUPLICATE_RETRIES} → ${result.quoteUrl}`);
              continue;
            }
            logger.warn(`🐦 AutoTweet: 引用RT重複がリトライ上限に達した、投稿スキップ → ${result.quoteUrl}`);
            return;
          }

          logger.info(`🐦 AutoTweet: 引用RT生成完了「${result.text}」→ ${result.quoteUrl}`);
          this.eventBus.publish({
            type: 'twitter:post_scheduled_message',
            memoryZone: 'twitter:post',
            data: {
              text: result.text,
              quoteTweetUrl: result.quoteUrl,
              topic: result.topic,
            } as TwitterClientInput,
          });
          return;
        }

        logger.info(`🐦 AutoTweet: 生成完了「${result.text}」`);
        this.eventBus.publish({
          type: 'twitter:post_scheduled_message',
          memoryZone: 'twitter:post',
          data: {
            text: result.text,
            topic: result.topic,
          } as TwitterClientInput,
        });
        return;
      }
    } catch (error) {
      logger.error('🐦 AutoTweet エラー:', error);
    }
  }

  async processCreateScheduledPost(message: TwitterClientInput) {
    let post = '';
    let postForToyama = '';
    let imagePrompt: string | undefined;

    if (message.command === 'forecast') {
      const result = await this.weatherAgent.createPost();
      post = result.text;
      imagePrompt = result.imagePrompt;
      postForToyama = await this.weatherAgent.createPostForToyama();
    } else if (message.command === 'fortune') {
      const result = await this.fortuneAgent.createPost();
      post = result.text;
      imagePrompt = result.imagePrompt;
      postForToyama = post;
    } else if (message.command === 'about_today') {
      const result = await this.aboutTodayAgent.createPost();
      post = result.text;
      imagePrompt = result.imagePrompt;
      postForToyama = post;
    } else if (message.command === 'news_today') {
      const result = await this.newsAgent.createPost();
      post = result.text;
      imagePrompt = result.imagePrompt;
      postForToyama = post;
    }

    // 画像生成（全 command 共通）
    let mediaId: string | null = null;
    let imageBuffer: Buffer | null = null;
    if (imagePrompt) {
      try {
        imageBuffer = await generateImage(imagePrompt, '1024x1024', 'low');
        if (imageBuffer && !this.isDevMode) {
          const { TwitterClient } = await import('../../twitter/client.js');
          const twitterClient = TwitterClient.getInstance();
          mediaId = await twitterClient.uploadMedia(imageBuffer, `${message.command}.jpg`) ?? null;
          if (mediaId) {
            logger.info(`[ScheduledPost] ${message.command} 画像アップロード成功: ${mediaId}`, 'green');
          }
        }
      } catch (imgErr) {
        logger.warn(`[ScheduledPost] ${message.command} 画像生成/アップロード失敗（テキストのみ投稿）: ${imgErr}`);
      }
    }

    if (this.isDevMode) {
      this.eventBus.publish({
        type: 'discord:scheduled_post',
        memoryZone: 'discord:test_server',
        data: {
          command: message.command,
          text: post,
          ...(imageBuffer ? { imageBuffer } : {}),
        } as DiscordScheduledPostInput,
      });
      this.eventBus.publish({
        type: 'discord:scheduled_post',
        memoryZone: 'discord:test_server',
        data: {
          command: message.command,
          text: postForToyama,
          ...(imageBuffer ? { imageBuffer } : {}),
        } as DiscordScheduledPostInput,
      });
    } else {
      this.eventBus.log('twitter:schedule_post', 'green', post, true);
      this.eventBus.log('discord:toyama_server', 'green', postForToyama, true);
      this.eventBus.publish({
        type: 'twitter:post_scheduled_message',
        memoryZone: 'twitter:schedule_post',
        data: {
          text: post,
          imageUrl: mediaId,
        } as TwitterClientInput,
      });
      this.eventBus.publish({
        type: 'discord:scheduled_post',
        memoryZone: 'discord:toyama_server',
        data: {
          command: message.command,
          text: postForToyama,
          ...(imageBuffer ? { imageBuffer } : {}),
        } as DiscordScheduledPostInput,
      });
      this.eventBus.publish({
        type: 'discord:scheduled_post',
        memoryZone: 'discord:douki_server',
        data: {
          command: message.command,
          text: post,
          ...(imageBuffer ? { imageBuffer } : {}),
        } as DiscordScheduledPostInput,
      });
    }
  }
}
