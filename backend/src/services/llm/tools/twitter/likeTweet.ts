import { assertTwitterEnabled } from '../../../twitter/twitterPolicy.js';
import { StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { getTwitterToolPort } from '../../../runtime/platformToolGateway.js';

export default class LikeTweetTool extends StructuredTool {
  name = 'like-tweet';
  description =
    'X(Twitter)のツイートにいいねするツール。ツイートIDを指定していいねを実行する。';
  schema = z.object({
    tweetId: z
      .string()
      .describe('いいねするツイートのID。URLではなく数字のIDを指定。'),
  });

  async _call(data: z.infer<typeof this.schema>): Promise<string> {
    assertTwitterEnabled();
    try {
      const response = await getTwitterToolPort().likeTweet(data.tweetId);
      return response.message;
    } catch (error) {
      return `いいねエラー: ${error}`;
    }
  }
}
