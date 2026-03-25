import type {
  ActionDispatcher,
  RequestEnvelope,
  ShannonActionPlan,
  XAction,
} from '@shannon/common';
import type { TwitterClientInput } from '@shannon/common';
import { getEventBus } from '../../eventBus/index.js';

export const xDispatcher: ActionDispatcher = {
  channel: 'x',

  async dispatch(envelope: RequestEnvelope, plan: ShannonActionPlan): Promise<void> {
    const eventBus = getEventBus();
    const actions = plan.xActions ?? [];

    for (const action of actions) {
      dispatchAction(eventBus, envelope, action);
    }

    if (actions.length === 0 && plan.message) {
      const isReply = envelope.x?.isReply ?? (envelope.x?.tweetId != null);
      dispatchAction(eventBus, envelope, {
        type: isReply ? 'reply' : 'post',
        text: plan.message,
      });
    }
  },
};

function dispatchAction(
  eventBus: ReturnType<typeof getEventBus>,
  envelope: RequestEnvelope,
  action: XAction,
): void {
  switch (action.type) {
    case 'reply':
      eventBus.publish({
        type: 'twitter:post_message',
        memoryZone: 'twitter:post',
        data: {
          text: action.text,
          replyId: envelope.x?.tweetId ?? null,
        } as TwitterClientInput,
      });
      break;

    case 'post':
      eventBus.publish({
        type: 'twitter:post_message',
        memoryZone: 'twitter:post',
        data: {
          text: action.text,
        } as TwitterClientInput,
      });
      break;

    case 'quote':
      eventBus.publish({
        type: 'twitter:post_message',
        memoryZone: 'twitter:post',
        data: {
          text: action.text,
          quoteTweetUrl: `https://x.com/i/status/${action.targetTweetId}`,
        } as TwitterClientInput,
      });
      break;

    case 'draft':
      break;
  }
}
