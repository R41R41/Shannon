/**
 * The ear of the AI VTuber (stream-contract.md §2): the legacy runtime reads the YouTube live chat and hands every comment to the head,
 * which decides what to answer and writes it. The ear never answers anything itself.
 *
 *   watch the head's stream state (5 s)  ->  a stream was started: find the broadcast and its live chat (15 s)
 *   ->  tell the head (POST broadcast)  ->  read the chat as fast as YouTube asks and pass the comments on (POST comments)
 *   ->  write the head's chatPosts into the chat (only when the stream was started with chatWrites)
 *   ->  the chat ended: tell the head (POST broadcast { ended: true }); the head ended the stream or said 409: back to watching.
 *
 * Nothing here is behind a switch; with no stream started the only traffic is the 5 s state request to the head.
 * No call throws out of the loop: a head that is down, a YouTube error or a malformed answer only slows the ear down.
 */
import { createLogger } from '../../../utils/logger.js';
import { LRUSet } from '../../../utils/LRUSet.js';
import { chunkComments, classifyChatMessage, type StreamComment } from './chatMessages.js';
import type { HeadChatPost, HeadStream, HeadStreamClient } from './headStreamClient.js';
import { YoutubeApiError, type YoutubeLiveApi } from './youtubeLiveApi.js';

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
  /** The polling interval YouTube asks for is kept inside these bounds (contract: 1 s to 10 s). */
  minPollMs?: number;
  maxPollMs?: number;
  now?: () => number;
  /** Resolves after `ms`, or at once when `signal` aborts. A test passes a virtual clock here. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  log?: EarLog;
}

export type EarMode = 'stopped' | 'watching' | 'finding' | 'reading';

export interface EarCounters {
  pagesRead: number;
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
}

type ReadEnd = 'head_stopped' | 'chat_ended' | 'aborted';

/** More than this many unsent comments are never kept; the oldest go first (the head answers nothing older than 90 s anyway). */
const MAX_PENDING = 2_000;
const HEAD_BACKOFF_MAX_MS = 30_000;
const YOUTUBE_BACKOFF_MAX_MS = 60_000;
const QUOTA_BACKOFF_MS = 5 * 60_000;
const NOT_LIVE_BLOCK_MS = 60_000;

export class StreamEar {
  private readonly head: HeadStreamClient;
  private readonly youtube: YoutubeLiveApi;
  private readonly stateEveryMs: number;
  private readonly discoveryEveryMs: number;
  private readonly minPollMs: number;
  private readonly maxPollMs: number;
  private readonly now: () => number;
  private readonly sleepFor: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly log: EarLog;

  private abort: AbortController | null = null;
  private loop: Promise<void> | null = null;
  private mode: EarMode = 'stopped';
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
    pagesRead: 0, itemsRead: 0, commentsEligible: 0, commentsSent: 0, commentsDropped: 0, beforeStart: 0, chatPostsPosted: 0, chatPostsFailed: 0,
  };

  constructor(private readonly options: StreamEarOptions) {
    this.head = options.head;
    this.youtube = options.youtube;
    this.stateEveryMs = options.stateEveryMs ?? 5_000;
    this.discoveryEveryMs = options.discoveryEveryMs ?? 15_000;
    this.minPollMs = options.minPollMs ?? 1_000;
    this.maxPollMs = Math.max(this.minPollMs, options.maxPollMs ?? 10_000);
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

    let attachment = stream.phase === 'live' ? attachmentOf(stream) : null;
    if (!attachment) {
      this.mode = 'finding';
      this.current = { streamId: stream.streamId, attachment: null };
      if (this.now() < this.discoveryHoldUntil || this.now() - this.lastDiscoveryAt < this.discoveryEveryMs) return this.stateEveryMs;
      this.lastDiscoveryAt = this.now();
      attachment = await this.discover();
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
    if (end === 'chat_ended') {
      this.unreportedEnds.add(stream.streamId);
      await this.reportEnd(stream.streamId);
    } else if (end === 'head_stopped') {
      this.block(stream.streamId);
    }
    return this.stateEveryMs;
  }

  /** The broadcast and its chat, or null while there is none. Errors only slow the next look. */
  private async discover(): Promise<Attachment | null> {
    try {
      const fromUrl = videoIdOfUrl(this.options.liveUrl);
      const broadcast = fromUrl ? null : await this.youtube.findActiveBroadcast();
      const videoId = fromUrl ?? broadcast?.videoId;
      if (!videoId) return null;
      const details = await this.youtube.videoDetails(videoId);
      const liveChatId = details?.liveChatId ?? broadcast?.liveChatId;
      if (!liveChatId) return null;
      return {
        videoId,
        liveChatId,
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
    let pageToken: string | undefined;
    let chatWrites = stream.chatWrites;
    let lastStateAt = this.now();
    let youtubeFailures = 0;
    let flushFailures = 0;
    let nextFlushAt = 0;
    let chatEnded = false;

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

    while (!signal.aborted) {
      let waitMs = this.minPollMs;
      let page;
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
        this.counters.pagesRead += 1;
        this.counters.itemsRead += page.items.length;
        if (page.nextPageToken) pageToken = page.nextPageToken;
        waitMs = Math.min(this.maxPollMs, Math.max(this.minPollMs, page.pollingIntervalMillis ?? 5_000));
        for (const item of page.items) {
          if (item.id && this.ownPostIds.has(item.id)) continue;
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
      }

      if ((await flush()) === 'stop') return 'head_stopped';

      // The stream's own state: the end of it by the owner, and the head's chat posts (a topic of her own comes without any comment).
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

      if (chatEnded) {
        await flush();
        return 'chat_ended';
      }
      this.youtube.meter.tick();
      if (!signal.aborted) await this.sleepFor(waitMs, signal);
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
  return { videoId: broadcast.videoId ?? '', liveChatId: broadcast.liveChatId, title: broadcast.title ?? stream.title, channelId: broadcast.channelId ?? '' };
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
