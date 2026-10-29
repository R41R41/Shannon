/**
 * The YouTube Live pieces of the ear, over plain `fetch` (so a bench can point `baseUrl` at a fake API).
 *
 * Quota (units per call), from https://developers.google.com/youtube/v3/determine_quota_cost, read 2026-10-29:
 *   liveBroadcasts.list 1, videos.list 1, liveChatMessages.list 5, liveChatMessages.insert 20 (search.list is 1 unit but capped at
 *   100 calls a day, which is why the old runtime's `search.list` for the live video is not used here). The default is 10,000 units a day.
 * `liveChatMessages.list` is the cost that matters: 5 units for every poll, so the polling interval YouTube returns decides the day.
 */
import { createLogger } from '../../../utils/logger.js';

const logger = createLogger('YoutubeEar:Api');

export const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';

export type YoutubeEndpoint = 'liveBroadcasts.list' | 'videos.list' | 'liveChatMessages.list' | 'liveChatMessages.insert';

export const QUOTA_UNITS: Readonly<Record<YoutubeEndpoint, number>> = Object.freeze({
  'liveBroadcasts.list': 1,
  'videos.list': 1,
  'liveChatMessages.list': 5,
  'liveChatMessages.insert': 20,
});

/** The default daily quota of a project. A warning is logged from 80% of it. */
export const DAILY_QUOTA_UNITS = 10_000;

export type TokenProvider = (forceRefresh?: boolean) => Promise<string>;

export class YoutubeApiError extends Error {
  constructor(
    readonly endpoint: YoutubeEndpoint,
    /** HTTP status; 0 when the request did not get an answer (network, timeout). */
    readonly status: number,
    /** `error.errors[0].reason` of Google's error body (`liveChatEnded`, `quotaExceeded`, ...), or ''. */
    readonly reason: string,
    message?: string,
  ) {
    super(message ?? `${endpoint} failed: ${status} ${reason}`.trim());
    this.name = 'YoutubeApiError';
  }

  /** The chat is over, gone or closed for good: reading it again can never work. */
  get chatEnded(): boolean {
    return ['liveChatEnded', 'liveChatNotFound', 'liveChatDisabled'].includes(this.reason)
      || (this.endpoint === 'liveChatMessages.list' && this.status === 404);
  }

  /** The project's quota (or the request rate) is used up: wait, do not hammer. */
  get quota(): boolean {
    return ['quotaExceeded', 'dailyLimitExceeded', 'rateLimitExceeded', 'userRateLimitExceeded'].includes(this.reason);
  }
}

/** Counts the units spent and reports them. Time comes in as a function so a test can drive it. */
export class ApiUnitMeter {
  private hourUnits = 0;
  private hourCalls = 0;
  private hourStartedAt: number;
  private dayKey: string;
  private dayUnits = 0;
  private totalUnits = 0;
  private warnedDay = '';

  constructor(
    private readonly now: () => number = Date.now,
    private readonly report: (line: string) => void = line => logger.info(line),
    private readonly warn: (line: string) => void = line => logger.warn(line),
  ) {
    this.hourStartedAt = now();
    this.dayKey = quotaDay(now());
  }

  add(endpoint: YoutubeEndpoint): void {
    const units = QUOTA_UNITS[endpoint];
    this.rollDay();
    this.hourUnits += units;
    this.hourCalls += 1;
    this.dayUnits += units;
    this.totalUnits += units;
    if (this.dayUnits >= DAILY_QUOTA_UNITS * 0.8 && this.warnedDay !== this.dayKey) {
      this.warnedDay = this.dayKey;
      this.warn(`YouTube API: ${this.dayUnits} of ${DAILY_QUOTA_UNITS} units used today (quota resets at midnight Pacific time)`);
    }
  }

  /** Logs the last hour's total once an hour has passed. Called from the ear's loops; no timer of its own. */
  tick(): void {
    if (this.now() - this.hourStartedAt < 3_600_000) return;
    this.flush();
  }

