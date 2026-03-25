import { StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { logger } from '../../../../utils/logger.js';

export default class FetchUrlTool extends StructuredTool {
    name = 'fetch-url';
    description = 'URLからコンテンツを取得し、主にHTMLのテキスト内容を抽出するツール。ウェブサイトの情報を調査したい場合に使用します。';
    schema = z.object({
        url: z
            .string()
            .describe('取得したいコンテンツのURL。有効なURLを指定してください。'),
        extractMode: z
            .enum(['text', 'html', 'json'])
            .describe('取得するコンテンツの形式。textはHTMLからテキストのみを抽出、htmlは生のHTML、jsonはJSON形式のレスポンスを返します。')
            .default('text'),
    });

    // データサイズに関する定数
    private readonly MAX_RESPONSE_SIZE = 1 * 1024 * 1024; // 1 MB
    private readonly MAX_RETURN_TEXT_LENGTH = 4000; // 4000文字
    private readonly MAX_HTML_RETURN_LENGTH = 10000; // 10000文字

    constructor() {
        super();
    }

    // YouTubeの動画情報抽出
    private extractYouTubeInfo($: cheerio.CheerioAPI): string {
        try {
            const title = $('meta[property="og:title"]').attr('content') || $('title').text();
            const channelName = $('meta[property="og:video:tag"]').attr('content') ||
                $('.ytd-channel-name').text() ||
                $('[itemprop="author"]').text();
            const description = $('meta[property="og:description"]').attr('content') ||
                $('meta[name="description"]').attr('content') || '';
            const viewCount = $('[itemprop="interactionCount"]').attr('content') || '不明';

            return `YouTube動画: ${title}\nチャンネル: ${channelName}\n説明: ${description.substring(0, 500)}${description.length > 500 ? '...' : ''}\n再生回数: ${viewCount}`;
        } catch (error) {
            return 'YouTube動画情報の抽出に失敗しました。';
        }
    }

    // Twitter/Xの投稿情報抽出
    private extractTwitterInfo($: cheerio.CheerioAPI): string {
        try {
            const title = $('meta[property="og:title"]').attr('content') || $('title').text();
            const description = $('meta[property="og:description"]').attr('content') ||
                $('meta[name="description"]').attr('content') || '';

            return `Twitter/X投稿:\nタイトル: ${title}\n内容: ${description}`;
        } catch (error) {
            return 'Twitter/X投稿情報の抽出に失敗しました。';
        }
    }

    async _call(data: z.infer<typeof this.schema>): Promise<string> {
        try {
            logger.info(`URLからコンテンツを取得します: ${data.url}`);

            // 大きなレスポンスを制限するための設定
            const response = await axios.get(data.url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
                },
                maxContentLength: this.MAX_RESPONSE_SIZE,
                timeout: 10000, // 10秒のタイムアウト
            });

            // レスポンスの処理
            switch (data.extractMode) {
                case 'html':
                    // HTMLモードの場合、サイズを制限して返す
                    if (typeof response.data === 'string') {
                        return response.data.substring(0, this.MAX_HTML_RETURN_LENGTH) +
                            (response.data.length > this.MAX_HTML_RETURN_LENGTH ? '\n... (省略されました)' : '');
                    }
                    return JSON.stringify(response.data).substring(0, this.MAX_HTML_RETURN_LENGTH);

                case 'json':
                    // JSONモードの場合
                    if (typeof response.data === 'object') {
                        return JSON.stringify(response.data, null, 2).substring(0, this.MAX_RETURN_TEXT_LENGTH);
                    }
                    return String(response.data).substring(0, this.MAX_RETURN_TEXT_LENGTH);

                case 'text':
                default:
                    // HTMLからテキストを抽出（サイト特有の処理を含む）
                    if (typeof response.data === 'string' && response.data.includes('<')) {
                        try {
                            const $ = cheerio.load(response.data);

                            // サイト特有の処理
                            const url = data.url.toLowerCase();
                            if (url.includes('youtube.com/watch') || url.includes('youtu.be/')) {
                                return this.extractYouTubeInfo($);
                            } else if (url.includes('twitter.com') || url.includes('x.com')) {
                                return this.extractTwitterInfo($);
                            }

                            // メタデータの取得
                            const title = $('title').text();
                            const description = $('meta[name="description"]').attr('content') ||
                                $('meta[property="og:description"]').attr('content') || '';
                            const ogImage = $('meta[property="og:image"]').attr('content') || '';

                            // 本文テキストの抽出（HTMLタグを除去）
                            $('script, style, noscript, iframe, img').remove(); // 不要な要素を削除
                            let bodyText = $('body').text()
                                .replace(/\s+/g, ' ')
                                .trim();

                            // 長すぎる場合は切り詰め
                            const metaSize = 200 + title.length + description.length + ogImage.length;
                            const maxBody = this.MAX_RETURN_TEXT_LENGTH - metaSize;
                            if (bodyText.length > maxBody) {
                                bodyText = bodyText.substring(0, maxBody) + '...';
                            }

                            let result = `URL: ${data.url}\nタイトル: ${title}\n説明: ${description}`;
                            if (ogImage) result += `\n画像: ${ogImage}`;
                            result += `\n\n内容:\n${bodyText}`;
                            return result.substring(0, this.MAX_RETURN_TEXT_LENGTH);
                        } catch (error) {
                            return `HTMLの解析に失敗しました: ${error}\n生のレスポンス: ${String(response.data).substring(0, 500)}...`;
                        }
                    }
                    return String(response.data).substring(0, this.MAX_RETURN_TEXT_LENGTH);
            }
        } catch (error) {
            logger.error('URL取得エラー:', error);
            if (axios.isAxiosError(error)) {
                if (error.code === 'ECONNABORTED') {
                    return 'URLの取得中にタイムアウトが発生しました。サイトのサイズが大きすぎる可能性があります。';
                }
                const statusCode = error.response?.status;
                const statusText = error.response?.statusText;
                return `URLの取得中にエラーが発生しました: ${statusCode} ${statusText}`;
            }
            return `URLの取得中にエラーが発生しました: ${error}`;
        }
    }
} 