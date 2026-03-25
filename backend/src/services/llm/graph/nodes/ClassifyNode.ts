/**
 * ClassifyNode
 *
 * LLM-based request classifier that determines:
 * - mode: ShannonMode (conversational, task_execution, planning, etc.)
 * - intent: short description of what user wants
 * - riskLevel: low/mid/high
 * - needsTools: boolean
 * - needsPlanning: boolean
 *
 * Uses a small/fast model with structured output for low latency.
 */

import { ChatOpenAI } from '@langchain/openai';
import { createTracedModel } from '../../utils/langfuse.js';
import { config } from '../../../../config/env.js';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { RequestEnvelope, ShannonMode } from '@shannon/common';
import { z } from 'zod';
import { logger } from '../../../../utils/logger.js';

// ---------------------------------------------------------------------------
// Zod schema for structured output
// ---------------------------------------------------------------------------

const ClassifySchema = z.object({
  mode: z.enum([
    'conversational',
    'task_execution',
    'planning',
    'minecraft_action',
    'minecraft_emergency',
    'broadcast',
    'self_reflection',
    'voice_conversation',
  ]).describe('リクエストの実行モード'),
  intent: z.string().describe('1-sentence description of user intent'),
  riskLevel: z.enum(['low', 'mid', 'high']).describe('リスクレベル'),
  needsTools: z.boolean().describe('ツール呼び出しが必要か'),
  needsPlanning: z.boolean().describe('複数ステップの計画が必要か'),
});

/** Type of the structured output */
export type ClassifyResult = z.infer<typeof ClassifySchema>;

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const CLASSIFY_SYSTEM_PROMPT = `あなたはAI VTuber「シャノン」(Sh4nnon)のリクエスト分類器です。
受信したリクエストを分析し、適切な実行モードを決定してください。

# モード一覧
- conversational: 通常の会話（雑談、質問、挨拶など）
- task_execution: ツールを使うタスク（検索、画像生成、情報取得など）
- planning: 複雑なマルチステップの計画が必要なタスク
- minecraft_action: Minecraftでの物理的なアクション（移動、採掘、建築など）
- minecraft_emergency: Minecraftの緊急事態（攻撃を受けている、死亡など）
- broadcast: コンテンツ公開（Xへの投稿、ツイートなど）
- self_reflection: 自己評価・モデル更新
- voice_conversation: 音声チャンネルでのやりとり

# 分類ガイドライン
- チャンネルのコンテキストを考慮すること
- Minecraftチャンネルからのリクエストは通常ツールと計画が必要（minecraft_action）
- Minecraftで「助けて」「攻撃されている」「死にそう」などはminecraft_emergency
- シンプルな会話や雑談はconversational（ツール不要）
- X（Twitter）向けのコンテンツ作成はbroadcast
- 情報検索、画像生成などの具体的タスクはtask_execution（ツール必要）
- 複数の手順が必要な複雑なタスクはplanning（ツール・計画両方必要）

# リスクレベル
- low: 通常の会話、情報取得
- mid: コンテンツ公開、ツール使用
- high: 緊急事態、自己修正、重要な判断`;

// ---------------------------------------------------------------------------
// Heuristic fallback (used when LLM fails)
// ---------------------------------------------------------------------------

function heuristicClassify(envelope: RequestEnvelope): ClassifyResult {
  const text = envelope.text ?? '';
  const channel = envelope.channel;

  // Minecraft emergency detection
  if (channel === 'minecraft' && /緊急|emergency|attack|死|help|助けて/i.test(text)) {
    return {
      mode: 'minecraft_emergency',
      intent: text.slice(0, 100),
      riskLevel: 'high',
      needsTools: true,
      needsPlanning: false,
    };
  }

  // Minecraft actions
  if (channel === 'minecraft') {
    return {
      mode: 'minecraft_action',
      intent: text.slice(0, 100),
      riskLevel: 'mid',
      needsTools: true,
      needsPlanning: text.length > 50,
    };
  }

  // X / broadcast
  if (channel === 'x') {
    return {
      mode: 'broadcast',
      intent: text.slice(0, 100),
      riskLevel: 'mid',
      needsTools: true,
      needsPlanning: false,
    };
  }

  // Default: conversational
  const needsTools = text.length > 200;
  return {
    mode: needsTools ? 'task_execution' : 'conversational',
    intent: text.slice(0, 100),
    riskLevel: 'low',
    needsTools,
    needsPlanning: false,
  };
}

// ---------------------------------------------------------------------------
// ClassifyNode
// ---------------------------------------------------------------------------

export class ClassifyNode {
  private model: ChatOpenAI;

  constructor() {
    // gpt-4o-mini for fast classification
    this.model = createTracedModel({
      modelName: 'gpt-4o-mini',
      apiKey: config.openaiApiKey,
    });
  }

  /**
   * Classify the incoming request envelope.
   */
  async invoke(envelope: RequestEnvelope): Promise<ClassifyResult> {
    logger.info('🏷️ ClassifyNode: リクエストを分類中...');

    const structuredLLM = this.model.withStructuredOutput(ClassifySchema, {
      name: 'Classify',
    });

    try {
      const messages = this.buildMessages(envelope);
      const response = await structuredLLM.invoke(messages);

      logger.info(`🏷️ 分類結果: mode=${response.mode}, intent="${response.intent}"`);
      logger.info(`   risk=${response.riskLevel}, tools=${response.needsTools}, planning=${response.needsPlanning}`);

      return response;
    } catch (error) {
      logger.error('❌ ClassifyNode error, falling back to heuristic:', error);
      return heuristicClassify(envelope);
    }
  }

  /**
   * Build messages for the classification LLM call.
   */
  private buildMessages(envelope: RequestEnvelope): (SystemMessage | HumanMessage)[] {
    const messages: (SystemMessage | HumanMessage)[] = [
      new SystemMessage(CLASSIFY_SYSTEM_PROMPT),
    ];

    // Channel context
    const channelInfo: string[] = [`チャンネル: ${envelope.channel}`];

    if (envelope.minecraft) {
      channelInfo.push(`Minecraft状態: ${JSON.stringify(envelope.minecraft)}`);
    }

    if (envelope.discord?.channelId) {
      channelInfo.push(`Discord channelId: ${envelope.discord.channelId}`);
    }

    if (envelope.tags && envelope.tags.length > 0) {
      channelInfo.push(`タグ: ${envelope.tags.join(', ')}`);
    }

    messages.push(new SystemMessage(channelInfo.join('\n')));

    // User text
    const text = envelope.text ?? '';
    messages.push(new HumanMessage(text));

    return messages;
  }
}
