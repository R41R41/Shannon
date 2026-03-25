import { StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { logger } from '../../../../utils/logger.js';

export default class WaitTool extends StructuredTool {
  name = 'wait';
  description =
    'A tool to wait for a specified number of seconds. Set the number of seconds to wait by subtracting 5 seconds from the actual waiting time. Do not use this tool if the waiting time is less than 5 seconds.';
  schema = z.object({
    seconds: z
      .number()
      .describe(
        'The number of seconds to wait. Set the number of seconds to wait by subtracting 5 seconds from the actual waiting time. For example, if you want to wait for 1 minute, set 55 (60 seconds - 5 seconds).'
      ),
  });

  constructor() {
    super();
  }

  async _call(data: z.infer<typeof this.schema>): Promise<string> {
    try {
      logger.info(`wait for ${data.seconds} seconds`);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 1000 * (data.seconds ?? 1));
        const cleanup = () => {
          clearTimeout(timer);
          reject(new Error('Wait interrupted'));
        };

        // プロセス終了イベントをリッスン
        process.once('SIGTERM', cleanup);
        process.once('SIGINT', cleanup);

        // クリーンアップ関数を返して、プロミス完了時にイベントリスナーを削除
        return () => {
          process.off('SIGTERM', cleanup);
          process.off('SIGINT', cleanup);
        };
      });
      const currentTime = new Date().toLocaleString('ja-JP', {
        timeZone: 'Asia/Tokyo',
      });
      return `${currentTime} 待機しました: ${data.seconds}秒`;
    } catch (error) {
      logger.error('Wait error:', error);
      return `待機中にエラーが発生しました: ${error}`;
    }
  }
}
