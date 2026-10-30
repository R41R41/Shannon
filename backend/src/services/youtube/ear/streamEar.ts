/**
 * The ear of the AI VTuber (stream-contract.md §2): the legacy runtime reads the YouTube live chat and hands every comment to the head,
 * which decides what to answer and writes it. The ear never answers anything itself.
 *
 *   watch the head's stream state (5 s)  ->  a stream was started: find the broadcast and its live chat (15 s)
 *   ->  tell the head (POST broadcast)  ->  read the chat and pass the comments on (POST comments)
 *   ->  write the head's chatPosts into the chat (only when the stream was started with chatWrites)
 *   ->  the chat ended: tell the head (POST broadcast { ended: true }); the head ended the stream or said 409: back to watching.
 *
 * The chat is read over `liveChatMessages.streamList` (one long connection YouTube pushes the messages down; 5 units a connection) and,
 * only when YouTube answers that streamList cannot be used (404, 405, 501, permission, see YoutubeApiError.streamUnavailable), by polling
 * `liveChatMessages.list` (5 units a poll, never faster than every 8 s) until streamList is tried again. A stream that ends or breaks is
 * opened again at once with the last `nextPageToken`, then after 1, 2, 4 ... 30 s while it keeps failing.
 *
 * Nothing here is behind a switch; with no stream started the only traffic is the 5 s state request to the head.
 * No call throws out of the loop: a head that is down, a YouTube error or a malformed answer only slows the ear down.
 */
import { createLogger } from '../../../utils/logger.js';
import { LRUSet } from '../../../utils/LRUSet.js';
import { chunkComments, classifyChatMessage, type StreamComment } from './chatMessages.js';
import type { HeadChatPost, HeadStream, HeadStreamClient } from './headStreamClient.js';
import { YoutubeApiError, type LiveChatPage, type YoutubeLiveApi } from './youtubeLiveApi.js';

const logger = createLogger('YoutubeEar');

export interface EarLog {
  info(message: string): void;
  warn(message: string): void;
}

