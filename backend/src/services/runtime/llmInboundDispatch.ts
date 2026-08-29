import type {
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

export function deliverWebMessageToLlm(
  message: OpenAIMessageOutput & { recentChatLog?: string[]; sessionId?: string },
): void {
  getLlmInbound().handleWebMessage(message);
}

export function deliverDiscordMessageToLlm(
  message: DiscordSendTextMessageOutput | DiscordVoiceMessageOutput,
): void {
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
