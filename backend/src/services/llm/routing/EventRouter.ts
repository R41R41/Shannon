import { BaseMessage, HumanMessage } from '@langchain/core/messages';
import {
  DiscordSendTextMessageOutput,
  DiscordVoiceMessageOutput,
  MemberTweetInput,
  MinebotVoiceResponseOutput,
  OpenAIMessageOutput,
  TwitterAutoTweetInput,
  TwitterClientInput,
  TwitterQuoteRTOutput,
  TwitterReplyOutput,
  YoutubeCommentOutput,
  YoutubeLiveChatMessageOutput,
} from '@shannon/common';
import type { RequestEnvelope, ShannonGraphState } from '@shannon/common';
import { EventBus } from '../../eventBus/eventBus.js';
import { RealtimeAPIService } from '../agents/realtimeApiAgent.js';
import {
  discordAdapter,
  webAdapter,
  type DiscordNativeEvent,
} from '../../common/adapters/index.js';
import { logger } from '../../../utils/logger.js';
import type { AgentOrchestrator } from '../agents/AgentOrchestrator.js';
import type { VoiceProcessor } from '../voice/VoiceProcessor.js';

export type InvokeGraphFn = (
  envelope: RequestEnvelope,
  legacyMessages?: BaseMessage[],
) => Promise<ShannonGraphState>;

export interface EventRouterDeps {
  eventBus: EventBus;
  isDevMode: boolean;
  realtimeApi: RealtimeAPIService;
  agentOrchestrator: AgentOrchestrator;
  voiceProcessor: VoiceProcessor;
  invokeGraph: InvokeGraphFn;
}

export class EventRouter {
  private eventBus: EventBus;
  private isDevMode: boolean;
  private realtimeApi: RealtimeAPIService;
  private agents: AgentOrchestrator;
  private voice: VoiceProcessor;
  private invokeGraph: InvokeGraphFn;

  constructor(deps: EventRouterDeps) {
    this.eventBus = deps.eventBus;
    this.isDevMode = deps.isDevMode;
    this.realtimeApi = deps.realtimeApi;
    this.agents = deps.agentOrchestrator;
    this.voice = deps.voiceProcessor;
    this.invokeGraph = deps.invokeGraph;
  }

  setupEventBus() {
    this.eventBus.subscribe('llm:get_web_message', (event) => {
      this.processWebMessage(event.data as OpenAIMessageOutput);
    });

    this.eventBus.subscribe('llm:get_discord_message', (event) => {
      this.processDiscordMessage(event.data as DiscordSendTextMessageOutput);
    });

    this.eventBus.subscribe('llm:post_scheduled_message', (event) => {
      if (this.isDevMode) return;
      this.agents.processCreateScheduledPost(event.data as TwitterClientInput);
    });

    this.eventBus.subscribe('llm:post_twitter_reply', (event) => {
      this.agents.processTwitterReply(event.data as TwitterReplyOutput).catch((err) => {
        logger.error('[Twitter Reply] 未処理エラー:', err);
      });
    });

    this.eventBus.subscribe('llm:post_twitter_quote_rt', (event) => {
      if (this.isDevMode) return;
      this.agents.processTwitterQuoteRT(event.data as TwitterQuoteRTOutput);
    });

    this.eventBus.subscribe('llm:respond_member_tweet', (event) => {
      if (this.isDevMode) return;
      this.agents.processMemberTweet(event.data as MemberTweetInput).catch((err) => {
        logger.error('[MemberTweet] 未処理エラー:', err);
      });
    });

    this.eventBus.subscribe('llm:generate_auto_tweet', (event) => {
      this.agents.processAutoTweet(event.data as TwitterAutoTweetInput);
    });

    this.eventBus.subscribe('llm:reply_youtube_comment', (event) => {
      if (this.isDevMode) return;
      this.agents.processYoutubeReply(event.data as YoutubeCommentOutput);
    });

    // NOTE: llm:get_skills is subscribed directly in LLMService (needs tool access)

    this.eventBus.subscribe('llm:get_youtube_message', (event) => {
      this.agents.processYoutubeMessage(event.data as YoutubeLiveChatMessageOutput);
    });

    this.eventBus.subscribe('minebot:voice_response', (event) => {
      this.voice.processMinebotVoiceResponse(event.data as MinebotVoiceResponseOutput).catch((err) => {
        logger.error('[Minebot Voice] 未処理エラー:', err);
      });
    });
  }

