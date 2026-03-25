/**
 * RequestEnvelope and channel-specific context types.
 */

import type { ShannonChannel } from './channels.js';

/** Attachment included with a request. */
export interface RequestAttachment {
  type: 'image' | 'audio' | 'video' | 'file';
  url?: string;
  data?: string;          // base64 for inline data
  mimeType?: string;
  filename?: string;
}

/** Minecraft-specific context snapshot at request time. */
export interface MinecraftContext {
  serverId?: string;
  serverName?: string;
  worldId?: string;
  dimension?: string;     // overworld, nether, end
  biome?: string;
  position?: { x: number; y: number; z: number };
  health?: number;
  food?: number;
  nearbyEntities?: string[];
  inventory?: Array<{ name: string; count: number }>;
  nearbyInfrastructure?: Array<{ name: string; x: number; y: number; z: number; distance: number }>;
  /** 半径 32 ブロック以内の資源ブロック（木材等）のサマリー。CraftPreflight が代替素材を選択するために使用。 */
  nearbyResources?: Array<{ name: string; count: number }>;
  eventType?:
    | 'chat'
    | 'mentioned'
    | 'attacked'
    | 'observed'
    | 'task_result'
    | 'death'
    | 'system';
}

/** Discord-specific context. */
export interface DiscordContext {
  guildId?: string;
  guildName?: string;
  channelId?: string;
  channelName?: string;
  messageId?: string;
  isVoiceChannel?: boolean;
  isDM?: boolean;
}

/** X (Twitter)-specific context. */
export interface XContext {
  tweetId?: string;
  conversationId?: string;
  authorId?: string;
  authorName?: string;
  isReply?: boolean;
  isQuote?: boolean;
  isMention?: boolean;
}

/** YouTube-specific context. */
export interface YoutubeContext {
  videoId?: string;
  channelId?: string;
  commentId?: string;
  liveId?: string;
}

/**
 * Normalized input envelope from any channel.
 *
 * Every channel adapter converts its native event into this shape
 * before handing off to the unified graph.
 */
export interface RequestEnvelope {
  /** Unique ID for this request (UUID v4). */
  requestId: string;

  // -- source identification --
  channel: ShannonChannel;
  sourceUserId: string;
  sourceDisplayName?: string;

  // -- session / thread tracking --
  /** Logical conversation ID (persists across multiple messages in a thread). */
  conversationId: string;
  /** Thread ID for checkpointer (channel + conversation scoped). */
  threadId: string;

  // -- raw input --
  text?: string;
  attachments?: RequestAttachment[];

  // -- channel-specific context --
  minecraft?: MinecraftContext;
  discord?: DiscordContext;
  x?: XContext;
  youtube?: YoutubeContext;

  // -- generic metadata --
  metadata?: Record<string, unknown>;

  // -- tags for recall & routing --
  tags: string[];

  // -- timing --
  timestampIso: string;
}
