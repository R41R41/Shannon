/**
 * The YouTube Live pieces of the ear, over plain `fetch` (so a bench can point `baseUrl` at a fake API).
 *
 * Quota (units per call), from https://developers.google.com/youtube/v3/determine_quota_cost, read 2026-10-29 and again 2026-10-30:
 *   liveBroadcasts.list 1, videos.list 1, liveChatMessages.list 5, liveChatMessages.streamList 5, liveChatMessages.insert 20
 *   (search.list is 1 unit but capped at 100 calls a day, which is why the old runtime's `search.list` for the live video is not used
 *   here). The default is 10,000 units a day. The same page: "each additional page request incurs the cost again" for list/streamList.
 *
 * `liveChatMessages.list` costs 5 units for every poll, so the polling interval decides the day (5 s: 2.8 h of a 10,000-unit day).
 * `liveChatMessages.streamList` is one long connection that YouTube pushes the messages down; Google's reference says
 * "A call to this method has a quota cost of 5 units" (discovery document, 2026-10-30) and does not say whether a "call" is the
 * connection or each response pushed down it. UNKNOWN. The ear counts 5 units per connection opened (what the call wording and the
 * open-source clients I read assume); the hourly log line is what to compare with the Cloud console's quota graph.
 *
 * streamList, from the same sources (2026-10-30):
 *   - REST form (discovery document https://www.googleapis.com/discovery/v1/apis/youtube/v3/rest, resource `youtube.v3.liveChat.messages`,
 *     method `stream`): `GET https://www.googleapis.com/youtube/v3/liveChat/messages/stream`, query `liveChatId`, `part` (`id`, `snippet`,
 *     `authorDetails`), `pageToken`, `hl`, `profileImageSize`, `maxResults` ("Not used in the streaming RPC"); no body; response type
 *     `LiveChatMessageListResponse` (`items`, `nextPageToken`, `offlineAt`, ...); scopes youtube, youtube.force-ssl, youtube.readonly.
 *   - The first answer is the recent history ("will only contain the most recent events"); then new messages as they arrive, oldest
 *     first inside a response; "pass the last nextPageToken as pageToken" to resume after a disconnect
 *     (https://developers.google.com/youtube/v3/live/docs/liveChatMessages/streamList and .../streaming-live-chat).
 *   - Errors (same streamList page): over web traffic 400 pageTokenInvalid, 403 forbidden / liveChatDisabled / liveChatEnded /
 *     rateLimitExceeded, 404 liveChatNotFound; over gRPC PERMISSION_DENIED, INVALID_ARGUMENT, FAILED_PRECONDITION (disabled or ended,
 *     not told apart), NOT_FOUND, RESOURCE_EXHAUSTED.
 *   - NOT documented (UNKNOWN, not guessed): the framing of the HTTP body (streamParser.ts reads every usual one), how long a connection
 *     lives, whether the server sends anything on a quiet chat, and what `pollingIntervalMillis` means on a stream. The ear therefore
 *     resumes by token whenever a connection ends and watches for silence itself (`streamIdleMs`).
 *   - The documented streaming client is gRPC (`youtube.googleapis.com:443`, `V3DataLiveChatMessageService/StreamList`); this ear uses
 *     the REST form over plain `fetch`, which needs no extra dependency. It has not been run against the real YouTube yet.
 */
import { createLogger } from '../../../utils/logger.js';
import { JsonStreamParser } from './streamParser.js';

const logger = createLogger('YoutubeEar:Api');

export const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';

export type YoutubeEndpoint = 'liveBroadcasts.list' | 'videos.list' | 'liveChatMessages.list' | 'liveChatMessages.streamList' | 'liveChatMessages.insert';