export interface StreamEarOptions {
  head: HeadStreamClient;
  youtube: YoutubeLiveApi;
  /** `YOUTUBE_LIVE_URL`: when set, this video is the broadcast and no search for one is made. */
  liveUrl?: string;
  /** `YOUTUBE_CHANNEL_ID`: sent to the head when YouTube's answer does not carry a channel. */
  channelId?: string;
  /** How often the head's state is read. Default 5 s (the contract). */
  stateEveryMs?: number;
  /** How often a broadcast is looked for while the head waits for the chat. Default 15 s. */
  discoveryEveryMs?: number;
  /**
   * Polling only: the interval YouTube asks for is kept inside these bounds. Default 8 s to 10 s: every poll is 5 units, and at 5 s a
   * 10,000-unit day lasts 2.8 hours (the contract's 1 s to 10 s is a limit for the head, not something the ear needs).
   */
  minPollMs?: number;
  maxPollMs?: number;
  /** A streamList connection that has said nothing for this long is closed and opened again with the token. Default 5 minutes. */
  streamIdleMs?: number;
  /** After streamList was found unusable, polling is used this long before streamList is tried again. Default 15 minutes. */
  streamRetryMs?: number;
  /** Called when the way the chat is read changes (also to null when no chat is being read), so a status can be shown. */
  onMethodChange?: (method: ReadMethod | null) => void;
  now?: () => number;
  /** Resolves after `ms`, or at once when `signal` aborts. A test passes a virtual clock here. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  log?: EarLog;
}

export type EarMode = 'stopped' | 'watching' | 'finding' | 'reading';

/** How the live chat is being read: `liveChatMessages.streamList` or `liveChatMessages.list` polling. */
export type ReadMethod = 'streamList' | 'polling';

export interface EarCounters {
  pagesRead: number;
  /** streamList connections opened (each is 5 units). */
  streamConnections: number;
  /** Of `pagesRead`, the responses that came down a stream (the rest are polls). */
  streamPages: number;
  /** Chat messages of every type that YouTube returned. */
  itemsRead: number;
  /** Comments that were not before the stream's start, not the ear's own posts, and of a type the head takes. */
  commentsEligible: number;
  /** Comments the head acknowledged (accepted or a duplicate). */
  commentsSent: number;
  /** Comments that could never be sent: the head refused them, or more waited than the ear keeps. */
  commentsDropped: number;
  /** Messages older than the stream's start (the chat's past), not sent. */
  beforeStart: number;
  chatPostsPosted: number;
  chatPostsFailed: number;
}

export interface EarStatus {
  running: boolean;
  mode: EarMode;
  /** How the chat is read right now; null while no chat is being read. */
  readMethod: ReadMethod | null;
  streamId: string | null;
  videoId: string | null;
  liveChatId: string | null;
  /** null before the first answer. */
  headReachable: boolean | null;
  /** Comments read but not yet acknowledged by the head. */
  pending: number;
  counters: EarCounters;
  units: { hourUnits: number; hourCalls: number; dayUnits: number; totalUnits: number };
  lastError: string | null;
}

interface Attachment {
  videoId: string;
  liveChatId: string;
  title: string;
  channelId: string;
  onAir?: boolean;
}

type ReadEnd = 'head_stopped' | 'chat_ended' | 'aborted';

/** More than this many unsent comments are never kept; the oldest go first (the head answers nothing older than 90 s anyway). */
const MAX_PENDING = 2_000;
const HEAD_BACKOFF_MAX_MS = 30_000;
const YOUTUBE_BACKOFF_MAX_MS = 60_000;
const QUOTA_BACKOFF_MS = 5 * 60_000;
const NOT_LIVE_BLOCK_MS = 60_000;
/** Unreadable stream bodies in a row before the chat is polled instead. */
const STREAM_BAD_LIMIT = 3;

/** A stream connection that lived this long was a good one: the failures before it are forgotten. */
const STREAM_STABLE_MS = 30_000;
const STREAM_BACKOFF_MAX_MS = 30_000;
const SEEN_IDS = 5_000;
const TICK = Symbol('tick');

export class StreamEar {
  private readonly head: HeadStreamClient;
  private readonly youtube: YoutubeLiveApi;
  private readonly stateEveryMs: number;
  private readonly discoveryEveryMs: number;
  private readonly minPollMs: number;
  private readonly maxPollMs: number;
  private readonly streamIdleMs: number;
  private readonly streamRetryMs: number;
  private readonly now: () => number;
  private readonly sleepFor: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly log: EarLog;

  private abort: AbortController | null = null;
  private loop: Promise<void> | null = null;
  private mode: EarMode = 'stopped';
  private readMethod: ReadMethod | null = null;
  /** While now is before this, streamList was found unusable and the chat is polled. */
  private pollingUntil = 0;
  private current: { streamId: string; attachment: Attachment | null } | null = null;
  private headReachable: boolean | null = null;
  private headFailures = 0;
  private lastError: string | null = null;
  private pendingCount = 0;
  private lastDiscoveryAt = Number.NEGATIVE_INFINITY;
  private discoveryHoldUntil = 0;
  /** Streams whose chat ended but whose end the head has not acknowledged yet. */
  private readonly unreportedEnds = new Set<string>();
  /** A stream the head answered 409 for: not attached again for a while. */
  private blocked: { streamId: string; until: number } | null = null;
  /** Ids YouTube gave the ear's own chat posts, so they are not read back as viewers' comments. */
  private readonly ownPostIds = new LRUSet<string>(500);
  /** Head chat-post ids already handled (the head may hand the same one again). */
  private readonly handledPostIds = new LRUSet<string>(500);
  private readonly counters: EarCounters = {
    pagesRead: 0, streamConnections: 0, streamPages: 0, itemsRead: 0, commentsEligible: 0, commentsSent: 0, commentsDropped: 0, beforeStart: 0, chatPostsPosted: 0, chatPostsFailed: 0,
  };

