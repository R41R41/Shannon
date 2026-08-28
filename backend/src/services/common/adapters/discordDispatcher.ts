/**
 * Discord Action Dispatcher
 *
 * Sends ShannonActionPlans back to Discord channels.
 * Complements the FCA tool-based dispatch (chat-on-discord)
 * with a structured action plan dispatch path.
 */

import type {
  RequestEnvelope,
  ShannonActionPlan,
  ActionDispatcher,
  DiscordAction,
  MemoryZone,
} from '@shannon/common';
import { getEventBus } from '../../eventBus/index.js';
import { createRequestDiscordConversation } from '../discordConversationPort.js';
import { createLogger } from '../../../utils/logger.js';
const logger = createLogger('DiscordDispatcher', 'discord');

export const discordDispatcher: ActionDispatcher = {
  channel: 'discord',

  async dispatch(envelope: RequestEnvelope, plan: ShannonActionPlan, options?: { signal?: AbortSignal }): Promise<void> {
    if (envelope.channel !== 'discord' || (plan.channel && plan.channel !== 'discord')) throw new Error('Discord channel mismatch');
    if (envelope.discord?.isVoiceChannel !== true) {
      const port = createRequestDiscordConversation(envelope, options?.signal);
      const actions = plan.discordActions ?? [];
      // Validate all action kinds before sending the first message. No arbitrary destinations or attachments.
      if (actions.some(a => a.type !== 'reply' && a.type !== 'send_embed')) throw new Error('Unsupported Discord text action');
      const messages = actions.length ? actions.map(a => a.type === 'send_embed' ? `## ${a.title}\n\n${a.body}` : a.type === 'reply' ? a.text : '') : plan.message ? [plan.message] : [];
      if (messages.some(m => !m.trim() || m.length > 12000)) throw new Error('Invalid Discord text reply');
      for (const message of messages) {
        const result = await port.reply({ message });
        if (result.status !== 'sent') throw new Error(result.message);
      }
      return;
    }
    // Legacy voice dispatch remains separate; text must never enter its channel-wide interception path.
    const eventBus = getEventBus();
    const channelId = envelope.discord?.channelId;
    const guildId = envelope.discord?.guildId;

    if (!channelId || !guildId) {
      logger.warn('[DiscordDispatcher] Missing channelId/guildId in envelope, cannot dispatch');
      return;
    }

    // Process each Discord action
    const actions = plan.discordActions ?? [];
    for (const action of actions) {
      await dispatchAction(eventBus, envelope, action);
    }

    // Fallback: if no explicit actions but has a message, send as reply
    if (actions.length === 0 && plan.message) {
      eventBus.publish({
        type: 'discord:post_message',
        memoryZone: `discord:${envelope.discord?.guildName ?? 'unknown'}` as MemoryZone,
        data: {
          channelId,
          guildId,
          text: plan.message,
          imageUrl: '',
        },
      });
    }
  },
};

async function dispatchAction(
  eventBus: ReturnType<typeof getEventBus>,
  envelope: RequestEnvelope,
  action: DiscordAction,
): Promise<void> {
  const channelId = envelope.discord?.channelId;
  const guildId = envelope.discord?.guildId;
  if (!channelId || !guildId) {
    logger.warn('[DiscordDispatcher] Missing channelId/guildId in envelope action dispatch');
    return;
  }
  const memoryZone = `discord:${envelope.discord?.guildName ?? 'unknown'}` as MemoryZone;

  switch (action.type) {
    case 'reply':
      eventBus.publish({
        type: 'discord:post_message',
        memoryZone,
        data: {
          channelId,
          guildId,
          text: action.text,
          imageUrl: '',
        },
      });
      break;

    case 'react':
      break;

    case 'send_embed':
      eventBus.publish({
        type: 'discord:post_message',
        memoryZone,
        data: {
          channelId,
          guildId,
          text: `## ${action.title}\n\n${action.body}`,
          imageUrl: '',
        },
      });
      break;

    case 'voice_speak':
      eventBus.publish({
        type: 'discord:post_message',
        memoryZone,
        data: {
          guildId,
          channelId,
          text: action.text,
          imageUrl: '',
        },
      });
      break;
  }
}
