import type { Client, Message, MessageReaction, PartialMessage, PartialMessageReaction, PartialUser, User } from 'discord.js';
import type { DiscordReactionInput } from '../integration/oneHeadConverse.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('Discord:Reactions');

/** What the relay asks of the bot: the same filters a message passes (`client.ts`), and where an event goes. */
export interface ReactionRelayOptions {
  isRunning(): boolean;
  skipGuild(guildId: string | null): boolean;
  /** The bot's own message rule for this place; a reaction on her own message counts as being spoken to. */
  accepts(input: { guildId: string; channelId: string; onHerMessage: boolean }): boolean;
  nickname(user: User, guildId: string): string;
  send(input: DiscordReactionInput): Promise<void>;
  now?(): Date;
}

/**
 * Someone put an emoji on a message, or took it off (the head's rich chat §4): the event goes to the head, which tells her next turn
 * in that conversation. Her own reactions and other bots' are not sent; places the bot does not read are not sent. Never throws.
 */
export function relayDiscordReactions(client: Pick<Client, 'on' | 'user'>, options: ReactionRelayOptions): void {
  const handle = (on: boolean) => async (reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser): Promise<void> => {
    try {
      const input = await reactionInput(client, options, reaction, user, on);
      if (input) await options.send(input);
    } catch (error) {
      logger.warn(`[Discord] reaction not relayed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  client.on('messageReactionAdd', handle(true));
  client.on('messageReactionRemove', handle(false));
}

/** The event as the head takes it, or null when it is not sent. Exported for tests. */
export async function reactionInput(
  client: Pick<Client, 'user'>, options: ReactionRelayOptions, reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser, on: boolean,
): Promise<DiscordReactionInput | null> {
  if (!options.isRunning()) return null;
  const herId = client.user?.id;
  if (!herId || user.id === herId) return null;
  // A removed reaction may no longer be fetchable; its emoji is in the event, so only the message is read.
  let message: Message | PartialMessage = reaction.message;
  if (message.partial) message = await message.fetch();
  const guildId = message.guildId;
  if (!guildId || options.skipGuild(guildId)) return null;
  const author = message.author;
  if (!author) return null;
  const onHerMessage = author.id === herId;
  if (!options.accepts({ guildId, channelId: message.channelId, onHerMessage })) return null;
  const actor = user.partial ? await user.fetch() : user;
  if (actor.bot) return null;
  return {
    guildId, channelId: message.channelId, messageId: message.id,
    authorId: author.id, authorName: onHerMessage ? undefined : options.nickname(author, guildId), authorIsShannon: onHerMessage,
    content: message.content ?? '',
    actorId: actor.id, actorName: options.nickname(actor, guildId),
    emoji: { name: reaction.emoji.name ?? null, id: reaction.emoji.id ?? null },
    on, at: options.now?.() ?? new Date(),
  };
}