export const QUOTA_UNITS: Readonly<Record<YoutubeEndpoint, number>> = Object.freeze({
  'liveBroadcasts.list': 1,
  'videos.list': 1,
  'liveChatMessages.list': 5,
  'liveChatMessages.streamList': 5,
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
      || (this.endpoint === 'liveChatMessages.list' && this.status === 404)
      // gRPC-style statuses (the docs: FAILED_PRECONDITION is "disabled or ended", NOT_FOUND is "the live chat was not found").
      || (this.endpoint === 'liveChatMessages.streamList' && ['FAILED_PRECONDITION', 'NOT_FOUND'].includes(this.reason));
  }

  /** The project's quota (or the request rate) is used up: wait, do not hammer. */
  get quota(): boolean {
    return ['quotaExceeded', 'dailyLimitExceeded', 'rateLimitExceeded', 'userRateLimitExceeded', 'RESOURCE_EXHAUSTED'].includes(this.reason)
      || (this.endpoint === 'liveChatMessages.streamList' && this.status === 429);
  }

  /** The resume token was refused (400 `pageTokenInvalid`): read again without it. */
  get pageTokenInvalid(): boolean {
    return this.reason === 'pageTokenInvalid';
  }

  /**
   * streamList is not something this project or this API can use, as far as the answer says: no such method (404 that is not a missing
   * chat, 405, 501, gRPC UNIMPLEMENTED), no permission (403 that is not an ended chat or a rate limit, PERMISSION_DENIED) or arguments
   * it does not take (400 that is not a bad token, INVALID_ARGUMENT). The ear reads by polling then.
   */
  get streamUnavailable(): boolean {
    if (this.endpoint !== 'liveChatMessages.streamList') return false;
    if (this.chatEnded || this.quota || this.pageTokenInvalid) return false;
    if (['UNIMPLEMENTED', 'PERMISSION_DENIED', 'INVALID_ARGUMENT'].includes(this.reason)) return true;
    return [400, 403, 404, 405, 501].includes(this.status);
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
  actualEndTime?: string;
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

  /** The broadcast of the OAuth channel that is live now (`broadcastStatus=active`; mineと同時指定しない), or null. A `live` one is preferred over a `testing` one. */
  async findActiveBroadcast(): Promise<ActiveBroadcast | null> {
    const body = await this.request('liveBroadcasts.list', 'GET', '/liveBroadcasts', {
      part: 'snippet,status', broadcastStatus: 'active', broadcastType: 'all',
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
      ...(typeof video.liveStreamingDetails?.actualEndTime === 'string' ? { actualEndTime: video.liveStreamingDetails.actualEndTime } : {}),
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
    return pageOf(body);
  }

  /**
   * One `liveChatMessages.streamList` connection: yields each response YouTube pushes, as it comes, and ends when the server closes the
   * connection (or `signal` aborts, which ends it quietly). Throws a `YoutubeApiError` for an HTTP error, for an `{"error": ...}` object in
   * the stream, for a connection that broke (status 0, reason `network`), for a body that is not JSON (`badStream`) and for one that said
   * nothing for `idleMs` (status 0, reason `idle`). There is no total timeout: the connection is meant to stay open. The 5 units are
   * counted when the request is made.
   */
  async *streamMessages(input: { liveChatId: string; pageToken?: string; idleMs?: number; signal?: AbortSignal }): AsyncGenerator<LiveChatPage, void, void> {
    const endpoint = 'liveChatMessages.streamList';
    const idleMs = input.idleMs ?? 300_000;
    const url = new URL(`${this.baseUrl}/liveChat/messages/stream`);
    url.searchParams.set('part', 'snippet,authorDetails');
    url.searchParams.set('liveChatId', input.liveChatId);
    if (input.pageToken) url.searchParams.set('pageToken', input.pageToken);

    if (input.signal?.aborted) return;
    const connection = new AbortController();
    const onAbort = () => connection.abort();
    input.signal?.addEventListener('abort', onAbort, { once: true });
    let idle = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { idle = true; connection.abort(); }, idleMs);
    };
    const fail = (error: unknown): YoutubeApiError => {
      if (idle) return new YoutubeApiError(endpoint, 0, 'idle', `${endpoint} said nothing for ${Math.round(idleMs / 1000)} s`);
      return new YoutubeApiError(endpoint, 0, 'network', `${endpoint} broke: ${error instanceof Error ? error.message : 'unknown'}`);
    };
    try {
      let response: Response | null = null;
      for (let attempt = 0; response === null; attempt += 1) {
        const token = await this.options.getAccessToken(attempt > 0);
        this.meter.add(endpoint);
        arm();
        let answer: Response;
        try {
          answer = await this.fetcher(url.toString(), {
            method: 'GET',
            headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
            signal: connection.signal,
          });
        } catch (error) {
          if (input.signal?.aborted) return;
          throw fail(error);
        }
        if (answer.ok) { response = answer; break; }
        const text = await answer.text().catch(() => '');
        let parsed: Record<string, any> = {};
        try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = {}; }
        if (answer.status === 401 && attempt === 0) continue;
        throw errorOf(endpoint, answer.status, parsed);
      }
      if (!response.body) throw new YoutubeApiError(endpoint, 0, 'network', `${endpoint} answered without a body`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parser = new JsonStreamParser();
      try {
        for (;;) {
          arm();
          let chunk: Awaited<ReturnType<typeof reader.read>>;
          try {
            chunk = await reader.read();
          } catch (error) {
            if (input.signal?.aborted) return;
            throw fail(error);
          }
          // No timer runs while the consumer works on what it was handed.
          clearTimeout(timer);
          const text = chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
          let objects: unknown[];
          try {
            objects = parser.push(text);
          } catch (error) {
            throw new YoutubeApiError(endpoint, 0, 'badStream', `${endpoint}: ${error instanceof Error ? error.message : 'unreadable stream'}`);
          }
          for (const object of objects) {
            const body = (object && typeof object === 'object' ? object : {}) as Record<string, any>;
            if (body.error && typeof body.error === 'object' && !body.items && !body.nextPageToken) {
              throw errorOf(endpoint, Number(body.error.code) || 0, body);
            }
            yield pageOf(unwrapResult(body));
          }
          if (chunk.done) {
            // A connection that ends in the middle of an object was cut; what came before it was complete and has been handed over.
            if (parser.remainder) throw new YoutubeApiError(endpoint, 0, 'network', `${endpoint} was cut in the middle of a response`);
            break;
          }
        }
      } finally {
        reader.cancel().catch(() => undefined);
      }
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', onAbort);
      connection.abort();
    }
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
      throw errorOf(endpoint, response.status, parsed);
    }
  }
}

