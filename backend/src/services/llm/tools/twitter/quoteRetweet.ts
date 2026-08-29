import { assertTwitterEnabled } from '../../../twitter/twitterPolicy.js';
import { StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { getTwitterToolPort } from '../../../runtime/platformToolGateway.js';

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

  async _call(data: z.infer<typeof this.schema>): Promise<string> {
    assertTwitterEnabled();
    try {
      const response = await getTwitterToolPort().quoteRetweet(data.text, data.tweetUrl);
      return response.message;
    } catch (error) {
      return `引用リツイートエラー: ${error}`;
    }
  }
}
