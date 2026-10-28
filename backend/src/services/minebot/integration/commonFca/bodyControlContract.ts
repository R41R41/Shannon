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
  /** Continue contracts (2, 5): the life number of the observation the deciding read (required of a command that moves the body), the head's start-up id, and what the decision read (a command that is not a queue item). */
  life?: number; headBoot?: string; madeIn?: import('./continueContract.js').MadeIn;
  /** The interrupted process is context only; it is never an instruction to replay that operation. */
  taskState?: { phase: string; progress: string; activeAction?: { name: string; operationId: string; input: BodyValue };
    recentResults: readonly { name: string; ok: boolean; summary: string }[] };
  /**
   * The task's plan tree (`@shannon/mind` planTree, design mb-llm-centric 2.7), for display only: the body shows it (ShannonUI mod v2's
   * nested task tree) and never acts on it. Present only on a task that holds a plan (SHANNON_MINECRAFT_LLM_CENTRIC); absent, the body
   * shows what it showed before. A body that does not know it ignores it.
   */
  plan?: BodyPlanView;
  /**
   * The fix run (2026-10-28): `hold`, an operator's request asked to be held on a heavy failure (the body then writes its box and the scene, stops
   * the world and holds the task's next acts, `utils/incidents`); `resume`, the hold's id that the act sent again after the operator's resume names
   * (the body moves the world again and runs it). An API that does not know it never sends it.
   */
  incident?: { hold?: boolean; resume?: string; cancel?: string };
}
/** A plan node as the body shows it. `state`: done → completed, the current node → in_progress, continue and wait → pending, blocked → error. */
export interface BodyPlanNode {
  id: string; parentId: string | null; title: string;
  state: 'done' | 'continue' | 'wait' | 'blocked';
  /** Why a blocked node is blocked (at most 80 characters). */
  reason?: string;
  /**
   * Display only (ShannonUIMod's tooltips on the plan section; the head sends them when the node has them). Where it is done, what shows it
   * done, a note, and what not to do / what to mind (at most 4 lines each).
   */
  where?: string; doneWhen?: string; note?: string;
  forbid?: readonly string[]; caution?: readonly string[];
}
/** At most 64 nodes, parents before their children, siblings in order; at most 4 deep. `current` is a node's id or null. */
export interface BodyPlanView { revision: number; current: string | null; nodes: readonly BodyPlanNode[] }export interface BodyPrecondition { key: string; value: BodyFact }
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
