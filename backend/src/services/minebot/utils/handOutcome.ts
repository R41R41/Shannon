import type { CutBy, GoalOutcome, InventoryEvent, Progress, RunEnd } from '../integration/commonFca/continueContract.js';
import type { StepOutcome } from './primitives/common.js';
import type { StoppedBy } from './actReport.js';

/**
 * The two axes of a hand's result (continue contracts, 1): what the hand aimed at, and how its run ended. Decided here from what the part said
 * (its own `goal`, its `progress`) and from what the body saw (the effective motor operations the hand sent), never from the words of its line.
 */
export interface HandVerdict { goal: GoalOutcome; end: RunEnd; cutBy?: CutBy; code?: string; progress?: Progress }

/** A hand that ended by itself (the part returned): done, already, unknown (it could not see), partial (it got somewhere), failed (it moved the body and got nowhere), not_started. */
export function finishedVerdict(outcome: StepOutcome, motorOps: number): HandVerdict {
  const code = outcome.code ?? outcome.reason;
  const base = { end: 'finished' as const, ...(code ? { code } : {}), ...(outcome.progress ? { progress: outcome.progress } : {}) };
  if (outcome.goal === 'unknown') return { goal: 'unknown', ...base };
  if (outcome.ok) return { goal: outcome.goal === 'already' ? 'already' : 'done', ...base, };
  if ((outcome.progress?.done ?? 0) > 0) return { goal: 'partial', ...base };
  return { goal: motorOps > 0 ? 'failed' : 'not_started', ...base };
}

/** The act's stop from outside its hands, as the contract's cut reason. */
const DIRECT = new Set(['death', 'stale_life', 'dimension_changed', 'lease_expired', 'connection_changed', 'operator_stop', 'handover']);
export function cutByOf(code: string | undefined, stoppedBy?: StoppedBy, reason?: unknown): CutBy {
  const text = String(code ?? '');
  if (DIRECT.has(text)) return text as CutBy;
  if (text === 'reflex' || text === 'interrupted_by_reflex' || stoppedBy === 'reflex') return 'reflex';
  if (text.startsWith('stop_if') || stoppedBy === 'stopIf') return 'stopIf';
  if (text === 'inventory_full' || stoppedBy === 'inventoryFull') return 'inventoryFull';
  if (text === 'no_progress' || stoppedBy === 'noProgress') return 'noProgress';
  if (text === 'damage_taken' || stoppedBy === 'damage') return 'damage';
  if (text === 'fell' || stoppedBy === 'fall') return 'fall';
  if (text === 'died') return 'death';
  if (text === 'dimension_changed') return 'dimension_changed';
  if (text === 'disconnected') return 'connection_changed';
  if (text === 'timeout' || text === 'deadline' || stoppedBy === 'deadline') return 'deadline';
  const why = String(reason ?? '');
  if (why === 'operator_stop') return 'operator_stop';
  if (why === 'handover') return 'handover';
  if (why === 'lease_expired') return 'lease_expired';
  if (why === 'connection_changed' || why === 'body_disconnected' || why === 'control_disconnected') return 'connection_changed';
  if (why === 'death') return 'death';
  if (why === 'stale_life') return 'stale_life';
  return 'cancelled';
}

/** Whether the act's stop came from outside its hands (not a hand's own failure). */
export function stoppedFromOutside(stoppedBy: StoppedBy | undefined): boolean { return stoppedBy !== undefined && stoppedBy !== 'failure'; }

/** The inventory events of a hand given their ids and delivery numbers: `${command}:${pass}:${hand}:${seq}`, the order they were given in. */
export function numberEvents(events: Array<Omit<InventoryEvent, 'id' | 'obsSeq' | 'deliverySeq'> & Partial<InventoryEvent>>, input: {
  command: string; pass: number; hand: number; obsSeq: number; nextDelivery: number }): InventoryEvent[] {
  return events.map((event, seq) => ({ ...event, id: `${input.command}:${input.pass}:${input.hand}:${seq}`, obsSeq: event.obsSeq ?? input.obsSeq, deliverySeq: input.nextDelivery + seq }));
}
