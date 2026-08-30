import type {
  DiscordClientInput,
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
import { getLlmInbound } from './llmInboundRegistry.js';

export type WebInboundMessage = {
  type?: string;
  text?: string;
  senderName?: string;
  recentChatLog?: string[] | string;
  sessionId?: string;
  sourceUserId?: string;
  realtime_text?: string;
  realtime_audio?: string;
  command?: string | null;
};

export type DiscordInboundMessage =
  | DiscordSendTextMessageOutput
  | DiscordVoiceMessageOutput
  | DiscordClientInput;

export function deliverWebMessageToLlm(message: WebInboundMessage): void {
  getLlmInbound().handleWebMessage(message);
}

export function deliverDiscordMessageToLlm(message: DiscordInboundMessage): void {
  getLlmInbound().handleDiscordMessage(message);
}

export function deliverScheduledPostToLlm(data: TwitterClientInput): void {
  getLlmInbound().handleScheduledPost(data);
}

export function deliverTwitterReplyToLlm(data: TwitterReplyOutput): void {
  getLlmInbound().handleTwitterReply(data);
}

export function deliverTwitterQuoteRtToLlm(data: TwitterQuoteRTOutput): void {
  getLlmInbound().handleTwitterQuoteRT(data);
}

export function deliverMemberTweetToLlm(data: MemberTweetInput): void {
  getLlmInbound().handleMemberTweet(data);
}

export function deliverAutoTweetToLlm(data: TwitterAutoTweetInput): void {
  getLlmInbound().handleAutoTweet(data);
}

export function deliverYoutubeReplyToLlm(data: YoutubeCommentOutput): void {
  getLlmInbound().handleYoutubeReply(data);
}

export function deliverYoutubeMessageToLlm(data: YoutubeLiveChatMessageOutput): void {
  getLlmInbound().handleYoutubeMessage(data);
}

export function deliverMinebotVoiceResponseToLlm(data: MinebotVoiceResponseOutput): void {
  getLlmInbound().handleMinebotVoiceResponse(data);
}
