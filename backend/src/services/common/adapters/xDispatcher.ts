import type {
  ActionDispatcher,
  RequestEnvelope,
  ShannonActionPlan,
  XAction,
} from '@shannon/common';
import { getTwitterToolPort } from '../../runtime/platformToolGateway.js';

export const xDispatcher: ActionDispatcher = {
  channel: 'x',

  async dispatch(envelope: RequestEnvelope, plan: ShannonActionPlan): Promise<void> {
    const port = getTwitterToolPort();
    const actions = plan.xActions ?? [];

    for (const action of actions) {
      dispatchAction(port, envelope, action);
    }

    if (actions.length === 0 && plan.message) {
      const isReply = envelope.x?.isReply ?? (envelope.x?.tweetId != null);
      dispatchAction(port, envelope, {
        type: isReply ? 'reply' : 'post',
        text: plan.message,
      });
    }
  },
};

function dispatchAction(
  port: ReturnType<typeof getTwitterToolPort>,
  envelope: RequestEnvelope,
  action: XAction,
): void {
  switch (action.type) {
    case 'reply':
      void port.postMessage({
        text: action.text,
        replyId: envelope.x?.tweetId ?? null,
      });
      break;

    case 'post':
      void port.postMessage({
        text: action.text,
      });
      break;

    case 'quote':
      void port.postMessage({
        text: action.text,
        quoteTweetUrl: `https://x.com/i/status/${action.targetTweetId}`,
      });
      break;

    case 'draft':
      break;
  }
}
