/**
 * X (Twitter) Channel Adapter
 *
 * Converts X-native events into RequestEnvelopes.
 */

import {
  RequestEnvelope,
  ChannelAdapter,
} from '@shannon/common';
import { createEnvelope } from './envelopeFactory.js';

/**
 * Shape of the data published by Twitter client
 * via eventBus as 'llm:post_twitter_reply'.
 */
export interface XNativeReplyEvent {
  replyId: string;
  text: string;
  authorName: string;
  authorId?: string;
  repliedTweet?: string;
  repliedTweetAuthorName?: string;
}

/**
 * Shape of a member tweet event (llm:respond_member_tweet).
 */
export interface XNativeMemberTweetEvent {
  tweetId: string;
  text: string;
  authorName: string;
  authorId: string;
  isQuoteRT?: boolean;
}

export type XNativeEvent = XNativeReplyEvent | XNativeMemberTweetEvent;

export const xAdapter: ChannelAdapter<XNativeEvent> = {
  channel: 'x',

  toEnvelope(event: XNativeEvent): RequestEnvelope {
    const isReply = 'replyId' in event;
    const tweetId = isReply
      ? (event as XNativeReplyEvent).replyId
      : (event as XNativeMemberTweetEvent).tweetId;

    const tags: string[] = ['public_post'];
    if (isReply) tags.push('reply');
    if ('isQuoteRT' in event && event.isQuoteRT) tags.push('quote_rt');

    return createEnvelope({
      channel: 'x',
      sourceUserId: event.authorId ?? event.authorName,
      sourceDisplayName: event.authorName,
      conversationId: `x:${tweetId}`,
      threadId: `x:${tweetId}`,
      text: event.text,
      tags,
      x: {
        tweetId,
        conversationId: `x:${tweetId}`,
        authorId: event.authorId ?? event.authorName,
        authorName: event.authorName,
        isReply,
        isQuote: 'isQuoteRT' in event && event.isQuoteRT,
      },
      metadata: {
        repliedTweet: isReply
          ? (event as XNativeReplyEvent).repliedTweet
          : undefined,
        legacyMemoryZone: 'twitter:post',
      },
    });
  },
};
