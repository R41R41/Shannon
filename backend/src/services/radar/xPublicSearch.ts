import type { RawRadarCandidate } from './radarDiscovery.js';

const TWEET_ID = /^\d{5,30}$/;
const USER = /^[A-Za-z0-9_]{1,15}$/;
const clean = (value: unknown, max: number) => typeof value === 'string' && value.trim() && value.trim().length <= max
  && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value) ? value.trim() : undefined;
const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 1_000_000_000 ? Number(value) : 0;

/** Dedicated read-only twitterapi.io search. One bounded GET, no cookies, account login, write endpoint, retry or pagination. */
export class XPublicSearch {
  constructor(private readonly apiKey: string, private readonly http: typeof fetch = fetch, private readonly now = Date.now) {
    if (!/^[A-Za-z0-9._-]{16,256}$/.test(apiKey)) throw new Error('X_SEARCH_CONFIG_INVALID');
  }
  async list(query: string, limit: number, signal: AbortSignal): Promise<readonly RawRadarCandidate[]> {
    if (!clean(query, 120) || /[\r\n]/.test(query) || !Number.isSafeInteger(limit) || limit < 1 || limit > 20)
      throw new Error('X_SEARCH_POLICY_INVALID');
    const url = new URL('https://api.twitterapi.io/twitter/tweet/advanced_search');
    url.search = new URLSearchParams({ query: query.trim(), queryType: 'Latest' }).toString();
    const response = await this.http(url, { method: 'GET', redirect: 'error', headers: { 'X-API-Key': this.apiKey },
      signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) });
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > 1024 * 1024) throw new Error('X_SEARCH_RESPONSE_INVALID');
    const text = await response.text();
    if (!response.ok || Buffer.byteLength(text) > 1024 * 1024) throw new Error('X_SEARCH_UNAVAILABLE');
    let body: any; try { body = JSON.parse(text); } catch { throw new Error('X_SEARCH_RESPONSE_INVALID'); }
    if ((body.status !== undefined && body.status !== 'success') || !Array.isArray(body.tweets) || body.tweets.length > 50)
      throw new Error('X_SEARCH_RESPONSE_INVALID');
    const result: RawRadarCandidate[] = []; const seen = new Set<string>(); const now = this.now();
    for (const raw of body.tweets) {
      const id = clean(raw?.id, 30), tweet = clean(raw?.text, 5000), username = clean(raw?.author?.userName, 15);
      const publishedAt = typeof raw?.createdAt === 'string' ? Date.parse(raw.createdAt) : NaN;
      if (!id || !TWEET_ID.test(id) || seen.has(id) || !tweet || /^RT\s/i.test(tweet) || raw?.isReply === true
        || !username || !USER.test(username) || !Number.isSafeInteger(publishedAt) || publishedAt > now + 300000) continue;
      seen.add(id);
      const likes = count(raw.likeCount), reposts = count(raw.retweetCount), replies = count(raw.replyCount), quotes = count(raw.quoteCount);
      result.push(Object.freeze({ source: 'x' as const, externalId: id, title: `@${username}`, fact: tweet.slice(0, 600),
        url: `https://x.com/${username}/status/${id}`, publishedAt,
        metadata: Object.freeze([`likes ${likes}`, `reposts ${reposts}`, `replies ${replies}`, `quotes ${quotes}`]) }));
      if (result.length >= limit) break;
    }
    return Object.freeze(result);
  }
}