  setupRealtimeAPICallback() {
    this.realtimeApi.setTextCallback((text) => {
      this.eventBus.publish({
        type: 'web:post_message',
        memoryZone: 'web',
        data: {
          type: 'realtime_text',
          realtime_text: text,
        } as OpenAIMessageOutput,
        targetMemoryZones: ['web'],
      });
    });

    this.realtimeApi.setTextDoneCallback(() => {
      this.eventBus.publish({
        type: 'web:post_message',
        memoryZone: 'web',
        data: {
          type: 'realtime_text',
          command: 'text_done',
        } as OpenAIMessageOutput,
        targetMemoryZones: ['web'],
      });
    });

    this.realtimeApi.setAudioCallback((audio) => {
      this.eventBus.publish({
        type: 'web:post_message',
        memoryZone: 'web',
        data: {
          realtime_audio: audio.toString(),
          type: 'realtime_audio',
          command: 'realtime_audio_append',
        } as OpenAIMessageOutput,
        targetMemoryZones: ['web'],
      });
    });

    this.realtimeApi.setAudioDoneCallback(() => {
      this.eventBus.publish({
        type: 'web:post_message',
        memoryZone: 'web',
        data: {
          type: 'realtime_audio',
          command: 'realtime_audio_commit',
        } as OpenAIMessageOutput,
        targetMemoryZones: ['web'],
      });
    });

    this.realtimeApi.setUserTranscriptCallback((text) => {
      this.eventBus.publish({
        type: 'web:post_message',
        memoryZone: 'web',
        data: {
          realtime_text: text,
          type: 'user_transcript',
        } as OpenAIMessageOutput,
        targetMemoryZones: ['web'],
      });
    });
  }

  private async processWebMessage(message: OpenAIMessageOutput & {
    recentChatLog?: string[];
    sessionId?: string;
  }) {
    try {
      // Realtime audio/text passthrough (not graph-routed)
      if (message.type === 'realtime_text' && message.realtime_text) {
        await this.realtimeApi.inputText(message.realtime_text);
        return;
      }
      if (message.type === 'realtime_audio' && message.command === 'realtime_audio_append' && message.realtime_audio) {
        await this.realtimeApi.inputAudioBufferAppend(message.realtime_audio);
        return;
      }
      if (message.type === 'realtime_audio' && message.command === 'realtime_audio_commit') {
        await this.realtimeApi.inputAudioBufferCommit();
        return;
      }
      if (message.command === 'realtime_vad_on') {
        await this.realtimeApi.vadModeChange(true);
        return;
      }
      if (message.command === 'realtime_vad_off') {
        await this.realtimeApi.vadModeChange(false);
        return;
      }

      // Text message → unified graph via web adapter
      if (message.type === 'text') {
        const currentTime = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
        const envelope = webAdapter.toEnvelope({
          type: 'text',
          text: `${currentTime} ${message.senderName ?? ''}: ${message.text ?? ''}`,
          senderName: message.senderName ?? undefined,
          recentChatLog: message.recentChatLog?.join('\n'),
          sessionId: message.sessionId,
        });
        await this.invokeGraph(envelope);
      }
    } catch (error) {
      logger.error('LLM処理エラー:', error);
    }
  }

  private async processDiscordMessage(message: DiscordSendTextMessageOutput | DiscordVoiceMessageOutput) {
    try {
      if (message.type === 'text') {
        const textMsg = message as DiscordSendTextMessageOutput;
        const currentTime = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });

        // Build envelope via ChannelAdapter
        const envelope = discordAdapter.toEnvelope({
          text: `${currentTime} ${textMsg.userName}: ${textMsg.text}`,
          type: textMsg.type,
          guildName: textMsg.guildName,
          channelId: textMsg.channelId,
          guildId: textMsg.guildId,
          channelName: textMsg.channelName,
          userName: textMsg.userName,
          messageId: textMsg.messageId,
          userId: textMsg.userId,
          recentMessages: textMsg.recentMessages as unknown[],
        } as DiscordNativeEvent);

        const msgs = textMsg.recentMessages
          ? [...textMsg.recentMessages, new HumanMessage(`${currentTime} ${textMsg.userName}: ${textMsg.text}`)]
          : [];

        await this.invokeGraph(envelope, msgs);
        return;
      }

      if (message.type === 'voice') {
        await this.voice.processDiscordVoiceMessage(message as DiscordVoiceMessageOutput);
        return;
      }
    } catch (error) {
      logger.error('LLM処理エラー:', error);
      throw error;
    }
  }
}
