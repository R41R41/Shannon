import { StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { searchWeb } from '../../../search/webSearchService.js';
import { logger } from '../../../../utils/logger.js';

/** Backward-compatible tool name backed by a replaceable provider chain. */
export default class GoogleSearchTool extends StructuredTool {
  name = 'google-search';
  description = '最新のWebを検索する。Google CSEを標準とし、設定済みの代替プロバイダへ順にフォールバックする。複数の独立した情報源を返す。同時に調べられる別クエリは並列呼び出ししてよい。';
  schema = z.object({
    query: z.string().min(1).max(600).describe('検索クエリ'),
    dateRestrict: z.string().optional().describe('日付範囲（例: d1, w1, m1, y1）。対応プロバイダで使用'),
    siteSearch: z.string().optional().describe('特定ドメインに限定する場合のドメイン'),
    num: z.number().int().min(1).max(10).optional().describe('結果数'),
    start: z.number().int().min(1).optional().describe('ページング開始位置'),
    sort: z.string().optional(),
    filter: z.string().optional(),
    gl: z.string().optional().describe('国コード。既定JP'),
    lr: z.string().optional().describe('言語。例 lang_ja'),
  });

  async _call(data: z.infer<typeof this.schema>): Promise<string> {
    try {
      const response = await searchWeb(data);
      const items = response.results.map((item, index) =>
        `【${index + 1}. ${item.title}】\n${item.snippet || '要約なし'}\nURL: ${item.url}`,
      );
      const answer = response.answer ? `\n検索による要約:\n${response.answer}\n` : '';
      return `検索クエリ: "${data.query}"\nプロバイダ: ${response.provider}${answer}\n検索結果 ${response.results.length}件:\n\n${items.join('\n\n')}\n\n重要な事実はfetch-urlで本文を確認してください。`;
    } catch (error) {
      logger.error('Web search error:', error);
      return `Web検索中にエラーが発生しました: ${error instanceof Error ? error.message : String(error)} [failure_type=search_unavailable recoverable=true]`;
    }
  }
}
