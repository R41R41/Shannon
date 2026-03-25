/**
 * Web Action Dispatcher
 *
 * Sends ShannonActionPlans back to the Web UI.
 */

import type {
  RequestEnvelope,
  ShannonActionPlan,
  ActionDispatcher,
} from '@shannon/common';
import { getEventBus } from '../../eventBus/index.js';

export const webDispatcher: ActionDispatcher = {
  channel: 'web',

  async dispatch(envelope: RequestEnvelope, plan: ShannonActionPlan): Promise<void> {
    const eventBus = getEventBus();

    if (plan.message) {
      eventBus.publish({
        type: 'web:post_message',
        memoryZone: 'web',
        data: {
          type: 'text',
          text: plan.message,
        },
        targetMemoryZones: ['web'],
      });
    }
  },
};
