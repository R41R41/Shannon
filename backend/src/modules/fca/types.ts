/** SDK-free FCA contract. Destination, memory and transport stay outside the loop. */
export type FcaRole = 'system' | 'user' | 'assistant' | 'tool';
/** Cooperative cancellation. Callers may pass AbortSignal. */
export interface FcaSignal { readonly aborted: boolean; throwIfAborted(): void }
export interface FcaToolCall { id: string; name: string; arguments: unknown }
export interface FcaMessage {
  role: FcaRole; content: string; toolCallId?: string; toolCalls?: readonly FcaToolCall[];
}
export interface FcaToolDefinition {
  name: string; description: string; parameters: Record<string, unknown>;
}
export interface FcaToolResult { content: string; done?: boolean; value?: unknown }
export interface FcaBoundTool extends FcaToolDefinition {
  execute(args: unknown, signal: FcaSignal): Promise<FcaToolResult>;
}
export interface FcaModel {
  next(input: { system: string; messages: readonly FcaMessage[]; tools: readonly FcaToolDefinition[] },
    signal: FcaSignal): Promise<{ content: string; toolCalls: readonly FcaToolCall[] }>;
}
export interface FcaLimits {
  maxTurns: number; maxToolCalls: number; maxToolCallsPerTurn: number; maxElapsedMs?: number;
}
export type FcaDecision = 'complete' | 'continue' | 'fail';
export interface FcaPreparedTurn { readonly ephemeral?: readonly FcaMessage[]; readonly tools?: readonly FcaBoundTool[] }
export interface FcaCallPlan {
  readonly execute: readonly FcaToolCall[];
  readonly synthetic?: readonly { call: FcaToolCall; content: string }[];
}
export interface FcaTurnEvent {
  turn: number; content: string; toolCalls: readonly FcaToolCall[];
  results: readonly { call: FcaToolCall; content: string; done?: boolean; value?: unknown }[];
}
export interface FcaHooks {
  beforeModel?(input: { turn: number; messages: readonly FcaMessage[]; elapsedMs: number }): FcaPreparedTurn | Promise<FcaPreparedTurn>;
  planCalls?(calls: readonly FcaToolCall[], input: { turn: number }): FcaCallPlan;
  onTextOnly?(input: { turn: number; content: string }): FcaDecision;
  afterTools?(event: FcaTurnEvent): FcaDecision | Promise<FcaDecision>;
}
export type FcaPolicy =
  | { kind: 'text' }
  | { kind: 'terminal-tool'; name: string; drain: 'until-terminal' | 'all' };
export interface FcaRunInput {
  system: string; messages: readonly FcaMessage[]; tools: readonly FcaBoundTool[];
  model: FcaModel; signal: FcaSignal; limits: FcaLimits; policy: FcaPolicy;
  hooks?: FcaHooks; now?: () => number;
}
export interface FcaRunResult {
  readonly messages: readonly FcaMessage[];
  readonly turns: number;
  readonly content: string;
  readonly stop: 'complete' | 'terminal' | 'turns' | 'time';
  readonly value?: unknown;
}
export class FcaError extends Error {
  constructor(readonly code: 'FCA_CONFIG' | 'FCA_MODEL' | 'FCA_TOOL_NOT_ALLOWED' | 'FCA_TOOL_BUDGET' | 'FCA_NO_TERMINAL') {
    super(code); this.name = 'FcaError';
  }
}
