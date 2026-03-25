import { StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { DiscordBot } from '../../../discord/client.js';
import { logger } from '../../../../utils/logger.js';

export default class GetDiscordRecentMessagesTool extends StructuredTool {
  name = 'get-discord-recent-messages';
  description =
    '現在のDiscordチャンネルの直近のチャットログを取得するツール。会話の流れや文脈を確認したい時に使う。';
  schema = z.object({
    channelId: z.string().describe('取得するDiscordチャンネルのID'),
    limit: z
      .number()
      .optional()
      .describe('取得するメッセージ数（デフォルト10、最大30）'),
  });

  async _call(data: z.infer<typeof this.schema>): Promise<string> {
    try {
      const bot = DiscordBot.getInstance();
      const limit = Math.min(data.limit ?? 10, 30);
      const messages = await bot.getRecentMessages(data.channelId, limit);

      if (messages.length === 0) {
        return 'チャットログが見つかりませんでした。';
      }

      const log = messages
        .map(m => m.content?.toString() ?? '')
        .filter(Boolean)
        .join('\n');

      return `直近${messages.length}件のチャットログ:\n${log}`;
    } catch (error) {
      logger.error('get-discord-recent-messages error:', error);
      return `チャットログの取得中にエラーが発生しました: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
}
