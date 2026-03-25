/**
 * ScopedMemoryService
 *
 * Scoped recall and writeback for the unified Shannon graph.
 * Replaces the MemoryNode wrapper pattern with direct scope-aware queries.
 *
 * Design doc Section 7-8:
 * - Queries use visibilityScope + channel/world/project tags
 * - Privacy filter prevents cross-user leakage
 * - Ranking: semantic similarity + same_user + same_channel + recency
 * - Writeback sets proper scope metadata on all new memories
 *
 * This file is the main entry point. Logic is delegated to:
 * - recall/RecallEngine.ts
 * - recall/ScopeDeriver.ts
 * - writeback/WritebackProcessor.ts
 * - writeback/AutonomyUpdater.ts
 * - formatting/MemoryFormatter.ts
 */

import { EmbeddingService } from './embeddingService.js';
import {
  ShannonMemoryService,
} from './shannonMemoryService.js';
import {
  PersonMemoryService,
} from './personMemoryService.js';
import { IPersonMemory } from '../../models/PersonMemory.js';
import { IShannonMemory } from '../../models/ShannonMemory.js';
import type {
  InternalState,
  RelationshipModel,
  RequestEnvelope,
  ShannonSelfModel,
  StrategyUpdate,
  UserProfileSnapshot,
  WorldModelPattern,
} from '@shannon/common';
import { logger } from '../../utils/logger.js';

import { RecallEngine } from './recall/RecallEngine.js';
import { ScopeDeriver } from './recall/ScopeDeriver.js';
import { WritebackProcessor, ScopedWritebackInput } from './writeback/WritebackProcessor.js';
import { MemoryFormatter } from './formatting/MemoryFormatter.js';
import { IExchange } from '../../models/PersonMemory.js';

// ---------------------------------------------------------------------------
// Re-export types for consumers
// ---------------------------------------------------------------------------

export interface ScopedRecallQuery {
  envelope: RequestEnvelope;
  text: string;
  /** true の場合、person/selfModel/relationship/semantic search をスキップ（Minecraft 高速パス用） */
  lightweightMode?: boolean;
}

export interface ScopedRecallResult {
  person: IPersonMemory | null;
  memories: IShannonMemory[];
  userProfile: UserProfileSnapshot | null;
  relationshipModel: RelationshipModel | null;
  selfModel: ShannonSelfModel | null;
  strategyUpdates: StrategyUpdate[];
  internalState: InternalState | null;
  worldModelPatterns: WorldModelPattern[];
  relationshipPrompt: string;
  selfModelPrompt: string;
  strategyPrompt: string;
  internalStatePrompt: string;
  worldModelPrompt: string;
  formattedPrompt: string;
}

