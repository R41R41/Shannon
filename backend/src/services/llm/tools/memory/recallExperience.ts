import { StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import type { MemoryPort } from '../../../../modules/memory/index.js';

export default class RecallExperienceTool extends StructuredTool {
  name = 'recall-experience';
  description =
    '自分の過去の体験・出来事を思い出す。体験にはそのときの感想も含まれる。';
  schema = z.object({
    query: z
      .string()
      .describe(
        '思い出したい体験のキーワード (例: "クリーパー", "バレンタイン", "ライと建築")',
      ),
    limit: z
      .number()
      .optional()
      .describe('取得件数 (デフォルト5)'),
  });

  private memoryPort?: MemoryPort;
  createForRun(): RecallExperienceTool { return new RecallExperienceTool(); }
  setMemoryPort(port: MemoryPort): void { this.memoryPort = port; }

  async _call(data: z.infer<typeof this.schema>): Promise<string> {
    try {
      const results = await this.memoryPort?.search('experience', data.query, data.limit ?? 5) ?? [];

      if (results.length === 0) {
        return 'その体験は思い出せない…まだ経験してないかも。';
      }

      const lines = results.map((r) => {
        const date = r.createdAt.toLocaleDateString('ja-JP', {
          month: 'numeric',
          day: 'numeric',
        });
        const feeling = r.feeling ? ` → ${r.feeling}` : '';
        return `[${date}] ${r.content}${feeling}`;
      });

      return `思い出した体験:\n${lines.join('\n')}`;
    } catch (error) {
      return `思い出せなかった: ${error}`;
    }
  }
}
