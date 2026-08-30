import { StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { type MemoryPort } from '../../../../modules/memory/index.js';

/**
 * save-memory ツール
 *
 * 実行ごとに注入された MemoryPort へ保存する。LLM 判断なしで即保存。
 * 旧 save-experience / save-knowledge を統合。
 */
export default class SaveMemoryTool extends StructuredTool {
    /** Request context is never copied from the catalog instance. */
    createForRun(): SaveMemoryTool { return new SaveMemoryTool(); }

    name = 'save-memory';
    description = '覚えておきたいことを記憶に保存する。チェストの中身、場所の情報、学んだことなど。';
    schema = z.object({
        content: z.string().describe('保存する内容 (例: "チェスト(10,64,20)にiron_ingot x3が入っていた")'),
        importance: z.number().optional().describe('重要度 (1-10, デフォルト5)'),
    });

    private memoryPort?: MemoryPort;
    setMemoryPort(port: MemoryPort): void { this.memoryPort = port; }

    async _call(data: z.infer<typeof this.schema>): Promise<string> {
        if (!this.memoryPort) return '記憶システムが初期化されていません。';
        const result = await this.memoryPort.save({ category: 'knowledge', content: data.content, importance: data.importance ?? 5, tags: [] });
        return result.message;
    }
}
