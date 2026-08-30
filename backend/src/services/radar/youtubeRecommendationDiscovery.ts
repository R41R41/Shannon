import type { RawRadarCandidate } from './radarDiscovery.js';
import type { YouTubeDataApiVideoSearch } from './youtubeSearch.js';
import { YOUTUBE_READONLY_SCOPE, type YouTubeReadGrant, type YouTubeSubscriptionReader } from './youtubeSubscriptionInbox.js';

const OWNER = /^line:[a-f0-9]{64}$/;
const validGrant = (grant: YouTubeReadGrant, owner: string, now: number, first?: YouTubeReadGrant) => grant.owner === owner
  && /^[a-f0-9]{64}$/.test(grant.bindingId) && grant.revision > 0 && grant.scope === YOUTUBE_READONLY_SCOPE && grant.expiresAt > now
  && (!first || (grant.bindingId === first.bindingId && grant.revision === first.revision && grant.expiresAt === first.expiresAt));

/** Public recent-video discovery that explicitly excludes the owner's current subscription channels. */
export class YouTubeRecommendationDiscovery {
  constructor(private readonly subscriptions: Pick<YouTubeSubscriptionReader, 'list'>,
    private readonly search: Pick<YouTubeDataApiVideoSearch, 'list'>, private readonly owner: string,
    private readonly authorize: () => Promise<YouTubeReadGrant>, private readonly maxSubscriptions = 500,
    private readonly now = Date.now) {
    if (!OWNER.test(owner) || !Number.isSafeInteger(maxSubscriptions) || maxSubscriptions < 1 || maxSubscriptions > 500)
      throw new Error('YOUTUBE_RECOMMENDATION_CONFIG_INVALID');
  }
  async find(query: string, limit: number, signal: AbortSignal): Promise<readonly RawRadarCandidate[]> {
    const now = this.now();
    if (typeof query !== 'string' || !query.trim() || query.trim().length > 80 || /[\r\n]/.test(query)
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 8) throw new Error('YOUTUBE_RECOMMENDATION_POLICY_INVALID');
    const first = await this.authorize();
    if (!validGrant(first, this.owner, now)) throw new Error('YOUTUBE_RECOMMENDATION_DENIED');
    const bound = async () => {
      const grant = await this.authorize();
      if (!validGrant(grant, this.owner, this.now(), first)) throw new Error('YOUTUBE_RECOMMENDATION_DENIED');
      return grant;
    };
    const subscribed = await this.subscriptions.list(this.owner, bound, signal, { maxSubscriptions: this.maxSubscriptions });
    const subscribedIds = new Set(subscribed.map(item => item.channelId));
    const hits = await this.search.list(await bound(), query.trim(), limit, signal,
      { publishedAfter: now - 30 * 86400000, order: 'date' });
    await bound();
    return Object.freeze(hits.filter(hit => !subscribedIds.has(hit.channelId)).slice(0, limit).map(hit => Object.freeze({
      source: 'youtube' as const, externalId: hit.videoId, title: hit.title, fact: `${hit.channelTitle} · ${hit.fact}`,
      url: `https://www.youtube.com/watch?v=${hit.videoId}`, publishedAt: hit.publishedAt,
      metadata: Object.freeze([hit.channelTitle, '未登録チャンネル候補']),
    })));
  }
}
