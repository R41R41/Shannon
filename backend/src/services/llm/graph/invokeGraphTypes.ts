import type { BaseMessage } from '@langchain/core/messages';
import type { RequestEnvelope, ShannonGraphState, TaskTreeState } from '@shannon/common';

export type InvokeGraphOptions = {
  onToolStarting?: (toolName: string, args?: Record<string, unknown>) => void;
  onTaskTreeUpdate?: (taskTree: TaskTreeState) => void;
  onStreamSentence?: (sentence: string) => Promise<void>;
  onRequestSkillInterrupt?: () => void;
  getLiveInventory?: () => import('@shannon/common').MinecraftInventoryEntry[];
  getActiveEffects?: () => Array<{ name: string; amplifier: number }>;
  getInventoryDiff?: () => string | null;
  getInitialMemory?: () => Promise<string | null>;
  abortSignal?: AbortSignal;
};

export type InvokeGraphFn = (
  envelope: RequestEnvelope,
  legacyMessages?: BaseMessage[],
  options?: InvokeGraphOptions,
) => Promise<ShannonGraphState>;
