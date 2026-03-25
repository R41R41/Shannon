import { StructuredTool } from '@langchain/core/tools';
import { TwitterActionResult, TwitterClientInput } from '@shannon/common';
import { z } from 'zod';
import { EventBus } from '../../../eventBus/eventBus.js';
import { getEventBus } from '../../../eventBus/index.js';

export default class RetweetTweetTool extends StructuredTool {
  name = 'retweet-tweet';
  description =
    'X(Twitter)のツイートをリツイートするツール。ツイートIDを指定してリツイートを実行する。';
  schema = z.object({
    tweetId: z
      .string()
      .describe('リツイートするツイートのID。URLではなく数字のIDを指定。'),
  });

  private eventBus: EventBus;

  constructor() {
    super();
    this.eventBus = getEventBus();
  }

  async _call(data: z.infer<typeof this.schema>): Promise<string> {
    try {
      const result = new Promise<TwitterActionResult>((resolve) => {
        const unsubscribe = this.eventBus.subscribe(
          'tool:retweet_tweet',
          (event) => {
            unsubscribe();
            resolve(event.data as TwitterActionResult);
          }
        );
        this.eventBus.publish({
          type: 'twitter:retweet_tweet',
          memoryZone: 'twitter:post',
          data: { tweetId: data.tweetId } as TwitterClientInput,
        });
      });

      const response = await result;
      return response.message;
    } catch (error) {
      return `リツイートエラー: ${error}`;
    }
  }
}
