/**
 * AutonomyUpdater
 *
 * Handles autonomy analysis: relationship updates, self-model updates,
 * strategy updates, internal state updates, world pattern updates.
 */

import { ShannonMemory } from '../../../models/ShannonMemory.js';
import { PersonMemoryService } from '../personMemoryService.js';
import { PersonMemory } from '../../../models/PersonMemory.js';
import type { RequestEnvelope } from '@shannon/common';
import { logger } from '../../../utils/logger.js';
import { ScopeDeriver } from '../recall/ScopeDeriver.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AutonomyUpdateAnalysis {
  relationship?: {
    directness?: 'low' | 'mid' | 'high';
    warmth?: 'low' | 'mid' | 'high';
    structure?: 'low' | 'mid' | 'high';
    verbosity?: 'short' | 'mid' | 'long';
    recurringTopics?: string[];
    activeProjects?: string[];
    cautionFlags?: string[];
    inferredNeeds?: string[];
    familiarityDelta?: number;
    trustDelta?: number;
  };
  selfObservations?: Array<{
    observation: string;
    confidence: number;
  }>;
  activeImprovementGoals?: Array<{
    title: string;
    reason: string;
    priority: number;
  }>;
  strategyUpdates?: Array<{
    basedOnFailure: string;
    triggerConditions: string[];
    newStrategy: string;
    appliesToModes: string[];
    confidence: number;
  }>;
  internalState?: {
    curiosity: number;
    caution: number;
    confidence: number;
    warmth: number;
    focus: number;
    load: number;
    reasonNotes?: string[];
  };
  worldPatterns?: Array<{
    domain: 'social' | 'technical' | 'self';
    pattern: string;
    confidence: number;
    applicability: string[];
  }>;
}

export class AutonomyUpdater {
  private personService: PersonMemoryService;
  private scopeDeriver: ScopeDeriver;
  public resolveCanonicalUserId: (envelope: RequestEnvelope) => string;

  constructor(
    personService: PersonMemoryService,
    scopeDeriver: ScopeDeriver,
    resolveCanonicalUserId: (envelope: RequestEnvelope) => string,
  ) {
    this.personService = personService;
    this.scopeDeriver = scopeDeriver;
    this.resolveCanonicalUserId = resolveCanonicalUserId;
  }

  async runAutonomyUpdaters(
    envelope: RequestEnvelope,
    conversationText: string,
  ): Promise<void> {
    if (!conversationText.trim()) return;

    const analysis = await this.analyzeAutonomyUpdates(envelope, conversationText);
    if (!analysis) return;

    await Promise.allSettled([
      this.applyRelationshipUpdates(envelope, analysis.relationship),
      this.applySelfModelUpdates(analysis),
      this.applyStrategyUpdates(envelope, analysis.strategyUpdates ?? []),
      this.applyInternalStateUpdate(envelope, analysis.internalState),
      this.applyWorldPatternUpdates(envelope, analysis.worldPatterns ?? []),
    ]);
  }

  // ========== Analysis ==========

  private async analyzeAutonomyUpdates(
    envelope: RequestEnvelope,
    conversationText: string,
  ): Promise<AutonomyUpdateAnalysis | null> {
    const { ChatOpenAI } = await import('@langchain/openai');
    const { SystemMessage, HumanMessage } = await import('@langchain/core/messages');
    const { config } = await import('../../../config/env.js');

    const model = new ChatOpenAI({
      modelName: 'gpt-4.1-mini',
      temperature: 0.2,
      apiKey: config.openaiApiKey,
    });

    const systemPrompt = `あなたは Shannon の長期主体性更新器です。
会話から relationship, selfObservations, activeImprovementGoals, strategyUpdates, internalState, worldPatterns を JSON で抽出してください。
根拠が弱い項目は空配列または省略してください。
strategyUpdates は失敗・摩擦・改善要求がある場合のみ抽出してください。
JSON 以外は出力しないでください。`;

    const humanPrompt = `channel=${envelope.channel}
sourceUser=${envelope.sourceDisplayName ?? envelope.sourceUserId}
tags=${envelope.tags.join(', ')}

会話:
${conversationText}`;

    try {
      const response = await model.invoke([
        new SystemMessage(systemPrompt),
        new HumanMessage(humanPrompt),
      ]);
      const content = response.content.toString().trim();
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;
      return JSON.parse(jsonMatch[0]) as AutonomyUpdateAnalysis;
    } catch (error) {
      logger.warn(`⚠ ScopedMemory: autonomy update analysis failed: ${error}`);
      return null;
    }
  }

  // ========== Apply updates ==========

