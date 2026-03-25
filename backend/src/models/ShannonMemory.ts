import mongoose, { Schema, Types } from 'mongoose';

export type MemoryCategory =
  | 'experience'
  | 'knowledge'
  | 'self_model'
  | 'strategy_update'
  | 'internal_state_snapshot'
  | 'world_pattern';

export interface IShannonSelfModelData {
  stableIdentity?: {
    coreMission?: string[];
    behavioralPrinciples?: string[];
    toneIdentity?: string[];
  };
  capabilities?: {
    strengths?: string[];
    weaknesses?: string[];
    knownFailurePatterns?: string[];
  };
  activeImprovementGoals?: Array<{
    id: string;
    title: string;
    reason: string;
    priority: number;
    status: 'active' | 'paused' | 'done';
  }>;
  recentSelfObservations?: Array<{
    timestamp: Date;
    observation: string;
    confidence: number;
  }>;
}

export interface IStrategyUpdateData {
  id: string;
  basedOnFailure: string;
  triggerConditions: string[];
  newStrategy: string;
  appliesToModes: string[];
  appliesToUsers?: string[];
  confidence: number;
  createdAt: Date;
}

export interface IInternalStateSnapshotData {
  curiosity: number;
  caution: number;
  confidence: number;
  warmth: number;
  focus: number;
  load: number;
  reasonNotes?: string[];
  updatedAt: Date;
}

export interface IWorldPatternData {
  id: string;
  domain: 'social' | 'technical' | 'self';
  pattern: string;
  evidenceIds: string[];
  confidence: number;
  applicability: string[];
  updatedAt: Date;
}

export interface IShannonMemory {
  _id: Types.ObjectId;
  category: MemoryCategory;
  content: string;
  feeling?: string;
  context?: string;
  source: string;
  importance: number;
  tags: string[];
  embedding?: number[];
  relatedPersonId?: Types.ObjectId;
  createdAt: Date;

  // Scoped memory fields (Phase 1 migration)
  visibilityScope?: 'private_user' | 'shared_project' | 'shared_channel' | 'shared_world' | 'global_generalized' | 'self_model';
  ownerUserId?: string;
  worldTags?: string[];
  projectTags?: string[];
  channelTags?: string[];
  relationTags?: string[];
  sensitivityLevel?: 'low' | 'mid' | 'high';
  generalized?: boolean;
  selfModelData?: IShannonSelfModelData;
  strategyUpdateData?: IStrategyUpdateData;
  internalStateSnapshot?: IInternalStateSnapshotData;
  worldPatternData?: IWorldPatternData;
}

const ShannonMemorySchema = new Schema<IShannonMemory>({
  category: {
    type: String,
    enum: [
      'experience',
      'knowledge',
      'self_model',
      'strategy_update',
      'internal_state_snapshot',
      'world_pattern',
    ],
    required: true,
  },
  content: { type: String, required: true },
  feeling: { type: String },
  context: { type: String },
  source: { type: String, required: true },
  importance: { type: Number, required: true, min: 1, max: 10 },
  tags: { type: [String], default: [] },
  embedding: { type: [Number], select: false },
  relatedPersonId: { type: Schema.Types.ObjectId, ref: 'PersonMemory' },
  createdAt: { type: Date, default: Date.now },

  // Scoped memory fields (Phase 1 migration)
  visibilityScope: {
    type: String,
    enum: ['private_user', 'shared_project', 'shared_channel', 'shared_world', 'global_generalized', 'self_model'],
    default: 'shared_channel',
  },
  ownerUserId: { type: String },
  worldTags: { type: [String], default: [] },
  projectTags: { type: [String], default: [] },
  channelTags: { type: [String], default: [] },
  relationTags: { type: [String], default: [] },
  sensitivityLevel: {
    type: String,
    enum: ['low', 'mid', 'high'],
    default: 'low',
  },
  generalized: { type: Boolean, default: false },
  selfModelData: {
    stableIdentity: {
      coreMission: { type: [String], default: [] },
      behavioralPrinciples: { type: [String], default: [] },
      toneIdentity: { type: [String], default: [] },
    },
    capabilities: {
      strengths: { type: [String], default: [] },
      weaknesses: { type: [String], default: [] },
      knownFailurePatterns: { type: [String], default: [] },
    },
    activeImprovementGoals: {
      type: [{
        id: { type: String, required: true },
        title: { type: String, required: true },
        reason: { type: String, required: true },
        priority: { type: Number, required: true },
        status: { type: String, enum: ['active', 'paused', 'done'], required: true },
      }],
      default: [],
    },
    recentSelfObservations: {
      type: [{
        timestamp: { type: Date, required: true },
        observation: { type: String, required: true },
        confidence: { type: Number, required: true },
      }],
      default: [],
    },
  },
  strategyUpdateData: {
    id: { type: String },
    basedOnFailure: { type: String },
    triggerConditions: { type: [String], default: [] },
    newStrategy: { type: String },
    appliesToModes: { type: [String], default: [] },
    appliesToUsers: { type: [String], default: [] },
    confidence: { type: Number },
    createdAt: { type: Date },
  },
  internalStateSnapshot: {
    curiosity: { type: Number },
    caution: { type: Number },
    confidence: { type: Number },
    warmth: { type: Number },
    focus: { type: Number },
    load: { type: Number },
    reasonNotes: { type: [String], default: [] },
    updatedAt: { type: Date },
  },
  worldPatternData: {
    id: { type: String },
    domain: { type: String, enum: ['social', 'technical', 'self'] },
    pattern: { type: String },
    evidenceIds: { type: [String], default: [] },
    confidence: { type: Number },
    applicability: { type: [String], default: [] },
    updatedAt: { type: Date },
  },
});

// カテゴリ + 重要度 + 日時 で検索・eviction
ShannonMemorySchema.index({ category: 1, importance: -1, createdAt: -1 });

// tags での検索用
ShannonMemorySchema.index({ tags: 1 });

// 全文検索用 (content + tags)
ShannonMemorySchema.index({ content: 'text' }, { default_language: 'none' });

// スコープ付きメモリ検索用 (visibilityScope + category + importance)
ShannonMemorySchema.index({ visibilityScope: 1, category: 1, importance: -1 });
ShannonMemorySchema.index({ category: 1, generalized: 1, createdAt: -1 });
ShannonMemorySchema.index({ relationTags: 1, category: 1, createdAt: -1 });

export const ShannonMemory = mongoose.model<IShannonMemory>(
  'ShannonMemory',
  ShannonMemorySchema,
);
