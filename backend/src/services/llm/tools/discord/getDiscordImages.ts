import { StructuredTool } from '@langchain/core/tools';
import { Client, Message, ThreadChannel } from 'discord.js';
import { z } from 'zod';
import { DiscordBot } from '../../../discord/client.js';
import { logger } from '../../../../utils/logger.js';

/**
 * Discordチャンネルの直近メッセージから画像（添付ファイル・embed）を取得するツール。
 * スレッド内で呼ばれた場合、スレッドの元投稿（スターターメッセージ）の画像も自動的に含める。
 *
 * 用途:
 * - 「上の画像を編集して」→ チャンネルの最新画像URLを取得 → edit-image に渡す
 * - 「さっきの画像を説明して」→ 画像URLを取得 → describe-image に渡す
 * - ユーザーが添付した画像も、シャノンが投稿した画像も取得できる
 */
export default class GetDiscordImagesTool extends StructuredTool {
  name = 'get-discord-images';
  description =
    'Discordチャンネルの直近メッセージから画像を検索して取得するツール。「上の画像」「さっきの画像」等と言われたらまずこのツールで画像URLを取得し、そのURLを edit-image や describe-image に渡す。スレッド内で画像が見つからない場合はスレッドの元投稿も自動的に検索する。';
  schema = z.object({
    channelId: z.string().describe('検索するDiscordチャンネルのID'),
    limit: z
      .number()
      .optional()
      .describe('検索するメッセージ数（デフォルト20）'),
  });

  private extractImagesFromMessage(msg: Pick<Message, 'attachments' | 'embeds'>): string[] {
    const images: string[] = [];
    // 1. 添付ファイルから画像を取得
    for (const [, attachment] of msg.attachments) {
      if (attachment.contentType?.startsWith('image/')) {
        images.push(attachment.url);
      }
    }
    // 2. Embedから画像を取得
    for (const embed of msg.embeds) {
      if (embed.image?.url) {
        images.push(embed.image.url);
      }
      if (embed.thumbnail?.url) {
        images.push(embed.thumbnail.url);
      }
    }
    return images;
  }

  async _call(data: z.infer<typeof this.schema>): Promise<string> {
    try {
      const bot = DiscordBot.getInstance();
      // DiscordBot.client is private; access via cast through unknown
      const client = (bot as unknown as { client: Client }).client;

      if (!client) {
        return 'エラー: Discord クライアントが初期化されていません';
      }

      let channel = client.channels.cache.get(data.channelId);
      // キャッシュにない場合はfetchを試みる
      if (!channel) {
        try { channel = await client.channels.fetch(data.channelId) ?? undefined; } catch { /* ignore */ }
      }
      if (!channel?.isTextBased() || !('messages' in channel)) {
        return 'エラー: 指定されたチャンネルが見つからないか、テキストチャンネルではありません';
      }

      const limit = data.limit ?? 20;
      const messages = await channel.messages.fetch({ limit });
      const sorted = messages.sort(
        (a, b) => b.createdTimestamp - a.createdTimestamp,
      );

      const results: string[] = [];

      for (const [, msg] of sorted) {
        const images = this.extractImagesFromMessage(msg);

        if (images.length > 0) {
          const author = msg.author?.username || 'Unknown';
          const time = new Date(msg.createdTimestamp).toLocaleTimeString(
            'ja-JP',
            { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' },
          );
          const content = msg.content
            ? msg.content.substring(0, 80)
            : '(テキストなし)';

          results.push(
            `[${time}] ${author}: ${content}\n` +
              images.map((url) => `  画像URL: ${url}`).join('\n'),
          );
        }
      }

      // スレッド内で画像が見つからない場合、スレッドの元投稿（スターターメッセージ）をチェック
      if (channel instanceof ThreadChannel) {
        try {
          const starterMsg = await channel.fetchStarterMessage();
          if (starterMsg) {
            const starterImages = this.extractImagesFromMessage(starterMsg);
            if (starterImages.length > 0) {
              const author = starterMsg.author?.username || 'Unknown';
              const time = new Date(starterMsg.createdTimestamp).toLocaleTimeString(
                'ja-JP',
                { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' },
              );
              const content = starterMsg.content
                ? starterMsg.content.substring(0, 80)
                : '(テキストなし)';

              results.push(
                `[${time}] ${author} (スレッド元投稿): ${content}\n` +
                  starterImages.map((url) => `  画像URL: ${url}`).join('\n'),
              );
            }
          }
        } catch (err) {
          logger.warn(`[get-discord-images] スターターメッセージの取得に失敗: ${err}`);
        }
      }

      if (results.length === 0) {
        return `直近${limit}件のメッセージに画像は見つかりませんでした。`;
      }

      return `チャンネル内の画像一覧（新しい順）:\n\n${results.join('\n\n')}\n\n※ edit-image の imagePath にこの画像URLをそのまま渡せます。`;
    } catch (error) {
      logger.error('get-discord-images error:', error);
      return `画像の取得中にエラーが発生しました: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
}