export { ScopedWritebackInput };

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class ScopedMemoryService {
  private static instance: ScopedMemoryService;
  private static readonly CONSOLIDATOR_INTERVAL_MS = 3000;

  private recallEngine: RecallEngine;
  private scopeDeriver: ScopeDeriver;
  private writebackProcessor: WritebackProcessor;
  private formatter: MemoryFormatter;

  private constructor() {
    const embeddingService = EmbeddingService.getInstance();
    const shannonService = ShannonMemoryService.getInstance();
    const personService = PersonMemoryService.getInstance();

    this.scopeDeriver = new ScopeDeriver();
    this.recallEngine = new RecallEngine(embeddingService, personService);
    this.formatter = new MemoryFormatter(shannonService, personService);
    this.writebackProcessor = new WritebackProcessor(
      shannonService,
      personService,
      (envelope: RequestEnvelope) => this.recallEngine.resolveCanonicalUserId(envelope),
    );

    setInterval(() => {
      this.processPendingWritebacks().catch((err) => {
        logger.error('❌ ScopedMemory consolidator tick error:', err);
      });
    }, ScopedMemoryService.CONSOLIDATOR_INTERVAL_MS);
  }

  static getInstance(): ScopedMemoryService {
    if (!ScopedMemoryService.instance) {
      ScopedMemoryService.instance = new ScopedMemoryService();
    }
    return ScopedMemoryService.instance;
  }

  // ========== Recall ==========

  /**
   * Scoped recall: retrieves memories relevant to the request,
   * filtered by visibility scope and privacy rules.
   */
  async recall(query: ScopedRecallQuery): Promise<ScopedRecallResult> {
    const { envelope, text, lightweightMode } = query;
    const userId = this.recallEngine.resolveCanonicalUserId(envelope);
    const channel = envelope.channel;
    const scopeTags = this.scopeDeriver.deriveScopeTags(envelope);

    // Phase 2-C: 軽量モード（Minecraft アクション向け）
    // person, selfModel, relationship, internalState, semantic search をスキップ
    // strategyUpdates と worldPatterns のみ取得（-1〜4秒）
    if (lightweightMode) {
      const [strategyUpdates, worldModelPatterns] = await Promise.all([
        this.recallEngine.recallStrategyUpdates(envelope, userId, scopeTags),
        this.recallEngine.recallWorldPatterns(envelope, scopeTags),
      ]);
      const strategyPrompt = this.formatter.formatStrategyPrompt(strategyUpdates);
      const worldModelPrompt = this.formatter.formatWorldPatternPrompt(worldModelPatterns);
      const formattedPrompt = [strategyPrompt, worldModelPrompt].filter(Boolean).join('\n\n');
      return {
        person: null,
        memories: [],
        userProfile: null,
        relationshipModel: null,
        selfModel: null,
        strategyUpdates,
        internalState: null,
        worldModelPatterns,
        relationshipPrompt: '',
        selfModelPrompt: '',
        strategyPrompt,
        internalStatePrompt: '',
        worldModelPrompt,
        formattedPrompt,
      };
    }

    // 1. Recall person
    const person = await this.recallEngine.recallPerson(envelope);
    const userProfile = this.recallEngine.toUserProfile(person);
    const relationshipModel = this.recallEngine.toRelationshipModel(person, userId);
    const [
      selfModel,
      strategyUpdates,
      internalState,
      worldModelPatterns,
    ] = await Promise.all([
      this.recallEngine.recallSelfModel(),
      this.recallEngine.recallStrategyUpdates(envelope, userId, scopeTags),
      this.recallEngine.recallInternalState(),
      this.recallEngine.recallWorldPatterns(envelope, scopeTags),
    ]);

    const relationshipPrompt = this.formatter.formatRelationshipPrompt(relationshipModel, person);
    const selfModelPrompt = this.formatter.formatSelfModelPrompt(selfModel);
    const strategyPrompt = this.formatter.formatStrategyPrompt(strategyUpdates);
    const internalStatePrompt = this.formatter.formatInternalStatePrompt(internalState);
    const worldModelPrompt = this.formatter.formatWorldPatternPrompt(worldModelPatterns);

    if (!text) {
      const formattedPrompt = [
        relationshipPrompt,
        selfModelPrompt,
        strategyPrompt,
        internalStatePrompt,
        worldModelPrompt,
      ].filter(Boolean).join('\n\n');
      return {
        person,
        memories: [],
        userProfile,
        relationshipModel,
        selfModel,
        strategyUpdates,
        internalState,
        worldModelPatterns,
        relationshipPrompt,
        selfModelPrompt,
        strategyPrompt,
        internalStatePrompt,
        worldModelPrompt,
        formattedPrompt,
      };
    }

    // 2. Semantic search
    const semanticResults = await this.recallEngine.semanticSearch(text);

    // 3. Tag-based search
    const tagResults = await this.recallEngine.searchByTags(envelope, text);

    // 4. Merge + deduplicate
    const seenIds = new Set<string>();
    const allMemories: IShannonMemory[] = [];
    for (const mem of [...semanticResults, ...tagResults]) {
      const id = mem._id.toString();
      if (!seenIds.has(id)) {
        seenIds.add(id);
        allMemories.push(mem);
      }
    }

    // 5. Privacy filter
    const filtered = this.recallEngine.privacyFilter(allMemories, userId, channel, envelope);

    // 6. Rank
    const ranked = this.recallEngine.rank(filtered, userId, channel, envelope);

    // 7. Format
    const formattedPrompt = this.formatter.formatForPrompt(ranked);

    return {
      person,
      memories: ranked,
      userProfile,
      relationshipModel,
      selfModel,
      strategyUpdates,
      internalState,
      worldModelPatterns,
      relationshipPrompt,
      selfModelPrompt,
      strategyPrompt,
      internalStatePrompt,
      worldModelPrompt,
      formattedPrompt,
    };
  }

  // ========== Writeback ==========

  async writeback(input: ScopedWritebackInput): Promise<void> {
    return this.writebackProcessor.writeback(input);
  }

  async runAutonomyUpdaters(
    envelope: RequestEnvelope,
    conversationText: string,
  ): Promise<void> {
    // Delegate to the writeback processor's autonomy updater
    // (accessed through processPendingWritebacks path, but also callable directly)
    const { AutonomyUpdater } = await import('./writeback/AutonomyUpdater.js');
    const autonomyUpdater = new AutonomyUpdater(
      PersonMemoryService.getInstance(),
      this.scopeDeriver,
      (env: RequestEnvelope) => this.recallEngine.resolveCanonicalUserId(env),
    );
    return autonomyUpdater.runAutonomyUpdaters(envelope, conversationText);
  }

  async processPendingWritebacks(limit = 10): Promise<void> {
    return this.writebackProcessor.processPendingWritebacks(limit);
  }
}
