import { StructuredTool } from '@langchain/core/tools';
import { TwitterClientInput } from '@shannon/common';
import { z } from 'zod';
import { config } from '../../../../config/env.js';
import { EventBus } from '../../../eventBus/eventBus.js';
import { getEventBus } from '../../../eventBus/index.js';

const isPremium = !config.isDev;

export default class PostOnTwitterTool extends StructuredTool {
  name = 'post-on-twitter';
  description = isPremium
    ? 'X(Twitter)にツイートを投稿するツール。Premium対応のため長文投稿も可能。返信する場合は replyToTweetId を指定する。投稿前に generate-tweet-text でツイート文を生成すること。'
    : 'X(Twitter)にツイートを投稿するツール。日本語は140文字以内（英語は280文字以内）。長文は絶対にNG。返信する場合は replyToTweetId を指定する。投稿前に generate-tweet-text でツイート文を生成すること。';
  schema = z.object({
    text: z.string().describe(isPremium
      ? '投稿するテキスト。長文も投稿可能'
      : '投稿するテキスト。日本語は140文字以内、英語は280文字以内。超過すると投稿失敗する'),
    replyToTweetId: z
      .string()
      .optional()
      .describe(
        '返信先のツイートID。返信する場合のみ指定。新規ツイートの場合は省略。'
      ),
  });

  private eventBus: EventBus;

  constructor() {
    super();
    this.eventBus = getEventBus();
  }

  async _call(data: z.infer<typeof this.schema>): Promise<string> {
    try {
      // 結果を待つ Promise を作成
      const resultPromise = new Promise<{ isSuccess: boolean; errorMessage: string }>((resolve) => {
        const timeout = setTimeout(() => {
          resolve({ isSuccess: false, errorMessage: 'ツイート投稿がタイムアウトしました（15秒）' });
        }, 15000);

        this.eventBus.subscribe('tool:post_tweet_result', (event) => {
          clearTimeout(timeout);
          const { isSuccess, errorMessage } = event.data as { isSuccess: boolean; errorMessage: string };
          resolve({ isSuccess, errorMessage });
        });
      });

      // 投稿リクエストを送信
      this.eventBus.publish({
        type: 'twitter:post_message',
        memoryZone: 'twitter:post',
        data: {
          text: data.text,
          replyId: data.replyToTweetId ?? null,
        } as TwitterClientInput,
      });

      // 結果を待機
      const result = await resultPromise;

      const currentTime = new Date().toLocaleString('ja-JP', {
        timeZone: 'Asia/Tokyo',
      });

      if (!result.isSuccess) {
        return `${currentTime} ツイート投稿に失敗しました: ${result.errorMessage}。文字数を減らして再試行してください。`;
      }

      if (data.replyToTweetId) {
        return `${currentTime} ツイート ${data.replyToTweetId} に返信しました: ${data.text}`;
      }
      return `${currentTime} ツイートを投稿しました: ${data.text}`;
    } catch (error) {
      return `ツイート投稿エラー: ${error}`;
    }
  }
}
