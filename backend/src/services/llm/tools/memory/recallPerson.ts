import { StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';

export default class RecallPersonTool extends StructuredTool {
  name = 'recall-person';
  description =
    '今話している人や特定の人物の情報を思い出す。特徴、過去の会話の要約、直近のやりとりが分かる。';
  schema = z.object({
    name: z
      .string()
      .describe('思い出したい人の名前 (例: "ライ", "ヤミー")'),
  });

  async _call(_data: z.infer<typeof this.schema>): Promise<string> {
    return '人物記憶は公開範囲の移行・確認が済むまで検索を停止しています。表示名では本人確認をしません。';
  }
}
