import { assertTwitterEnabled } from '../../../twitter/twitterPolicy.js';
import { StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { getTwitterToolPort } from '../../../runtime/platformToolGateway.js';

export default class RetweetTweetTool extends StructuredTool {
  name = 'retweet-tweet';
  description =
    'X(Twitter)のツイートをリツイートするツール。ツイートIDを指定してリツイートを実行する。';
  schema = z.object({
    tweetId: z
      .string()
      .describe('リツイートするツイートのID。URLではなく数字のIDを指定。'),
  });

  async _call(data: z.infer<typeof this.schema>): Promise<string> {
    assertTwitterEnabled();
    try {
      const response = await getTwitterToolPort().retweetTweet(data.tweetId);
      return response.message;
    } catch (error) {
      return `リツイートエラー: ${error}`;
    }
  }
}
