export type CognitiveRuntimeMode = 'off' | 'shadow' | 'feedback';
export type CognitiveDecisionSource = 'jev' | 'openai' | 'anthropic' | 'fallback';

export type ProgressState =
  | 'ON_TRACK'
  | 'UNCERTAIN'
  | 'STALLED'
  | 'REGRESSING'
  | 'COMPLETED_UNVERIFIED';

export type FailureCause =
  | 'NONE'
  | 'BLOCKED_PATH'
  | 'MISSING_RESOURCE'
  | 'WRONG_ASSUMPTION'
  | 'REPEATED_FAILURE'
  | 'WORLD_CHANGED'
  | 'CAPABILITY_GAP'
  | 'UNSAFE'
  | 'UNKNOWN';

export type NextControl =
  | 'CONTINUE'
  | 'OBSERVE'
  | 'RETRY_ONCE'
  | 'SWITCH_SUBTASK'
  | 'REPLAN'
  | 'ABORT_UNSAFE';

export type ReflexAction =
  | 'FLEE'
  | 'EAT'
  | 'SURFACE'
  | 'STOP_MOVEMENT'
  | 'SEEK_SHELTER'
  | 'OBSERVE'
  | 'DELEGATE_SYSTEM2';

export interface ReflexDecisionInput {
  event: Record<string, unknown>;
  world: WorldObservation;
  currentTaskActive: boolean;
  availableCapabilities: string[];
}

export interface ReflexDecision {
  id: string;
  eventType: string;
  evaluatedAt: string;
  elapsedMilliseconds: number;
  source: CognitiveDecisionSource;
  shouldPreemptProbability: number;
  immediateAction: ReflexAction;
  urgency: 'LOW' | 'MEDIUM' | 'CRITICAL';
  confidence: number;
  capabilityAvailable: boolean;
  confidenceKind?: 'provider_distribution' | 'self_reported' | 'fallback';
  decisionEvidence?: DecisionEvidence<ReflexAction>;
  stale?: boolean;
}

export interface DecisionEvidence<T extends string> {
  choice: T;
  probabilities: Record<T, number>;
  providerConfidence: number;
}

export interface ObservedFact<T> {
  value: T | null;
  observedAt: string;
  source: 'native' | 'window' | 'derived' | 'cache';
  coverage: 'known' | 'partial' | 'unknown';
}

export interface ReflexPolicy {
  readonly source: CognitiveDecisionSource;
  decide(input: ReflexDecisionInput): Promise<ReflexDecision>;
}

export interface WorldVector {
  x: number;
  y: number;
  z: number;
}

export interface WorldInventoryStack {
  name: string;
  count: number;
  /** Uses left before a tool or armour piece breaks, as its durability bar shows. */
  durability?: { left: number; max: number };
  /** For a potion (or an arrow tipped with one): what it is a potion of, by the game's name (`fire_resistance`, `water`). */
  contents?: string;
}

export interface NearbyEntityObservation {
  name: string;
  kind: string;
  distance: number;
  position: WorldVector;
  /** Observed rate at which the gap is shrinking, m/s (negative: widening). Hostiles only, once measured. */
  closingSpeed?: number;
  /** Seconds until it is within reach at that rate; absent when it is not closing. */
  secondsToContact?: number;
  /** Present (false) for a hostile that has no line of sight to the body and no open way to it: solid blocks all round. */
  canReachMe?: false;
}

export interface WorldObservation {
  observedAt: string;
  dimension: string | null;
  position: WorldVector | null;
  health: number | null;
  food: number | null;
  oxygen: number | null;
  /** Hidden hunger reserve: it drains before the food level does. */
  saturation?: number | null;
  /** Distance and jumps since the body connected, by gait; sprinting and jumping spend hunger, walking does not. */
  exertion?: { walkedMetres: number; sprintedMetres: number; swumMetres: number; jumps: number };
  /** The pace of ordinary travel chosen with set-movement-pace. */
  movementPace?: 'walk' | 'sprint';
  /**
   * What the body's reserves come to, in the terms a decision is made in. Present only on a live body.
   * `darkInSeconds`/`lightInSeconds`: time until monsters can spawn under the sky, or until they stop.
   * `regenerating`: whether health comes back by itself (it does not below 18 food).
   * `foodItems`: things to eat in the pack. `hitsLeft`: how many more hits the body can take from the
   * hardest-hitting hostile that can reach it now, by the damage that kind has been measured to do.
   */
  margin?: { darkInSeconds?: number; lightInSeconds?: number; regenerating: boolean; foodItems: number; hitsLeft?: { from: string; hits: number } };
  isInWater: boolean;
  /** Present (true) only while the body stands closed in: solid floor, roof and walls round its two cells. Mobs cannot reach it; opening a wall or the roof ends that. */
  sealedInShelter?: true;
  weather: string | null;
  time: string | null;
  biome: string | null;
  heldItem: string | null;
  inventory: WorldInventoryStack[];
  activeEffects: Array<{ name: string; amplifier: number }>;
  nearbyEntities: NearbyEntityObservation[];
  nearbyThreats?: NearbyEntityObservation[];
  /** Notable places within the loaded chunks (a village), with distance, direction and what gave them away. */
  landmarks?: Array<{ kind: string; distance: number; direction: string; position: WorldVector; evidence: string }>;
  /**
   * Places seen before and kept in mind, also when out of sight now: for each kind the nearest one, as
   * "distance direction (x,y,z) ×count". The rest is recalled on request (recall-places).
   */
  rememberedPlaces?: Record<string, string>;
  /**
   * Said only when the task has been stopped for the same thing again and again lately: how often, for what,
   * what it cost, and what the body has measured of that kind. What to do about it is the planner's.
   */
  recentInterruptions?: string;
  /** Said only while the body is near what it last built round itself (build-around-self): where, and how many of its blocks are missing. */
  builtAround?: string;
  /** Said only while the planner has taken a kind of mob on for a time (accept-threat): which, and the seconds left. */
  acceptedThreats?: string;
  facts?: Record<string, ObservedFact<unknown>>;
  container?: { type: string; items: WorldInventoryStack[]; fuel: number | null; progress: number | null } | null;
}

