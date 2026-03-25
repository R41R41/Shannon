/**
 * MemoryFormatter
 *
 * All formatting methods that convert memories/models to prompt text.
 */

import { IShannonMemory } from '../../../models/ShannonMemory.js';
import { IPersonMemory } from '../../../models/PersonMemory.js';
import { ShannonMemoryService } from '../shannonMemoryService.js';
import { PersonMemoryService } from '../personMemoryService.js';
import type {
  InternalState,
  RelationshipModel,
  ShannonSelfModel,
  StrategyUpdate,
  WorldModelPattern,
} from '@shannon/common';

// ---------------------------------------------------------------------------
// Standalone utility functions (also used by RecallEngine)
// ---------------------------------------------------------------------------

export function normalizeUnitValue(value: unknown): number | null {
  if (typeof value !== 'number' || Number.isNaN(value) || !Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, Math.min(1, value));
}

export function safeISOString(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// MemoryFormatter class
// ---------------------------------------------------------------------------

export class MemoryFormatter {
  private shannonService: ShannonMemoryService;
  private personService: PersonMemoryService;

  constructor(
    shannonService: ShannonMemoryService,
    personService: PersonMemoryService,
  ) {
    this.shannonService = shannonService;
    this.personService = personService;
  }

  formatPerson(person: IPersonMemory | null): string {
    if (!person) return '';
    return this.personService.formatForPrompt(person);
  }

  formatForPrompt(memories: IShannonMemory[]): string {
    const sections: string[] = [];

    const experiences = memories.filter((m) => m.category === 'experience');
    const knowledge = memories.filter((m) => m.category === 'knowledge');

    if (experiences.length > 0 || knowledge.length > 0) {
      const memText = this.shannonService.formatForPrompt(experiences, knowledge);
      if (memText) {
        sections.push(`## ボクの関連する記憶\n${memText}`);
      }
    }

    return sections.join('\n\n');
  }

  formatRelationshipPrompt(
    relationshipModel: RelationshipModel | null,
    person: IPersonMemory | null,
  ): string {
    if (!relationshipModel || !person) return '';
    const lines = [`## Relationship profile (${person.displayName})`];
    lines.push(
      `- 親密度=${relationshipModel.familiarityLevel}/100, 信頼度=${relationshipModel.trustLevel}/100`,
    );
    lines.push(
      `- 対話傾向: 率直さ=${relationshipModel.interactionPreferences.directness}, 温かさ=${relationshipModel.interactionPreferences.warmth}, 構造化=${relationshipModel.interactionPreferences.structure}, 長さ=${relationshipModel.interactionPreferences.verbosity}`,
    );
    if (relationshipModel.activeProjects.length > 0) {
      lines.push(`- 進行中テーマ: ${relationshipModel.activeProjects.join(', ')}`);
    }
    if (relationshipModel.cautionFlags.length > 0) {
      lines.push(`- 注意点: ${relationshipModel.cautionFlags.join(', ')}`);
    }
    if (relationshipModel.inferredNeeds.length > 0) {
      lines.push(`- 推定ニーズ: ${relationshipModel.inferredNeeds.join(', ')}`);
    }
    return lines.join('\n');
  }

  formatSelfModelPrompt(selfModel: ShannonSelfModel | null): string {
    if (!selfModel) return '';
    const lines = ['## Self model'];
    if (selfModel.stableIdentity.coreMission.length > 0) {
      lines.push(`- Core mission: ${selfModel.stableIdentity.coreMission.join('; ')}`);
    }
    if (selfModel.stableIdentity.behavioralPrinciples.length > 0) {
      lines.push(`- Behavioral principles: ${selfModel.stableIdentity.behavioralPrinciples.join('; ')}`);
    }
    if (selfModel.capabilities.strengths.length > 0) {
      lines.push(`- Strengths: ${selfModel.capabilities.strengths.join(', ')}`);
    }
    if (selfModel.capabilities.weaknesses.length > 0) {
      lines.push(`- Weaknesses: ${selfModel.capabilities.weaknesses.join(', ')}`);
    }
    const activeGoals = selfModel.activeImprovementGoals
      .filter((goal) => goal.status === 'active')
      .sort((a, b) => b.priority - a.priority)
      .slice(0, 3);
    if (activeGoals.length > 0) {
      lines.push(`- Active improvement goals: ${activeGoals.map((goal) => goal.title).join(', ')}`);
    }
    return lines.join('\n');
  }

  formatStrategyPrompt(strategyUpdates: StrategyUpdate[]): string {
    if (strategyUpdates.length === 0) return '';
    const lines = ['## Active strategy updates'];
    for (const strategy of strategyUpdates.slice(0, 4)) {
      const confidence = normalizeUnitValue(strategy.confidence);
      lines.push(
        `- ${strategy.basedOnFailure}: ${strategy.newStrategy}${confidence !== null ? ` (confidence=${confidence.toFixed(2)})` : ''}`,
      );
    }
    return lines.join('\n');
  }

  formatInternalStatePrompt(internalState: InternalState | null): string {
    if (!internalState) return '';
    const normalizedValues = [
      ['curiosity', normalizeUnitValue(internalState.curiosity)],
      ['caution', normalizeUnitValue(internalState.caution)],
      ['confidence', normalizeUnitValue(internalState.confidence)],
      ['warmth', normalizeUnitValue(internalState.warmth)],
      ['focus', normalizeUnitValue(internalState.focus)],
      ['load', normalizeUnitValue(internalState.load)],
    ] as const;
    const validValues = normalizedValues.filter(([, value]) => value !== null);
    if (validValues.length === 0) return '';
    const values = [
      ...validValues.map(([name, value]) => `${name}=${value!.toFixed(2)}`),
    ];
    const lines = [`## Internal state`, `- ${values.join(', ')}`];
    if (internalState.reasonNotes?.length) {
      lines.push(`- Notes: ${internalState.reasonNotes.join('; ')}`);
    }
    return lines.join('\n');
  }

  formatWorldPatternPrompt(worldPatterns: WorldModelPattern[]): string {
    if (worldPatterns.length === 0) return '';
    const lines = ['## Relevant world patterns'];
    for (const pattern of worldPatterns.slice(0, 4)) {
      lines.push(`- [${pattern.domain}] ${pattern.pattern}`);
    }
    return lines.join('\n');
  }
}
