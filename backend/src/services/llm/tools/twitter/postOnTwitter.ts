import { assertTwitterEnabled } from '../../../twitter/twitterPolicy.js';
import { StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { config } from '../../../../config/env.js';
import { getTwitterToolPort } from '../../../runtime/platformToolGateway.js';

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

  async _call(data: z.infer<typeof this.schema>): Promise<string> {
    assertTwitterEnabled();
    try {
      const result = await getTwitterToolPort().postMessage({
        text: data.text,
        replyId: data.replyToTweetId ?? null,
      });

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
