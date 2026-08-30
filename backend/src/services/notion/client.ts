import { Client } from "@notionhq/client";
import type { BlockObjectResponse, RichTextItemResponse } from "@notionhq/client/build/src/api-endpoints";
import { NotionClientOutput } from '@shannon/common';
import { BaseClient } from '../common/BaseClient.js';
import { registerNotionToolPort } from '../runtime/platformToolGateway.js';
import { registerServiceCommandHandler } from '../runtime/serviceCommandRegistry.js';
import { emitWebServiceStatus } from '../web/webNotificationHub.js';
import { config } from '../../config/env.js';
import { logger } from '../../utils/logger.js';

export class NotionClient extends BaseClient {
    private client: Client;
    private myUserId: string | null = null;
    public isTest: boolean = false;
    private gatewaysRegistered = false;

    private static instance: NotionClient;

    public static getInstance(isTest?: boolean) {
        if (!NotionClient.instance) {
            NotionClient.instance = new NotionClient('notion', isTest ?? false);
        }
        if (isTest !== undefined) {
            NotionClient.instance.isTest = isTest;
        }
        NotionClient.instance.myUserId = config.twitter.userId || null;
        return NotionClient.instance;
    }

    private constructor(serviceName: 'notion', isTest: boolean) {
        super(serviceName);
        const apiKey = config.notion.apiKey;

        if (!apiKey) {
            throw new Error('Notion APIの認証情報が設定されていません');
        }

        this.client = new Client({ auth: apiKey });
    }

    private registerGateways() {
        if (this.gatewaysRegistered) return;
        this.gatewaysRegistered = true;

        registerNotionToolPort({
            getPageMarkdown: (pageId) => this.getPageMarkdown(pageId),
        });

        registerServiceCommandHandler('notion', async (command) => {
            if (command === 'start') {
                await this.start();
            } else if (command === 'stop') {
                await this.stop();
            } else if (command === 'status') {
                emitWebServiceStatus({
                    service: 'notion',
                    status: this.status,
                });
            }
        });
    }

    public async getPageMarkdown(pageId: string): Promise<NotionClientOutput> {
        try {
            const markdown = await this.getPageBlocksToMarkdown(pageId);
            const title = await this.getPageTitle(pageId);
            return {
                title,
                content: markdown,
            };
        } catch (error: unknown) {
            if ((error as { code?: string })?.code === 'object_not_found') {
                logger.info(`[Notion] ページとして見つからないため、データベースとして取得: ${pageId}`);
                try {
                    const dbResult = await this.queryDatabase(pageId);
                    return {
                        title: dbResult.title,
                        content: dbResult.content,
                    };
                } catch (dbError: unknown) {
                    logger.error(`[Notion] データベース取得エラー: ${dbError instanceof Error ? dbError.message : String(dbError)}`);
                    return {
                        title: 'エラー',
                        content: [`Notionのページ/データベースを取得できませんでした。\nエラー: ${dbError instanceof Error ? dbError.message : String(dbError)}\n\n対象のページまたはデータベースがNotion Integrationと共有されているか確認してください。\nNotion > ページ右上の「...」 > 接続 > シャノンのIntegrationを追加`],
                    };
                }
            }

            logger.error(`[Notion] ページ取得エラー: ${error instanceof Error ? (error as Error).message : String(error)}`);
            return {
                title: 'エラー',
                content: [`Notionのページ取得中にエラーが発生しました。\nエラー: ${error instanceof Error ? (error as Error).message : String(error)}`],
            };
        }
    }

    async getPageTitle(pageId: string) {
        const response = await this.client.pages.properties.retrieve({ page_id: pageId, property_id: "title" });
        const resp = response as { results?: Array<{ title?: { plain_text?: string } }>; property_item?: { title?: { plain_text?: string } } };
        const title = resp?.results?.[0]?.title?.plain_text
            || resp?.property_item?.title?.plain_text
            || '';
        return title;
    }

