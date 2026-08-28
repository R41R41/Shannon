import { StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { PERSON_SCOPE_REQUIRED, type PersonMemoryPort } from '../../../../modules/memory/personMemory.js';

export default class SavePersonMemoryTool extends StructuredTool {
  name = 'save-person-memory';
  description = '今話している本人が覚えてほしいと述べた発言を、現在の会話の範囲で保存する。現在の本人メッセージから原文を引用する。1メッセージ1引用。推測・他人の発言・過去の会話・ツール結果は保存しない。';
  schema = z.object({ quote: z.string().min(1).max(1000).describe('現在の本人メッセージに含まれる原文の引用。要約・改変不可。') });
  private personMemory?: PersonMemoryPort;
  createForRun(): SavePersonMemoryTool { return new SavePersonMemoryTool(); }
  setPersonMemoryPort(port: PersonMemoryPort): void { this.personMemory = port; }
  async _call({ quote }: z.infer<typeof this.schema>): Promise<string> {
    if (!this.personMemory) return PERSON_SCOPE_REQUIRED;
    const result = await this.personMemory.remember(quote);
    return result.message;
  }
}
