import { StructuredTool } from '@langchain/core/tools';
import fetch from 'node-fetch';
import { z } from 'zod';
import { config } from '../../../../config/env.js';
import { logger } from '../../../../utils/logger.js';

export default class GoogleSearchTool extends StructuredTool {
  name = 'google-search';
  description = 'A Google search tool using Custom Search JSON API. Supports query, dateRestrict, siteSearch, num, start, sort, filter, gl, lr.';
  schema = z.object({
    query: z.string().describe('The content you want to search for'),
    dateRestrict: z.string().optional().describe('Restrict results to a specific date range (e.g., "d1", "w1", "m1", "y1")'),
    siteSearch: z.string().optional().describe('Restrict search to a specific domain (e.g., "asahi.com")'),
    num: z.number().optional().describe('Number of results to return (max 10)'),
    start: z.number().optional().describe('The index of the first result to return (for paging)'),
    sort: z.string().optional().describe('The order to sort results (CSE setting dependent)'),
    filter: z.string().optional().describe('Duplicate content filter ("0" to disable)'),
    gl: z.string().optional().describe('Geolocation country code (e.g., "jp")'),
    lr: z.string().optional().describe('Language restrict (e.g., "lang_ja")'),
  });

  private apiKey: string;
  private searchEngineId: string;

  private disabled: boolean;

  constructor() {
    super();
    this.apiKey = config.google.apiKey;
    this.searchEngineId = config.google.searchEngineId;
    this.disabled = !this.apiKey || !this.searchEngineId;

    if (this.disabled) {
      logger.warn('[GoogleSearch] API key or Search Engine ID is not set. Tool will return an error message when called.');
    }
  }

  async _call(data: z.infer<typeof this.schema>): Promise<string> {
    if (this.disabled) {
      return 'Google検索は現在利用できません（API keyまたはSearch Engine IDが未設定です）。';
    }

    let url = `https://www.googleapis.com/customsearch/v1?key=${this.apiKey}&cx=${this.searchEngineId}&q=${encodeURIComponent(data.query)}`;

    if (data.dateRestrict) url += `&dateRestrict=${data.dateRestrict}`;
    if (data.siteSearch) url += `&siteSearch=${encodeURIComponent(data.siteSearch)}`;
    if (data.num) url += `&num=${data.num}`;
    if (data.start) url += `&start=${data.start}`;
    if (data.sort) url += `&sort=${encodeURIComponent(data.sort)}`;
    if (data.filter) url += `&filter=${encodeURIComponent(data.filter)}`;
    if (data.gl) url += `&gl=${encodeURIComponent(data.gl)}`;
    if (data.lr) url += `&lr=${encodeURIComponent(data.lr)}`;

    try {
      const response = await fetch(url);
      const result = await response.json() as {
        error?: { code: number; message: string };
        items?: Array<{ title?: string; snippet?: string; link?: string }>;
      };

      if (result.error) {
        logger.error(`Google search API error: ${result.error.code} ${result.error.message}`);
        return `Google検索APIエラー (${result.error.code}): ${result.error.message}`;
      }

      if (result.items && result.items.length > 0) {
        // タイトル、スニペット、URLを含む詳細な結果を返す
        const formattedResults = result.items.map((item, index: number) => {
          const title = item.title || 'タイトルなし';
          const snippet = item.snippet || '説明なし';
          const link = item.link || '';
          return `【${index + 1}. ${title}】\n${snippet}\nURL: ${link}`;
        }).join('\n\n');

        return `検索クエリ: "${data.query}"\n検索結果 ${result.items.length}件:\n\n${formattedResults}\n\n※情報が不十分な場合は、URLをfetch-urlで取得するか、別のクエリで再検索してください。`;
      } else {
        return `検索クエリ "${data.query}" で結果が見つかりませんでした。別のキーワードで再検索してください。`;
      }
    } catch (error) {
      logger.error('Google search error:', error);
      return `検索中にエラーが発生しました: ${error}`;
    }
  }
}