    /**
     * データベースの情報とエントリをクエリして返す
     */
    async queryDatabase(databaseId: string, pageSize: number = 50): Promise<{ title: string; content: string[] }> {
        const uuid = this.toUuid(databaseId);
        logger.info(`[Notion] データベースクエリ: ${uuid}`);

        const dbMeta = await this.client.databases.retrieve({ database_id: uuid });

        const dbTitle = (dbMeta as { title?: Array<{ plain_text: string }> }).title?.map((t) => t.plain_text).join('') || 'Untitled Database';

        const properties = Object.entries(dbMeta.properties);
        const propertyNames = properties.map(([name]) => name);

        const queryResponse = await this.client.databases.query({
            database_id: uuid,
            page_size: pageSize,
        });

        const content: string[] = [];
        content.push(`## データベース: ${dbTitle}`);
        content.push(`プロパティ: ${propertyNames.join(', ')}`);
        content.push(`エントリ数: ${queryResponse.results.length}件`);
        content.push('---');

        for (const page of queryResponse.results) {
            if (!('properties' in page)) continue;
            const entry: string[] = [];

            for (const [propName, propValue] of Object.entries(page.properties)) {
                const value = this.extractPropertyValue(propValue as { type: string; [key: string]: unknown });
                if (value) {
                    entry.push(`${propName}: ${value}`);
                }
            }

            if (entry.length > 0) {
                content.push(entry.join(' | '));
            }
        }

        return { title: dbTitle, content };
    }

    /**
     * Notionプロパティ値を文字列に変換
     */
    private extractPropertyValue(prop: { type: string; [key: string]: unknown }): string {
        if (!prop) return '';
        const p = prop as Record<string, unknown>;
        switch (prop.type) {
            case 'title':
                return (p.title as Array<{ plain_text: string }> | undefined)?.map((t) => t.plain_text).join('') || '';
            case 'rich_text':
                return (p.rich_text as Array<{ plain_text: string }> | undefined)?.map((t) => t.plain_text).join('') || '';
            case 'number':
                return p.number != null ? String(p.number) : '';
            case 'select':
                return (p.select as { name?: string } | undefined)?.name || '';
            case 'multi_select':
                return (p.multi_select as Array<{ name: string }> | undefined)?.map((s) => s.name).join(', ') || '';
            case 'date': {
                const dateVal = p.date as { start?: string; end?: string } | undefined;
                if (!dateVal) return '';
                const start = dateVal.start || '';
                const end = dateVal.end ? ` → ${dateVal.end}` : '';
                return `${start}${end}`;
            }
            case 'checkbox':
                return p.checkbox ? '✅' : '❌';
            case 'url':
                return (p.url as string) || '';
            case 'email':
                return (p.email as string) || '';
            case 'phone_number':
                return (p.phone_number as string) || '';
            case 'status':
                return (p.status as { name?: string } | undefined)?.name || '';
            case 'people':
                return (p.people as Array<{ name?: string }> | undefined)?.map((person) => person.name || 'Unknown').join(', ') || '';
            case 'relation':
                return (p.relation as unknown[] | undefined)?.length ? `(${(p.relation as unknown[]).length}件のリレーション)` : '';
            case 'formula': {
                const formula = p.formula as { type?: string; string?: string; number?: number; boolean?: boolean; date?: { start?: string } } | undefined;
                if (formula?.type === 'string') return formula.string || '';
                if (formula?.type === 'number') return String(formula.number ?? '');
                if (formula?.type === 'boolean') return formula.boolean ? 'true' : 'false';
                if (formula?.type === 'date') return formula.date?.start || '';
                return '';
            }
            case 'rollup': {
                const rollup = p.rollup as { type?: string; number?: number; array?: unknown[] } | undefined;
                if (rollup?.type === 'number') return String(rollup.number ?? '');
                if (rollup?.type === 'array') return `(${rollup.array?.length || 0}件)`;
                return '';
            }
            case 'created_time':
                return (p.created_time as string) || '';
            case 'last_edited_time':
                return (p.last_edited_time as string) || '';
            case 'created_by':
                return (p.created_by as { name?: string } | undefined)?.name || '';
            case 'last_edited_by':
                return (p.last_edited_by as { name?: string } | undefined)?.name || '';
            case 'files':
                return (p.files as Array<{ name?: string; file?: { url?: string }; external?: { url?: string } }> | undefined)?.map((f) => f.name || f.file?.url || f.external?.url || '').join(', ') || '';
            default:
                return '';
        }
    }

    private toUuid(id: string): string {
        if (id.includes('-')) return id;
        return [
            id.substring(0, 8),
            id.substring(8, 12),
            id.substring(12, 16),
            id.substring(16, 20),
            id.substring(20)
        ].join('-');
    }

    private extractRichText(richTextArray: RichTextItemResponse[]): string {
        if (!richTextArray || !Array.isArray(richTextArray)) return "";
        return richTextArray.map(rt => ('text' in rt ? rt.text.content : null) || rt.plain_text || "").join("");
    }

    private getImageUrl(imageBlock: Extract<BlockObjectResponse, { type: 'image' }>): string | null {
        const imageData = imageBlock.image;
        if (!imageData) return null;

        if (imageData.type === 'file') {
            return imageData.file?.url || null;
        } else if (imageData.type === 'external') {
            return imageData.external?.url || null;
        }
        return null;
    }

