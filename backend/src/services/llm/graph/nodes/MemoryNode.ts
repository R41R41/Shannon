import type { TaskContext } from '@shannon/common';
import type { IShannonMemory } from '../../../../models/ShannonMemory.js';
import type { IPersonMemory, IExchange } from '../../../../models/PersonMemory.js';

/**
 * MemoryNode に渡す入力
 */
export interface MemoryNodeInput {
  userMessage: string | null;
  context: TaskContext | null;
}

/**
 * MemoryNode の出力 (FunctionCallingAgent に渡す共有状態)
 */
export interface MemoryState {
  person: IPersonMemory | null;
  experiences: IShannonMemory[];
  knowledge: IShannonMemory[];
}

/**
 * postProcess に渡す入力
 */
export interface PostProcessInput {
  context: TaskContext | null;
  /** ユーザーメッセージとシャノンの応答 */
  conversationText: string;
  /** recentExchanges に追加する会話 */
  exchanges: IExchange[];
}

/**
 * Compatibility shell for old X/YouTube agents. TaskContext lacks a reviewed
 * audience contract, so no recall, extraction, model construction or global
 * maintenance is allowed here. Migrate callers to the RequestEnvelope port.
 */
export class MemoryNode {
  async initialize(): Promise<void> {}
  async preProcess(_input: MemoryNodeInput): Promise<MemoryState> {
    return { person: null, experiences: [], knowledge: [] };
  }
  async postProcess(_input: PostProcessInput): Promise<void> {}
  async formatForSystemPrompt(_state: MemoryState): Promise<string> { return ''; }
}