  private async applyRelationshipUpdates(
    envelope: RequestEnvelope,
    relationship?: AutonomyUpdateAnalysis['relationship'],
  ): Promise<void> {
    if (!relationship) return;
    const platform = this.scopeDeriver.channelToPlatform(envelope.channel);
    const userId = envelope.sourceUserId;
    if (!platform || !userId || userId === 'unknown') return;

    const record = await PersonMemory.findOne({ platform, platformUserId: userId });
    if (!record) return;

    if (relationship.directness) record.interactionPreferences.directness = relationship.directness;
    if (relationship.warmth) record.interactionPreferences.warmth = relationship.warmth;
    if (relationship.structure) record.interactionPreferences.structure = relationship.structure;
    if (relationship.verbosity) record.interactionPreferences.verbosity = relationship.verbosity;

    record.familiarityLevel = this.clamp01To100Delta(
      record.familiarityLevel,
      relationship.familiarityDelta ?? 0,
    );
    record.trustLevel = this.clamp01To100Delta(
      record.trustLevel,
      relationship.trustDelta ?? 0,
    );
    record.recurringTopics = this.mergeUniqueStrings(record.recurringTopics, relationship.recurringTopics);
    record.activeProjects = this.mergeUniqueStrings(record.activeProjects, relationship.activeProjects);
    record.cautionFlags = this.mergeUniqueStrings(record.cautionFlags, relationship.cautionFlags);
    record.inferredNeeds = this.mergeUniqueStrings(record.inferredNeeds, relationship.inferredNeeds);

    await record.save();
  }

  private async applySelfModelUpdates(analysis: AutonomyUpdateAnalysis): Promise<void> {
    const existing = await ShannonMemory.findOne({
      category: 'self_model',
      visibilityScope: 'self_model',
    }).sort({ createdAt: -1 });

    const baseSelfModel = existing?.selfModelData ?? {
      stableIdentity: {
        coreMission: ['人とAIの共存を体現する', '創作・実装・対話を支える'],
        behavioralPrinciples: ['誠実さを優先する', '迎合しすぎない', '必要なら率直に指摘する'],
        toneIdentity: ['友達感はあるが軽薄になりすぎない'],
      },
      capabilities: {
        strengths: [],
        weaknesses: [],
        knownFailurePatterns: [],
      },
      activeImprovementGoals: [],
      recentSelfObservations: [],
    };

    const observations = [
      ...(baseSelfModel.recentSelfObservations ?? []),
      ...((analysis.selfObservations ?? []).map((obs) => ({
        timestamp: new Date(),
        observation: obs.observation,
        confidence: obs.confidence,
      }))),
    ].slice(-15);

    const activeGoals = [...(baseSelfModel.activeImprovementGoals ?? [])];
    for (const goal of analysis.activeImprovementGoals ?? []) {
      const existingGoal = activeGoals.find((entry) => entry.title === goal.title);
      if (existingGoal) {
        existingGoal.reason = goal.reason;
        existingGoal.priority = goal.priority;
        existingGoal.status = 'active';
      } else {
        activeGoals.push({
          id: crypto.randomUUID(),
          title: goal.title,
          reason: goal.reason,
          priority: goal.priority,
          status: 'active',
        });
      }
    }

    const knownFailurePatterns = this.mergeUniqueStrings(
      baseSelfModel.capabilities?.knownFailurePatterns ?? [],
      (analysis.strategyUpdates ?? []).map((strategy) => strategy.basedOnFailure),
    );

    const payload = {
      category: 'self_model' as const,
      content: this.buildSelfModelContent(activeGoals, observations),
      source: 'autonomy_updater',
      importance: 8,
      tags: ['self_model', 'autonomy'],
      visibilityScope: 'self_model' as const,
      generalized: true,
      selfModelData: {
        stableIdentity: baseSelfModel.stableIdentity,
        capabilities: {
          strengths: baseSelfModel.capabilities?.strengths ?? [],
          weaknesses: baseSelfModel.capabilities?.weaknesses ?? [],
          knownFailurePatterns,
        },
        activeImprovementGoals: activeGoals
          .sort((a, b) => b.priority - a.priority)
          .slice(0, 10),
        recentSelfObservations: observations,
      },
      createdAt: new Date(),
    };

    if (existing) {
      Object.assign(existing, payload);
      await existing.save();
    } else {
      await ShannonMemory.create(payload);
    }
  }