  constructor(private readonly options: StreamEarOptions) {
    this.head = options.head;
    this.youtube = options.youtube;
    this.stateEveryMs = options.stateEveryMs ?? 5_000;
    this.discoveryEveryMs = options.discoveryEveryMs ?? 15_000;
    this.minPollMs = options.minPollMs ?? 8_000;
    this.maxPollMs = Math.max(this.minPollMs, options.maxPollMs ?? 10_000);
    this.streamIdleMs = options.streamIdleMs ?? 300_000;
    this.streamRetryMs = options.streamRetryMs ?? 900_000;
    this.now = options.now ?? Date.now;
    this.sleepFor = options.sleep ?? defaultSleep;
    this.log = options.log ?? logger;
  }

  /** Starts the loop. Calling it while it runs does nothing. */
  start(): void {
    if (this.loop) return;
    this.abort = new AbortController();
    this.mode = 'watching';
    this.loop = this.run(this.abort.signal).finally(() => {
      this.mode = 'stopped';
      this.readMethod = null;
      this.current = null;
      this.loop = null;
    });
  }

  /** Stops the loop and waits for it. The head is not told anything: a stream the ear leaves is still the head's. */
  async stop(): Promise<void> {
    const loop = this.loop;
    this.abort?.abort();
    await loop;
    this.youtube.meter.flush();
  }

  /** Resolves when the loop has ended (a test waits on it after aborting). */
  get done(): Promise<void> {
    return this.loop ?? Promise.resolve();
  }

  status(): EarStatus {
    return {
      running: this.loop !== null,
      mode: this.mode,
      readMethod: this.readMethod,
      streamId: this.current?.streamId ?? null,
      videoId: this.current?.attachment?.videoId ?? null,
      liveChatId: this.current?.attachment?.liveChatId ?? null,
      headReachable: this.headReachable,
      pending: this.pendingCount,
      counters: { ...this.counters },
      units: this.youtube.meter.snapshot(),
      lastError: this.lastError,
    };
  }

  private async run(signal: AbortSignal): Promise<void> {
    let crashes = 0;
    while (!signal.aborted) {
      let wait: number;
      try {
        wait = await this.watchOnce(signal);
        crashes = 0;
      } catch (error) {
        crashes += 1;
        this.lastError = errorText(error);
        this.log.warn(`the ear's loop failed (${this.lastError}); trying again`);
        wait = backoffMs(crashes, this.stateEveryMs, HEAD_BACKOFF_MAX_MS);
      }
      this.youtube.meter.tick();
      if (!signal.aborted) await this.sleepFor(wait, signal);
    }
  }

  /** One look at the head. Returns how long to wait before the next one. */
  private async watchOnce(signal: AbortSignal): Promise<number> {
    this.mode = 'watching';
    this.current = null;
    const state = await this.head.getState();
    if (state.status !== 'ok') {
      this.headReachable = false;
      this.headFailures += 1;
      if (this.headFailures === 1) this.log.warn('the head cannot be reached; the ear keeps asking');
      return backoffMs(this.headFailures, this.stateEveryMs, HEAD_BACKOFF_MAX_MS);
    }
    if (this.headFailures > 0) this.log.info('the head is back');
    this.headFailures = 0;
    this.headReachable = true;

    const stream = state.stream;
    if (!stream || stream.phase === 'ended') return this.stateEveryMs;

    if (this.unreportedEnds.has(stream.streamId)) {
      await this.reportEnd(stream.streamId);
      return this.stateEveryMs;
    }
    if (this.blocked && this.blocked.streamId === stream.streamId && this.now() < this.blocked.until) return this.stateEveryMs;

    let attachment = attachmentOf(stream);
    if (!attachment) {
      this.mode = 'finding';
      this.current = { streamId: stream.streamId, attachment: null };
      if (this.now() < this.discoveryHoldUntil || this.now() - this.lastDiscoveryAt < this.discoveryEveryMs) return this.stateEveryMs;
      this.lastDiscoveryAt = this.now();
      attachment = await this.discover(stream.targetVideoId);
      if (!attachment) return this.stateEveryMs;
      const told = await this.head.postBroadcast({ streamId: stream.streamId, ...attachment });
      if (told.status === 'not_live') {
        this.block(stream.streamId);
        return this.stateEveryMs;
      }
      if (told.status !== 'ok') return this.stateEveryMs;
      this.log.info(`live chat found: ${attachment.videoId} (${attachment.title})`);
    }

    this.current = { streamId: stream.streamId, attachment };
    this.mode = 'reading';
    const end = await this.readChat(stream, attachment, signal);
    this.pendingCount = 0;
    this.setMethod(null);
    if (end === 'chat_ended') {
      this.unreportedEnds.add(stream.streamId);
      await this.reportEnd(stream.streamId);
    } else if (end === 'head_stopped') {
      this.block(stream.streamId);
    }
    return this.stateEveryMs;
  }

