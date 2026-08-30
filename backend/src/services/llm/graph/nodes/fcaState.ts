import type { BaseMessage } from '@langchain/core/messages';
import type { MinecraftInventoryEntry, RequestEnvelope, TaskContext, TaskTreeState } from '@shannon/common';
import type { ExecutionResult } from '../types.js';

/** Run identity: one FCA invocation, no channel I/O. */
export interface FcaRunIdentity {
  taskId: string;
  userMessage: string | null;
  messages: BaseMessage[];
  isEmergency: boolean;
  maxIterations?: number;
}

/**
 * Injected per run: envelope, scoped memory prompts, classification.
 * The loop must not call getInstance() for person/memory/episode data.
 */
export interface FcaComposition {
  requestEnvelope?: RequestEnvelope;
  context: TaskContext | null;
  channelId: string | null;
  environmentState: string | null;
  memoryPrompt?: string;
  relationshipPrompt?: string;
  selfModelPrompt?: string;
  strategyPrompt?: string;
  internalStatePrompt?: string;
  worldModelPrompt?: string;
  /** Pre-loaded episode recall text. Filled by the graph before run(). */
  episodePrompt?: string;
  /** Pre-loaded Minecraft world knowledge. Filled by the graph when applicable. */
  worldKnowledgePrompt?: string;
  classifyMode?: string;
  needsTools?: boolean;
  needsPlanning?: boolean;
  selectedModel?: string;
  allowedTools?: string[];
}

/** Channel hooks and live callbacks. Kept outside the FCA kernel. */
export interface FcaChannelAdapter {
  onToolsExecuted?: (messages: BaseMessage[], results: ExecutionResult[]) => void;
  onToolStarting?: (toolName: string, args?: Record<string, unknown>) => void;
  onTaskTreeUpdate?: (taskTree: TaskTreeState) => void;
  onStreamSentence?: (sentence: string) => Promise<void>;
  onRequestSkillInterrupt?: () => void;
  getLiveInventory?: () => MinecraftInventoryEntry[];
  getActiveEffects?: () => Array<{ name: string; amplifier: number }>;
  getInventoryDiff?: () => string | null;
  getInitialMemory?: () => Promise<string | null>;
}

export interface FunctionCallingAgentState extends FcaRunIdentity {
  composition: FcaComposition;
  channel: FcaChannelAdapter;
}

export type FlatFcaStateInput = FcaRunIdentity & Partial<FcaComposition> & Partial<FcaChannelAdapter>;

const compositionKeys = new Set<keyof FcaComposition>([
  'requestEnvelope', 'context', 'channelId', 'environmentState',
  'memoryPrompt', 'relationshipPrompt', 'selfModelPrompt', 'strategyPrompt',
  'internalStatePrompt', 'worldModelPrompt', 'episodePrompt', 'worldKnowledgePrompt',
  'classifyMode', 'needsTools', 'needsPlanning', 'selectedModel', 'allowedTools',
]);

const channelKeys = new Set<keyof FcaChannelAdapter>([
  'onToolsExecuted', 'onToolStarting', 'onTaskTreeUpdate', 'onStreamSentence',
  'onRequestSkillInterrupt', 'getLiveInventory', 'getActiveEffects', 'getInventoryDiff',
  'getInitialMemory',
]);

export function buildFcaState(input: FlatFcaStateInput): FunctionCallingAgentState {
  const composition = {} as FcaComposition;
  const channel = {} as FcaChannelAdapter;
  for (const [key, value] of Object.entries(input)) {
    if (compositionKeys.has(key as keyof FcaComposition)) {
      (composition as Record<string, unknown>)[key] = value;
    } else if (channelKeys.has(key as keyof FcaChannelAdapter)) {
      (channel as Record<string, unknown>)[key] = value;
    }
  }
  if (input.context !== undefined) composition.context = input.context;
  if (input.channelId !== undefined) composition.channelId = input.channelId;
  if (input.environmentState !== undefined) composition.environmentState = input.environmentState;
  return {
    taskId: input.taskId,
    userMessage: input.userMessage,
    messages: input.messages,
    isEmergency: input.isEmergency,
    maxIterations: input.maxIterations,
    composition,
    channel,
  };
}

export function normalizeFcaState(state: FunctionCallingAgentState | FlatFcaStateInput): FunctionCallingAgentState {
  return 'composition' in state ? state : buildFcaState(state);
}
