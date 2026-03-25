import { StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { getEventBus } from '../../../eventBus/index.js';
import { EventBus } from '../../../eventBus/eventBus.js';
import { TwitterClientOutput, TwitterClientInput } from '@shannon/common';
import { logger } from '../../../../utils/logger.js';

export default class GetXorTwitterPostContentFromURLTool extends StructuredTool {
  name = 'get-x-or-twitter-post-content-from-url';
  description =
    'X(Twitter)の投稿URLから内容を取得するツール。画像がある場合は画像のURLも取得するので、必ずdescribeImageツールで画像の内容を取得してください';
  schema = z.object({
    url: z
      .string()
      .describe(
        '取得したいX(Twitter)の投稿のURL。有効なURLを指定してください。'
      ),
  });

  private eventBus: EventBus;

  constructor() {
    super();
    this.eventBus = getEventBus();
  }

  private extractTweetId(url: string): string | null {
    const match = url.match(/status\/(\d+)/);
    return match ? match[1] : null;
  }

  async _call(data: z.infer<typeof this.schema>): Promise<string> {
    try {
      const tweetId = this.extractTweetId(data.url);
      if (!tweetId) {
        return 'X(Twitter)の投稿URLを指定してください。';
      }

      const getContent = new Promise<TwitterClientOutput>((resolve) => {
        const unsubscribe = this.eventBus.subscribe(
          'tool:get_tweet_content',
          (event) => {
            unsubscribe();
            resolve(event.data as TwitterClientOutput);
          }
        );
        this.eventBus.publish({
          type: 'twitter:get_tweet_content',
          memoryZone: 'twitter:get',
          data: { tweetId } as TwitterClientInput,
        });
      });
      const response = await getContent;

      return `X(Twitter)の投稿からコンテンツを取得しました。${JSON.stringify(response)} `;
    } catch (error) {
      logger.error('get-x-or-twitter-post-content-from-url error:', error);
      return `An error occurred while getting content from X(Twitter): ${error}`;
    }
  }
}