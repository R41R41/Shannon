import { StructuredTool } from '@langchain/core/tools';
import { DiscordClientInput, MemoryZone } from '@shannon/common';
import { z } from 'zod';
import { EventBus } from '../../../eventBus/eventBus.js';
import { getEventBus } from '../../../eventBus/index.js';
import { logger } from '../../../../utils/logger.js';

export default class ChatOnDiscordTool extends StructuredTool {
  name = 'chat-on-discord';
  description = 'Discordにメッセージを送信するツール。調査結果を報告する際は、見出し・箇条書き等のDiscord Markdownで整形すること。画像URLがあれば imageUrl に設定して添付できる。';
  schema = z.object({
    message: z.string().describe('送信するメッセージ。Discord Markdown（**太字**, - 箇条書き 等）を使って読みやすく整形する'),
    channelId: z.string().describe('送信先のチャンネルID'),
    guildId: z.string().describe('送信先のサーバーID'),
    memoryZone: z
      .string()
      .optional()
      .describe('MemoryZone値。省略時は discord:general'),
    imageUrl: z
      .string()
      .optional()
      .describe(
        '添付する画像のURL（og:image等から取得したもの）。人物や作品について報告する際はできるだけ画像を添付する'
      ),
  });
  private eventBus: EventBus;

  constructor() {
    super();
    this.eventBus = getEventBus();
  }

  async _call(data: z.infer<typeof this.schema>): Promise<string> {
    try {
      // console.log('\x1b[35mchat-on-discord', data, '\x1b[0m');
      const memoryZone = (data.memoryZone || 'discord:general') as MemoryZone;
      this.eventBus.publish({
        type: 'discord:post_message',
        memoryZone,
        data: {
          type: 'text',
          channelId: data.channelId,
          guildId: data.guildId,
          text: data.message,
          imageUrl: data.imageUrl,
        } as DiscordClientInput,
      });
      const currentTime = new Date().toLocaleString('ja-JP', {
        timeZone: 'Asia/Tokyo',
      });
      return `${currentTime} Sent a message to Discord: ${data.message}`;
    } catch (error) {
      logger.error('Discord send error:', error);
      return `Discordへの送信中にエラーが発生しました: ${error}`;
    }
  }
}
