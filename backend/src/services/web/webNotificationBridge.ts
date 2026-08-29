import type { OpenAIMessageOutput } from '@shannon/common';
import { deliverWebMessageToLlm as dispatchWebMessageToLlm } from '../runtime/llmInboundDispatch.js';

export function deliverWebMessageToLlm(
  message: OpenAIMessageOutput & { recentChatLog?: string[]; sessionId?: string },
): void {
  dispatchWebMessageToLlm(message);
}

export function matchesWebSession(
  payload: { sessionId?: string },
  sessionId: string,
): boolean {
  return !payload.sessionId || payload.sessionId === sessionId;
}
