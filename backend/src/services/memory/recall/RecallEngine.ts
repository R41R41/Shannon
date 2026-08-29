/**
 * RecallEngine
 *
 * Handles all recall logic: semantic search, tag-based search,
 * person recall, self-model/strategy/internal-state/world-pattern recall,
 * privacy filtering, and ranking/scoring.
 */

import { deriveMemoryScope, memoryScopeFilter, canReadMemory } from '../../../modules/memory/index.js';
import { createRequestPersonMemory } from '../requestPersonMemory.js';
import type { PersonStatement } from '../../../modules/memory/personMemory.js';
import { ShannonMemory, IShannonMemory } from '../../../models/ShannonMemory.js';
import { EmbeddingService } from '../embeddingService.js';
import { IPersonMemory } from '../../../models/PersonMemory.js';
import type {
  InternalState,
  RelationshipModel,
  RequestEnvelope,
  ShannonChannel,
  ShannonSelfModel,
  StrategyUpdate,
  UserProfileSnapshot,
  WorldModelPattern,
} from '@shannon/common';
import { logger } from '../../../utils/logger.js';
import { ScopeDeriver } from './ScopeDeriver.js';
import { normalizeUnitValue, safeISOString } from '../formatting/MemoryFormatter.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SEMANTIC_TOP_K = 7;
const SEMANTIC_RANDOM_N = 2;

/** Bonus multipliers for ranking */
const SAME_USER_BONUS = 1.3;
const SAME_CHANNEL_BONUS = 1.2;
const SAME_WORLD_BONUS = 1.15;
const RECENCY_DECAY_DAYS = 30;

const channelToSource: Record<ShannonChannel, string> = {
  discord: 'discord',
  x: 'twitter',
  minecraft: 'minebot',
  web: 'web',
  youtube: 'youtube',
  scheduler: 'web',
  notion: 'notion',
  internal: 'unknown',
};

export class RecallEngine {
  private embeddingService: EmbeddingService;
  private scopeDeriver: ScopeDeriver;

  constructor(embeddingService: EmbeddingService) {
    this.embeddingService = embeddingService;
    this.scopeDeriver = new ScopeDeriver();
  }

  // ========== Person recall ==========

  async recallPerson(envelope: RequestEnvelope): Promise<IPersonMemory | null> {
    // Legacy PersonMemory combines DM/public/other-channel exchanges. Quarantine until scoped migration.
    return null;
  }

  async recallPersonStatements(envelope: RequestEnvelope): Promise<PersonStatement[]> {
    return createRequestPersonMemory(envelope).recall(5);
  }

  // ========== Semantic search ==========

  async semanticSearch(text: string, envelope?: RequestEnvelope): Promise<IShannonMemory[]> {
    const scope = deriveMemoryScope(envelope);
    if (!scope) return [];
    try {
      const results = await this.embeddingService.search(text, SEMANTIC_TOP_K, SEMANTIC_RANDOM_N, undefined, scope);
      return results.filter(
        (mem) => mem.category === 'experience' || mem.category === 'knowledge',
      );
    } catch (err) {
      logger.warn(`⚠ ScopedMemory: semantic search failed: ${err}`);
      return [];
    }
  }

  // ========== Tag-based search ==========

  async searchByTags(envelope: RequestEnvelope, text: string): Promise<IShannonMemory[]> {
    const scope = deriveMemoryScope(envelope);
    if (!scope) return [];
    const scopeTags = this.scopeDeriver.deriveScopeTags(envelope);

    try {
      return await ShannonMemory.find({
        ...memoryScopeFilter(scope),
        category: { $in: ['experience', 'knowledge'] },
        $or: [
          { channelTags: { $in: scopeTags } },
          { worldTags: { $in: scopeTags } },
          { projectTags: { $in: scopeTags } },
          { tags: { $in: scopeTags } },
          { ownerUserId: this.resolveCanonicalUserId(envelope) },
        ],
      })
        .sort({ importance: -1, createdAt: -1 })
        .limit(10)
        .lean();
    } catch {
      return [];
    }
  }

  // ========== Self-model recall ==========

  async recallSelfModel(envelope?: RequestEnvelope): Promise<ShannonSelfModel | null> {
    const scope = deriveMemoryScope(envelope);
    if (!scope) return null;
    const doc = await ShannonMemory.findOne({
      category: 'self_model',
      ...memoryScopeFilter(scope),
    })
      .sort({ createdAt: -1 })
      .lean();
    if (!doc?.selfModelData) return null;
    return {
      stableIdentity: {
        coreMission: doc.selfModelData.stableIdentity?.coreMission ?? [],
        behavioralPrinciples: doc.selfModelData.stableIdentity?.behavioralPrinciples ?? [],
        toneIdentity: doc.selfModelData.stableIdentity?.toneIdentity ?? [],
      },
      capabilities: {
        strengths: doc.selfModelData.capabilities?.strengths ?? [],
        weaknesses: doc.selfModelData.capabilities?.weaknesses ?? [],
        knownFailurePatterns: doc.selfModelData.capabilities?.knownFailurePatterns ?? [],
      },
      activeImprovementGoals: (doc.selfModelData.activeImprovementGoals ?? []).map((goal) => ({
        ...goal,
      })),
      recentSelfObservations: (doc.selfModelData.recentSelfObservations ?? []).map((obs) => ({
        timestamp: obs.timestamp.toISOString(),
        observation: obs.observation,
        confidence: obs.confidence,
      })),
    };
  }

  // ========== Strategy recall ==========

