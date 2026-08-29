import { StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { getNotionToolPort } from '../../../runtime/platformToolGateway.js';
import { cacheNotionImageUrls } from '../image/describeNotionImage.js';
import { logger } from '../../../../utils/logger.js';

export default class GetNotionPageContentFromUrlTool extends StructuredTool {
    name = 'get-notion-page-content-from-url';
    description = 'NotionのページまたはデータベースのURLからタイトルと内容を取得するツール。通常のページもデータベース（カレンダーやテーブル等）も対応。';
    schema = z.object({
        url: z
            .string()
            .describe('取得したいNotionのページまたはデータベースのURL。有効なURLを指定してください。'),
    });

    private extractFileName(url: string): string {
        try {
            const urlObj = new URL(url);
            const pathname = urlObj.pathname;
            const parts = pathname.split('/');
            const fileName = parts[parts.length - 1];
            const decoded = decodeURIComponent(fileName);
            if (decoded.length > 40) {
                return decoded.substring(0, 37) + '...';
            }
            return decoded;
        } catch {
            return '(ファイル名取得不可)';
        }
    }

    private extractPageId(url: string): string | null {
        const parts = url.split('/');
        const lastPart = parts[parts.length - 1];
        const pathPart = lastPart.split('?')[0];
        const match = pathPart.match(/([a-f0-9]{32})$/i) || pathPart.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i);

        if (match) {
            return match[1];
        }

        return null;
    }

    async _call(data: z.infer<typeof this.schema>): Promise<string> {
        try {
            const url = data.url;
            if (!url.includes('notion.so/')) {
                return 'NotionのページURLを指定してください。';
            }

            const pageId = this.extractPageId(url);
            if (!pageId) {
                return `NotionのURLからページIDを抽出できませんでした: ${url}`;
            }

            logger.info(`get-notion-page-content-from-url ${pageId}`);
            const response = await getNotionToolPort().getPageMarkdown(pageId);
            const contentArray = Array.isArray(response.content) ? response.content : [response.content];

            const imageUrls: { index: number; caption: string; url: string }[] = [];
            const processedContent: string[] = [];

            for (const line of contentArray) {
                const imageMatch = line.match(/📷 \[画像(?:: ([^\]]*))?\] URL: (.+)/);
                if (imageMatch) {
                    const caption = imageMatch[1] || '';
                    const imageUrl = imageMatch[2];
                    const index = imageUrls.length + 1;
                    imageUrls.push({ index, caption, url: imageUrl });
                    processedContent.push(`📷 [画像${index}${caption ? `: ${caption}` : ''}]`);
                } else {
                    processedContent.push(line);
                }
            }

            let result = `Notionのページからコンテンツを取得しました。\n\nタイトル: ${response.title}\n\n内容:\n${processedContent.join('\n')}`;

            if (imageUrls.length > 0) {
                cacheNotionImageUrls(imageUrls.map(img => img.url));

                result += `\n\n━━━━━━━━━━━━━━━━━━━━\n`;
                result += `📷 画像一覧（${imageUrls.length}件）- URLはキャッシュ済み\n`;
                result += `━━━━━━━━━━━━━━━━━━━━\n`;
                for (const img of imageUrls) {
                    const fileName = this.extractFileName(img.url);
                    result += `[画像${img.index}] ${fileName}\n`;
                }
                result += `\n🚨 **重要**: describe-notion-image ツールを使って、すべての画像を分析してください。`;
                result += `\n例: describe-notion-image(image_number: 1), describe-notion-image(image_number: 2)...`;
                result += `\n画像を分析せずにユーザーに報告しないでください。`;
            }

            return result;
        } catch (error) {
            logger.error('get-notion-page-content-from-url error:', error);
            return `An error occurred while getting content from Notion: ${error}`;
        }
    }
}
