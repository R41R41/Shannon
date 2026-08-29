import type { YouTubeReadGrant, YouTubeSubscriptionPage, YouTubeSubscriptionTransport, YouTubeUpload } from './youtubeSubscriptionInbox.js';
import { YouTubeSubscriptionError } from './youtubeSubscriptionInbox.js';

const channelId = (v: unknown): v is string => typeof v === 'string' && /^UC[A-Za-z0-9_-]{22}$/.test(v);
const videoId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{11}$/.test(v);
const token = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(v);
const text = (v: unknown, max: number): v is string => typeof v === 'string' && !!v.trim() && v.length <= max;

/** Token handling and refresh remain in this broker. Implementations must use GET, no redirects/retries, and a response byte limit. */
export interface AuthorizedYouTubeGet {
  get(grant: YouTubeReadGrant, pathAndQuery: string, signal: AbortSignal): Promise<unknown>;
}

export class YouTubeDataApiSubscriptionTransport implements YouTubeSubscriptionTransport {
  constructor(private readonly broker: AuthorizedYouTubeGet) {}
  async listSubscriptions(grant: YouTubeReadGrant, pageToken: string | undefined, signal: AbortSignal): Promise<YouTubeSubscriptionPage> {
    if (pageToken !== undefined && !token(pageToken)) throw new YouTubeSubscriptionError('INVALID_PAGE_TOKEN');
    const query = new URLSearchParams({ part:'snippet', mine:'true', maxResults:'50',
      fields:'nextPageToken,items(snippet(title,resourceId(channelId)))' });
    if (pageToken) query.set('pageToken', pageToken);
    const raw = await this.broker.get(grant, `/youtube/v3/subscriptions?${query}`, signal);
    if (!raw || typeof raw !== 'object') throw new YouTubeSubscriptionError('INVALID_RESPONSE');
    const body = raw as { items?: unknown; nextPageToken?: unknown };
    if (!Array.isArray(body.items) || body.items.length > 50 || (body.nextPageToken !== undefined && !token(body.nextPageToken)))
      throw new YouTubeSubscriptionError('INVALID_RESPONSE');
    const items = body.items.flatMap(value => {
      const item = value as { snippet?: { title?: unknown; resourceId?: { channelId?: unknown } } };
      const id = item?.snippet?.resourceId?.channelId, title = item?.snippet?.title;
      return channelId(id) && text(title,160) ? [{channelId:id,title:title.trim()}] : [];
    });
    return { items, ...(body.nextPageToken ? {nextPageToken:body.nextPageToken} : {}) };
  }
}

export interface YouTubeUploadDiscoveryPolicy {
  publishedAfter: number; maxPerChannel: number; maxTotal: number;
}

/** Bounded upload discovery for the synchronized subscription set. No search.list or recommendation endpoint. */
export class YouTubeDataApiUploadReader {
  constructor(private readonly broker: AuthorizedYouTubeGet) {}
  async list(grant: YouTubeReadGrant, subscriptions: readonly {channelId:string}[], policy: YouTubeUploadDiscoveryPolicy,
    signal: AbortSignal): Promise<readonly YouTubeUpload[]> {
    if (!Number.isSafeInteger(policy.publishedAfter) || !Number.isSafeInteger(policy.maxPerChannel) || policy.maxPerChannel<1 || policy.maxPerChannel>10
      || !Number.isSafeInteger(policy.maxTotal) || policy.maxTotal<1 || policy.maxTotal>100 || subscriptions.length<1 || subscriptions.length>500
      || subscriptions.some(s=>!channelId(s.channelId)) || new Set(subscriptions.map(s=>s.channelId)).size!==subscriptions.length)
      throw new YouTubeSubscriptionError('INVALID_POLICY');
    const channels = new Map<string,{title:string;uploads:string}>();
    for(let offset=0;offset<subscriptions.length;offset+=50){
      signal.throwIfAborted(); const ids=subscriptions.slice(offset,offset+50).map(e=>e.channelId);
      const query=new URLSearchParams({part:'snippet,contentDetails',id:ids.join(','),maxResults:'50',
        fields:'items(id,snippet(title),contentDetails(relatedPlaylists(uploads)))'});
      const raw=await this.broker.get(grant,`/youtube/v3/channels?${query}`,signal);
      const items=(raw as {items?:unknown})?.items;
      if(!Array.isArray(items)||items.length>50)throw new YouTubeSubscriptionError('INVALID_RESPONSE');
      for(const value of items){
        const item=value as {id?:unknown;snippet?:{title?:unknown};contentDetails?:{relatedPlaylists?:{uploads?:unknown}}};
        const id=item.id,title=item.snippet?.title,uploads=item.contentDetails?.relatedPlaylists?.uploads;
        if(channelId(id)&&text(title,160)&&typeof uploads==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(uploads))channels.set(id,{title:title.trim(),uploads});
      }
    }
    const result=new Map<string,YouTubeUpload>();
    // Sequential calls keep provider pressure and cancellation behavior predictable. Runtime may shard this later under a reviewed quota policy.
    for(const [id,channel] of channels){
      signal.throwIfAborted();
      const query=new URLSearchParams({part:'snippet,contentDetails',playlistId:channel.uploads,maxResults:String(policy.maxPerChannel),
        fields:'items(contentDetails(videoId,videoPublishedAt),snippet(title,channelId,channelTitle,publishedAt))'});
      const raw=await this.broker.get(grant,`/youtube/v3/playlistItems?${query}`,signal);
      const items=(raw as {items?:unknown})?.items;
      if(!Array.isArray(items)||items.length>policy.maxPerChannel)throw new YouTubeSubscriptionError('INVALID_RESPONSE');
      for(const value of items){
        const item=value as {contentDetails?:{videoId?:unknown;videoPublishedAt?:unknown};snippet?:{title?:unknown;channelId?:unknown;channelTitle?:unknown;publishedAt?:unknown}};
        const vid=item.contentDetails?.videoId, source=item.snippet?.channelId, title=item.snippet?.title;
        const date=item.contentDetails?.videoPublishedAt??item.snippet?.publishedAt, publishedAt=typeof date==='string'?Date.parse(date):NaN;
        if(!videoId(vid)||source!==id||!text(title,300)||!Number.isSafeInteger(publishedAt)||publishedAt<=policy.publishedAfter)continue;
        const normalized={videoId:vid,channelId:id,channelTitle:channel.title,title:title.trim(),publishedAt};
        const previous=result.get(vid);if(previous&&JSON.stringify(previous)!==JSON.stringify(normalized))throw new YouTubeSubscriptionError('CONFLICT');
        result.set(vid,normalized);
      }
    }
    return Object.freeze([...result.values()].sort((a,b)=>b.publishedAt-a.publishedAt||a.videoId.localeCompare(b.videoId)).slice(0,policy.maxTotal));
  }
}
