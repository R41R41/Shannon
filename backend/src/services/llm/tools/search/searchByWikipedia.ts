import { StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import axios from 'axios';
import { logger } from '../../../../utils/logger.js';

const USER_AGENT = 'ShannonBot/1.0 (https://sh4nnon.com; contact@sh4nnon.com)';

export default class SearchByWikipediaTool extends StructuredTool {
    name = 'search-by-wikipedia';
    description = 'Wikipediaで対象を検索し、内容を返すツール。日本語・英語どちらも対応。';
    schema = z.object({
        query: z.string().describe('Wikipediaで検索したい内容（日本語も可）'),
        lang: z.string().optional().describe('検索言語（例: "ja" または "en"。省略時はja)'),
        summary: z.boolean().optional().describe('要約を返すかどうか（省略時はfalse）'),
    });

    constructor() {
        super();
    }

    async _call(data: z.infer<typeof this.schema>): Promise<string> {
        const lang = data.lang || 'ja';
        const baseUrl = `https://${lang}.wikipedia.org/w/api.php`;
        const headers = {
            'User-Agent': USER_AGENT,
            'Api-User-Agent': USER_AGENT,
        };
        try {
            // 1. まず検索して正しいページタイトルを取得
            const searchRes = await axios.get(baseUrl, {
                headers,
                params: {
                    action: 'query',
                    list: 'search',
                    srsearch: data.query,
                    srlimit: 1,
                    format: 'json',
                    origin: '*',
                },
            });
            const results = searchRes.data?.query?.search;
            if (!results || results.length === 0) {
                return `Wikipediaで「${data.query}」の記事が見つかりませんでした。`;
            }
            const pageTitle = results[0].title;
            const pageId = results[0].pageid;

            if (data.summary) {
                // REST API で要約取得
                const summaryRes = await axios.get(
                    `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(pageTitle.replace(/ /g, '_'))}`,
                    { headers }
                );
                return summaryRes.data?.extract || `「${pageTitle}」の要約を取得できませんでした。`;
            } else {
                // Legacy API で本文取得
                const contentRes = await axios.get(baseUrl, {
                    headers,
                    params: {
                        action: 'query',
                        prop: 'extracts',
                        explaintext: '',
                        pageids: pageId,
                        format: 'json',
                        origin: '*',
                    },
                });
                const pages = contentRes.data?.query?.pages;
                const page = pages?.[pageId];
                const extract = page?.extract;
                if (!extract) {
                    return `「${pageTitle}」の本文を取得できませんでした。`;
                }
                // 長すぎる場合は先頭2000文字に切り詰め
                return extract.length > 2000 ? extract.slice(0, 2000) + '...' : extract;
            }
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            logger.error('Wikipedia search error:', msg);
            return `Wikipedia検索中にエラーが発生しました: ${msg}`;
        }
    }
}
