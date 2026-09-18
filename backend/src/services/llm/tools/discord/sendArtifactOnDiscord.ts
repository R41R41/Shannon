import { StructuredTool } from '@langchain/core/tools';
import type { MemoryZone } from '@shannon/common';
import { z } from 'zod';
import { getArtifactStore } from '../../../artifacts/artifactStore.js';
import { getEventBus } from '../../../eventBus/index.js';

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

  async _call(data: SendArtifactInput): Promise<string> {
    const bundle = await getArtifactStore().resolveBundle(data.artifactId);
    const payload = {
      channelId: data.channelId,
      guildId: data.guildId,
      text: data.message,
      imageUrl: '',
      artifactIds: [data.artifactId],
    };
    getEventBus().publish({
      type: 'discord:post_message',
      memoryZone: (data.memoryZone || 'discord:general') as MemoryZone,
      data: payload,
    });
    return JSON.stringify({
      status: 'queued',
      artifactId: data.artifactId,
      files: bundle.files.map((file) => file.fileName),
      message: 'Discord送信キューへ登録しました。',
    });
  }
}
