/**
 * Factory utility for creating RequestEnvelope instances.
 *
 * Provides a standardized way to construct envelopes with
 * sensible defaults, ensuring all required fields are populated.
 */

import {
  RequestEnvelope,
  ShannonChannel,
  DiscordContext,
  XContext,
  MinecraftContext,
  YoutubeContext,
  RequestAttachment,
} from '@shannon/common';

/** Minimal input required to create an envelope. */
export interface EnvelopeInput {
  channel: ShannonChannel;
  sourceUserId: string;
  sourceDisplayName?: string;
  conversationId?: string;
  threadId?: string;
  text?: string;
  attachments?: RequestAttachment[];
  tags?: string[];
  metadata?: Record<string, unknown>;

  // Channel-specific context (at most one should be set)
  discord?: DiscordContext;
  x?: XContext;
  minecraft?: MinecraftContext;
  youtube?: YoutubeContext;
}

/**
 * Create a fully-populated RequestEnvelope from minimal input.
 *
 * - Generates requestId (UUID v4)
 * - Generates conversationId / threadId if not provided
 * - Sets timestampIso to now
 * - Ensures tags array is never undefined
 */
export function createEnvelope(input: EnvelopeInput): RequestEnvelope {
  const requestId = crypto.randomUUID();
  const now = new Date().toISOString();

  // Build a default conversationId from channel + userId if not provided
  const conversationId =
    input.conversationId ?? `${input.channel}:${input.sourceUserId}`;

  // threadId defaults to conversationId (1 conversation = 1 thread unless overridden)
  const threadId = input.threadId ?? conversationId;

  // Auto-generate channel tag
  const baseTags = [input.channel];
  const tags = input.tags
    ? [...baseTags, ...input.tags.filter((t) => t !== input.channel)]
    : baseTags;

  return {
    requestId,
    channel: input.channel,
    sourceUserId: input.sourceUserId,
    sourceDisplayName: input.sourceDisplayName,
    conversationId,
    threadId,
    text: input.text,
    attachments: input.attachments,
    discord: input.discord,
    x: input.x,
    minecraft: input.minecraft,
    youtube: input.youtube,
    metadata: input.metadata,
    tags,
    timestampIso: now,
  };
}
