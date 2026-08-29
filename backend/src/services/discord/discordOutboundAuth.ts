import type { DiscordSendServerEmojiInput, DiscordSendTextMessageInput } from '@shannon/common';
import { config } from '../../config/env.js';
import { authorizeDiscordVoiceOutbound } from './discordVoiceSession.js';

function configuredGuildIds(): ReadonlySet<string> {
  const ids = [
    config.discord.guilds.test.guildId,
    config.discord.guilds.aimine.guildId,
    config.discord.guilds.toyama.guildId,
    config.discord.guilds.douki.guildId,
    config.discord.guilds.colab.guildId,
  ].filter((id): id is string => typeof id === 'string' && id.length > 0);
  return new Set(ids);
}

/** Outbound postMessage is voice-only. Text replies use discordConversationPort, not this gateway. */
export function authorizeDiscordOutboundPostMessage(input: DiscordSendTextMessageInput): boolean {
  const { guildId, channelId } = input;
  if (!guildId || !channelId) return false;
  return authorizeDiscordVoiceOutbound({ guildId, channelId }) != null;
}

/** Legacy outbound emoji/react helpers are fail-closed unless guild matches configured servers. */
export function authorizeDiscordOutboundGuildRead(guildId: string | undefined): boolean {
  if (!guildId) return false;
  return configuredGuildIds().has(guildId);
}

export function authorizeDiscordOutboundGuildAction(input: Pick<DiscordSendServerEmojiInput, 'guildId' | 'channelId'>): boolean {
  const { guildId, channelId } = input;
  if (!authorizeDiscordOutboundGuildRead(guildId) || !channelId) return false;
  return authorizeDiscordVoiceOutbound({ guildId, channelId }) != null;
}
