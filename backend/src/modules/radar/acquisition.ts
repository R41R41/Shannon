import { timestamp, validId } from './content.js';

export const ACQUISITION_WINDOW_MS = 86400000;
export const MAX_ACQUISITION_ATTEMPTS = 256;
/** Server-owned limits, separate from notification budgets. No live defaults. */
export interface AcquisitionPolicy {
  readonly maxPer24Hours: number;
  readonly minimumIntervalMs: number;
  readonly leaseMs: number;
}
export interface AcquisitionLease {
  readonly id: string;
  readonly sourceId: string;
  readonly sourceRevision: number;
  readonly startedAt: number;
  readonly expiresAt: number;
}
export interface AcquisitionState {
  readonly version: 1;
  readonly policy: AcquisitionPolicy;
  readonly observedAt: number;
  /** Every reserved attempt counts, even failure, cancellation or a crash before HTTP. */
  readonly starts: readonly number[];
  readonly lease: AcquisitionLease | null;
}
export class AcquisitionError extends Error {
  constructor(readonly code: 'INVALID_STATE' | 'POLICY_MISMATCH' | 'CLOCK_ROLLBACK' | 'BUSY' | 'RATE_LIMITED' | 'LEASE_EXPIRED') { super(code); }
}
const keys = (v: unknown, expected: string[]): v is Record<string, unknown> => !!v && typeof v === 'object'
  && !Array.isArray(v) && Object.keys(v).length === expected.length && Object.keys(v).every(k => expected.includes(k));
export function validAcquisitionPolicy(v: unknown): v is AcquisitionPolicy {
  return keys(v, ['maxPer24Hours', 'minimumIntervalMs', 'leaseMs'])
    && timestamp(v.maxPer24Hours) && v.maxPer24Hours >= 1 && v.maxPer24Hours <= MAX_ACQUISITION_ATTEMPTS
    && timestamp(v.minimumIntervalMs) && v.minimumIntervalMs <= ACQUISITION_WINDOW_MS
    && timestamp(v.leaseMs) && v.leaseMs >= 100 && v.leaseMs <= 60000;
}
export function validAcquisitionState(v: unknown): v is AcquisitionState {
  if (!keys(v, ['version', 'policy', 'observedAt', 'starts', 'lease']) || v.version !== 1
    || !validAcquisitionPolicy(v.policy) || !timestamp(v.observedAt) || !Array.isArray(v.starts)
    || v.starts.length > MAX_ACQUISITION_ATTEMPTS || v.starts.some((t, i, a) => !timestamp(t) || t > Number(v.observedAt) || (i > 0 && t < a[i - 1]))) return false;
  const l = v.lease;
  return l === null || (keys(l, ['id', 'sourceId', 'sourceRevision', 'startedAt', 'expiresAt'])
    && validId(l.id) && validId(l.sourceId) && timestamp(l.sourceRevision) && l.sourceRevision > 0
    && timestamp(l.startedAt) && l.startedAt === v.starts.at(-1) && timestamp(l.expiresAt)
    && l.expiresAt > l.startedAt && l.expiresAt <= l.startedAt + v.policy.leaseMs);
}
export function acquisitionTime(state: AcquisitionState, now: number): void {
  if (!validAcquisitionState(state) || !timestamp(now)) throw new AcquisitionError('INVALID_STATE');
  if (now < state.observedAt) throw new AcquisitionError('CLOCK_ROLLBACK');
}
export function assertAcquisitionLease(state: AcquisitionState | undefined, id: string, now: number): void {
  if (!state) throw new AcquisitionError('INVALID_STATE');
  acquisitionTime(state, now);
  if (state.lease?.id !== id || state.lease.expiresAt <= now) throw new AcquisitionError('LEASE_EXPIRED');
}
export function reserveAcquisition(state: AcquisitionState | undefined, policy: AcquisitionPolicy,
  lease: AcquisitionLease): AcquisitionState {
  if (!validAcquisitionPolicy(policy)) throw new AcquisitionError('INVALID_STATE');
  const now = lease.startedAt;
  if (state) {
    acquisitionTime(state, now);
    if (state.policy.maxPer24Hours !== policy.maxPer24Hours || state.policy.minimumIntervalMs !== policy.minimumIntervalMs
      || state.policy.leaseMs !== policy.leaseMs) throw new AcquisitionError('POLICY_MISMATCH');
    // Expired work must be explicitly recovered; claiming never silently starts another fetch.
    if (state.lease) throw new AcquisitionError('BUSY');
  }
  const starts = (state?.starts ?? []).filter(t => t > now - ACQUISITION_WINDOW_MS);
  if (starts.length >= policy.maxPer24Hours || (starts.length > 0 && now - starts.at(-1)! < policy.minimumIntervalMs))
    throw new AcquisitionError('RATE_LIMITED');
  const next: AcquisitionState = { version: 1, policy: { ...policy }, observedAt: now, starts: [...starts, now], lease: { ...lease } };
  if (!validAcquisitionState(next)) throw new AcquisitionError('INVALID_STATE');
  return next;
}
/** Only releases ownership; never refunds an attempt or retries an HTTP request. */
export function releaseAcquisition(state: AcquisitionState, now: number): AcquisitionState {
  acquisitionTime(state, now);
  return { ...state, policy: { ...state.policy }, observedAt: now, starts: [...state.starts], lease: null };
}
