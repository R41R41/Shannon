import { ChannelType, PermissionFlagsBits, type Client } from 'discord.js';
import { ConversationDeniedError, hasDiscordConversation, discordId, type DiscordConversationBinding, type DiscordHistoryEntry } from '../../modules/conversation/discordConversation.js';
import type { DiscordConversationTransport } from '../common/discordConversationPort.js';
import { deliverDiscordPlanning, listGuildEmojis, reactToMessage } from './planningDelivery.js';
import type { TaskTreeState } from '@shannon/common';

/** SDK boundary: recheck destination and current permissions before every I/O. */
export function createDiscordConversationTransport(client: Client, isRunning: () => boolean): DiscordConversationTransport {
  function check(binding: DiscordConversationBinding, history: boolean, signal?: AbortSignal) {
    if (!hasDiscordConversation(binding) || !isRunning() || signal?.aborted || !client.user) throw new ConversationDeniedError();
    // A received message's channel must already be known. Missing cache/member state fails closed.
    const channel = client.channels.cache.get(binding.channelId);
    if (!channel || channel.id !== binding.channelId || !channel.isTextBased() || !('send' in channel) || !('messages' in channel)) throw new ConversationDeniedError();
    if (binding.isDM) {
      if (channel.type !== ChannelType.DM || channel.recipientId !== binding.subjectId) throw new ConversationDeniedError();
    } else {
      if (!('guildId' in channel) || channel.guildId !== binding.guildId || !('permissionsFor' in channel)) throw new ConversationDeniedError();
      const actor = channel.permissionsFor(binding.subjectId), bot = channel.permissionsFor(client.user);
      if (channel.type === ChannelType.PrivateThread && (!channel.members.cache.has(binding.subjectId)
          || !channel.members.cache.has(client.user.id))) throw new ConversationDeniedError();
      if (!actor?.has(PermissionFlagsBits.ViewChannel) || !bot?.has(PermissionFlagsBits.ViewChannel)) throw new ConversationDeniedError();
      const required = history ? PermissionFlagsBits.ReadMessageHistory
        : channel.isThread() ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages;
      if (!bot.has(required) || (history && !actor.has(PermissionFlagsBits.ReadMessageHistory))) throw new ConversationDeniedError();
    }
    return channel;
  }
  return Object.freeze({
    async reply(binding, message, signal) {
      if (typeof message !== 'string' || !message.trim() || message.length > 12000) throw new ConversationDeniedError();
      let sent = false;
      for (let i = 0; i < message.length; i += 2000) {
        let channel;
        try { channel = check(binding, false, signal); }
        catch (error) { if (sent) throw new Error('Partial delivery; no automatic retry'); throw error; }
        await channel.send({ content: message.slice(i, i + 2000), allowedMentions: { parse: [], repliedUser: false } });
        sent = true;
      }
      signal?.throwIfAborted(); // Already-sent network effects cannot be undone.
    },
    async recent(binding, limit, signal) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 30) throw new ConversationDeniedError();
      const channel = check(binding, true, signal);
      const messages = await channel.messages.fetch({ limit, before: binding.messageId });
      check(binding, true, signal);
      const rows: DiscordHistoryEntry[] = [];
      for (const msg of messages.values()) {
        if (msg.channelId !== binding.channelId || (msg.guildId ?? '') !== binding.guildId
            || !discordId(msg.id) || !discordId(msg.author?.id) || BigInt(msg.id) >= BigInt(binding.messageId)
            || typeof msg.content !== 'string' || !Number.isFinite(msg.createdTimestamp)) continue;
        rows.push(Object.freeze({ messageId: msg.id, authorId: msg.author.id, text: msg.content.slice(0, 4000), timestamp: msg.createdTimestamp }));
      }
      return Object.freeze(rows.sort((a, b) => a.timestamp - b.timestamp).slice(-limit));
    },
    async react(binding, messageId, emojiId, signal) {
      check(binding, false, signal);
      const result = await reactToMessage(client, binding, messageId, emojiId);
      if (!result.isSuccess) throw new ConversationDeniedError();
      signal?.throwIfAborted();
    },
    async listEmojis(binding, signal) {
      check(binding, false, signal);
      if (!binding.guildId) throw new ConversationDeniedError();
      return listGuildEmojis(client, binding.guildId);
    },
    async publishPlanning(binding, planning, taskId, signal) {
      check(binding, false, signal);
      await deliverDiscordPlanning(client, binding, planning as TaskTreeState, taskId, isRunning);
      signal?.throwIfAborted();
    },
  } satisfies DiscordConversationTransport);
}
