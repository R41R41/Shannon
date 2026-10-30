/**
 * The ear's wire to the head: `/v1/platform/stream/*` of stream-contract.md §2 (bridge token, like every `/v1/platform/*` route).
 * Every method answers with a status and never throws: the head may be down, restarting or slow, and the ear must carry on.
 */
import type { StreamComment } from './chatMessages.js';

export type StreamPhase = 'waiting_for_chat' | 'live' | 'ended';

export interface HeadChatPost {
  id: string;
  text: string;
}

export interface HeadStream {
  streamId: string;
  phase: StreamPhase;
  startedAt: string;
  title: string;
  targetVideoId?: string;
  /** Posting into the chat is allowed for this stream (`chatWrites: true` at start). */
  chatWrites: boolean;
  broadcast: { videoId?: string; liveChatId?: string; title?: string; channelId?: string; onAir?: boolean } | null;
}

export type HeadStateResult =
  | { status: 'ok'; stream: HeadStream | null; chatPosts: HeadChatPost[] }
  | { status: 'unavailable' };

export type HeadBroadcastResult =
  | { status: 'ok' }
  /** 409 `STREAM_NOT_LIVE`: the head's stream is not that one (or is over). */
  | { status: 'not_live' }
  | { status: 'unavailable' };

export type HeadCommentsResult =
  | { status: 'ok'; accepted: number; duplicates: number; chatPosts: HeadChatPost[] }
  | { status: 'not_live' }
  /** The head refused this batch for what is in it (400, 413, 422): sending it again cannot help. */
  | { status: 'rejected' }
  | { status: 'unavailable' };

export interface HeadStreamClientOptions {
  /**
   * The head's address. Only the origin is used: `SHANNON_CORE_PLATFORM_URL` points at `/v1/platform/turns` for the Discord bridge,
   * and the stream routes live next to it.
   */
  url: string;
  token: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

export class HeadStreamClient {
  private readonly origin: string;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: HeadStreamClientOptions) {
    this.origin = new URL(options.url).origin;
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 5_000;
  }

  async getState(): Promise<HeadStateResult> {
    const answer = await this.send('GET', '/v1/platform/stream/state');
    if (!answer || answer.status !== 200) return { status: 'unavailable' };
    const body = asRecord(answer.body);
    return { status: 'ok', stream: parseStream(body.stream), chatPosts: parsePosts(body.chatPosts) };
  }

  async postBroadcast(input: { streamId: string; videoId: string; liveChatId: string; title: string; channelId: string; onAir?: boolean }): Promise<HeadBroadcastResult> {
    const answer = await this.send('POST', '/v1/platform/stream/broadcast', input);
    return broadcastResult(answer);
  }

  /** YouTube says the chat is over: the head ends the stream as `POST /v1/stream/end` does. */
  async postEnded(streamId: string): Promise<HeadBroadcastResult> {
    const answer = await this.send('POST', '/v1/platform/stream/broadcast', { streamId, ended: true });
    return broadcastResult(answer);
  }

  async postComments(streamId: string, comments: StreamComment[]): Promise<HeadCommentsResult> {
    const answer = await this.send('POST', '/v1/platform/stream/comments', { streamId, comments });
    if (!answer) return { status: 'unavailable' };
    if (answer.status === 409) return { status: 'not_live' };
    if ([400, 413, 422].includes(answer.status)) return { status: 'rejected' };
    if (answer.status !== 202 && answer.status !== 200) return { status: 'unavailable' };
    const body = asRecord(answer.body);
    return {
      status: 'ok',
      accepted: typeof body.accepted === 'number' ? body.accepted : comments.length,
      duplicates: typeof body.duplicates === 'number' ? body.duplicates : 0,
      chatPosts: parsePosts(body.chatPosts),
    };
  }

  /** Best effort: the head only learns whether a chat post went out. */
  async postChatPostReceipt(id: string, outcome: 'posted' | 'failed'): Promise<void> {
    await this.send('POST', `/v1/platform/stream/chat-posts/${encodeURIComponent(id)}/receipt`, { outcome });
  }

  /** `null` when the head could not be reached or answered something unreadable. */
  private async send(method: 'GET' | 'POST', path: string, json?: unknown): Promise<{ status: number; body: unknown } | null> {
    try {
      const response = await this.fetcher(`${this.origin}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.options.token}`,
          ...(json === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(json === undefined ? {} : { body: JSON.stringify(json) }),
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const text = await response.text().catch(() => '');
      let body: unknown = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = null; }
      return { status: response.status, body };
    } catch {
      return null;
    }
  }
}

function broadcastResult(answer: { status: number; body: unknown } | null): HeadBroadcastResult {
  if (!answer) return { status: 'unavailable' };
  if (answer.status === 409) return { status: 'not_live' };
  if (answer.status === 200 || answer.status === 201 || answer.status === 202 || answer.status === 204) return { status: 'ok' };
  return { status: 'unavailable' };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function parseStream(value: unknown): HeadStream | null {
  const stream = asRecord(value);
  if (typeof stream.streamId !== 'string' || !stream.streamId) return null;
  const phase = stream.phase === 'live' || stream.phase === 'ended' ? stream.phase : 'waiting_for_chat';
  const broadcast = stream.broadcast && typeof stream.broadcast === 'object' ? asRecord(stream.broadcast) : null;
  return {
    streamId: stream.streamId,
    phase,
    startedAt: typeof stream.startedAt === 'string' ? stream.startedAt : '',
    title: typeof stream.title === 'string' ? stream.title : '',
    chatWrites: stream.chatWrites === true,
    ...(typeof stream.targetVideoId === 'string' ? { targetVideoId: stream.targetVideoId } : {}),
    broadcast: broadcast ? {
      onAir: broadcast.onAir === true,
      ...(typeof broadcast.videoId === 'string' ? { videoId: broadcast.videoId } : {}),
      ...(typeof broadcast.liveChatId === 'string' ? { liveChatId: broadcast.liveChatId } : {}),
      ...(typeof broadcast.title === 'string' ? { title: broadcast.title } : {}),
      ...(typeof broadcast.channelId === 'string' ? { channelId: broadcast.channelId } : {}),
    } : null,
  };
}

function parsePosts(value: unknown): HeadChatPost[] {
  if (!Array.isArray(value)) return [];
  const posts: HeadChatPost[] = [];
  for (const entry of value) {
    const post = asRecord(entry);
    if (typeof post.id === 'string' && post.id && typeof post.text === 'string' && post.text.trim()) posts.push({ id: post.id, text: post.text });
  }
  return posts;
}
