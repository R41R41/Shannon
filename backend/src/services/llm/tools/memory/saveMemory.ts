import { StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { type MemoryPort } from '../../../../modules/memory/index.js';
import type { MemoryAgent } from '../../graph/cognitive/MemoryAgent.js';

/**
 * save-memory ツール
 *
 * MemoryAgent に保存を依頼する。LLM 判断なしで即保存。
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

    private memoryAgent: MemoryAgent | null = null;
    private memoryPort?: MemoryPort;
    setMemoryPort(port: MemoryPort): void { this.memoryPort = port; }

    /** ParallelExecutor から MemoryAgent を注入する */
    setMemoryAgent(agent: MemoryAgent): void {
        this.memoryAgent = agent;
    }

    async _call(data: z.infer<typeof this.schema>): Promise<string> {
        if (this.memoryAgent) {
            const result = await this.memoryAgent.save(data.content, data.importance);
            return result.message;
        }
        if (!this.memoryPort) return '記憶システムが初期化されていません。';
        const result = await this.memoryPort.save({ category: 'knowledge', content: data.content, importance: data.importance ?? 5, tags: [] });
        return result.message;
    }
}
