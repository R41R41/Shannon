/**
 * Web Action Dispatcher
 *
 * Sends ShannonActionPlans back to the Web UI via the request-bound conversation port.
 */

import type {
  RequestEnvelope,
  ShannonActionPlan,
  ActionDispatcher,
} from '@shannon/common';
import { createRequestWebConversation } from '../webConversationPort.js';

export const webDispatcher: ActionDispatcher = {
  channel: 'web',

  async dispatch(envelope: RequestEnvelope, plan: ShannonActionPlan, options?: { signal?: AbortSignal }): Promise<void> {
    if (!plan.message?.trim()) return;
    const port = createRequestWebConversation(envelope, options?.signal);
    const result = await port.postMessage({ message: plan.message });
    if (result.status !== 'sent') throw new Error(result.message);
  },
};
