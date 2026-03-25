/**
 * Minebot Channel Adapter
 *
 * Converts Minecraft bot events into RequestEnvelopes.
 */

import {
  RequestEnvelope,
  ChannelAdapter,
  MinecraftContext,
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
  botHeldItem?: string;
  lookingAt?: string;
  inventory?: Array<{ name: string; count: number }>;

  // Nearby entities
  nearbyEntities?: string[];

  // Event classification
  eventType?: 'chat' | 'mentioned' | 'attacked' | 'observed' | 'task_result' | 'death' | 'system';

  // Emergency flag
  isEmergency?: boolean;
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

    const minecraft: MinecraftContext = {
      serverName: event.serverName,
      dimension: event.dimension,
      biome: event.biome,
      position: event.botPosition,
      health: event.botHealth,
      food: event.botFoodLevel,
      nearbyEntities: event.nearbyEntities,
      inventory: event.inventory,
      eventType: event.eventType ?? 'chat',
    };

    return createEnvelope({
      channel: 'minecraft',
      sourceUserId: event.senderId ?? event.senderName,
      sourceDisplayName: event.senderName,
      conversationId: `minecraft:${event.serverName ?? 'default'}:${event.senderName}`,
      threadId: `minecraft:${event.serverName ?? 'default'}`,
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
