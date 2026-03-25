/**
 * ScopeDeriver
 *
 * Derives visibility scope, channel/world/project tags from a RequestEnvelope.
 */

import { IShannonMemory } from '../../../models/ShannonMemory.js';
import { MemoryPlatform } from '../../../models/PersonMemory.js';
import type {
  RequestEnvelope,
  ShannonChannel,
} from '@shannon/common';

export const channelToSource: Record<ShannonChannel, string> = {
  discord: 'discord',
  x: 'twitter',
  minecraft: 'minebot',
  web: 'web',
  youtube: 'youtube',
  scheduler: 'web',
  notion: 'notion',
  internal: 'unknown',
};

export class ScopeDeriver {
  deriveVisibilityScope(envelope: RequestEnvelope): IShannonMemory['visibilityScope'] {
    if (envelope.metadata?.isDM || envelope.discord?.isDM) return 'private_user';
    if (envelope.channel === 'minecraft') return 'shared_world';
    if (envelope.channel === 'discord' && envelope.discord?.guildId) return 'shared_channel';
    if (envelope.channel === 'x') return 'shared_channel';
    return 'shared_channel';
  }

  deriveScopeTags(envelope: RequestEnvelope): string[] {
    return [
      ...this.deriveChannelTags(envelope),
      ...this.deriveWorldTags(envelope),
      ...envelope.tags,
    ];
  }

  deriveChannelTags(envelope: RequestEnvelope): string[] {
    const tags: string[] = [envelope.channel];
    if (envelope.discord?.guildId) tags.push(`discord:guild:${envelope.discord.guildId}`);
    if (envelope.discord?.channelId) tags.push(`discord:channel:${envelope.discord.channelId}`);
    if (envelope.discord?.guildName) tags.push(envelope.discord.guildName);
    if (envelope.discord?.channelName) tags.push(envelope.discord.channelName);
    if (envelope.x?.tweetId) tags.push(`x:tweet:${envelope.x.tweetId}`);
    if (envelope.conversationId) tags.push(`conversation:${envelope.conversationId}`);
    if (envelope.metadata?.sessionId) tags.push(`web:session:${String(envelope.metadata.sessionId)}`);
    return tags;
  }

  deriveWorldTags(envelope: RequestEnvelope): string[] {
    const tags: string[] = [];
    if (envelope.minecraft?.serverId) tags.push(`minecraft:server:${envelope.minecraft.serverId}`);
    if (envelope.minecraft?.serverName) tags.push(`minecraft:server_name:${envelope.minecraft.serverName}`);
    if (envelope.minecraft?.worldId) tags.push(`minecraft:world:${envelope.minecraft.worldId}`);
    if (envelope.minecraft?.dimension) tags.push(`minecraft:dimension:${envelope.minecraft.dimension}`);
    return tags;
  }

  deriveProjectTags(envelope: RequestEnvelope): string[] {
    const rawTags = envelope.metadata?.projectTags;
    if (!Array.isArray(rawTags)) return [];
    return rawTags.map((tag) => String(tag));
  }

  channelToPlatform(channel: ShannonChannel): MemoryPlatform | null {
    const map: Partial<Record<ShannonChannel, MemoryPlatform>> = {
      discord: 'discord',
      x: 'twitter',
      minecraft: 'minebot',
      youtube: 'youtube',
    };
    return map[channel] ?? null;
  }
}
