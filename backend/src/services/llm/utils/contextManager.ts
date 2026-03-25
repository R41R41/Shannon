/**
 * コンテキストウィンドウの動的管理。
 * トークン数ベースで会話履歴をトリミングし、
 * 古いメッセージをサマリーに圧縮する。
 */
import { BaseMessage, HumanMessage, AIMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { createLogger } from '../../../utils/logger.js';

const log = createLogger('LLM:ContextManager');

const CHARS_PER_TOKEN = 3.5;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function getMessageText(msg: BaseMessage): string {
  return typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
}

export interface ContextConfig {
  maxContextTokens: number;
  reservedForResponse: number;
  summaryPrefix: string;
}

const DEFAULT_CONFIG: ContextConfig = {
  maxContextTokens: 6000,
  reservedForResponse: 2000,
  summaryPrefix: '[以前の会話サマリー]',
};

/**
 * メッセージ配列をトークン上限内にトリミングする。
 * - SystemMessage は常に保持
 * - 最新メッセージを優先的に保持
 * - 古いメッセージはサマリーに圧縮
 * - AIMessage(tool_calls) + 後続の ToolMessage はアトミックブロックとして扱い、
 *   ペアが壊れないようにする
 */
export function trimContext(
  messages: BaseMessage[],
  config: Partial<ContextConfig> = {},
): BaseMessage[] {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const budget = cfg.maxContextTokens - cfg.reservedForResponse;
  if (budget <= 0) return messages.slice(-3);

  const system = messages.filter((m) => m instanceof SystemMessage);
  const nonSystem = messages.filter((m) => !(m instanceof SystemMessage));

  const systemTokens = system.reduce((sum, m) => sum + estimateTokens(getMessageText(m)), 0);
  let remaining = budget - systemTokens;

  if (remaining <= 0) {
    // 最低限: 最後の完全なブロック（AIMessage+ToolMessages ペア）を保持
    const emergencyBlocks: BaseMessage[][] = [];
    let ei = nonSystem.length - 1;
    // 末尾の ToolMessage 群を集める
    while (ei >= 0 && nonSystem[ei] instanceof ToolMessage) ei--;
    // その直前の AIMessage を含むブロック
    if (ei >= 0) {
      const block = [nonSystem[ei]];
      for (let j = ei + 1; j < nonSystem.length; j++) {
        if (nonSystem[j] instanceof ToolMessage) block.push(nonSystem[j]);
        else break;
      }
      emergencyBlocks.push(block);
    }
    const emergencyMsgs = emergencyBlocks.flat();
    return [...system, ...(emergencyMsgs.length > 0 ? emergencyMsgs : nonSystem.slice(-1))];
  }

  // AIMessage(tool_calls) + 後続 ToolMessage(s) をアトミックブロックにまとめる
  const blocks: BaseMessage[][] = [];
  let idx = 0;
  while (idx < nonSystem.length) {
    const msg = nonSystem[idx];
    const hasToolCalls =
      msg instanceof AIMessage &&
      ((msg.tool_calls?.length ?? 0) > 0 ||
       (msg.additional_kwargs?.tool_calls as unknown[])?.length > 0);

    if (hasToolCalls) {
      const block = [msg];
      let j = idx + 1;
      while (j < nonSystem.length && nonSystem[j] instanceof ToolMessage) {
        block.push(nonSystem[j]);
        j++;
      }
      blocks.push(block);
      idx = j;
    } else {
      blocks.push([msg]);
      idx++;
    }
  }

  // 最新ブロックから逆順に追加
  const kept: BaseMessage[] = [];
  const dropped: BaseMessage[] = [];

  for (let b = blocks.length - 1; b >= 0; b--) {
    const blockTokens = blocks[b].reduce(
      (sum, m) => sum + estimateTokens(getMessageText(m)),
      0,
    );
    if (remaining - blockTokens >= 0) {
      kept.unshift(...blocks[b]);
      remaining -= blockTokens;
    } else {
      for (let d = 0; d <= b; d++) {
        dropped.push(...blocks[d]);
      }
      break;
    }
  }

  // ドロップされたメッセージをサマリー化
  if (dropped.length > 0) {
    const summaryLines = dropped
      .filter((m) => !(m instanceof ToolMessage))
      .map((m) => {
        const role = m instanceof HumanMessage ? 'User' : 'AI';
        const text = getMessageText(m);
        return `${role}: ${text.slice(0, 80)}${text.length > 80 ? '...' : ''}`;
      })
      .slice(-5);

    if (summaryLines.length > 0) {
      const summary = new SystemMessage(
        `${cfg.summaryPrefix}\n${summaryLines.join('\n')}`,
      );
      return [...system, summary, ...kept];
    }
  }

  return [...system, ...kept];
}

/**
 * トークン数を推定して返す（デバッグ用）
 */
export function estimateContextTokens(messages: BaseMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(getMessageText(m)), 0);
}
