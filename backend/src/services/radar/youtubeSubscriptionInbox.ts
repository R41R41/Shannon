import { createHash } from 'node:crypto';

export const YOUTUBE_READONLY_SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';
const channelId = (value: unknown): value is string => typeof value === 'string' && /^UC[A-Za-z0-9_-]{22}$/.test(value);
const videoId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{11}$/.test(value);
const clean = (value: unknown, max: number) => typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : undefined;
export const youtubeDeliveryKey = (owner: string, id: string) => createHash('sha256').update(JSON.stringify([owner, id])).digest('hex');

export type YouTubeViewState = 'viewed' | 'unviewed' | 'unknown';
export interface YouTubeReadGrant {
  owner: string; bindingId: string; revision: number; scope: typeof YOUTUBE_READONLY_SCOPE; expiresAt: number;
}
export interface YouTubeSubscription { channelId: string; title: string; }
export interface YouTubeUpload { videoId: string; channelId: string; channelTitle: string; title: string; publishedAt: number; }
export interface YouTubeSubscriptionPage { items: unknown[]; nextPageToken?: unknown; }
export interface YouTubeSubscriptionTransport {
  listSubscriptions(grant: YouTubeReadGrant, pageToken: string | undefined, signal: AbortSignal): Promise<YouTubeSubscriptionPage>;
}
export interface YouTubeViewStatePort {
  states(owner: string, videoIds: readonly string[], signal: AbortSignal): Promise<ReadonlyMap<string, YouTubeViewState>>;
}
export interface YouTubeDeliveryReceiptPort {
  /** Insert-only reservation. False means this video was already reserved/sent; reservations are never refunded. */
  reserve(owner: string, videoId: string, at: number): Promise<boolean>;
}

export class YouTubeSubscriptionError extends Error {}
export interface YouTubeInboxPolicy {
  baselineAt: number; maxSubscriptions: number; maxCandidates: number;
  unknownViewState: 'defer' | 'assume-unviewed';
}

const validGrant = (grant: YouTubeReadGrant, owner: string, now: number) => grant.owner === owner
  && /^[a-f0-9]{64}$/.test(grant.bindingId) && Number.isSafeInteger(grant.revision) && grant.revision > 0
  && grant.scope === YOUTUBE_READONLY_SCOPE && Number.isSafeInteger(grant.expiresAt) && grant.expiresAt > now;

/** Read-only subscription discovery. OAuth credentials remain inside the injected broker/transport. */
export class YouTubeSubscriptionReader {
  constructor(private readonly transport: YouTubeSubscriptionTransport, private readonly now = Date.now) {}
  async list(owner: string, authorize: () => Promise<YouTubeReadGrant>, signal: AbortSignal,
    policy: Pick<YouTubeInboxPolicy, 'maxSubscriptions'>): Promise<readonly YouTubeSubscription[]> {
    if (!/^line:[a-f0-9]{64}$/.test(owner) || !Number.isSafeInteger(policy.maxSubscriptions)
      || policy.maxSubscriptions < 1 || policy.maxSubscriptions > 500) throw new YouTubeSubscriptionError('INVALID_POLICY');
    const first = await authorize(); if (!validGrant(first, owner, this.now())) throw new YouTubeSubscriptionError('DENIED');
    const result = new Map<string, YouTubeSubscription>(); let token: string | undefined;
    for (let page = 0; page < 10; page++) {
      signal.throwIfAborted();
      const current = await authorize();
      if (!validGrant(current, owner, this.now()) || current.bindingId !== first.bindingId || current.revision !== first.revision)
        throw new YouTubeSubscriptionError('DENIED');
      const response = await this.transport.listSubscriptions(current, token, signal);
      if (!response || !Array.isArray(response.items) || response.items.length > 50) throw new YouTubeSubscriptionError('INVALID_RESPONSE');
      for (const raw of response.items) {
        if (!raw || typeof raw !== 'object') continue;
        const item = raw as { channelId?: unknown; title?: unknown };
        const title = clean(item.title, 160);
        if (!channelId(item.channelId) || !title) continue;
        result.set(item.channelId, { channelId: item.channelId, title });
        if (result.size > policy.maxSubscriptions) throw new YouTubeSubscriptionError('SUBSCRIPTION_LIMIT');
      }
      if (response.nextPageToken === undefined) break;
      if (typeof response.nextPageToken !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(response.nextPageToken)
        || response.nextPageToken === token || page === 9) throw new YouTubeSubscriptionError('INVALID_RESPONSE');
      token = response.nextPageToken;
    }
    const last = await authorize();
    if (!validGrant(last, owner, this.now()) || last.bindingId !== first.bindingId || last.revision !== first.revision)
      throw new YouTubeSubscriptionError('DENIED');
    return Object.freeze([...result.values()].sort((a,b) => a.channelId.localeCompare(b.channelId)));
  }
}

