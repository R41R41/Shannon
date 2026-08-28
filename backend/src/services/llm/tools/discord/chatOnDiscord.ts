import { StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { DISCORD_CONVERSATION_REQUIRED, type DiscordConversationPort } from '../../../../modules/conversation/discordConversation.js';
const schema = z.object({
    message: z.string().min(1).max(12000),
    channelId: z.string().optional().describe('省略可。指定時は現在のチャンネルIDのみ'),
    guildId: z.string().optional().describe('省略可。指定時は現在のguild IDのみ'),
    memoryZone: z.string().optional().describe('互換用。送信先や権限には使用しない'),
    imageUrl: z.string().optional().describe('この経路では添付不可'),
  });

// Avoid LangChain 0.3 interop-schema recursion; the concrete Zod schema below still validates invoke() at runtime.
// Input/output remain explicitly typed; no unchecked cast or ts-ignore is used.
export default class ChatOnDiscordTool extends StructuredTool<unknown, z.output<typeof schema>, z.input<typeof schema>, string> {
  name = 'chat-on-discord';
  description = '現在のDiscordテキスト会話だけに返信する。別チャンネル・添付は不可。送信先はリクエストから固定される。';
  schema = schema;
  private port?: DiscordConversationPort;
  createForRun(): ChatOnDiscordTool { return new ChatOnDiscordTool(); }
  setDiscordConversationPort(port: DiscordConversationPort) { this.port = port; }
  async _call(data: z.infer<typeof schema>): Promise<string> {
    if (!this.port) return DISCORD_CONVERSATION_REQUIRED;
    return (await this.port.reply(data)).message;
  }
}