export interface WorldFrame extends WorldObservation {
  runId: string;
  revision: number;
}

export interface WorldDelta {
  positionDelta: WorldVector | null;
  healthDelta: number | null;
  foodDelta: number | null;
  dimensionChanged: boolean;
  inventoryDelta: WorldInventoryStack[];
}

export type ActionKind = 'instant_skill' | 'routine' | 'agent_tool' | 'meta_tool';

export interface ActionReceipt {
  id: string;
  runId: string;
  iteration: number;
  actionKind: ActionKind;
  capability: string;
  args: Record<string, unknown>;
  intendedEffect: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  beforeRevision: number;
  afterRevision: number;
  success: boolean | null;
  outcome?: 'succeeded' | 'pending_external' | 'failed' | 'unknown';
  failureType: string | null;
  recoverable: boolean | null;
  resultSummary: string;
  observedDelta: WorldDelta;
  meaningfulWorldAction: boolean;
  taskNodeId?: string;
  execution?: ActionTrace;
}

export interface GoalNodeProjection {
  id: string;
  goal: string;
  status: 'pending' | 'in_progress' | 'completed' | 'error';
  progress?: string | null;
  blockedBy?: string | null;
  children?: GoalNodeProjection[] | null;
}

export interface CriticInput {
  runId: string;
  goal: string;
  evaluatedRevision: number;
  currentWorld: WorldFrame | null;
  previousWorld: WorldFrame | null;
  plan: GoalNodeProjection[];
  recentReceipts: ActionReceipt[];
  previousAssessment: CriticAssessment | null;
  activeAction?: ActionProgress | null;
}

export interface CriticAssessment {
  id: string;
  runId: string;
  evaluatedRevision: number;
  receivedAt: string;
  elapsedMilliseconds: number;
  source: CognitiveDecisionSource;
  stale: boolean;
  progressState: ProgressState;
  continueProbability: number;
  needsObservationProbability: number;
  needsReplanProbability: number;
  failureCause: FailureCause;
  nextControl: NextControl;
  confidence: number;
  confidenceKind?: 'provider_distribution' | 'self_reported' | 'fallback';
  decisionEvidence?: DecisionEvidence<NextControl>;
}

export type TaskWorkspaceEventType =
  | 'workspace_created'
  | 'world_observed'
  | 'plan_projected'
  | 'action_finished'
  | 'action_progress'
  | 'critic_assessed'
  | 'reflex_assessed';

export interface TaskWorkspaceEvent {
  sequence: number;
  runId: string;
  type: TaskWorkspaceEventType;
  occurredAt: string;
  worldRevision: number;
  payload: Record<string, unknown>;
}

export interface TaskWorkspaceSnapshot {
  schemaVersion: 1;
  runId: string;
  goal: string;
  createdAt: string;
  updatedAt: string;
  nextSequence: number;
  worldRevision: number;
  currentWorld: WorldFrame | null;
  previousWorld: WorldFrame | null;
  plan: GoalNodeProjection[];
  receipts: ActionReceipt[];
  assessments: CriticAssessment[];
  reflexDecisions: ReflexDecision[];
  events: TaskWorkspaceEvent[];
  activeAction?: ActionProgress | null;
  goalContract?: import('./GoalVerifier.js').GoalContract;
  goalBaseline?: WorldObservation;
  goalProof?: import('./GoalVerifier.js').GoalProof;
  planRevisions?: Array<{ revision: number; recordedAt: string; plan: GoalNodeProjection[] }>;
  activeSubtaskId?: string;
  usedTaskNodeIds?: string[];
}

export interface ExecutionCritic {
  readonly source: CognitiveDecisionSource;
  assess(input: CriticInput): Promise<CriticAssessment>;
}
import type { ActionProgress, ActionTrace } from '../execution/actionTypes.js';
