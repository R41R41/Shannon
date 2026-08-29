import type { WebConversationBinding } from '../../modules/conversation/webConversation.js';
import type { WebConversationTransport } from '../common/webConversationPort.js';
import { registerWebConversationTransport } from '../common/webConversationPort.js';
import { getWebNotificationHub } from './webNotificationHub.js';

export function createWebConversationTransport(): WebConversationTransport {
  const hub = getWebNotificationHub();
  return Object.freeze({
    async postMessage(binding: WebConversationBinding, message: string) {
      hub.emitPostMessage({
        type: 'text',
        text: message,
        sessionId: binding.sessionId,
        conversationId: binding.conversationId,
      });
    },
    async publishPlanning(binding: WebConversationBinding, planning: unknown, taskId: string) {
      hub.emitPlanning({
        ...(planning as Record<string, unknown>),
        sessionId: binding.sessionId,
        conversationId: binding.conversationId,
        taskId,
      });
    },
  });
}

export function registerDefaultWebConversationTransport(): void {
  registerWebConversationTransport(createWebConversationTransport());
}