  /** The broadcast and its chat, or null while there is none. Errors only slow the next look. */
  private async discover(targetVideoId?: string): Promise<Attachment | null> {
    try {
      const fromUrl = targetVideoId ?? videoIdOfUrl(this.options.liveUrl);
      const broadcast = fromUrl ? null : await this.youtube.findActiveBroadcast();
      const videoId = fromUrl ?? broadcast?.videoId;
      if (!videoId) return null;
      const details = await this.youtube.videoDetails(videoId);
      const liveChatId = details?.liveChatId ?? broadcast?.liveChatId;
      if (!liveChatId) return null;
      return {
        videoId,
        liveChatId,
        onAir: Boolean(details?.actualStartTime && !details.actualEndTime),
        title: details?.title || broadcast?.title || '',
        channelId: details?.channelId || broadcast?.channelId || this.options.channelId || '',
      };
    } catch (error) {
      this.lastError = errorText(error);
      const quota = error instanceof YoutubeApiError && error.quota;
      if (quota) this.discoveryHoldUntil = this.now() + QUOTA_BACKOFF_MS;
      this.log.warn(`looking for the broadcast failed (${this.lastError})`);
      return null;
    }
  }

  private setMethod(method: ReadMethod | null): void {
    if (this.readMethod === method) return;
    this.readMethod = method;
    try { this.options.onMethodChange?.(method); } catch { /* a status listener must not stop the ear */ }
  }

  private block(streamId: string): void {
    this.blocked = { streamId, until: this.now() + NOT_LIVE_BLOCK_MS };
  }

  private async reportEnd(streamId: string): Promise<void> {
    const told = await this.head.postEnded(streamId);
    if (told.status === 'ok' || told.status === 'not_live') {
      this.unreportedEnds.delete(streamId);
      this.log.info(`the live chat ended; the head knows (${told.status})`);
    }
  }

