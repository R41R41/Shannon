import { StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { WEB_CONVERSATION_REQUIRED, type WebConversationPort } from '../../../../modules/conversation/webConversation.js';
import { logger } from '../../../../utils/logger.js';

const schema = z.object({
  message: z.string().describe('Message to send'),
});

export default class ChatOnWebTool extends StructuredTool<unknown, z.output<typeof schema>, z.input<typeof schema>, string> {
  name = 'chat-on-web';
  description = '現在のWebセッションにだけメッセージを送る。別セッションへの送信は不可。';
  schema = schema;

  private port?: WebConversationPort;
  createForRun(): ChatOnWebTool { return new ChatOnWebTool(); }
  setWebConversationPort(port: WebConversationPort): void { this.port = port; }

  async _call(data: z.infer<typeof schema>): Promise<string> {
    try {
      logger.info(`chat-on-web ${JSON.stringify(data)}`);
      if (!this.port) return WEB_CONVERSATION_REQUIRED;
      const result = await this.port.postMessage({ message: data.message });
      const currentTime = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
      return result.status === 'sent'
        ? `${currentTime} Sent a message to ShannonUI: ${data.message}`
        : result.message;
    } catch (error) {
      logger.error('chat-on-web error:', error);
      return `An error occurred while sending: ${error}`;
    }
  }
}
