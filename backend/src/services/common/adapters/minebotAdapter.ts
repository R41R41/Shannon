import { minecraftConversationKeys, normalizeMinecraftDimension } from '../../../modules/memory/minecraftIdentity.js';
/**
 * Minebot Channel Adapter
 *
 * Converts Minecraft bot events into RequestEnvelopes.
 */

import {
  RequestEnvelope,
  ChannelAdapter,
  MinecraftContext,
  type MinecraftInventoryEntry,
} from '@shannon/common';
import { createEnvelope } from './envelopeFactory.js';

/**
 * Shape of a minebot chat/event input.
 * Derived from the current SkillAgent.processMessage() parameters
 * and the bot's environmentState / selfState.
 */
export interface MinebotNativeEvent {
  senderName: string;
  senderId?: string;
  message: string;

  // Environment state
  serverName?: string;
  /** Explicit operator-owned identity, supplied by the connected bot runtime. */
  serverId?: string;
  worldId?: string;
  senderPosition?: { x: number; y: number; z: number };
  weather?: string;
  time?: string;
  biome?: string;
  dimension?: string;
  bossbar?: string;

  // Self state
  botPosition?: { x: number; y: number; z: number };
  botHealth?: number;
  botFoodLevel?: number;
  botExperienceLevel?: number;
  botTotalExperience?: number;
  botExperienceBarProgress?: number;
  botHeldItem?: string;
  lookingAt?: string;
  inventory?: MinecraftInventoryEntry[];

  // Nearby entities
  nearbyEntities?: string[];

  // Event classification
  eventType?: 'chat' | 'mentioned' | 'attacked' | 'observed' | 'task_result' | 'death' | 'system';

  // Emergency flag
  isEmergency?: boolean;

  // Active furnaces tracking
  activeFurnaces?: MinecraftContext['activeFurnaces'];
}

export const minebotAdapter: ChannelAdapter<MinebotNativeEvent> = {
  channel: 'minecraft',

  toEnvelope(event: MinebotNativeEvent): RequestEnvelope {
    const tags: string[] = [];
    if (event.serverName) tags.push(event.serverName);
    if (event.dimension) tags.push(event.dimension);
    if (event.biome) tags.push(event.biome);
    if (event.isEmergency) tags.push('emergency');
    if (event.eventType) tags.push(event.eventType);

    const dimension = normalizeMinecraftDimension(event.dimension) ?? undefined;
    const memoryKeys = minecraftConversationKeys({ serverId: event.serverId, worldId: event.worldId, dimension }, event.senderId ?? event.senderName);
    const minecraft: MinecraftContext = {
      serverId: event.serverId,
      worldId: event.worldId,
      serverName: event.serverName,
      dimension,
      biome: event.biome,
      position: event.botPosition,
      health: event.botHealth,
      food: event.botFoodLevel,
      experienceLevel: event.botExperienceLevel,
      totalExperience: event.botTotalExperience,
      experienceBarProgress: event.botExperienceBarProgress,
      nearbyEntities: event.nearbyEntities,
      inventory: event.inventory,
      activeFurnaces: event.activeFurnaces,
      eventType: event.eventType ?? 'chat',
    };

    return createEnvelope({
      channel: 'minecraft',
      sourceUserId: event.senderId ?? event.senderName,
      sourceDisplayName: event.senderName,
      conversationId: memoryKeys?.conversationId ?? `minecraft:unbound:${event.senderName}`,
      threadId: memoryKeys?.threadId ?? 'minecraft:unbound',
      text: event.message,
      tags,
      minecraft,
      metadata: {
        environmentState: JSON.stringify({
          senderName: event.senderName,
          senderPosition: event.senderPosition,
          weather: event.weather,
          time: event.time,
          biome: event.biome,
          dimension: event.dimension,
          bossbar: event.bossbar,
        }),
        selfState: JSON.stringify({
          botPosition: event.botPosition,
          botHealth: event.botHealth,
          botFoodLevel: event.botFoodLevel,
          botExperienceLevel: event.botExperienceLevel,
          botTotalExperience: event.botTotalExperience,
          botExperienceBarProgress: event.botExperienceBarProgress,
          botHeldItem: event.botHeldItem,
          lookingAt: event.lookingAt,
          inventory: event.inventory,
        }),
        isEmergency: event.isEmergency ?? false,
        legacyMemoryZone: 'minebot',
      },
    });
  },
};
