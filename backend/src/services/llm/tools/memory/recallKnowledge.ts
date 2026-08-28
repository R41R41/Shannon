import { StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import type { MemoryPort } from '../../../../modules/memory/index.js';

export default class RecallKnowledgeTool extends StructuredTool {
  name = 'recall-knowledge';
  description = '自分が学んだ知識・事実を思い出す。';
  schema = z.object({
    query: z
      .string()
      .describe(
        '思い出したい知識のキーワード (例: "レッドストーン", "Python", "大谷翔平")',
      ),
    limit: z
      .number()
      .optional()
      .describe('取得件数 (デフォルト5)'),
  });

  private memoryPort?: MemoryPort;
  createForRun(): RecallKnowledgeTool { return new RecallKnowledgeTool(); }
  setMemoryPort(port: MemoryPort): void { this.memoryPort = port; }

  async _call(data: z.infer<typeof this.schema>): Promise<string> {
    try {
      const results = await this.memoryPort?.search('knowledge', data.query, data.limit ?? 5) ?? [];

      if (results.length === 0) {
        return 'その知識は持ってない…まだ学んでないかも。';
      }

      const lines = results.map((r) => `- ${r.content}`);
      return `知ってること:\n${lines.join('\n')}`;
    } catch (error) {
      return `思い出せなかった: ${error}`;
    }
  }
}
