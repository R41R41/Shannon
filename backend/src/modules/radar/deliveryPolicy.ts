import { audienceKey, eligibleContent, timestamp, unit, validId, type RadarAudience, type RankedCandidate } from './content.js';

export interface DeliveryPolicy {
  readonly audience: RadarAudience;
  readonly revision: number;
  readonly enabled: boolean;
  readonly allowedSourceIds: readonly string[];
  readonly minimumScore: number;
  readonly maxPerHour: number;
  readonly maxPerDay: number;
  readonly minimumGapMs: number;
  readonly maxDigestItems: number;
}
export interface DeliveryContext {
  readonly now: number;
  readonly focusMode: boolean;
  /** Converted from the owner's timezone/quiet-hours policy by the control-plane adapter. */
  readonly quietUntil: number;
  /** Authoritative sent + reserved + uncertain count, across workers and devices. */
  readonly usedThisHour: number;
  readonly usedToday: number;
  readonly lastDeliveryAt: number | null;
  readonly deliveredOrReservedClusterIds: readonly string[];
}
export type DeliveryDecision = Readonly<{
  kind: 'silence' | 'digest' | 'approval_required';
  reason: 'disabled' | 'invalid_context' | 'scope' | 'source' | 'ineligible' | 'low_score' | 'duplicate' | 'quiet' | 'budget' | 'personal_digest' | 'manual_review';
  candidateId: string;
  policyRevision: number | null;
}>;
const count = (n: number) => Number.isSafeInteger(n) && n >= 0;
/** Advisory only: no result grants permission to send. Re-evaluate under an atomic reservation at dispatch. */
export function decideDelivery(candidate: RankedCandidate, policy: DeliveryPolicy | undefined, context: DeliveryContext): DeliveryDecision {
  const result = (kind: DeliveryDecision['kind'], reason: DeliveryDecision['reason']): DeliveryDecision =>
    Object.freeze({ kind, reason, candidateId: candidate.item.id, policyRevision: policy?.revision ?? null });
  if (!policy || policy.enabled !== true) return result('silence', 'disabled');
  if (!timestamp(context.now) || !timestamp(context.quietUntil) || typeof context.focusMode !== 'boolean'
    || !count(context.usedThisHour) || !count(context.usedToday) || context.usedThisHour > context.usedToday
    || (context.lastDeliveryAt !== null && (!timestamp(context.lastDeliveryAt) || context.lastDeliveryAt > context.now))
    || !count(policy.maxPerHour) || !count(policy.maxPerDay) || !timestamp(policy.minimumGapMs)
    || !Number.isSafeInteger(policy.revision) || policy.revision < 1 || !unit(policy.minimumScore)
    || !count(policy.maxDigestItems) || policy.maxDigestItems > 5
    || !Array.isArray(policy.allowedSourceIds) || !policy.allowedSourceIds.every(validId)
    || !Array.isArray(context.deliveredOrReservedClusterIds) || !context.deliveredOrReservedClusterIds.every(validId))
    return result('silence', 'invalid_context');
  const key = audienceKey(candidate.audience);
  if (!key || key !== audienceKey(policy.audience)) return result('silence', 'scope');
  if (!policy.allowedSourceIds.includes(candidate.item.sourceId)) return result('silence', 'source');
  if (!eligibleContent(candidate.item, candidate.audience, context.now) || !unit(candidate.score)) return result('silence', 'ineligible');
  if (candidate.score < policy.minimumScore) return result('silence', 'low_score');
  if (context.deliveredOrReservedClusterIds.includes(candidate.item.clusterId)) return result('silence', 'duplicate');
  // Personal MVP only creates an on-demand digest draft. No immediate alerts, DMs or device pushes.
  if (candidate.audience.kind === 'personal') return policy.maxDigestItems > 0
    ? result('digest', 'personal_digest') : result('silence', 'disabled');
  if (context.focusMode || context.quietUntil > context.now) return result('silence', 'quiet');
  if (context.usedThisHour >= policy.maxPerHour || context.usedToday >= policy.maxPerDay
    || (context.lastDeliveryAt !== null && context.now - context.lastDeliveryAt < policy.minimumGapMs))
    return result('silence', 'budget');
  return result('approval_required', 'manual_review');
}
