/**
 * Discord Channel Adapter
 *
 * Converts Discord-native events (DiscordSendTextMessageOutput)
 * into RequestEnvelopes.
 */

import {
  RequestEnvelope,
  ChannelAdapter,
} from '@shannon/common';
import { createEnvelope } from './envelopeFactory.js';

/**
 * Shape of the data currently published by Discord client
 * via eventBus as 'llm:get_discord_message'.
 */
export interface DiscordNativeEvent {
  text: string;
  type: string;
  guildName: string;
  channelId: string;
  guildId: string;
  channelName: string;
  userName: string;
  messageId: string;
  userId: string;
  recentMessages?: unknown[];
  isVoiceChannel?: boolean;
  isDM?: boolean;
}

export const discordAdapter: ChannelAdapter<DiscordNativeEvent> = {
  channel: 'discord',

  toEnvelope(event: DiscordNativeEvent): RequestEnvelope {
    const tags: string[] = [];
    if (event.guildName) tags.push(event.guildName);
    if (event.channelName) tags.push(event.channelName);
    if (event.isVoiceChannel) tags.push('voice_channel');
    if (event.isDM) tags.push('dm');

    return createEnvelope({
      channel: 'discord',
      sourceUserId: event.userId,
      sourceDisplayName: event.userName,
      conversationId: `discord:${event.guildId}:${event.channelId}`,
      threadId: `discord:${event.channelId}`,
      text: event.text,
      tags,
      discord: {
        guildId: event.guildId,
        guildName: event.guildName,
        channelId: event.channelId,
        channelName: event.channelName,
        messageId: event.messageId,
        isVoiceChannel: event.isVoiceChannel,
        isDM: event.isDM,
      },
      metadata: {
        recentMessages: event.recentMessages,
        legacyMemoryZone: event.guildName,
        isDM: event.isDM,
      },
    });
  },
};
