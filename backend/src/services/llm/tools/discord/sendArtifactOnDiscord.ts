import { StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { getArtifactStore } from '../../../artifacts/artifactStore.js';
import type { DiscordConversationPort } from '../../../../modules/conversation/discordConversation.js';

const schema = z.object({
  artifactId: z.string().uuid().describe('create-travel-briefが返したartifactId'),
  message: z.string().trim().min(1).max(1800).describe('ファイルに添える短い案内。長い調査本文を重複させない'),
  channelId: z.string().trim().min(1).describe('送信先DiscordチャンネルID'),
  guildId: z.string().trim().min(1).describe('送信先DiscordサーバーID'),
  memoryZone: z.string().trim().optional().describe('省略時はdiscord:general'),
});

interface SendArtifactInput {
  artifactId: string;
  message: string;
  channelId: string;
  guildId: string;
  memoryZone?: string;
}

export default class SendArtifactOnDiscordTool extends StructuredTool<any> {
  name = 'send-artifact-on-discord';
  description = 'Shannonが生成・保管した成果物をDiscordへ添付送信する。任意のローカルパスや外部URLは受け付けず、create-travel-briefが返したartifactIdだけを送れる。';
  schema = schema;
  private discordConversation: DiscordConversationPort | null = null;

  createForRun(): SendArtifactOnDiscordTool {
    return new SendArtifactOnDiscordTool();
  }

  setDiscordConversationPort(port: DiscordConversationPort): void {
    this.discordConversation = port;
  }

  async _call(data: SendArtifactInput): Promise<string> {
    const bundle = await getArtifactStore().resolveBundle(data.artifactId);
    if (!this.discordConversation) {
      return JSON.stringify({ status: 'denied', artifactId: data.artifactId, message: '現在のDiscord会話への送信権限がありません。' });
    }
    const delivery = await this.discordConversation.replyWithArtifacts({
      message: data.message,
      channelId: data.channelId,
      guildId: data.guildId,
      artifactIds: [data.artifactId],
    });
    return JSON.stringify({
      status: delivery.status,
      artifactId: data.artifactId,
      files: bundle.files.filter((file) => file.role !== 'html').map((file) => file.fileName),
      message: delivery.message,
    });
  }
}
