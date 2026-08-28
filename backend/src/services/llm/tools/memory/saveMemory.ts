import { StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
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

    /** ParallelExecutor から MemoryAgent を注入する */
    setMemoryAgent(agent: MemoryAgent): void {
        this.memoryAgent = agent;
    }

    async _call(data: z.infer<typeof this.schema>): Promise<string> {
        if (!this.memoryAgent) {
            return '記憶システムが初期化されていません。';
        }
        await this.memoryAgent.save(data.content, data.importance);
        return `記憶に保存しました: ${data.content.substring(0, 80)}`;
    }
}