/** Selection is separate from ranking. Exact mode only emits explicit unviewed evidence and otherwise fails closed. */
export async function reserveUnseenYouTubeUploads(owner: string, uploads: readonly YouTubeUpload[], views: YouTubeViewStatePort,
  receipts: YouTubeDeliveryReceiptPort, policy: YouTubeInboxPolicy, now: number, signal: AbortSignal): Promise<readonly YouTubeUpload[]> {
  if (!/^line:[a-f0-9]{64}$/.test(owner) || !Number.isSafeInteger(now) || !Number.isSafeInteger(policy.baselineAt)
    || policy.baselineAt > now || !Number.isSafeInteger(policy.maxCandidates) || policy.maxCandidates < 1 || policy.maxCandidates > 20
    || !Number.isSafeInteger(policy.maxSubscriptions) || policy.maxSubscriptions < 1 || policy.maxSubscriptions > 500
    || !['defer','assume-unviewed'].includes(policy.unknownViewState)) throw new YouTubeSubscriptionError('INVALID_POLICY');
  const unique = new Map<string, YouTubeUpload>();
  for (const upload of uploads) {
    if (!videoId(upload?.videoId) || !channelId(upload?.channelId) || !clean(upload.channelTitle,160) || !clean(upload.title,300)
      || !Number.isSafeInteger(upload.publishedAt) || upload.publishedAt <= policy.baselineAt || upload.publishedAt > now + 300000) continue;
    const normalized = { ...upload, channelTitle: upload.channelTitle.trim(), title: upload.title.trim() };
    const previous = unique.get(upload.videoId);
    if (previous && JSON.stringify(previous) !== JSON.stringify(normalized)) throw new YouTubeSubscriptionError('CONFLICT');
    unique.set(upload.videoId, normalized);
  }
  const ordered = [...unique.values()].sort((a,b) => b.publishedAt - a.publishedAt || a.videoId.localeCompare(b.videoId));
  signal.throwIfAborted(); const states = await views.states(owner, ordered.map(e => e.videoId), signal);
  const selected: YouTubeUpload[] = [];
  for (const upload of ordered) {
    signal.throwIfAborted(); const state = states.get(upload.videoId) ?? 'unknown';
    if (!['viewed','unviewed','unknown'].includes(state)) throw new YouTubeSubscriptionError('INVALID_VIEW_STATE');
    if (state === 'viewed' || (state === 'unknown' && policy.unknownViewState === 'defer')) continue;
    // The receipt key is intentionally derived inside the persistence adapter contract; callers never treat title/URL as identity.
    if (await receipts.reserve(owner, youtubeDeliveryKey(owner, upload.videoId), now)) selected.push(upload);
    if (selected.length >= policy.maxCandidates) break;
  }
  return Object.freeze(selected);
}

/** The official YouTube Data API does not expose watch history; this port makes that limitation explicit. */
export class YouTubeOfficialViewState implements YouTubeViewStatePort {
  async states(_owner: string, videoIds: readonly string[]): Promise<ReadonlyMap<string, YouTubeViewState>> {
    return new Map(videoIds.filter(videoId).map(id => [id, 'unknown' as const]));
  }
}