    private blockToMarkdown(block: BlockObjectResponse, indent: number = 0): string {
        const indentStr = "  ".repeat(indent);
        let content = "";

        if (block.type === "paragraph") {
            content = this.extractRichText(block.paragraph.rich_text);
        } else if (block.type === "heading_1") {
            content = `# ${this.extractRichText(block.heading_1.rich_text)}`;
        } else if (block.type === "heading_2") {
            content = `## ${this.extractRichText(block.heading_2.rich_text)}`;
        } else if (block.type === "heading_3") {
            content = `### ${this.extractRichText(block.heading_3.rich_text)}`;
        } else if (block.type === "bulleted_list_item") {
            content = `${indentStr}- ${this.extractRichText(block.bulleted_list_item.rich_text)}`;
        } else if (block.type === "numbered_list_item") {
            content = `${indentStr}1. ${this.extractRichText(block.numbered_list_item.rich_text)}`;
        } else if (block.type === "to_do") {
            const checked = block.to_do.checked;
            content = `${indentStr}- [${checked ? 'x' : ' '}] ${this.extractRichText(block.to_do.rich_text)}`;
        } else if (block.type === "toggle") {
            content = `${indentStr}▶ ${this.extractRichText(block.toggle.rich_text)}`;
        } else if (block.type === "code") {
            const language = block.code.language || "";
            content = `\`\`\`${language}\n${this.extractRichText(block.code.rich_text)}\n\`\`\``;
        } else if (block.type === "quote") {
            content = `> ${this.extractRichText(block.quote.rich_text)}`;
        } else if (block.type === "callout") {
            const icon = (block.callout.icon?.type === 'emoji' ? block.callout.icon.emoji : null) || "💡";
            content = `${icon} ${this.extractRichText(block.callout.rich_text)}`;
        } else if (block.type === "divider") {
            content = "---";
        } else if (block.type === "table_row") {
            const cells = block.table_row.cells;
            content = `| ${cells.map((cell: RichTextItemResponse[]) => this.extractRichText(cell)).join(" | ")} |`;
        } else if (block.type === "image") {
            const imageUrl = this.getImageUrl(block);
            const caption = this.extractRichText(block.image.caption);
            if (imageUrl) {
                content = `📷 [画像${caption ? `: ${caption}` : ''}] URL: ${imageUrl}`;
            } else {
                content = "📷 [画像: URLを取得できませんでした]";
            }
        } else if (block.type === "file") {
            const fileData = block.file;
            const fileUrl = (fileData.type === 'file' ? fileData.file.url : fileData.external.url) || "";
            const fileName = block.file.name || "添付ファイル";
            content = `📎 [ファイル: ${fileName}] URL: ${fileUrl}`;
        } else if (block.type === "pdf") {
            const pdfData = block.pdf;
            const pdfUrl = (pdfData.type === 'file' ? pdfData.file.url : pdfData.external.url) || "";
            content = `📄 [PDF] URL: ${pdfUrl}`;
        } else if (block.type === "video") {
            const videoData = block.video;
            const videoUrl = (videoData.type === 'external' ? videoData.external.url : videoData.type === 'file' ? videoData.file.url : "") || "";
            content = `🎥 [動画] URL: ${videoUrl}`;
        } else if (block.type === "embed") {
            const url = block.embed.url || "";
            content = `🔗 [埋め込み] URL: ${url}`;
        } else if (block.type === "bookmark") {
            const url = block.bookmark.url || "";
            content = `🔗 [埋め込み] URL: ${url}`;
        }

        return content;
    }

    async getPageBlocksToMarkdown(pageId: string, indent: number = 0): Promise<string[]> {
        logger.info(`getPageBlocksToMarkdown ${pageId}`, 'blue');
        try {
            const response = await this.client.blocks.children.list({
                block_id: pageId,
            });

            const markdownLines: string[] = [];

            for (const block of response.results) {
                if (!('type' in block)) continue;

                const content = this.blockToMarkdown(block, indent);
                if (content) {
                    markdownLines.push(content);
                }

                if (block.has_children) {
                    const childMarkdown = await this.getPageBlocksToMarkdown(block.id, indent + 1);
                    markdownLines.push(...childMarkdown);
                }
            }

            return markdownLines;
        } catch (error) {
            logger.error(`Notionブロック取得エラー: ${error}`);
            throw error;
        }
    }

    public async initialize() {
        this.registerGateways();
    }
}
