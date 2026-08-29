import type { EventBus } from '../eventBus/eventBus.js';
import type { WebConversationBinding } from '../../modules/conversation/webConversation.js';
import type { WebConversationTransport } from '../common/webConversationPort.js';
import { registerWebConversationTransport } from '../common/webConversationPort.js';

/** EventBus is an implementation detail; callers must go through the request-bound port. */
export function createEventBusWebConversationTransport(eventBus: EventBus): WebConversationTransport {
  return Object.freeze({
    async postMessage(binding: WebConversationBinding, message: string) {
      eventBus.publish({
        type: 'web:post_message',
        memoryZone: 'web',
        data: {
          type: 'text',
          text: message,
          sessionId: binding.sessionId,
          conversationId: binding.conversationId,
        } as never,
        targetMemoryZones: ['web'],
      });
    },
    async publishPlanning(binding: WebConversationBinding, planning: unknown, taskId: string) {
      eventBus.publish({
        type: 'web:planning',
        memoryZone: 'web',
        data: {
          ...(planning as Record<string, unknown>),
          sessionId: binding.sessionId,
          conversationId: binding.conversationId,
          taskId,
        } as never,
        targetMemoryZones: ['web'],
      });
    },
  });
}

export function registerDefaultWebConversationTransport(eventBus: EventBus): void {
  registerWebConversationTransport(createEventBusWebConversationTransport(eventBus));
}