/** A Google error body (`{ error: { code, message, status, errors: [{ reason }] } }`) as a `YoutubeApiError`. */
function errorOf(endpoint: YoutubeEndpoint, status: number, parsed: Record<string, any>): YoutubeApiError {
  const reason = str(parsed?.error?.errors?.[0]?.reason) || str(parsed?.error?.status);
  return new YoutubeApiError(endpoint, status, reason, `${endpoint} failed: ${status} ${reason} ${str(parsed?.error?.message)}`.trim());
}

/** A streamed object may come wrapped as `{ "result": { ... } }` (grpc-gateway style); the page is what is inside. */
function unwrapResult(body: Record<string, any>): Record<string, any> {
  const inner = body.result;
  return inner && typeof inner === 'object' && !Array.isArray(inner) && !('items' in body) && !('nextPageToken' in body) ? inner as Record<string, any> : body;
}

function pageOf(body: Record<string, any>): LiveChatPage {
  const polling = Number(body.pollingIntervalMillis);
  return {
    items: Array.isArray(body.items) ? body.items as LiveChatMessageResource[] : [],
    ...(typeof body.nextPageToken === 'string' && body.nextPageToken ? { nextPageToken: body.nextPageToken } : {}),
    ...(Number.isFinite(polling) && polling > 0 ? { pollingIntervalMillis: polling } : {}),
    ...(typeof body.offlineAt === 'string' && body.offlineAt ? { offlineAt: body.offlineAt } : {}),
  };
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
