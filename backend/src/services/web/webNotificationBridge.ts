import type { ILog, OpenAIMessageOutput, OpenAITextInput, StatusAgentInput, ServiceOutput } from '@shannon/common';
import type { WebPlanningPayload, WebPostMessagePayload } from './webNotificationHub.js';
import { getLlmInbound } from '../runtime/llmInboundRegistry.js';

export function deliverWebMessageToLlm(message: OpenAIMessageOutput & { recentChatLog?: string[]; sessionId?: string }): void {
  void getLlmInbound().handleWebMessage(message);
}

export function matchesWebSession(
  payload: { sessionId?: string },
  sessionId: string,
): boolean {
  return !payload.sessionId || payload.sessionId === sessionId;
}

export type { WebPlanningPayload, WebPostMessagePayload, ILog, OpenAITextInput, StatusAgentInput, ServiceOutput };
