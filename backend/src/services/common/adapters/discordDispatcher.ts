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
import { createLogger } from '../../../utils/logger.js';
const logger = createLogger('DiscordDispatcher', 'discord');

export const discordDispatcher: ActionDispatcher = {
  channel: 'discord',

  async dispatch(envelope: RequestEnvelope, plan: ShannonActionPlan): Promise<void> {
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