  async recallStrategyUpdates(
    envelope: RequestEnvelope,
    canonicalUserId: string,
    scopeTags: string[],
  ): Promise<StrategyUpdate[]> {
    const scope = deriveMemoryScope(envelope);
    if (!scope) return [];
    const docs = await ShannonMemory.find({
      ...memoryScopeFilter(scope),
      category: 'strategy_update',
      $or: [
        { ownerUserId: canonicalUserId },
        { generalized: true },
        { visibilityScope: 'self_model' },
        { relationTags: { $in: scopeTags } },
        { channelTags: { $in: scopeTags } },
      ],
    })
      .sort({ importance: -1, createdAt: -1 })
      .limit(envelope.channel === 'minecraft' ? 5 : 3)
      .lean();

    return docs
      .map((doc) => doc.strategyUpdateData)
      .filter(Boolean)
      .map((strategy) => ({
        id: strategy!.id,
        basedOnFailure: strategy!.basedOnFailure,
        triggerConditions: strategy!.triggerConditions ?? [],
        newStrategy: strategy!.newStrategy,
        appliesToModes: strategy!.appliesToModes ?? [],
        appliesToUsers: strategy!.appliesToUsers ?? [],
        confidence: strategy!.confidence,
        createdAt: strategy!.createdAt.toISOString(),
      }));
  }

  // ========== Internal state recall ==========

  async recallInternalState(envelope?: RequestEnvelope): Promise<InternalState | null> {
    const scope = deriveMemoryScope(envelope);
    if (!scope) return null;
    const doc = await ShannonMemory.findOne({
      category: 'internal_state_snapshot',
      ...memoryScopeFilter(scope),
    })
      .sort({ createdAt: -1 })
      .lean();
    if (!doc?.internalStateSnapshot) return null;
    const normalized = {
      curiosity: normalizeUnitValue(doc.internalStateSnapshot.curiosity),
      caution: normalizeUnitValue(doc.internalStateSnapshot.caution),
      confidence: normalizeUnitValue(doc.internalStateSnapshot.confidence),
      warmth: normalizeUnitValue(doc.internalStateSnapshot.warmth),
      focus: normalizeUnitValue(doc.internalStateSnapshot.focus),
      load: normalizeUnitValue(doc.internalStateSnapshot.load),
    };
    if (Object.values(normalized).some((value) => value === null)) {
      return null;
    }
    return {
      curiosity: normalized.curiosity!,
      caution: normalized.caution!,
      confidence: normalized.confidence!,
      warmth: normalized.warmth!,
      focus: normalized.focus!,
      load: normalized.load!,
      reasonNotes: doc.internalStateSnapshot.reasonNotes ?? [],
      updatedAt: safeISOString(doc.internalStateSnapshot.updatedAt) ?? new Date().toISOString(),
    };
  }

  // ========== World pattern recall ==========

  async recallWorldPatterns(
    envelope: RequestEnvelope,
    scopeTags: string[],
  ): Promise<WorldModelPattern[]> {
    const scope = deriveMemoryScope(envelope);
    if (!scope) return [];
    const docs = await ShannonMemory.find({
      ...memoryScopeFilter(scope),
      category: 'world_pattern',
      $or: [
        { generalized: true },
        { worldTags: { $in: scopeTags } },
        { projectTags: { $in: scopeTags } },
        { channelTags: { $in: scopeTags } },
        { tags: { $in: scopeTags } },
      ],
    })
      .sort({ importance: -1, createdAt: -1 })
      .limit(envelope.channel === 'minecraft' ? 5 : 3)
      .lean();

    return docs
      .map((doc) => doc.worldPatternData)
      .filter(Boolean)
      .map((pattern) => ({
        id: pattern!.id,
        domain: pattern!.domain,
        pattern: pattern!.pattern,
        evidenceIds: pattern!.evidenceIds ?? [],
        confidence: pattern!.confidence,
        applicability: pattern!.applicability ?? [],
        updatedAt: pattern!.updatedAt.toISOString(),
      }));
  }

  // ========== Privacy filter ==========

  privacyFilter(
    memories: IShannonMemory[],
    currentUserId: string,
    _channel: ShannonChannel,
    envelope: RequestEnvelope,
  ): IShannonMemory[] {
    const scope = deriveMemoryScope(envelope);
    return memories.filter(memory => canReadMemory(scope, memory));
  }

  // ========== Ranking ==========

  rank(
    memories: IShannonMemory[],
    currentUserId: string,
    channel: ShannonChannel,
    envelope: RequestEnvelope,
  ): IShannonMemory[] {
    const channelSource = channelToSource[channel];
    const worldTags = new Set(this.scopeDeriver.deriveWorldTags(envelope));

    const scored = memories.map((mem) => {
      let score = mem.importance;

      if (mem.ownerUserId === currentUserId) {
        score *= SAME_USER_BONUS;
      }

      if (mem.source === channelSource) {
        score *= SAME_CHANNEL_BONUS;
      }

      if (mem.worldTags?.some((t) => worldTags.has(t))) {
        score *= SAME_WORLD_BONUS;
      }

      const ageMs = Date.now() - new Date(mem.createdAt).getTime();
      const ageDays = ageMs / (1000 * 60 * 60 * 24);
      const recencyBonus = Math.exp(-ageDays / RECENCY_DECAY_DAYS);
      score += recencyBonus * 2;

      if (mem.generalized) {
        score += 1;
      }

      return { mem, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 10).map((s) => s.mem);
  }

  // ========== Helpers ==========

  resolveCanonicalUserId(envelope: RequestEnvelope): string {
    return deriveMemoryScope(envelope)?.ownerUserId ?? 'unknown';
  }

  toUserProfile(_person: IPersonMemory | null): UserProfileSnapshot | null {
    return null;
  }

  toRelationshipModel(
    _person: IPersonMemory | null,
    _userId: string,
  ): RelationshipModel | null {
    return null;
  }
}
