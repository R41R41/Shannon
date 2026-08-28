import { audienceKey, eligibleContent, rankCandidates, timestamp, validId, type RadarAudience } from '../../modules/radar/content.js';
import { snapshotSubscription, subscriptionVersion, validFeedSubscription, type FeedRegistryPort } from '../../modules/radar/sourceRegistry.js';
import { createPersonalDigest, type QuietCard } from '../../modules/radar/drafts.js';
import type { DeliveryContext, DeliveryPolicy } from '../../modules/radar/deliveryPolicy.js';
import { feedUrl, type FeedConnectorPort, type FeedRecord } from './feedConnector.js';

export interface CollectionResult {
  readonly status: 'collected' | 'denied' | 'cancelled' | 'failed';
  readonly records: readonly FeedRecord[];
  readonly audit: Readonly<{ sourceId: string; sourceRevision: number | null; audienceKey: string | null;
    outcome: CollectionResult['status']; count: number; at: number }>;
}
/** One explicit read. No schedule, DB writer, retry, memory learning, external post or ambient credentials. */
export class FeedCollector {
  constructor(private readonly registry: FeedRegistryPort, private readonly connector: FeedConnectorPort,
    private readonly clock: () => number = Date.now) {}
  async collect(id: string, requestedAudience: RadarAudience, signal: AbortSignal): Promise<CollectionResult> {
    const audience = Object.freeze({ ...requestedAudience });
    let revision: number | null = null;
    const result = (status: CollectionResult['status'], records: readonly FeedRecord[] = []): CollectionResult => Object.freeze({
      status, records: Object.freeze([...records]), audit: Object.freeze({ sourceId: validId(id) ? id : 'invalid', sourceRevision: revision,
        audienceKey: audienceKey(audience), outcome: status, count: records.length, at: this.clock() }) });
    if (!validId(id) || !audienceKey(audience) || !timestamp(this.clock())) return result('denied');
    if (signal.aborted) return result('cancelled');
    try {
      const original = await this.registry.get(id, audience);
      if (signal.aborted) return result('cancelled');
      if (!original || original.id !== id || !validFeedSubscription(original, audience, this.clock())) return result('denied');
      const source = snapshotSubscription(original); revision = source.revision;
      const records = await this.connector.read(source, signal);
      if (signal.aborted) return result('cancelled');
      // A disabled/expired/moved source cannot return a stale in-flight batch, even if revision wasn't bumped.
      const current = await this.registry.get(id, audience);
      if (signal.aborted) return result('cancelled');
      if (!current || !validFeedSubscription(current, audience, this.clock())
        || subscriptionVersion(current) !== subscriptionVersion(source)) return result('denied');
      if (!Array.isArray(records) || records.length > source.maxItems || records.some(record =>
        record.content.sourceId !== source.id || record.content.sourceKind !== source.kind || record.content.visibility !== 'public'
        || record.provenance.sourceRevision !== source.revision || record.provenance.fetchedUrl !== feedUrl(source)
        || !eligibleContent(record.content, audience, this.clock()))) return result('failed');
      return result('collected', records);
    } catch { return result(signal.aborted ? 'cancelled' : 'failed'); }
  }
}
/** Feed metadata -> existing rank/policy -> private preview. Callers still authenticate the current viewer. */
export function previewCollectedFeed(result: CollectionResult, policy: DeliveryPolicy, context: DeliveryContext,
  preferences: readonly { topicId: string; weight: number }[]): readonly QuietCard[] {
  if (result.status !== 'collected' || policy.audience.kind !== 'personal'
    || result.audit.audienceKey !== audienceKey(policy.audience)) return [];
  return createPersonalDigest(rankCandidates(result.records.map(r => r.content), { audience: policy.audience, now: context.now, preferences }), policy, context);
}
