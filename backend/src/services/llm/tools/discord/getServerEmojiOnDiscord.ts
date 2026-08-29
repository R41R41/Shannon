import { StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { DISCORD_CONVERSATION_REQUIRED, type DiscordConversationPort } from '../../../../modules/conversation/discordConversation.js';
import { logger } from '../../../../utils/logger.js';

const schema = z.object({
  guildId: z.string().optional().describe('省略可。指定時は現在のguild IDのみ'),
});

export default class GetServerEmojiOnDiscordTool extends StructuredTool<unknown, z.output<typeof schema>, z.input<typeof schema>, string> {
  name = 'get-server-emoji-on-discord';
  description = '現在のDiscordサーバーのカスタム絵文字一覧を取得する。';
  schema = schema;

  private port?: DiscordConversationPort;
  createForRun(): GetServerEmojiOnDiscordTool { return new GetServerEmojiOnDiscordTool(); }
  setDiscordConversationPort(port: DiscordConversationPort): void { this.port = port; }

  async _call(data: z.infer<typeof schema>): Promise<string> {
    try {
      if (!this.port) return DISCORD_CONVERSATION_REQUIRED;
      const result = await this.port.listEmojis({ guildId: data.guildId });
      if (result.status !== 'ok') return result.message;
      const currentTime = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
      return `${currentTime} discordのサーバー固有絵文字のリストを取得しました。\n${result.emojis.join('\n')}`;
    } catch (error) {
      logger.error('Discord emoji error:', error);
      return `絵文字の取得中にエラーが発生しました: ${error}`;
    }
  }
}