  private async readChat(stream: HeadStream, attachment: Attachment, signal: AbortSignal): Promise<ReadEnd> {
    const startedAt = Date.parse(stream.startedAt);
    // What was said before this stream began is the chat's past, not for her. (The head's clock; YouTube stamps with its own.)
    const cutoff = Number.isFinite(startedAt) ? startedAt : this.now();
    const pending: StreamComment[] = [];
    /** Messages already taken in: a connection opened without a token (or with one YouTube refused) starts with the chat's recent history again. */
    const seen = new LRUSet<string>(SEEN_IDS);
    let pageToken: string | undefined;
    let chatWrites = stream.chatWrites;
    let lastStateAt = this.now();
    let flushFailures = 0;
    let nextFlushAt = 0;
    let chatEnded = false;
    let lastAirCheckAt = this.now();

    const takePosts = async (posts: HeadChatPost[]): Promise<void> => {
      if (!chatWrites || posts.length === 0) return;
      if (await this.writePosts(attachment.liveChatId, posts)) chatEnded = true;
    };

    // Sends what waits. 'stop' when the head says the stream is not live; the rest only schedules the next try.
    const flush = async (): Promise<'ok' | 'stop'> => {
      if (pending.length === 0 || this.now() < nextFlushAt) return 'ok';
      for (const chunk of chunkComments(pending)) {
        const sent = await this.head.postComments(stream.streamId, chunk);
        if (sent.status === 'not_live') return 'stop';
        if (sent.status === 'ok') {
          pending.splice(0, chunk.length);
          this.counters.commentsSent += chunk.length;
          flushFailures = 0;
          this.headReachable = true;
          await takePosts(sent.chatPosts);
          continue;
        }
        if (sent.status === 'rejected') {
          pending.splice(0, chunk.length);
          this.counters.commentsDropped += chunk.length;
          this.log.warn(`the head refused ${chunk.length} comments; they are dropped`);
          continue;
        }
        flushFailures += 1;
        this.headReachable = false;
        nextFlushAt = this.now() + backoffMs(flushFailures, 1_000, HEAD_BACKOFF_MAX_MS);
        break;
      }
      this.pendingCount = pending.length;
      return 'ok';
    };

    // What one response of YouTube (a poll's page or a stream's push) adds. The page token moves on only here, after the messages of
    // the response are in `pending`, so a connection that breaks never skips a message.
    const take = (page: LiveChatPage): void => {
      this.counters.pagesRead += 1;
      this.counters.itemsRead += page.items.length;
      if (page.nextPageToken) pageToken = page.nextPageToken;
      for (const item of page.items) {
        if (item.id && this.ownPostIds.has(item.id)) continue;
        if (item.id) {
          if (seen.has(item.id)) continue;
          seen.add(item.id);
        }
        const event = classifyChatMessage(item);
        if (event.class === 'chat_ended') chatEnded = true;
        if (event.class !== 'comment') continue;
        const at = Date.parse(event.comment.publishedAt);
        if (Number.isFinite(at) && at < cutoff) {
          this.counters.beforeStart += 1;
          continue;
        }
        this.counters.commentsEligible += 1;
        pending.push(event.comment);
      }
      if (page.offlineAt) chatEnded = true;
      if (pending.length > MAX_PENDING) {
        const dropped = pending.splice(0, pending.length - MAX_PENDING).length;
        this.counters.commentsDropped += dropped;
        this.log.warn(`${dropped} unsent comments are dropped (more than ${MAX_PENDING} waited)`);
      }
      this.pendingCount = pending.length;
    };

    // After every response, and on a clock while nothing comes: send what waits, look at the head's stream (the end of it by the owner,
    // and its chat posts: a topic of her own comes without any comment), and see whether the chat is over. Null when reading goes on.
    const housekeeping = async (): Promise<ReadEnd | null> => {
      if ((await flush()) === 'stop') return 'head_stopped';
      if (this.now() - lastStateAt >= this.stateEveryMs) {
        const state = await this.head.getState();
        if (state.status === 'ok') {
          lastStateAt = this.now();
          this.headReachable = true;
          if (!state.stream || state.stream.streamId !== stream.streamId || state.stream.phase === 'ended') return 'head_stopped';
          chatWrites = state.stream.chatWrites;
          await takePosts(state.chatPosts);
        } else {
          this.headReachable = false;
        }
      }
      if (!chatEnded && !attachment.onAir && this.now() - lastAirCheckAt >= this.discoveryEveryMs) {
        lastAirCheckAt = this.now();
        try {
          const details = await this.youtube.videoDetails(attachment.videoId);
          if (details?.actualEndTime) chatEnded = true;
          if (details?.actualStartTime && !details.actualEndTime) {
            const told = await this.head.postBroadcast({ streamId: stream.streamId, ...attachment, onAir: true });
            if (told.status === 'not_live') return 'head_stopped';
            if (told.status === 'ok') attachment.onAir = true;
          }
        } catch { /* 次の時刻に再確認。未確認のまま開始済みにはしない。 */ }
      }
      if (chatEnded) {
        await flush();
        return 'chat_ended';
      }
      this.youtube.meter.tick();
      return null;
    };

    /** Waits `ms` and keeps up the housekeeping meanwhile (a stream that is down must not stop her mouth or hide the head's end). */
    const pause = async (ms: number): Promise<ReadEnd | null> => {
      let left = ms;
      while (left > 0 && !signal.aborted) {
        const slice = Math.min(left, this.stateEveryMs);
        await this.sleepFor(slice, signal);
        left -= slice;
        const end = await housekeeping();
        if (end) return end;
      }
      return null;
    };

    const streamLoop = async (): Promise<ReadEnd | 'fallback'> => {
      let failures = 0;
      let badStreams = 0;
      while (!signal.aborted) {
        const connection = new AbortController();
        const closeWithSignal = () => connection.abort();
        signal.addEventListener('abort', closeWithSignal, { once: true });
        const openedAt = this.now();
        this.counters.streamConnections += 1;
        let fault: unknown = null;
        let end: ReadEnd | null = null;
        const ticker = (): Promise<typeof TICK> => this.sleepFor(pending.length > 0 ? Math.min(this.stateEveryMs, 1_000) : this.stateEveryMs, connection.signal).then(() => TICK);
        try {
          const iterator = this.youtube.streamMessages({
            liveChatId: attachment.liveChatId,
            ...(pageToken ? { pageToken } : {}),
            idleMs: this.streamIdleMs,
            signal: connection.signal,
          })[Symbol.asyncIterator]();
          let next = iterator.next();
          let tick = ticker();
          for (;;) {
            if (signal.aborted) break;
            const got = await Promise.race([next, tick]);
            if (got === TICK) {
              end = await housekeeping();
              if (end) break;
              tick = ticker();
              continue;
            }
            if (got.done) break;
            this.counters.streamPages += 1;
            take(got.value);
            end = await housekeeping();
            if (end) break;
            next = iterator.next();
          }
        } catch (error) {
          fault = error;
        } finally {
          connection.abort();
          signal.removeEventListener('abort', closeWithSignal);
        }
        if (end) return end;
        if (signal.aborted) return 'aborted';

        const lived = this.now() - openedAt;
        const apiError = fault instanceof YoutubeApiError ? fault : null;
        if (apiError?.chatEnded) {
          await flush();
          return 'chat_ended';
        }
        // A body the parser cannot read three times running (a framing no source described) is read by polling instead of retried forever.
        badStreams = apiError?.reason === 'badStream' ? badStreams + 1 : 0;
        if (apiError?.streamUnavailable || badStreams >= STREAM_BAD_LIMIT) {
          this.lastError = errorText(fault);
          return 'fallback';
        }
        if (apiError?.pageTokenInvalid) {
          // Read again from the chat's recent history; what was taken in already is skipped by id (and the head ignores repeated ids).
          this.log.warn('YouTube refused the resume token; the stream starts again without it');
          pageToken = undefined;
        }
        if (fault) this.lastError = errorText(fault);
        failures = lived >= STREAM_STABLE_MS ? 0 : failures + 1;
        const quota = Boolean(apiError?.quota);
        // The first break of a series is opened again at once; keep failing and the wait grows 1, 2, 4 ... 30 s (a spent quota: a minute).
        const waitMs = quota ? YOUTUBE_BACKOFF_MAX_MS : failures <= 1 ? 0 : backoffMs(failures - 1, 1_000, STREAM_BACKOFF_MAX_MS);
        if (apiError?.reason === 'idle') this.log.info(`the live chat stream was silent for ${Math.round(this.streamIdleMs / 1000)} s; opening it again`);
        else if (failures === 1 || quota) this.log.warn(`the live chat stream ${fault ? `failed (${this.lastError})` : 'was closed by YouTube'}; opening it again${waitMs > 0 ? ` in ${Math.round(waitMs / 1000)} s` : ''}`);
        const paused = await pause(waitMs);
        if (paused) return paused;
      }
      return 'aborted';
    };

    const pollLoop = async (): Promise<ReadEnd | 'try_stream'> => {
      let youtubeFailures = 0;
      while (!signal.aborted) {
        let waitMs = this.minPollMs;
        let page: LiveChatPage | undefined;
        try {
          page = await this.youtube.listMessages({ liveChatId: attachment.liveChatId, ...(pageToken ? { pageToken } : {}) });
          youtubeFailures = 0;
        } catch (error) {
          if (error instanceof YoutubeApiError && error.chatEnded) {
            await flush();
            return 'chat_ended';
          }
          youtubeFailures += 1;
          this.lastError = errorText(error);
          const quota = error instanceof YoutubeApiError && error.quota;
          // A spent quota is waited out a minute at a time, so the head's state is still looked at while it lasts.
          waitMs = quota ? YOUTUBE_BACKOFF_MAX_MS : backoffMs(youtubeFailures, 2_000, YOUTUBE_BACKOFF_MAX_MS);
          if (youtubeFailures === 1 || quota) this.log.warn(`reading the live chat failed (${this.lastError}); waiting ${Math.round(waitMs / 1000)} s`);
        }
        if (page) {
          take(page);
          waitMs = Math.min(this.maxPollMs, Math.max(this.minPollMs, page.pollingIntervalMillis ?? 5_000));
        }
        const end = await housekeeping();
        if (end) return end;
        if (this.now() >= this.pollingUntil) return 'try_stream';
        if (!signal.aborted) await this.sleepFor(waitMs, signal);
      }
      return 'aborted';
    };

    let streaming = this.now() >= this.pollingUntil;
    while (!signal.aborted) {
      if (streaming) {
        this.setMethod('streamList');
        const result = await streamLoop();
        if (result !== 'fallback') return result;
        this.pollingUntil = this.now() + this.streamRetryMs;
        streaming = false;
        this.log.warn(`streamList cannot be used (${this.lastError}); reading the live chat by polling liveChatMessages.list every ${Math.round(this.minPollMs / 1000)} s or more, and trying streamList again in ${Math.round(this.streamRetryMs / 60_000)} min`);
      } else {
        this.setMethod('polling');
        const result = await pollLoop();
        if (result !== 'try_stream') return result;
        streaming = true;
        this.log.info('trying streamList again');
      }
    }
    return 'aborted';
  }

