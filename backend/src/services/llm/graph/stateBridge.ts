/**
 * State Bridge
 *
 * Minimal conversion layer for nodes that still need legacy types.
 *
 * Remaining functions:
 * - envelopeToTaskContext: for EmotionNode, FCA (accept TaskContext)
 * - envelopeToMemoryZone: for EventBus log zone derivation
 * - inferInitialMode: for ingest node
 *
 * Channel adapters now create RequestEnvelopes directly —
 * taskInputToEnvelope has been removed.
 */

import {
  TaskContext,
  MemoryZone,
} from '@shannon/common';
import type {
  Platform,
  RequestEnvelope,
  ShannonChannel,
  ShannonMode,
} from '@shannon/common';

// ---------------------------------------------------------------------------
// Channel → Platform mapping (used by envelopeToTaskContext)
// ---------------------------------------------------------------------------

const channelToPlatform: Record<ShannonChannel, Platform> = {
  discord: 'discord',
  x: 'twitter',
  minecraft: 'minebot',
  web: 'web',
  youtube: 'youtube',
  scheduler: 'web',
  notion: 'notion',
  internal: 'web',
};

/**
 * Extract a legacy TaskContext from a RequestEnvelope.
 * Used by EmotionNode and FCA which still accept TaskContext.
 */
export function envelopeToTaskContext(envelope: RequestEnvelope): TaskContext {
  const platform = channelToPlatform[envelope.channel] ?? 'web';
  const ctx: TaskContext = { platform };

  if (envelope.discord) {
    ctx.discord = {
      guildId: envelope.discord.guildId,
      guildName: envelope.discord.guildName,
      channelId: envelope.discord.channelId,
      channelName: envelope.discord.channelName,
      messageId: envelope.discord.messageId,
    };
  }

  if (envelope.x) {
    ctx.twitter = {
      tweetId: envelope.x.tweetId,
      authorId: envelope.x.authorId,
      authorName: envelope.x.authorName,
    };
  }

  if (envelope.youtube) {
    ctx.youtube = {
      videoId: envelope.youtube.videoId,
      channelId: envelope.youtube.channelId,
      commentId: envelope.youtube.commentId,
      liveId: envelope.youtube.liveId,
    };
  }

  ctx.conversationId = envelope.conversationId;
  ctx.metadata = {
    ...envelope.metadata,
    envelopeChannel: envelope.channel,
    envelopeTags: envelope.tags,
    minecraft: envelope.minecraft,
  };
  return ctx;
}

/**
 * Derive a legacy MemoryZone from a RequestEnvelope.
 */
export function envelopeToMemoryZone(envelope: RequestEnvelope): MemoryZone {
  const legacy = envelope.metadata?.legacyMemoryZone as string | undefined;

  switch (envelope.channel) {
    case 'discord':
      return `discord:${legacy ?? envelope.discord?.guildName ?? 'unknown'}` as MemoryZone;
    case 'x':
      return 'twitter:post' as MemoryZone;
    case 'minecraft':
      return 'minebot' as MemoryZone;
    case 'web':
      return 'web' as MemoryZone;
    case 'youtube':
      return 'youtube' as MemoryZone;
    default:
      return 'web' as MemoryZone;
  }
}

/**
 * Infer the initial ShannonMode from a RequestEnvelope.
 */
export function inferInitialMode(envelope: RequestEnvelope): ShannonMode {
  if (envelope.channel === 'minecraft') {
    if (envelope.tags.includes('emergency') || envelope.minecraft?.eventType === 'death') {
      return 'minecraft_emergency';
    }
    if (envelope.minecraft?.eventType === 'attacked') {
      return 'minecraft_emergency';
    }
    return 'minecraft_action';
  }

  if (envelope.channel === 'x') {
    return 'broadcast';
  }

  if (envelope.tags.includes('voice_channel')) {
    return 'voice_conversation';
  }

  return 'conversational';
}
