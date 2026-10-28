// Wire mirror of Shannon API contracts/continueContract.ts (the "continue" contracts, version 3.1: docs/continue-contracts.md); update both sides together.
// The types are the contract's (chapters 1 to 8); the pure rules at the end are the dependency table's (fixtures continue/dependency-table.json), which both sides test.
import type { ActCondition } from '../../utils/actConditions.js';

export const CONTINUE_CONTRACT_VERSION = '3.1' as const;
export type Dim = 'overworld' | 'the_nether' | 'the_end';
export interface ActPos { x: number; y: number; z: number }

/* ----- 1. results ----- */
/** What the unit aimed at, as it stands now. */
export type GoalOutcome = 'done' | 'already' | 'partial' | 'not_started' | 'failed' | 'unknown';
/** How the unit's run ended. */
export type RunEnd = 'finished' | 'cut' | 'not_run' | 'unknown';
export type CutBy = 'reflex' | 'stopIf' | 'inventoryFull' | 'cancelled' | 'deadline' | 'noProgress' | 'damage' | 'fall'
  | 'death' | 'stale_life' | 'dimension_changed' | 'lease_expired' | 'connection_changed' | 'operator_stop' | 'handover';

export interface Progress {
  unit: 'step' | 'block' | 'item' | 'meter' | 'blow' | 'second';
  done: number;
  left: number | null;
  at?: ActPos;
  msPerUnit?: number;
  work?: { dug: number; placed?: number; placeAttempts?: number; stockUsed?: number; placedConfirmed?: number };
  /** vertical: the ore the hand saw on the way (told, never followed; 8 at most). */
  seen?: { block: string; at: ActPos }[];
  /** vertical (amendment A-5): the steps found no longer there after they were counted (a block update, a look again); done (stepsValid) was lowered by them, the counts of what was sent and confirmed were not. */
  corrected?: { at: ActPos; was?: string; now: string; step: number }[];
  fromStopM?: number; searchEndM?: number;
  lastSearch?: { status: 'success' | 'partial' | 'timeout' | 'no_path'; len: number; nodes: number; ms: number; endM?: number;
    blockedAround?: { at: ActPos; block: string; diggable: boolean }[] };
}
export interface HandOutcome {
  goal: GoalOutcome; end: RunEnd; cutBy?: CutBy; code?: string; progress?: Progress; delta?: InventoryEvent[]; pass?: number;
}
export interface ActOutcome { goal: GoalOutcome; end: RunEnd; cutBy?: CutBy; life: number }
export interface QueueRef { queue: string; item: string }
export interface ItemOutcome {
  goal: GoalOutcome; end: RunEnd; released: boolean;
  /** Amendment A-4: the code of the hand (or the stop) that decided how the item ended: stuck, search_timeout, target_lost, cleanup_stop, precondition ... */
  code?: string;
  droppedBecause?: { code: CutBy | 'depends_failed' | 'depends_unknown'; item?: QueueRef };
  keptDespite?: { item: QueueRef; code: string };
  startedAt?: string;
}

/* ----- 2. continuing ----- */
export type DependState = 'succeeded' | 'failed' | 'pending' | 'unknown';
/** What the decision that made a command had read (the lapse checks compare it with the body now). */
export interface MadeIn { life: number; dim: Dim; dimSince: string; bodyBoot: string; connectionId: string; headBoot: string; obsSeq: number }

/* ----- 3. promises (the body's part) ----- */
export interface InventoryEvent {
  id: string; obsSeq: number; item: string; count: number;
  reason: 'ingredient' | 'fuel' | 'food' | 'placed' | 'thrown' | 'tool_broke' | 'crafted' | 'picked' | 'mined' | 'smelted' | 'stored' | 'retrieved' | 'reflex_eat' | 'reflex_armor' | 'death' | 'unexplained';
  intermediate?: boolean;
  /** The delivery number inside the command (0 from, in the order given; across passes and hands). */
  deliverySeq?: number;
}
export interface EventsMore { command: string; nextSeq: number; total: number }
export interface EventsReply { command: string; from: number; to: number; total: number; nextSeq: number; done: boolean; lost: boolean; events: InventoryEvent[] }
export interface Utilities {
  radius: number; dim: string; obsSeq: number; scanned: boolean;
  found: { block: string; at: ActPos; distance: number }[];
}

