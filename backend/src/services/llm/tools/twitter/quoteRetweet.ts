import { StructuredTool } from '@langchain/core/tools';
import { TwitterActionResult, TwitterClientInput } from '@shannon/common';
import { z } from 'zod';
import { EventBus } from '../../../eventBus/eventBus.js';
import { getEventBus } from '../../../eventBus/index.js';

export default class QuoteRetweetTool extends StructuredTool {
  name = 'quote-retweet';
  description =
    'X(Twitter)のツイートを引用リツイートするツール。元ツイートのURLとコメントテキストを指定して引用RTを実行する。';
  schema = z.object({
    tweetUrl: z
      .string()
      .describe(
        '引用リツイートする元ツイートのURL (例: https://x.com/user/status/123456789)'
      ),
    text: z.string().describe('引用リツイートに付けるコメントテキスト。'),
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
          'tool:quote_retweet',
          (event) => {
            unsubscribe();
            resolve(event.data as TwitterActionResult);
          }
        );
        this.eventBus.publish({
          type: 'twitter:quote_retweet',
          memoryZone: 'twitter:post',
          data: {
            text: data.text,
            quoteTweetUrl: data.tweetUrl,
          } as TwitterClientInput,
        });
      });

      const response = await result;
      return response.message;
    } catch (error) {
      return `引用リツイートエラー: ${error}`;
    }
  }
}
