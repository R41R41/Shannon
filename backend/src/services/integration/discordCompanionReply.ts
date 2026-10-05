import type { RequestEnvelope } from '@shannon/common';
import type { DiscordConversationPort } from '../../modules/conversation/discordConversation.js';
import { createRequestDiscordConversation } from '../common/discordConversationPort.js';
import { requestShannonCoreDiscordReply } from './configuredShannonCoreBridge.js';
import type { ShannonCoreReplyResult } from './shannonCoreBridge.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('ShannonCoreReply', 'discord');

export type DiscordCompanionReplyOutcome =
  /** Her reply came from the companion and was sent to the current conversation. */
  | 'answered'
  /** Not eligible, switched off, or the companion failed: the legacy path answers as before. */
  | 'fallback'
  /** The companion answered (and kept the turn) but sending failed: not retried and not answered again by the legacy path. */
  | 'send_failed';

export interface DiscordCompanionReplyDependencies {
  requestReply(envelope: RequestEnvelope): Promise<ShannonCoreReplyResult>;
  conversation(envelope: RequestEnvelope): Pick<DiscordConversationPort, 'reply'>;
}

const configuredDependencies: DiscordCompanionReplyDependencies = {
  requestReply: requestShannonCoreDiscordReply,
  conversation: envelope => createRequestDiscordConversation(envelope),
};

/**
 * Phase 5a of "one mind, many bodies" (`docs/refactor-discord-conversation.md`). With `SHANNON_CORE_PLATFORM_REPLY=true`
 * a Discord text message in a bound conversation is answered by the companion's `POST /v1/platform/reply`: her memory,
 * mood and history, and in the owner's private DM her tools (a request to her Minecraft body). Everything else (unbound
 * conversations, switched off, voice, attachments, a companion failure) returns `fallback` and the legacy graph answers.
 * The reply goes out through the same request-bound conversation port as every Discord text reply, and the turn is not
 * mirrored again: the companion already kept it.
 */
export async function answerDiscordFromCompanion(
  envelope: RequestEnvelope,
  dependencies: DiscordCompanionReplyDependencies = configuredDependencies,
): Promise<DiscordCompanionReplyOutcome> {
  let result: ShannonCoreReplyResult;
  try {
    result = await dependencies.requestReply(envelope);
  } catch {
    result = { status: 'unavailable' };
  }
  if (result.status !== 'available') {
    if (result.status === 'unavailable') logger.warn('companion reply unavailable; using legacy reply path');
    return 'fallback';
  }
  const sent = await dependencies.conversation(envelope).reply({ message: result.reply });
  if (sent.status === 'sent') return 'answered';
  logger.warn(`companion reply not sent: ${sent.status}`);
  return 'send_failed';
}
