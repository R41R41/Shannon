/**
 * Web Channel Adapter
 *
 * Converts Web UI messages into RequestEnvelopes.
 */

import {
  RequestEnvelope,
  ChannelAdapter,
} from '@shannon/common';
import { createEnvelope } from './envelopeFactory.js';

/**
 * Shape of a web text input event.
 */
export interface WebNativeEvent {
  type: 'text' | 'realtime_text' | 'realtime_audio' | 'command';
  text?: string;
  realtimeText?: string;
  senderName?: string;
  recentChatLog?: string;
  sessionId?: string;
  sourceUserId?: string;
}

export const webAdapter: ChannelAdapter<WebNativeEvent> = {
  channel: 'web',

  toEnvelope(event: WebNativeEvent): RequestEnvelope {
    const text = event.text ?? event.realtimeText ?? '';
    const tags: string[] = [event.type];
    const sessionId = event.sessionId ?? 'web-default';
    const sourceUserId = event.sourceUserId ?? `web-user:${sessionId}`;

    return createEnvelope({
      channel: 'web',
      sourceUserId,
      sourceDisplayName: event.senderName,
      conversationId: `web:${sessionId}`,
      threadId: `web:${sessionId}`,
      text,
      tags,
      metadata: {
        sessionId,
        recentChatLog: event.recentChatLog,
        inputType: event.type,
        legacyMemoryZone: 'web',
      },
    });
  },
};
