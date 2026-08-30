import { StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { type MemoryPort } from '../../../../modules/memory/index.js';
import { formatPersonStatements, type PersonMemoryPort } from '../../../../modules/memory/personMemory.js';

/**
 * recall-memory ツール
 *
 * 実行ごとに注入された MemoryPort で検索し、関連する記憶を返す。
 * 旧 recall-experience / recall-knowledge / recall-person を統合。
 */
export default class RecallMemoryTool extends StructuredTool {
    /** Request context is never copied from the catalog instance. */
    createForRun(): RecallMemoryTool { return new RecallMemoryTool(); }

    name = 'recall-memory';
    description = '記憶を検索する。「〜について知ってる？」「〜はどこにある？」「〜さんについて教えて」など、過去の体験・知識・人物情報を思い出す。';
    schema = z.object({
        question: z.string().describe('思い出したい内容の質問 (例: "鉄鉱石はどこで見つけた？", "(10,64,20)のチェストに何が入ってた？")'),
    });

    private memoryPort?: MemoryPort;
    private personMemoryPort?: PersonMemoryPort;
    setPersonMemoryPort(port: PersonMemoryPort): void { this.personMemoryPort = port; }
    setMemoryPort(port: MemoryPort): void { this.memoryPort = port; }

    async _call(data: z.infer<typeof this.schema>): Promise<string> {
        if (!this.memoryPort) return '記憶システムが初期化されていません。';
        const rows = (await Promise.all(['experience', 'knowledge'].map(category =>
            this.memoryPort!.search(category as 'experience' | 'knowledge', data.question, 5)))).flat();
        const personRows = await this.personMemoryPort?.recall(5).catch(() => []) ?? [];
        const result = [formatPersonStatements(personRows), ...rows.map(row => row.content)].filter(Boolean).join('\n');
        return result || 'この会話で参照できる記憶はありません。';
    }
}
