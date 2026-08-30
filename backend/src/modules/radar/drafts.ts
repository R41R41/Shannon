import { audienceKey, eligibleContent, timestamp, validId, type RankedCandidate } from './content.js';
import { decideDelivery, type DeliveryContext, type DeliveryPolicy } from './deliveryPolicy.js';

export interface QuietCard {
  readonly title: string;
  readonly fact: string;
  readonly sourceUrl: string;
  readonly metadata: readonly string[];
  readonly tags: readonly string[];
  readonly mentions: 'none';
  readonly notify: false;
  readonly thread: 'none';
}
const neutral = (text: string) => text.replace(/@/g, '＠').replace(/[\\_*~`|>\[\]<>]/g, '\\$&');
/** No reasons, subject IDs, instructions, reaction prompts, images or local file attachments. */
export function createQuietCard(candidate: RankedCandidate, now: number): QuietCard | null {
  const item = candidate.item;
  if (!eligibleContent(item, candidate.audience, now)) return null;
  // Private/community observations must not be made into public source cards.
  if (candidate.audience.kind === 'community' && item.visibility !== 'public') return null;
  if ([item.title, item.fact, ...item.metadata].some(text => /[?？]/.test(text))) return null;
  return Object.freeze({ title: neutral(item.title), fact: neutral(item.fact), sourceUrl: item.sourceUrl,
    metadata: Object.freeze(item.metadata.map(neutral)), tags: Object.freeze(item.topicIds.map(neutral)),
    mentions: 'none', notify: false, thread: 'none' });
}
export interface DiscordDraft {
  readonly deliveryId: string;
  readonly audienceKey: string;
  readonly policyRevision: number;
  readonly candidateId: string;
  readonly candidateRevision: number;
  readonly sourceId: string;
  readonly expiresAt: number;
  readonly card: QuietCard;
}
export function createDiscordDraft(candidate: RankedCandidate, policy: DeliveryPolicy, context: DeliveryContext, deliveryId: string): DiscordDraft | null {
  if (!validId(deliveryId) || candidate.audience.kind !== 'community'
    || decideDelivery(candidate, policy, context).kind !== 'approval_required') return null;
  const card = createQuietCard(candidate, context.now);
  if (!card) return null;
  return Object.freeze({ deliveryId, audienceKey: audienceKey(candidate.audience)!, policyRevision: policy.revision,
    candidateId: candidate.item.id, candidateRevision: candidate.item.revision, sourceId: candidate.item.sourceId,
    expiresAt: candidate.item.expiresAt, card });
}
/** Exact reviewed payload representation. Persistence may additionally hash this with SHA-256. */
export function reviewSnapshot(draft: DiscordDraft): string {
  return JSON.stringify([draft.deliveryId, draft.audienceKey, draft.policyRevision, draft.candidateId,
    draft.candidateRevision, draft.sourceId, draft.expiresAt, draft.card.title, draft.card.fact,
    draft.card.sourceUrl, draft.card.metadata, draft.card.tags, draft.card.mentions, draft.card.notify, draft.card.thread]);
}
export interface PublicationApproval {
  readonly approverId: string;
  readonly reviewedSnapshot: string;
  readonly approvedAt: number;
  readonly expiresAt: number;
  readonly revoked: boolean;
}
/** Consistency check, NOT authentication or a send capability. Only trusted repository records may enter here. */
export function matchesApproval(draft: DiscordDraft, approval: PublicationApproval | undefined, allowedApproverIds: readonly string[], now: number): boolean {
  return !!approval && validId(approval.approverId) && allowedApproverIds.includes(approval.approverId)
    && timestamp(now) && timestamp(approval.approvedAt) && approval.approvedAt <= now
    && timestamp(approval.expiresAt) && approval.expiresAt > now && draft.expiresAt > now && approval.revoked === false
    && approval.reviewedSnapshot === reviewSnapshot(draft);
}
/** Private preview only; no delivery budget is consumed and no notification is scheduled. */
export function createPersonalDigest(candidates: readonly RankedCandidate[], policy: DeliveryPolicy, context: DeliveryContext): readonly QuietCard[] {
  if (policy.audience.kind !== 'personal') return [];
  const seen = new Set<string>(); const cards: QuietCard[] = [];
  for (const candidate of candidates) {
    if (decideDelivery(candidate, policy, context).kind !== 'digest' || seen.has(candidate.item.clusterId)) continue;
    const card = createQuietCard(candidate, context.now);
    if (card) { cards.push(card); seen.add(candidate.item.clusterId); }
    if (cards.length >= policy.maxDigestItems) break;
  }
  return Object.freeze(cards);
}
