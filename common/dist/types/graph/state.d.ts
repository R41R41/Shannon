/**
 * ShannonGraphState and its internal supporting types.
 */
import type { EmotionType, TaskTreeState, HierarchicalSubTask, ActionItem } from '../taskGraph.js';
import type { ShannonChannel, ShannonMode } from './channels.js';
import type { RequestEnvelope } from './envelope.js';
import type { ShannonActionPlan } from './action.js';
import type { MemoryItem } from './memory.js';
/** A single tool call record within the graph execution. */
export interface ToolCallRecord {
    toolName: string;
    args: Record<string, unknown>;
    result?: unknown;
    error?: string;
    durationMs?: number;
    timestamp: string;
}
/** Planning structure (reuses existing HierarchicalSubTask for detail). */
export interface ShannonPlan {
    goal: string;
    strategy: string;
    steps: HierarchicalSubTask[];
    currentStepId?: string;
    successCriteria?: string[];
    /** Minecraft-specific: next physical actions to execute. */
    nextActions?: ActionItem[];
}
/** Self-modification proposal. */
export interface SelfModProposal {
    targetType: 'prompt' | 'tool' | 'behavior' | 'memory_rule';
    description: string;
    currentValue?: string;
    proposedValue?: string;
    reasoning: string;
    riskLevel: 'low' | 'mid' | 'high';
    approved?: boolean;
}
/** User profile snapshot retrieved at request time. */
export interface UserProfileSnapshot {
    userId: string;
    displayName: string;
    platform: ShannonChannel;
    traits: string[];
    notes: string;
    conversationSummary: string;
    totalInteractions: number;
    relationshipLevel?: 'stranger' | 'acquaintance' | 'friend' | 'close_friend';
}
export interface ShannonSelfImprovementGoal {
    id: string;
    title: string;
    reason: string;
    priority: number;
    status: 'active' | 'paused' | 'done';
}
export interface ShannonSelfObservation {
    timestamp: string;
    observation: string;
    confidence: number;
}
export interface ShannonSelfModel {
    stableIdentity: {
        coreMission: string[];
        behavioralPrinciples: string[];
        toneIdentity: string[];
    };
    capabilities: {
        strengths: string[];
        weaknesses: string[];
        knownFailurePatterns: string[];
    };
    activeImprovementGoals: ShannonSelfImprovementGoal[];
    recentSelfObservations: ShannonSelfObservation[];
}
export interface RelationshipModel {
    userId: string;
    familiarityLevel: number;
    trustLevel: number;
    interactionPreferences: {
        directness: 'low' | 'mid' | 'high';
        warmth: 'low' | 'mid' | 'high';
        structure: 'low' | 'mid' | 'high';
        verbosity: 'short' | 'mid' | 'long';
    };
    recurringTopics: string[];
    activeProjects: string[];
    cautionFlags: string[];
    inferredNeeds: string[];
    updatedAt: string;
}
export interface GoalHierarchy {
    coreConstraints: string[];
    identityGoals: string[];
    longTermGoals: ShannonSelfImprovementGoal[];
    sessionGoal?: {
        title: string;
        successCriteria: string[];
    };
    currentStepGoal?: string;
}
export interface StrategyUpdate {
    id: string;
    basedOnFailure: string;
    triggerConditions: string[];
    newStrategy: string;
    appliesToModes: string[];
    appliesToUsers?: string[];
    confidence: number;
    createdAt: string;
}
export interface InternalState {
    curiosity: number;
    caution: number;
    confidence: number;
    warmth: number;
    focus: number;
    load: number;
    reasonNotes?: string[];
    updatedAt: string;
}
export interface WorldModelPattern {
    id: string;
    domain: 'social' | 'technical' | 'self';
    pattern: string;
    evidenceIds: string[];
    confidence: number;
    applicability: string[];
    updatedAt: string;
}
/**
 * The unified state that flows through the Shannon core graph.
 *
 * Every node reads and writes slices of this state.
 */
export interface ShannonGraphState {
    envelope: RequestEnvelope;
    userProfile?: UserProfileSnapshot;
    selfModel?: ShannonSelfModel;
    relationshipModel?: RelationshipModel;
    goalHierarchy?: GoalHierarchy;
    strategyUpdates?: StrategyUpdate[];
    internalState?: InternalState;
    worldModelPatterns?: WorldModelPattern[];
    conversationSummary?: string;
    recentMessages?: string[];
    mode?: ShannonMode;
    intent?: string;
    riskLevel?: 'low' | 'mid' | 'high';
    needsTools?: boolean;
    needsPlanning?: boolean;
    needsSelfModification?: boolean;
    emotion?: EmotionType;
    relevantMemories: MemoryItem[];
    selfModelPrompt?: string;
    relationshipPrompt?: string;
    strategyPrompt?: string;
    internalStatePrompt?: string;
    worldModelPrompt?: string;
    plan?: ShannonPlan;
    /** Reference to existing Minebot TaskTreeState for backward compat. */
    taskTree?: TaskTreeState;
    toolBudget?: number;
    allowedTools?: string[];
    toolCalls: ToolCallRecord[];
    retrievedFacts: string[];
    fcaSummary?: string;
    actionPlan?: ShannonActionPlan;
    selfModProposal?: SelfModProposal;
    finalAnswer?: string;
    trace: string[];
    warnings: string[];
}
/**
 * Standard signature for a Shannon graph node.
 *
 * Each node receives the current state and returns a partial update.
 */
export type ShannonNodeFn = (state: ShannonGraphState) => Promise<Partial<ShannonGraphState>>;