/* ----- 4. control ----- */
export type ControlHolder =
  | { kind: 'idle' }
  | { kind: 'command'; actionId: string; command: string; item?: string; life: number; since: string }
  | { kind: 'reflex'; actionId: string; reflex: string; priority: number; target?: number; since: string; episode?: boolean }
  | { kind: 'bridge'; after: string; hold: 'shield' | 'step_back'; target?: number; since: string; until: string }
  | { kind: 'cleanup'; command: string; since: string };
export interface ControlView {
  holder: ControlHolder;
  reflexEpisode?: { reflex: string; target?: number; hands: number; hits: number; since: string };
  combatMark?: { skill: string; target?: number; until: string };
  waiting: { command: string; since: string; behind: string }[];
}
export interface Handover { from: string; target: number; waitedMs: number; reflexSettledAt: string; confirmed: boolean; shield: 'kept' | 'lowered' | 'none' }
export interface HandoverReservation {
  fromActionId: string; reflex: string; target: number; life: number; forCommand: string; holderSeq: number; shield: boolean; at: string; until: string;
}

/* ----- 5. life ----- */
export interface LifeView {
  life: number;
  advancedBy?: 'death' | 'file_unreadable';
  deathEpoch?: string; deathSeq?: number;
  since: string; alive: boolean; diedAt?: string; deathCause?: string;
  dimension: Dim; dimensionSince: string;
}
export interface BodyRun { bodyBoot: string; connectionId: string }

/* ----- 8. measurement ----- */
export interface BodyTimes {
  acceptedAt: string; startedAt?: string; lockAt?: string; firstMotorAt?: string;
  failedAt?: string; endedAt: string; reflexWaitMs?: number; motorOps?: number;
}
export interface HandStart {
  ids: { command: string; item?: string; queue?: string; hand: number; pass?: number; life: number; bodyBoot?: string; headBoot?: string; obsSeq: number; obsAt: string };
  at: string; pos: ActPos; hp: number; food: number; saturation: number; inventory: string; holder: ControlHolder;
  lastOps: { at: string; op: string; detail?: string }[];
}
export interface BodyVersion { revision: string; catalogHash: string }

/* ----- the dependency table's rules (fixtures continue/dependency-table.json is the source) ----- */
export interface UnitEnd { goal: GoalOutcome; end: RunEnd; released: boolean }

/** A hand/act/item that ended: whether others may rely on it (done|already and finished). */
export function isReliable(unit: Pick<UnitEnd, 'goal' | 'end'>): boolean {
  return (unit.goal === 'done' || unit.goal === 'already') && unit.end === 'finished';
}

/**
 * The state of what a unit depends on, the first that applies (the table's `dependStatePriority`):
 * not remembered -> unknown; not ended -> pending; released not confirmed -> unknown; end unknown -> unknown;
 * done|already and finished -> succeeded; else failed.
 */
export function dependStateOf(unit: (UnitEnd & { ended: boolean }) | null | undefined): DependState {
  if (!unit) return 'unknown';
  if (!unit.ended) return 'pending';
  if (!unit.released) return 'unknown';
  if (unit.end === 'unknown') return 'unknown';
  return isReliable(unit) ? 'succeeded' : 'failed';
}

/** The act's goal from its hands' goals and whether any hand moved the body (the table's `aggregate`, top to bottom). */
export function aggregateGoal(hands: { goal: GoalOutcome; motorOps?: number }[], doneMet: boolean): GoalOutcome {
  if (doneMet) return 'done';
  if (hands.length > 0 && hands.every(hand => hand.goal === 'done' || hand.goal === 'already')) {
    return hands.some(hand => hand.goal === 'done') ? 'done' : 'already';
  }
  if (hands.some(hand => hand.goal === 'unknown')) return 'unknown';
  if (hands.some(hand => hand.goal === 'done' || hand.goal === 'partial')) return 'partial';
  if (hands.some(hand => (hand.motorOps ?? 0) > 0 || hand.goal === 'failed')) return 'failed';
  return 'not_started';
}

/** Keep (stay in the queue) or drop, given the states of what an item depends on. */
export function keepVerdict(states: DependState[]): 'keep' | 'depends_failed' | 'depends_unknown' {
  if (states.some(state => state === 'failed')) return 'depends_failed';
  if (states.some(state => state === 'unknown')) return 'depends_unknown';
  return 'keep';
}
/** Start now or wait, given the states of what an item depends on (pre and the held body are the caller's). */
export function startVerdict(states: DependState[]): 'start' | 'wait' | 'drop' {
  if (states.some(state => state === 'failed' || state === 'unknown')) return 'drop';
  return states.some(state => state === 'pending') ? 'wait' : 'start';
}

export type { ActCondition };
