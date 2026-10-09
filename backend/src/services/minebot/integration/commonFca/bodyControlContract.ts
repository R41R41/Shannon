// Wire mirror of Shannon API contracts/bodyControlContract.ts; update both sides together.
/** Additive body-control protocol. Existing body/Minecraft message contracts retain their meaning. */
export const BODY_CONTROL_VERSION = 1 as const;
export type BodyValue = null | boolean | number | string | readonly BodyValue[] | { readonly [key: string]: BodyValue };
export type BodyFact = null | boolean | number | string;
export interface BodyImageReference { ref: string; capturedAt: string; expiresAt: string }
export interface BodyObservation {
  schemaVersion: typeof BODY_CONTROL_VERSION; bodyId: string; sequence: number;
  stateAt: string; receivedAt: string; connected: boolean;
  /** Public body-specific state. Images are short-lived references, never journalled pixels. */
  state: Readonly<Record<string, BodyValue>>;
  /** Adapter-normalized relevant preconditions, such as target, equipped item, GUI and safe retreat. */
  facts: Readonly<Record<string, BodyFact>>;
  image?: BodyImageReference;
}
export interface BodyTaskContext {
  scopeKey: string; taskId: string; taskRevision: number; bodyId: string;
  sessionId: string; generation: number; goal: string; completionCondition: string;
  /** The interrupted process is context only; it is never an instruction to replay that operation. */
  taskState?: { phase: string; progress: string; activeAction?: { name: string; operationId: string; input: BodyValue };
    recentResults: readonly { name: string; ok: boolean; summary: string }[] };
}
export interface BodyPrecondition { key: string; value: BodyFact }
export interface BodyCandidateDraft {
  kind: 'action' | 'observe' | 'return' | 'stop'; label: string;
  /** Registered adapter operation with fully resolved arguments. Selection never supplies free arguments. */
  operation?: string; arguments: Readonly<Record<string, BodyValue>>;
  preconditions: readonly BodyPrecondition[]; maxDurationMs: number; expiresAt: string; requiresImage?: boolean;
}
export interface BodyActionCandidate extends BodyCandidateDraft {
  id: string; sessionId: string; generation: number; taskRevision: number; observationSequence: number;
}
export interface BodyOperation {
  schemaVersion: typeof BODY_CONTROL_VERSION; operationId: string;
  context: BodyTaskContext; candidate: BodyActionCandidate; observationSequence: number; deadlineAt: string;
}
export interface BodyActionReceipt {
  schemaVersion: typeof BODY_CONTROL_VERSION; operationId: string; bodyId: string; sessionId: string; generation: number;
  outcome: 'completed' | 'failed' | 'cancelled' | 'unknown'; observedAt: string;
  /** Actual actuator acknowledgement, not lease release or a queued stop command. */
  inputsReleased: boolean; evidenceId: string; observation?: BodyObservation;
}
export interface BodyStopRequest { context: BodyTaskContext; requestId: string; reason: 'handoff' | 'return' | 'cancel' | 'disconnect' | 'deadline' }
export interface BodyStopAcknowledgement {
  bodyId: string; sessionId: string; generation: number; requestId: string;
  state: 'stopped' | 'unknown'; inputsReleased: boolean; observedAt: string;
}
export type ReflexEndReason = 'completed' | 'hazard_cleared' | 'target_lost' | 'no_progress' | 'no_candidates'
  | 'observation_unavailable' | 'cancelled' | 'deadline' | 'decision_limit' | 'action_limit'
  | 'stale_generation' | 'unknown' | 'returned' | 'stopped' | 'handoff_denied' | 'duplicate' | 'failed';
export interface ReflexSessionReceipt {
  schemaVersion: typeof BODY_CONTROL_VERSION; eventId: string; context: BodyTaskContext; reason: ReflexEndReason;
  control: 'returned' | 'held' | 'not_acquired'; startedAt: string; endedAt: string;
  decisions: number; actions: readonly BodyActionReceipt[]; latestObservation: BodyObservation | null;
}