  /** Writes the head's chat posts. Returns true when the chat turned out to be over. */
  private async writePosts(liveChatId: string, posts: HeadChatPost[]): Promise<boolean> {
    let ended = false;
    for (const post of posts) {
      if (this.handledPostIds.has(post.id)) continue;
      this.handledPostIds.add(post.id);
      // A chat message holds 200 characters.
      const text = Array.from(post.text).slice(0, 200).join('');
      let outcome: 'posted' | 'failed' = 'failed';
      try {
        const messageId = await this.youtube.insertMessage(liveChatId, text);
        if (messageId) this.ownPostIds.add(messageId);
        outcome = 'posted';
        this.counters.chatPostsPosted += 1;
      } catch (error) {
        this.counters.chatPostsFailed += 1;
        this.lastError = errorText(error);
        this.log.warn(`a chat post failed (${this.lastError})`);
        if (error instanceof YoutubeApiError && error.chatEnded) ended = true;
      }
      await this.head.postChatPostReceipt(post.id, outcome);
    }
    return ended;
  }
}

function attachmentOf(stream: HeadStream): Attachment | null {
  const broadcast = stream.broadcast;
  if (!broadcast?.liveChatId) return null;
  return { onAir: broadcast.onAir === true, videoId: broadcast.videoId ?? '', liveChatId: broadcast.liveChatId, title: broadcast.title ?? stream.title, channelId: broadcast.channelId ?? '' };
}

/** A video id from `YOUTUBE_LIVE_URL` (watch URL, /live/, /video/, youtu.be) or the 11-character id itself. */
export function videoIdOfUrl(liveUrl: string | undefined): string | null {
  const value = liveUrl?.trim();
  if (!value) return null;
  if (/^[a-zA-Z0-9_-]{11}$/.test(value)) return value;
  const match = value.match(/(?:v=|\/(?:video|live)\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return match?.[1] ?? null;
}

export function backoffMs(failures: number, baseMs: number, maxMs: number): number {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, failures - 1));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}
