import { StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { DISCORD_CONVERSATION_REQUIRED, type DiscordConversationPort } from '../../../../modules/conversation/discordConversation.js';
import { logger } from '../../../../utils/logger.js';

const schema = z.object({
  guildId: z.string().optional().describe('省略可。指定時は現在のguild IDのみ'),
  channelId: z.string().optional().describe('省略可。指定時は現在のchannel IDのみ'),
  messageId: z.string().optional().describe('省略可。未指定時は現在のユーザー発言'),
  emojiId: z.string().describe('Unicode絵文字（例: "😂"）またはサーバーカスタム絵文字のID'),
});

export default class ReactByServerEmojiOnDiscordTool extends StructuredTool<unknown, z.output<typeof schema>, z.input<typeof schema>, string> {
  name = 'react-by-server-emoji-on-discord';
  description =
    '現在のDiscord会話のメッセージに絵文字でリアクションする。messageIdはシステムプロンプトの「ユーザーのメッセージID」を使うこと（IDを推測・捏造しない）。' +
    'emojiには Unicode絵文字（例: "😂", "👍", "🎉"）またはサーバーカスタム絵文字のID を指定できる。';
  schema = schema;

  private port?: DiscordConversationPort;
  createForRun(): ReactByServerEmojiOnDiscordTool { return new ReactByServerEmojiOnDiscordTool(); }
  setDiscordConversationPort(port: DiscordConversationPort): void { this.port = port; }

  async _call(data: z.infer<typeof schema>): Promise<string> {
    try {
      if (!this.port) return DISCORD_CONVERSATION_REQUIRED;
      const result = await this.port.react(data);
      const currentTime = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
      return result.status === 'sent'
        ? `${currentTime} Reaction sent.`
        : `${currentTime} Could not send reaction. ${result.message}`;
    } catch (error) {
      logger.error('Discord emoji error:', error);
      return `An error occurred while sending an emoji: ${error}`;
    }
  }
}
