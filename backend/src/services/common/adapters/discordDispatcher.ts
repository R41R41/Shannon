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
} from '@shannon/common';
import { getDiscordOutboundPort } from '../../runtime/discordOutboundGateway.js';
import { createRequestDiscordConversation } from '../discordConversationPort.js';
import { authorizeDiscordVoiceOutbound } from '../../discord/discordVoiceSession.js';
import { mirrorCompletedDiscordTurn } from '../../integration/configuredShannonCoreBridge.js';
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
      if (actions.some(a => a.type !== 'reply' && a.type !== 'send_embed' && a.type !== 'send_artifact')) throw new Error('Unsupported Discord text action');
      const normalizedActions = actions.length ? actions : plan.message ? [{ type: 'reply' as const, text: plan.message }] : [];
      for (const action of normalizedActions) {
        const result = action.type === 'send_artifact'
          ? await port.replyWithArtifacts({ message: action.text, artifactIds: action.artifactIds })
          : await port.reply({ message: action.type === 'send_embed' ? `## ${action.title}\n\n${action.body}` : action.text });
        if (result.status !== 'sent') throw new Error(result.message);
      }
      if (normalizedActions.length) {
        const mirroredReply = normalizedActions.map(action =>
          action.type === 'send_embed' ? `## ${action.title}\n\n${action.body}` : action.text,
        ).join('\n\n');
        void mirrorCompletedDiscordTurn(envelope, mirroredReply).catch(error => {
          const code = error instanceof Error ? error.name : 'UnknownError';
          logger.warn(`[ShannonCoreBridge] mirror skipped: ${code}`);
        });
      }
      return;
    }
    // Legacy voice dispatch remains separate; text must never enter its channel-wide interception path.
    const outbound = getDiscordOutboundPort();
    const channelId = envelope.discord?.channelId;
    const guildId = envelope.discord?.guildId;

    if (!channelId || !guildId) {
      logger.warn('[DiscordDispatcher] Missing channelId/guildId in envelope, cannot dispatch');
      return;
    }
    if (!authorizeDiscordVoiceOutbound({ guildId, channelId })) {
      logger.warn('[DiscordDispatcher] No active voice session for outbound voice dispatch');
      return;
    }

    // Process each Discord action
    const actions = plan.discordActions ?? [];
    for (const action of actions) {
      await dispatchAction(outbound, envelope, action);
    }

    // Fallback: if no explicit actions but has a message, send as reply
    if (actions.length === 0 && plan.message) {
      await outbound.postMessage({
        channelId,
        guildId,
        text: plan.message,
        imageUrl: '',
      });
    }
  },
};

async function dispatchAction(
  outbound: ReturnType<typeof getDiscordOutboundPort>,
  envelope: RequestEnvelope,
  action: DiscordAction,
): Promise<void> {
  const channelId = envelope.discord?.channelId;
  const guildId = envelope.discord?.guildId;
  if (!channelId || !guildId) {
    logger.warn('[DiscordDispatcher] Missing channelId/guildId in envelope action dispatch');
    return;
  }

  switch (action.type) {
    case 'reply':
      await outbound.postMessage({
        channelId,
        guildId,
        text: action.text,
        imageUrl: '',
      });
      break;

    case 'react':
      break;

    case 'send_embed':
      await outbound.postMessage({
        channelId,
        guildId,
        text: `## ${action.title}\n\n${action.body}`,
        imageUrl: '',
      });
      break;

    case 'send_artifact':
      throw new Error('Artifacts may only be sent through a request-bound Discord text conversation');

    case 'voice_speak':
      await outbound.postMessage({
        guildId,
        channelId,
        text: action.text,
        imageUrl: '',
      });
      break;
  }
}
