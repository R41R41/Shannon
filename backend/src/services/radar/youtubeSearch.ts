import { YouTubeSubscriptionError, type YouTubeReadGrant } from './youtubeSubscriptionInbox.js';

export interface AuthorizedYouTubeSearch {
  search(grant: YouTubeReadGrant, pathAndQuery: string, signal: AbortSignal): Promise<unknown>;
}

const videoId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{11}$/.test(v);
const text = (v: unknown, max: number): v is string => typeof v === 'string' && !!v.trim() && v.length <= max;

export interface YouTubeSearchHit {
  videoId: string; channelId: string; title: string; channelTitle: string; publishedAt: number; fact: string;
}

/** Public video search. Distinct from subscription upload discovery; no recommendations. */
export class YouTubeDataApiVideoSearch {
  constructor(private readonly broker: AuthorizedYouTubeSearch) {}
  async list(grant: YouTubeReadGrant, query: string, limit: number, signal: AbortSignal, options: { publishedAfter?: number; order?: 'date' } = {}): Promise<readonly YouTubeSearchHit[]> {
    if (!text(query, 80) || /[\r\n]/.test(query) || !Number.isSafeInteger(limit) || limit < 1 || limit > 8)
      throw new YouTubeSubscriptionError('INVALID_POLICY');
    const params = new URLSearchParams({
      part: 'snippet', type: 'video', maxResults: String(limit), q: query.trim(),
      fields: 'items(id(videoId),snippet(channelId,title,channelTitle,publishedAt,description))',
    });
    if (options.order === 'date') params.set('order', 'date');
    if (options.publishedAfter !== undefined) {
      if (!Number.isSafeInteger(options.publishedAfter) || options.publishedAfter < 0)
        throw new YouTubeSubscriptionError('INVALID_POLICY');
      params.set('publishedAfter', new Date(options.publishedAfter).toISOString());
    }
    const raw = await this.broker.search(grant, `/youtube/v3/search?${params}`, signal);
    const items = (raw as { items?: unknown })?.items;
    if (!Array.isArray(items) || items.length > limit) throw new YouTubeSubscriptionError('INVALID_RESPONSE');
    const result: YouTubeSearchHit[] = [];
    const seen = new Set<string>();
    for (const value of items) {
      const item = value as { id?: { videoId?: unknown }; snippet?: { channelId?: unknown; title?: unknown; channelTitle?: unknown; publishedAt?: unknown; description?: unknown } };
      const id = item.id?.videoId, source = item.snippet?.channelId, title = item.snippet?.title, channel = item.snippet?.channelTitle;
      const publishedAt = typeof item.snippet?.publishedAt === 'string' ? Date.parse(item.snippet.publishedAt) : NaN;
      const fact = typeof item.snippet?.description === 'string' ? item.snippet.description.trim().slice(0, 200) : title;
      if (!videoId(id) || !/^UC[A-Za-z0-9_-]{22}$/.test(String(source)) || seen.has(id) || !text(title, 300) || !text(channel, 160)
        || !Number.isSafeInteger(publishedAt) || !text(fact, 200)) continue;
      seen.add(id);
      result.push({ videoId: id, channelId: String(source), title: title.trim(), channelTitle: channel.trim(), publishedAt, fact: fact.trim() });
    }
    return Object.freeze(result);
  }
}
