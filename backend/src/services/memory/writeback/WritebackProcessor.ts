import { snapshotMemoryEnvelope } from '../requestMemory.js';
/**
 * WritebackProcessor
 *
 * Handles memory extraction from conversations, pending event processing,
 * and the periodic writeback consolidation timer logic.
 */

import { deriveMemoryScope } from '../../../modules/memory/index.js';
import { MemoryWriteEvent, IMemoryWriteEvent } from '../../../models/MemoryWriteEvent.js';
import {
  ShannonMemoryService,
  ShannonMemoryInput,
} from '../shannonMemoryService.js';
import { IExchange } from '../../../models/PersonMemory.js';
import type { MemoryCategory } from '../../../models/ShannonMemory.js';
import type { RequestEnvelope } from '@shannon/common';
import { logger } from '../../../utils/logger.js';
import { ScopeDeriver, channelToSource } from '../recall/ScopeDeriver.js';
import { AutonomyUpdater } from './AutonomyUpdater.js';
import { parseLlmJsonObject } from './parseLlmJson.js';

export interface ScopedWritebackInput {
  envelope: RequestEnvelope;
  conversationText: string;
  exchanges: IExchange[];
}

/** Every field is optional because the extraction model, not the schema, produces it. */
interface ExtractedMemory {
  category?: MemoryCategory;
  content?: string;
  feeling?: string;
  importance?: number;
  tags?: string[];
}

export class WritebackProcessor {
  private shannonService: ShannonMemoryService;
  private scopeDeriver: ScopeDeriver;
  private autonomyUpdater: AutonomyUpdater;
  private isProcessingEvents = false;

  constructor(
    shannonService: ShannonMemoryService,
    resolveCanonicalUserId: (envelope: RequestEnvelope) => string,
  ) {
    this.shannonService = shannonService;
    this.scopeDeriver = new ScopeDeriver();
    this.autonomyUpdater = new AutonomyUpdater(this.scopeDeriver, resolveCanonicalUserId);
  }

  async writeback(input: ScopedWritebackInput): Promise<void> {
    const { conversationText, exchanges } = input;
    const envelope = snapshotMemoryEnvelope(input.envelope);
    const scope = deriveMemoryScope(envelope);
    if (!scope) return;
    if (conversationText.trim()) {
      await MemoryWriteEvent.create({
        eventId: crypto.randomUUID(),
        sourceRequestId: envelope.requestId,
        channel: envelope.channel,
        conversationId: envelope.conversationId,
        threadId: envelope.threadId,
        sourceUserId: scope.ownerUserId,
        scopeVersion: 1,
        scopeKey: scope.scopeKey,
        payload: {
          envelope: envelope as unknown as Record<string, unknown>,
          conversationText,
          exchanges,
        },
      });
    }

    // PersonMemory mixes audiences; do not append new conversations until migrated.
  }

  async processPendingWritebacks(limit = 10): Promise<void> {
    if (this.isProcessingEvents) return;
    this.isProcessingEvents = true;

    try {
      while (true) {
        const event = await MemoryWriteEvent.findOneAndUpdate(
          { status: 'pending', scopeVersion: 1 },
          { $set: { status: 'processing' } },
          { sort: { createdAt: 1 }, new: true },
        ).lean<IMemoryWriteEvent | null>();

        if (!event) break;

        try {
          const envelope = event.payload.envelope as unknown as RequestEnvelope;
          const scope = deriveMemoryScope(envelope);
          if (!scope || scope.scopeKey !== event.scopeKey || scope.ownerUserId !== event.sourceUserId) throw new Error('MEMORY_SCOPE_MISMATCH');
          const source = channelToSource[envelope.channel] ?? 'unknown';
          await this.extractAndSaveWithScope(event.payload.conversationText, source, envelope);
          await this.autonomyUpdater.runAutonomyUpdaters(
            envelope,
            event.payload.conversationText,
          );
          await MemoryWriteEvent.updateOne(
            { _id: event._id },
            { $set: { status: 'processed', processedAt: new Date() } },
          );
        } catch (error) {
          await MemoryWriteEvent.updateOne(
            { _id: event._id },
            {
              $set: {
                status: 'error',
                errorMessage: error instanceof Error ? error.message : String(error),
              },
            },
          );
        }

        limit -= 1;
        if (limit <= 0) break;
      }
    } finally {
      this.isProcessingEvents = false;
    }
  }

  private async extractAndSaveWithScope(
    conversationText: string,
    source: string,
    envelope: RequestEnvelope,
  ): Promise<void> {
    const scope = deriveMemoryScope(envelope);
    if (!scope) throw new Error('MEMORY_SCOPE_REQUIRED');
    const { ChatOpenAI } = await import('@langchain/openai');
    const { SystemMessage, HumanMessage } = await import('@langchain/core/messages');
    const { loadPrompt } = await import('../../llm/config/prompts.js');
    const { config } = await import('../../../config/env.js');

    const systemPrompt = await loadPrompt('extract_memories') ??
      '会話から記憶すべき体験と知識を JSON で抽出してください。';

    const model = new ChatOpenAI({
      modelName: 'gpt-4.1-mini',
      temperature: 0.3,
      apiKey: config.openaiApiKey,
    });

    const response = await model.invoke([
      new SystemMessage(systemPrompt),
      new HumanMessage(conversationText),
    ]);

    const content = response.content.toString().trim();
    try {
      const parsed = parseLlmJsonObject(content) as { memories?: unknown } | null;
      if (!Array.isArray(parsed?.memories)) return;

      for (const memory of parsed.memories as ExtractedMemory[]) {
        if (!memory.category || !memory.content || !memory.tags) continue;
        if (typeof memory.importance !== 'number' || memory.importance < 4) continue;

        const memoryInput: ShannonMemoryInput = {
          category: memory.category,
          content: memory.content,
          feeling: memory.feeling,
          source,
          importance: memory.importance,
          tags: memory.tags,
        };

        const result = await this.shannonService.saveWithDedup(memoryInput, scope);

        if (result.saved) {
          logger.info(`ScopedMemory: memory saved (scope=${scope.visibilityScope})`);
        }
      }
    } catch (error) {
      logger.error('❌ ScopedMemory extract parse error:', error);
    }
  }
}