  /** Logs what has been spent since the last report (also at stop). */
  flush(): void {
    this.rollDay();
    const hours = Math.max(1 / 60, (this.now() - this.hourStartedAt) / 3_600_000);
    this.report(`YouTube API units: ${this.hourUnits} in ${this.hourCalls} calls over ${hours.toFixed(2)} h, ${this.dayUnits} today (of ${DAILY_QUOTA_UNITS})`);
    this.hourUnits = 0;
    this.hourCalls = 0;
    this.hourStartedAt = this.now();
  }

  snapshot(): { hourUnits: number; hourCalls: number; dayUnits: number; totalUnits: number } {
    this.rollDay();
    return { hourUnits: this.hourUnits, hourCalls: this.hourCalls, dayUnits: this.dayUnits, totalUnits: this.totalUnits };
  }

  private rollDay(): void {
    const key = quotaDay(this.now());
    if (key !== this.dayKey) {
      this.dayKey = key;
      this.dayUnits = 0;
    }
  }
}

/** The quota day: YouTube resets the quota at midnight Pacific time. */
function quotaDay(at: number): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date(at));
  } catch {
    return new Date(at).toISOString().slice(0, 10);
  }
}

export interface LiveChatMessageResource {
  id?: string;
  snippet?: {
    type?: string;
    publishedAt?: string;
    hasDisplayContent?: boolean;
    displayMessage?: string;
    textMessageDetails?: { messageText?: string };
    superChatDetails?: { amountMicros?: string | number; currency?: string; amountDisplayString?: string; userComment?: string; tier?: number };
    superStickerDetails?: {
      amountMicros?: string | number; currency?: string; amountDisplayString?: string;
      superStickerMetadata?: { stickerId?: string; altText?: string; language?: string };
    };
    newSponsorDetails?: { memberLevelName?: string; isUpgrade?: boolean };
    memberMilestoneChatDetails?: { userComment?: string; memberMonth?: number; memberLevelName?: string };
    membershipGiftingDetails?: { giftMembershipsCount?: number; giftMembershipsLevelName?: string };
  };
  authorDetails?: {
    channelId?: string;
    displayName?: string;
    isChatOwner?: boolean;
    isChatModerator?: boolean;
    isChatSponsor?: boolean;
    isVerified?: boolean;
  };
}

export interface LiveChatPage {
  items: LiveChatMessageResource[];
  nextPageToken?: string;
  /** What YouTube asked for, in ms (the ear clamps it). Undefined when the answer did not carry one. */
  pollingIntervalMillis?: number;
  /** Present when the stream is already offline. */
  offlineAt?: string;
}

export interface ActiveBroadcast {
  videoId: string;
  title: string;
  channelId: string;
  /** `snippet.liveChatId` of the broadcast, when the list carried it. */
  liveChatId?: string;
}

export interface VideoLiveDetails {
  videoId: string;
  title: string;
  channelId: string;
  liveChatId?: string;
  actualStartTime?: string;
  liveBroadcastContent?: string;
}

export interface YoutubeLiveApiOptions {
  /** Default `https://www.googleapis.com/youtube/v3`; a bench passes its fake API here. */
  baseUrl?: string;
  getAccessToken: TokenProvider;
  fetcher?: typeof fetch;
  meter?: ApiUnitMeter;
  timeoutMs?: number;
}

export class YoutubeLiveApi {
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  readonly meter: ApiUnitMeter;

  constructor(private readonly options: YoutubeLiveApiOptions) {
    this.baseUrl = (options.baseUrl ?? YOUTUBE_API_BASE).replace(/\/+$/, '');
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.meter = options.meter ?? new ApiUnitMeter();
  }

  /** The broadcast of the OAuth channel that is live now (`mine=true`), or null. A `live` one is preferred over a `testing` one. */
  async findActiveBroadcast(): Promise<ActiveBroadcast | null> {
    const body = await this.request('liveBroadcasts.list', 'GET', '/liveBroadcasts', {
      part: 'snippet,status', mine: 'true', broadcastStatus: 'active',
    });
    const items = Array.isArray(body.items) ? body.items as Array<Record<string, any>> : [];
    const live = items.find(item => item?.status?.lifeCycleStatus === 'live') ?? items[0];
    if (!live || typeof live.id !== 'string' || !live.id) return null;
    return {
      videoId: live.id,
      title: str(live.snippet?.title),
      channelId: str(live.snippet?.channelId),
      ...(typeof live.snippet?.liveChatId === 'string' && live.snippet.liveChatId ? { liveChatId: live.snippet.liveChatId } : {}),
    };
  }

