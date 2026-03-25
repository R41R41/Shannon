/**
 * RecallEngine
 *
 * Handles all recall logic: semantic search, tag-based search,
 * person recall, self-model/strategy/internal-state/world-pattern recall,
 * privacy filtering, and ranking/scoring.
 */

import { ShannonMemory, IShannonMemory } from '../../../models/ShannonMemory.js';
import { EmbeddingService } from '../embeddingService.js';
import { PersonMemoryService } from '../personMemoryService.js';
import { IPersonMemory, MemoryPlatform } from '../../../models/PersonMemory.js';
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
  private personService: PersonMemoryService;
  private scopeDeriver: ScopeDeriver;

  constructor(
    embeddingService: EmbeddingService,
    personService: PersonMemoryService,
  ) {
    this.embeddingService = embeddingService;
    this.personService = personService;
    this.scopeDeriver = new ScopeDeriver();
  }

  // ========== Person recall ==========

  async recallPerson(envelope: RequestEnvelope): Promise<IPersonMemory | null> {
    const platform = this.scopeDeriver.channelToPlatform(envelope.channel);
    const userId = envelope.sourceUserId;
    if (!platform || !userId || userId === 'unknown') return null;

    try {
      return await this.personService.getOrCreate(
        platform,
        userId,
        envelope.sourceDisplayName ?? 'Unknown',
      );
    } catch (err) {
      logger.warn(`⚠ ScopedMemory: person recall failed: ${err}`);
      return null;
    }
  }

  // ========== Semantic search ==========

  async semanticSearch(text: string): Promise<IShannonMemory[]> {
    if (this.embeddingService.cacheSize <= 0) return [];
    try {
      const results = await this.embeddingService.search(text, SEMANTIC_TOP_K, SEMANTIC_RANDOM_N);
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
    const scopeTags = this.scopeDeriver.deriveScopeTags(envelope);
    if (scopeTags.length === 0) return [];

    try {
      return await ShannonMemory.find({
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

  async recallSelfModel(): Promise<ShannonSelfModel | null> {
    const doc = await ShannonMemory.findOne({
      category: 'self_model',
      visibilityScope: 'self_model',
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
    const docs = await ShannonMemory.find({
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

  async recallInternalState(): Promise<InternalState | null> {
    const doc = await ShannonMemory.findOne({
      category: 'internal_state_snapshot',
      visibilityScope: 'self_model',
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
    const docs = await ShannonMemory.find({
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
    const scopeTags = new Set(this.scopeDeriver.deriveScopeTags(envelope));

    return memories.filter((mem) => {
      const scope = mem.visibilityScope ?? 'shared_channel';

      switch (scope) {
        case 'private_user':
          return mem.ownerUserId === currentUserId;

        case 'shared_world':
          return !mem.worldTags?.length || mem.worldTags.some((t) => scopeTags.has(t));

        case 'shared_project':
          return !mem.projectTags?.length || mem.projectTags.some((t) => scopeTags.has(t));

        case 'shared_channel':
          return !mem.channelTags?.length || mem.channelTags.some((t) => scopeTags.has(t));

        case 'global_generalized':
        case 'self_model':
          return true;

        default:
          return true;
      }
    });
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
    const platform = this.scopeDeriver.channelToPlatform(envelope.channel);
    const userId = envelope.sourceUserId;
    if (!platform || !userId || userId === 'unknown') return 'unknown';
    return this.personService.resolveCanonicalPersonId(
      platform,
      userId,
      envelope.sourceDisplayName ?? undefined,
    );
  }

  toUserProfile(person: IPersonMemory | null): UserProfileSnapshot | null {
    if (!person) return null;
    const platformMap: Record<MemoryPlatform, UserProfileSnapshot['platform']> = {
      discord: 'discord',
      twitter: 'x',
      youtube: 'youtube',
      minebot: 'minecraft',
    };
    return {
      userId: person.canonicalPersonId,
      displayName: person.displayName,
      platform: platformMap[person.platform],
      traits: person.traits,
      notes: person.notes,
      conversationSummary: person.conversationSummary,
      totalInteractions: person.totalInteractions,
      relationshipLevel: this.toRelationshipLevel(person.familiarityLevel),
    };
  }

  toRelationshipModel(
    person: IPersonMemory | null,
    userId: string,
  ): RelationshipModel | null {
    if (!person) return null;
    return {
      userId,
      familiarityLevel: person.familiarityLevel ?? 0,
      trustLevel: person.trustLevel ?? 0,
      interactionPreferences: {
        directness: person.interactionPreferences?.directness ?? 'mid',
        warmth: person.interactionPreferences?.warmth ?? 'mid',
        structure: person.interactionPreferences?.structure ?? 'mid',
        verbosity: person.interactionPreferences?.verbosity ?? 'mid',
      },
      recurringTopics: person.recurringTopics ?? [],
      activeProjects: person.activeProjects ?? [],
      cautionFlags: person.cautionFlags ?? [],
      inferredNeeds: person.inferredNeeds ?? [],
      updatedAt: person.lastSeenAt.toISOString(),
    };
  }

  private toRelationshipLevel(
    familiarityLevel: number | undefined,
  ): UserProfileSnapshot['relationshipLevel'] {
    const level = familiarityLevel ?? 0;
    if (level >= 80) return 'close_friend';
    if (level >= 55) return 'friend';
    if (level >= 25) return 'acquaintance';
    return 'stranger';
  }
}