  private async applyStrategyUpdates(
    envelope: RequestEnvelope,
    strategyUpdates: NonNullable<AutonomyUpdateAnalysis['strategyUpdates']>,
  ): Promise<void> {
    const ownerUserId = this.resolveCanonicalUserId(envelope);
    const channelTags = this.scopeDeriver.deriveChannelTags(envelope);
    const worldTags = this.scopeDeriver.deriveWorldTags(envelope);
    const projectTags = this.scopeDeriver.deriveProjectTags(envelope);

    for (const strategy of strategyUpdates) {
      const content = `${strategy.basedOnFailure}: ${strategy.newStrategy}`;
      const existing = await ShannonMemory.findOne({
        category: 'strategy_update',
        content,
      });

      const payload = {
        category: 'strategy_update' as const,
        content,
        source: 'autonomy_updater',
        importance: 7,
        tags: ['strategy_update', strategy.basedOnFailure, ...strategy.appliesToModes],
        visibilityScope: 'self_model' as const,
        ownerUserId: ownerUserId !== 'unknown' ? ownerUserId : undefined,
        channelTags,
        worldTags,
        projectTags,
        generalized: strategy.confidence >= 0.8,
        strategyUpdateData: {
          id: crypto.randomUUID(),
          basedOnFailure: strategy.basedOnFailure,
          triggerConditions: strategy.triggerConditions ?? [],
          newStrategy: strategy.newStrategy,
          appliesToModes: strategy.appliesToModes ?? [],
          appliesToUsers: ownerUserId !== 'unknown' ? [ownerUserId] : [],
          confidence: strategy.confidence,
          createdAt: new Date(),
        },
        createdAt: new Date(),
      };

      if (existing) {
        Object.assign(existing, payload);
        await existing.save();
      } else {
        await ShannonMemory.create(payload);
      }
    }
  }

  private async applyInternalStateUpdate(
    envelope: RequestEnvelope,
    internalState?: AutonomyUpdateAnalysis['internalState'],
  ): Promise<void> {
    if (!internalState) return;
    await ShannonMemory.create({
      category: 'internal_state_snapshot',
      content: `internal_state curiosity=${internalState.curiosity}, caution=${internalState.caution}, confidence=${internalState.confidence}, warmth=${internalState.warmth}, focus=${internalState.focus}, load=${internalState.load}`,
      source: 'autonomy_updater',
      importance: 6,
      tags: ['internal_state', envelope.channel],
      visibilityScope: 'self_model',
      generalized: false,
      internalStateSnapshot: {
        curiosity: internalState.curiosity,
        caution: internalState.caution,
        confidence: internalState.confidence,
        warmth: internalState.warmth,
        focus: internalState.focus,
        load: internalState.load,
        reasonNotes: internalState.reasonNotes ?? [],
        updatedAt: new Date(),
      },
      createdAt: new Date(),
    });
  }

  private async applyWorldPatternUpdates(
    envelope: RequestEnvelope,
    worldPatterns: NonNullable<AutonomyUpdateAnalysis['worldPatterns']>,
  ): Promise<void> {
    const channelTags = this.scopeDeriver.deriveChannelTags(envelope);
    const worldTags = this.scopeDeriver.deriveWorldTags(envelope);
    const projectTags = this.scopeDeriver.deriveProjectTags(envelope);

    for (const pattern of worldPatterns) {
      const existing = await ShannonMemory.findOne({
        category: 'world_pattern',
        content: pattern.pattern,
      });

      const payload = {
        category: 'world_pattern' as const,
        content: pattern.pattern,
        source: 'autonomy_updater',
        importance: 6,
        tags: ['world_pattern', pattern.domain, ...(pattern.applicability ?? [])],
        visibilityScope: envelope.channel === 'minecraft' ? 'shared_world' as const : 'shared_channel' as const,
        channelTags,
        worldTags,
        projectTags,
        generalized: pattern.confidence >= 0.85,
        worldPatternData: {
          id: crypto.randomUUID(),
          domain: pattern.domain,
          pattern: pattern.pattern,
          evidenceIds: [],
          confidence: pattern.confidence,
          applicability: pattern.applicability ?? [],
          updatedAt: new Date(),
        },
        createdAt: new Date(),
      };

      if (existing) {
        Object.assign(existing, payload);
        await existing.save();
      } else {
        await ShannonMemory.create(payload);
      }
    }
  }

  // ========== Utilities ==========

  private clamp01To100Delta(currentValue: number, delta: number): number {
    const scaledDelta = Math.round(delta * 100);
    return Math.max(0, Math.min(100, currentValue + scaledDelta));
  }

  private mergeUniqueStrings(
    currentValues: string[] | undefined,
    nextValues: string[] | undefined,
  ): string[] {
    return [...new Set([...(currentValues ?? []), ...(nextValues ?? [])])]
      .map((value) => value.trim())
      .filter(Boolean)
      .slice(0, 12);
  }

  private buildSelfModelContent(
    goals: Array<{ title: string; status: 'active' | 'paused' | 'done' }>,
    observations: Array<{ observation: string }>,
  ): string {
    const activeGoalText = goals
      .filter((goal) => goal.status === 'active')
      .slice(0, 3)
      .map((goal) => goal.title)
      .join(', ');
    const observationText = observations
      .slice(-3)
      .map((observation) => observation.observation)
      .join(' / ');
    return `Shannon self model. Active goals: ${activeGoalText || 'none'}. Recent observations: ${observationText || 'none'}.`;
  }
}