  async videoDetails(videoId: string): Promise<VideoLiveDetails | null> {
    const body = await this.request('videos.list', 'GET', '/videos', { part: 'liveStreamingDetails,snippet', id: videoId });
    const video = Array.isArray(body.items) ? (body.items as Array<Record<string, any>>)[0] : undefined;
    if (!video) return null;
    const chatId = video.liveStreamingDetails?.activeLiveChatId;
    return {
      videoId,
      title: str(video.snippet?.title),
      channelId: str(video.snippet?.channelId),
      ...(typeof chatId === 'string' && chatId ? { liveChatId: chatId } : {}),
      ...(typeof video.liveStreamingDetails?.actualStartTime === 'string' ? { actualStartTime: video.liveStreamingDetails.actualStartTime } : {}),
      ...(typeof video.snippet?.liveBroadcastContent === 'string' ? { liveBroadcastContent: video.snippet.liveBroadcastContent } : {}),
    };
  }

  async listMessages(input: { liveChatId: string; pageToken?: string; maxResults?: number }): Promise<LiveChatPage> {
    const body = await this.request('liveChatMessages.list', 'GET', '/liveChat/messages', {
      part: 'snippet,authorDetails',
      liveChatId: input.liveChatId,
      maxResults: String(input.maxResults ?? 2000),
      ...(input.pageToken ? { pageToken: input.pageToken } : {}),
    });
    const polling = Number(body.pollingIntervalMillis);
    return {
      items: Array.isArray(body.items) ? body.items as LiveChatMessageResource[] : [],
      ...(typeof body.nextPageToken === 'string' && body.nextPageToken ? { nextPageToken: body.nextPageToken } : {}),
      ...(Number.isFinite(polling) && polling > 0 ? { pollingIntervalMillis: polling } : {}),
      ...(typeof body.offlineAt === 'string' && body.offlineAt ? { offlineAt: body.offlineAt } : {}),
    };
  }

  /** Writes one chat message as the OAuth channel. Returns the new message's id (so the ear can recognise its own echo). */
  async insertMessage(liveChatId: string, text: string): Promise<string> {
    const body = await this.request('liveChatMessages.insert', 'POST', '/liveChat/messages', { part: 'snippet' }, {
      snippet: { liveChatId, type: 'textMessageEvent', textMessageDetails: { messageText: text } },
    });
    return typeof body.id === 'string' ? body.id : '';
  }

  private async request(
    endpoint: YoutubeEndpoint,
    method: 'GET' | 'POST',
    path: string,
    query: Record<string, string>,
    json?: unknown,
  ): Promise<Record<string, unknown>> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    for (let attempt = 0; ; attempt += 1) {
      const token = await this.options.getAccessToken(attempt > 0);
      let response: Response;
      try {
        response = await this.fetcher(url.toString(), {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            accept: 'application/json',
            ...(json === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(json === undefined ? {} : { body: JSON.stringify(json) }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        throw new YoutubeApiError(endpoint, 0, 'network', `${endpoint} could not be reached: ${error instanceof Error ? error.message : 'unknown'}`);
      }
      this.meter.add(endpoint);
      const text = await response.text().catch(() => '');
      let parsed: Record<string, any> = {};
      try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = {}; }
      if (response.ok) return parsed;
      // One refresh and one more try when the token was refused; every other error is the caller's to judge.
      if (response.status === 401 && attempt === 0) continue;
      const reason = str(parsed?.error?.errors?.[0]?.reason) || str(parsed?.error?.status);
      throw new YoutubeApiError(endpoint, response.status, reason, `${endpoint} failed: ${response.status} ${reason} ${str(parsed?.error?.message)}`.trim());
    }
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
