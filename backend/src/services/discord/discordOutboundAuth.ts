import type { DiscordSendServerEmojiInput, DiscordSendTextMessageInput } from '@shannon/common';
import type { MemoryZone } from '@shannon/common';
import { config } from '../../config/env.js';
import { authorizeDiscordVoiceOutbound } from './discordVoiceSession.js';

const AUTHORIZED_SCHEDULED_POST_ZONES = Object.freeze(new Set<MemoryZone>([
  'discord:test_server',
  'discord:toyama_server',
  'discord:douki_server',
]));

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

/** Scheduler-only Discord posts. Arbitrary memory zones cannot reach configured channels. */
export function authorizeDiscordScheduledPost(memoryZone: MemoryZone): boolean {
  return AUTHORIZED_SCHEDULED_POST_ZONES.has(memoryZone);
}

/** YouTube subscriber announcements stay on the configured aimine guild only. */
export function authorizeDiscordSubscriberAnnounce(): boolean {
  const guildId = config.discord.guilds.aimine.guildId;
  return typeof guildId === 'string' && guildId.length > 0;
}
