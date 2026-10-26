import type { RequestEnvelope } from '@shannon/common';

/**
 * One head (owner 2026-10-20, `SHANNON_ONE_HEAD`): this runtime is Shannon's ears and mouth on Discord, and her one mind (the head,
 * shannon-ios `POST /v1/converse`) decides what she says. Every turn goes there in one shape (who said what where, in voice or text,
 * before whom); the head answers with one stream of lines (`decision`, `expression`, `sentence`, `intent`, `done`, `error`). The head
 * decides who is present (bound or not, the owner's or anyone's); this runtime's own model answers only when the head cannot.
 * Contract: shannon-ios `docs/one-head-contract.md`.
 */
export const ONE_HEAD_CONVERSE_PATH = '/v1/converse';

export interface ConverseTurn {
  version: 1;
  requestId: string;
  observedAt: string;
  modality: 'voice' | 'text';
  where: { platform: 'discord'; conversationId: string; conversationKind: 'channel' | 'dm'; title?: string; voiceChannelId?: string };
  who: { userId: string; displayName: string };
  presence: {
    participants: string[];
    heard?: Array<{ userId: string; name: string; text: string; at: string }>;
    followsShannonTurn?: boolean;
    speakingNow?: boolean;
    /** Ms since she last finished speaking (0: speaking now): the head's follow-up window (SHANNON_ADDRESSED). */
    shannonSpokeMsAgo?: number;
    situation?: string;
  };
  words: string;
  voice?: { fillerId?: string; sttMs?: number; utteranceMs?: number };
}

const DISCORD_FILE = /https?:\/\/(?:cdn|media)\.discordapp\.(?:com|net)\/\S+/giu;

function text(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum && !value.includes('\0');
}

/**
 * A Discord message's words for the head: text only, so a file or image link is said to be there instead of being sent (the head reads
 * no attachment); null for what this runtime handles itself (its own clarification follow-up for an agent task).
 */
export function converseWords(raw: string): string | null {
  if (raw.trimStart().startsWith('[追加要件への回答]')) return null;
  const words = raw.replace(DISCORD_FILE, '（画像）').trim();
  return words ? words.slice(0, 8_000) : null;
}

/** A typed Discord message in the one shape, or null when this runtime answers it itself (voice, malformed, its own follow-up). */
export function converseTextTurn(envelope: RequestEnvelope): ConverseTurn | null {
  const requestId = envelope.discord?.messageId ?? envelope.requestId;
  if (envelope.channel !== 'discord' || envelope.discord?.isVoiceChannel === true) return null;
  if (!text(requestId, 160) || !text(envelope.conversationId, 240) || !text(envelope.sourceUserId, 160)) return null;
  if (!Number.isFinite(Date.parse(envelope.timestampIso))) return null;
  const words = converseWords(envelope.text ?? '');
  if (!words) return null;
  const name = (envelope.sourceDisplayName ?? envelope.discord?.userName ?? '').trim().slice(0, 80) || 'Discordの人';
  const title = (envelope.discord?.channelName ?? '').trim().slice(0, 80);
  const dm = envelope.discord?.isDM === true;
  return {
    version: 1, requestId: requestId.trim(), observedAt: new Date(envelope.timestampIso).toISOString(), modality: 'text',
    where: { platform: 'discord', conversationId: envelope.conversationId.trim(), conversationKind: dm ? 'dm' : 'channel', ...(title && !dm ? { title } : {}) },
    who: { userId: envelope.sourceUserId.trim(), displayName: name },
    presence: { participants: [envelope.sourceUserId.trim()] },
    words,
  };
}

/**
 * The answer's last lines read from an NDJSON body: the reply ('' when she had nothing to say), or null without a `done` line. `reaction`
 * (the head's rich chat §4) is the emoji she puts on the message she answered; anything but a short string is none.
 */
export function converseAnswer(body: string): { reply: string; threadId: string; duplicate: boolean; reaction?: string } | null {
  for (const line of body.split('\n')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const row = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
    if (row.type === 'error') return null;
    if (row.type !== 'done') continue;
    return {
      reply: typeof row.reply === 'string' ? row.reply.trim() : '',
      threadId: typeof row.threadId === 'string' ? row.threadId : '',
      duplicate: row.duplicate === true,
      ...withReaction(row.reaction),
    };
  }
  return null;
}

/** Her reaction as the head sent it: one emoji (at most 32 code units, no whitespace or markup), or nothing. */
export function converseReaction(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const emoji = value.trim();
  return emoji && emoji.length <= 32 && !/[\s<>:@#`]/u.test(emoji) ? emoji : null;
}

function withReaction(value: unknown): { reaction?: string } {
  const reaction = converseReaction(value);
  return reaction ? { reaction } : {};
}

/** `POST /v1/platform/reactions` (the head's one-head contract, "Reactions"): someone put an emoji on a message, or took it off. */
export const ONE_HEAD_REACTIONS_PATH = '/v1/platform/reactions';

export interface ConverseReaction {
  version: 1;
  platform: 'discord';
  conversationId: string;
  messageId: string;
  author: { userId: string; displayName?: string; shannon: boolean };
  excerpt?: string;
  actor: { userId: string; displayName: string };
  emoji: string;
  on: boolean;
  observedAt: string;
}

/** A reaction event in Discord, as this runtime reads it (`client.ts`). */
export interface DiscordReactionInput {
  guildId: string | null;
  channelId: string;
  messageId: string;
  authorId: string;
  authorName?: string;
  authorIsShannon: boolean;
  content?: string;
  actorId: string;
  actorName: string;
  /** A Unicode emoji (`name`), or a server's own emoji (`id` and its `name`, sent as `:name:`). */
  emoji: { name: string | null; id: string | null };
  on: boolean;
  at: Date;
}

/**
 * A reaction in the one shape, or null for what the head does not take: a DM (not delivered to the head today) or a malformed event.
 * Her own reactions are filtered out before this (`client.ts`). The message's words go cut to 200 characters, so the head can say
 * which message it was; a file or image link is said to be there.
 */
export function converseReactionBody(input: DiscordReactionInput): ConverseReaction | null {
  if (!input.guildId || !text(input.channelId, 160) || !text(input.messageId, 160) || !text(input.authorId, 160) || !text(input.actorId, 160)) return null;
  const emoji = input.emoji.id ? (input.emoji.name ? `:${input.emoji.name}:` : null) : input.emoji.name?.trim() || null;
  if (!emoji || emoji.length > 40 || !Number.isFinite(input.at.getTime())) return null;
  const words = (input.content ?? '').replace(DISCORD_FILE, '（画像）').replace(/\s+/gu, ' ').trim().slice(0, 200);
  const authorName = (input.authorName ?? '').trim().slice(0, 80);
  return {
    version: 1, platform: 'discord', conversationId: `discord:${input.guildId}:${input.channelId}`, messageId: input.messageId,
    author: { userId: input.authorId, ...(authorName ? { displayName: authorName } : {}), shannon: input.authorIsShannon },
    ...(words ? { excerpt: words } : {}),
    actor: { userId: input.actorId, displayName: input.actorName.trim().slice(0, 80) || 'Discordの人' },
    emoji, on: input.on, observedAt: input.at.toISOString(),
  };
}
