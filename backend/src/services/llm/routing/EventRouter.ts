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
import { getWebNotificationHub } from '../../web/webNotificationHub.js';
import { acquireWebRealtimeInput } from '../../web/webRealtimeInputLock.js';
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
  isDevMode: boolean;
  realtimeApi: RealtimeAPIService;
  agentOrchestrator: AgentOrchestrator;
  voiceProcessor: VoiceProcessor;
  invokeGraph: InvokeGraphFn;
}

export class EventRouter {
  private isDevMode: boolean;
  private realtimeApi: RealtimeAPIService;
  private agents: AgentOrchestrator;
  private voice: VoiceProcessor;
  private invokeGraph: InvokeGraphFn;

  constructor(deps: EventRouterDeps) {
    this.isDevMode = deps.isDevMode;
    this.realtimeApi = deps.realtimeApi;
    this.agents = deps.agentOrchestrator;
    this.voice = deps.voiceProcessor;
    this.invokeGraph = deps.invokeGraph;
  }

  setupRealtimeAPICallback() {
    const hub = getWebNotificationHub();
    const withSession = <T extends OpenAIMessageOutput>(payload: T): T & { sessionId?: string } => {
      const sessionId = this.realtimeApi.getResponseSessionId();
      return sessionId ? { ...payload, sessionId } : payload;
    };
    this.realtimeApi.setTextCallback((text) => {
      hub.emitPostMessage(withSession({
        type: 'realtime_text',
        realtime_text: text,
      } as OpenAIMessageOutput));
    });

    this.realtimeApi.setTextDoneCallback(() => {
      hub.emitPostMessage(withSession({
        type: 'realtime_text',
        command: 'text_done',
      } as OpenAIMessageOutput));
    });

    this.realtimeApi.setAudioCallback((audio) => {
      hub.emitPostMessage(withSession({
        realtime_audio: audio.toString(),
        type: 'realtime_audio',
        command: 'realtime_audio_append',
      } as OpenAIMessageOutput));
    });

    this.realtimeApi.setAudioDoneCallback(() => {
      hub.emitPostMessage(withSession({
        type: 'realtime_audio',
        command: 'realtime_audio_commit',
      } as OpenAIMessageOutput));
    });

    this.realtimeApi.setUserTranscriptCallback((text) => {
      hub.emitPostMessage(withSession({
        realtime_text: text,
        type: 'user_transcript',
      } as OpenAIMessageOutput));
    });
  }

  handleWebMessage(message: OpenAIMessageOutput & {
    recentChatLog?: string[];
    sessionId?: string;
  }): void {
    void this.processWebMessage(message);
  }

  handleDiscordMessage(message: DiscordSendTextMessageOutput | DiscordVoiceMessageOutput): void {
    void this.processDiscordMessage(message);
  }

  handleScheduledPost(data: TwitterClientInput): void {
    if (this.isDevMode) return;
    this.agents.processCreateScheduledPost(data);
  }

  handleTwitterReply(data: TwitterReplyOutput): void {
    this.agents.processTwitterReply(data).catch((err) => {
      logger.error('[Twitter Reply] 未処理エラー:', err);
    });
  }

  handleTwitterQuoteRT(data: TwitterQuoteRTOutput): void {
    if (this.isDevMode) return;
    this.agents.processTwitterQuoteRT(data);
  }

  handleMemberTweet(data: MemberTweetInput): void {
    if (this.isDevMode) return;
    this.agents.processMemberTweet(data).catch((err) => {
      logger.error('[MemberTweet] 未処理エラー:', err);
    });
  }

  handleAutoTweet(data: TwitterAutoTweetInput): void {
    this.agents.processAutoTweet(data);
  }

  handleYoutubeReply(data: YoutubeCommentOutput): void {
    if (this.isDevMode) return;
    this.agents.processYoutubeReply(data);
  }

  handleYoutubeMessage(data: YoutubeLiveChatMessageOutput): void {
    this.agents.processYoutubeMessage(data);
  }

  handleMinebotVoiceResponse(data: MinebotVoiceResponseOutput): void {
    this.voice.processMinebotVoiceResponse(data).catch((err) => {
      logger.error('[Minebot Voice] 未処理エラー:', err);
    });
  }

  private isRealtimeWebMessage(message: OpenAIMessageOutput & { command?: string }): boolean {
    if (message.type === 'realtime_text' || message.type === 'realtime_audio') return true;
    if (message.command === 'realtime_vad_on' || message.command === 'realtime_vad_off') return true;
    if (message.command === 'realtime_audio_commit') return true;
    return false;
  }

  private async processWebMessage(message: OpenAIMessageOutput & {
    recentChatLog?: string[];
    sessionId?: string;
    sourceUserId?: string;
  }) {
    try {
      if (this.isRealtimeWebMessage(message)) {
        if (!message.sessionId || !acquireWebRealtimeInput(message.sessionId)) return;
        this.realtimeApi.setResponseSessionId(message.sessionId);
      }
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

      if (message.type === 'text') {
        const currentTime = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
        const envelope = webAdapter.toEnvelope({
          type: 'text',
          text: `${currentTime} ${message.senderName ?? ''}: ${message.text ?? ''}`,
          senderName: message.senderName ?? undefined,
          recentChatLog: message.recentChatLog?.join('\n'),
          sessionId: message.sessionId,
          sourceUserId: message.sourceUserId,
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

        const envelope = discordAdapter.toEnvelope({
          text: textMsg.text,
          type: textMsg.type,
          guildName: textMsg.guildName,
          channelId: textMsg.channelId,
          guildId: textMsg.guildId,
          channelName: textMsg.channelName,
          userName: textMsg.userName,
          messageId: textMsg.messageId,
          userId: textMsg.userId,
          recentMessages: textMsg.recentMessages as unknown[],
          isDM: textMsg.isDM === true,
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
