import mongoose, { Schema, Types } from 'mongoose';

export type PrivacyZone = 'internal' | 'external';
export type MemoryPlatform = 'discord' | 'twitter' | 'youtube' | 'minebot';

export interface IExchange {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

export interface IInteractionPreferences {
  directness: 'low' | 'mid' | 'high';
  warmth: 'low' | 'mid' | 'high';
  structure: 'low' | 'mid' | 'high';
  verbosity: 'short' | 'mid' | 'long';
}

export interface IPersonMemory {
  _id: Types.ObjectId;
  privacyZone: PrivacyZone;
  canonicalPersonId: string;
  platform: MemoryPlatform;
  platformUserId: string;
  displayName: string;
  traits: string[];
  notes: string;
  recentExchanges: IExchange[];
  conversationSummary: string;
  totalInteractions: number;
  familiarityLevel: number;
  trustLevel: number;
  interactionPreferences: IInteractionPreferences;
  recurringTopics: string[];
  activeProjects: string[];
  cautionFlags: string[];
  inferredNeeds: string[];
  firstSeenAt: Date;
  lastSeenAt: Date;
}

const ExchangeSchema = new Schema<IExchange>(
  {
    role: { type: String, enum: ['user', 'assistant'], required: true },
    content: { type: String, required: true },
    timestamp: { type: Date, default: Date.now },
  },
  { _id: false },
);

const PersonMemorySchema = new Schema<IPersonMemory>({
  privacyZone: {
    type: String,
    enum: ['internal', 'external'],
    required: true,
  },
  canonicalPersonId: { type: String, required: true },
  platform: {
    type: String,
    enum: ['discord', 'twitter', 'youtube', 'minebot'],
    required: true,
  },
  platformUserId: { type: String, required: true },
  displayName: { type: String, required: true },
  traits: { type: [String], default: [] },
  notes: { type: String, default: '' },
  recentExchanges: { type: [ExchangeSchema], default: [] },
  conversationSummary: { type: String, default: '' },
  totalInteractions: { type: Number, default: 0 },
  familiarityLevel: { type: Number, default: 0, min: 0, max: 100 },
  trustLevel: { type: Number, default: 0, min: 0, max: 100 },
  interactionPreferences: {
    directness: { type: String, enum: ['low', 'mid', 'high'], default: 'mid' },
    warmth: { type: String, enum: ['low', 'mid', 'high'], default: 'mid' },
    structure: { type: String, enum: ['low', 'mid', 'high'], default: 'mid' },
    verbosity: { type: String, enum: ['short', 'mid', 'long'], default: 'mid' },
  },
  recurringTopics: { type: [String], default: [] },
  activeProjects: { type: [String], default: [] },
  cautionFlags: { type: [String], default: [] },
  inferredNeeds: { type: [String], default: [] },
  firstSeenAt: { type: Date, default: Date.now },
  lastSeenAt: { type: Date, default: Date.now },
});

// プラットフォーム + ユーザーID で一意
PersonMemorySchema.index({ platform: 1, platformUserId: 1 }, { unique: true });
PersonMemorySchema.index({ canonicalPersonId: 1, lastSeenAt: -1 });

// privacyZone での検索用
PersonMemorySchema.index({ privacyZone: 1, displayName: 1 });

// 容量制限の eviction 用
PersonMemorySchema.index({ totalInteractions: 1, lastSeenAt: 1 });

export const PersonMemory = mongoose.model<IPersonMemory>(
  'PersonMemory',
  PersonMemorySchema,
);
