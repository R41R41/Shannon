import { audienceKey, timestamp, validId, validSourceUrl, type RadarAudience } from './content.js';

export interface FeedSubscription {
  readonly id: string;
  readonly revision: number;
  readonly audience: RadarAudience;
  readonly enabled: boolean;
  readonly consentExpiresAt: number;
  readonly kind: 'youtube' | 'web';
  /** YouTube channel ID or exact public Web feed URL. No credentials or signed private URLs. */
  readonly locator: string;
  readonly articleHosts: readonly string[];
  readonly topicIds: readonly string[];
  readonly maxItems: number;
  readonly retentionMs: number;
}
export interface FeedRegistryPort {
  /** Caller authenticates the subject/audience. This port is not a public administration API. */
  get(id: string, audience: RadarAudience): Promise<FeedSubscription | null>;
}
export function validFeedSubscription(source: FeedSubscription, audience: RadarAudience, now: number): boolean {
  return !!source && validId(source.id) && Number.isSafeInteger(source.revision) && source.revision > 0
    && !!audienceKey(audience) && audienceKey(source.audience) === audienceKey(audience)
    && source.enabled === true && timestamp(now) && timestamp(source.consentExpiresAt) && source.consentExpiresAt > now
    && Number.isSafeInteger(source.maxItems) && source.maxItems >= 1 && source.maxItems <= 20
    && Number.isSafeInteger(source.retentionMs) && source.retentionMs >= 60000 && source.retentionMs <= 7 * 86400000
    && Array.isArray(source.topicIds) && source.topicIds.length <= 10 && source.topicIds.every(validId)
    && Array.isArray(source.articleHosts) && source.articleHosts.length >= 1 && source.articleHosts.length <= 10
    && source.articleHosts.every(host => typeof host === 'string' && /^[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,63}$/.test(host))
    && (source.kind === 'youtube' ? /^UC[A-Za-z0-9_-]{22}$/.test(source.locator)
      && source.articleHosts.length === 1 && source.articleHosts[0] === 'www.youtube.com'
      : source.kind === 'web' && validSourceUrl(source.locator));
}
export function snapshotSubscription(source: FeedSubscription): FeedSubscription {
  return Object.freeze({ id: source.id, revision: source.revision, enabled: source.enabled,
    consentExpiresAt: source.consentExpiresAt, kind: source.kind, locator: source.locator,
    maxItems: source.maxItems, retentionMs: source.retentionMs, audience: Object.freeze({ ...source.audience }),
    articleHosts: Object.freeze([...source.articleHosts]), topicIds: Object.freeze([...source.topicIds]) });
}
/** Includes all authority and presentation fields; a revision number alone is insufficient. */
export function subscriptionVersion(source: FeedSubscription): string {
  return JSON.stringify([source.id, source.revision, audienceKey(source.audience), source.enabled, source.consentExpiresAt,
    source.kind, source.locator, source.articleHosts, source.topicIds, source.maxItems, source.retentionMs]);
}
