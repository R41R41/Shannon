import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { chunkComments, classifyChatMessage, type StreamComment } from '../../src/services/youtube/ear/chatMessages.js';
import { HeadStreamClient } from '../../src/services/youtube/ear/headStreamClient.js';
import { oauthTokenProvider } from '../../src/services/youtube/ear/oauthTokenProvider.js';
import { StreamEar, videoIdOfUrl, type ReadMethod, type StreamEarOptions } from '../../src/services/youtube/ear/streamEar.js';
import { JsonStreamParser } from '../../src/services/youtube/ear/streamParser.js';
import { ApiUnitMeter, YoutubeApiError, YoutubeLiveApi } from '../../src/services/youtube/ear/youtubeLiveApi.js';

/**
 * The ear (stream-contract.md section 2) against a fake head and a fake YouTube Data API, both as `fetch` functions, on a virtual clock:
 * `sleep` advances time, so 15 s of waiting costs no real time and every wait the ear asks for is recorded.
 */

const START = Date.parse('2026-10-29T12:00:00.000Z');
const at = (seconds: number) => new Date(START + seconds * 1000).toISOString();
const YT = 'http://yt.test/youtube/v3';
const HEAD = 'http://head.test';

const author = (id: string, extra: Record<string, boolean> = {}) => ({ channelId: id, displayName: `Name ${id}`, isChatOwner: false, isChatModerator: false, isChatSponsor: false, isVerified: false, ...extra });
const textItem = (id: string, seconds: number, message = `message ${id}`, who = 'UCviewer') => ({
  id,
  snippet: { type: 'textMessageEvent', publishedAt: at(seconds), hasDisplayContent: true, displayMessage: message, textMessageDetails: { messageText: message } },
  authorDetails: author(who),
});
const manyTexts = (count: number, from = 1) => Array.from({ length: count }, (_, i) => textItem(`m${from + i}`, from + i));

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const googleError = (status: number, reason: string) => json(status, { error: { code: status, message: reason, errors: [{ reason }] } });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

interface HeadStreamState { streamId: string; platform: 'youtube'; phase: string; startedAt: string; title: string; chatWrites: boolean; broadcast: unknown; targetVideoId?: string }

class FakeHead {
  stream: HeadStreamState | null = null;
  down = false;
  log: string[] = [];
  stateCalls = 0;
  received: any[] = [];
  seen = new Set<string>();
  batches: number[] = [];
  broadcasts: any[] = [];
  ended: any[] = [];
  receipts: Array<{ id: string; outcome: string }> = [];
  /** Statuses returned by the next comments POSTs, before the normal answer. */
  commentStatuses: number[] = [];
  /** chatPosts handed by the next comments POSTs / state GETs. */
  commentPosts: Array<Array<{ id: string; text: string }>> = [];
  statePosts: Array<Array<{ id: string; text: string }>> = [];
  commentsPosted = 0;
  headers: Array<string | null> = [];
  /** How many times a waiting stream became live (the head greets at that moment only). */
  wentLive = 0;
  /** Faults for the next broadcast POSTs (not the end notice) that `when` matches: an HTTP status with the head's error code, or the answer lost after the head applied it. */
  broadcastFaults: Array<{ when: (body: any) => boolean; times: number; status?: number; code?: string; lose?: boolean }> = [];
  /** The next this many state answers leave targetVideoId out (a head that did not tell the ear yet). */
  hideTargetStates = 0;
  /** The virtual clock (set by the test world) and the time before which the comments route answers 503 while the rest of the head works (the end notice, the state). */
  clock: () => number = () => 0;
  commentsDownUntil = 0;
  /** A request to the head that is made while `down` throws like a refused connection. */
  fetcher: typeof fetch = async (input, init) => {
    if (this.down) throw new TypeError('fetch failed');
    const url = new URL(String(input));
    this.headers.push(new Headers(init?.headers).get('authorization'));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const route = `${init?.method ?? 'GET'} ${url.pathname}`;
    if (route === 'GET /v1/platform/stream/state') {
      this.stateCalls += 1;
      let shown = this.stream;
      if (shown?.targetVideoId && this.hideTargetStates > 0) { this.hideTargetStates -= 1; const { targetVideoId: _hidden, ...rest } = shown; shown = rest; }
      return json(200, { stream: shown, chatPosts: this.statePosts.shift() ?? [] });
    }
    if (route === 'POST /v1/platform/stream/broadcast') {
      if (body.ended) {
        this.log.push('ended');
        this.ended.push(body);
        if (!this.stream || this.stream.streamId !== body.streamId) return json(409, { error: 'STREAM_NOT_LIVE' });
        this.stream = { ...this.stream, phase: 'ended' };
        return json(200, { stream: this.stream });
      }
      this.log.push('broadcast');
      this.broadcasts.push(body);
      const fault = this.broadcastFaults.find(entry => entry.times > 0 && entry.when(body));
      if (fault) fault.times -= 1;
      if (fault?.status) return json(fault.status, { error: fault.code ?? 'forced' });
      // As the real head does (streamService.broadcast): the stream must be the live one, the video must be the target, and only a waiting
      // stream told `onAir: true` goes live (and greets). A later `onAir: false` changes the stored broadcast but not the phase.
      if (!this.stream || this.stream.streamId !== body.streamId || this.stream.phase === 'ended') return json(409, { error: 'STREAM_NOT_LIVE' });
      if (this.stream.targetVideoId && body.videoId !== this.stream.targetVideoId) return json(409, { error: 'STREAM_VIDEO_MISMATCH' });
      let phase = this.stream.phase;
      if (body.onAir === true && phase === 'waiting_for_chat') { phase = 'live'; this.wentLive += 1; }
      this.stream = { ...this.stream, phase, broadcast: { videoId: body.videoId, liveChatId: body.liveChatId, title: body.title, channelId: body.channelId, onAir: body.onAir === true } };
      if (fault?.lose) throw new TypeError('fetch failed');
      return json(200, { stream: this.stream });
    }
    if (route === 'POST /v1/platform/stream/comments') {
      this.commentsPosted += 1;
      if (this.clock() < this.commentsDownUntil) return json(503, { error: 'comments are down' });
      const forced = this.commentStatuses.shift();
      if (forced) return json(forced, { error: 'forced' });
      if (!this.stream || this.stream.streamId !== body.streamId || this.stream.phase === 'ended') return json(409, { error: 'STREAM_NOT_LIVE' });
      let accepted = 0; let duplicates = 0;
      for (const comment of body.comments) {
        if (this.seen.has(comment.id)) { duplicates += 1; continue; }
        this.seen.add(comment.id); this.received.push(comment); accepted += 1;
      }
      this.batches.push(body.comments.length);
      this.log.push(`comments:${body.comments.length}`);
      return json(202, { accepted, duplicates, chatPosts: this.commentPosts.shift() ?? [] });
    }
    const receipt = route.match(/^POST \/v1\/platform\/stream\/chat-posts\/([^/]+)\/receipt$/);
    if (receipt) {
      this.receipts.push({ id: decodeURIComponent(receipt[1]), outcome: body.outcome });
      return new Response(null, { status: 204 });
    }
    return json(404, {});
  };

  start(extra: Partial<HeadStreamState> = {}) {
    this.stream = { streamId: 'st-1', platform: 'youtube', phase: 'waiting_for_chat', startedAt: at(0), title: '雑談', chatWrites: false, broadcast: null, ...extra };
  }
}

class FakeYoutube {
  messages: any[] = [];
  pageSize = 2000;
  polling: number[] = [5000];
  offlineAt: string | undefined;
  calls: Array<{ method: string; path: string; query: Record<string, string>; auth: string | null; at: number }> = [];
  /** Errors for the next videos.list calls: [status, reason]. */
  videoErrors: Array<[number, string]> = [];
  broadcasts: any[] = [{ id: 'vid00000001', snippet: { title: '配信', channelId: 'UCowner', liveChatId: 'chat-from-broadcast' }, status: { lifeCycleStatus: 'live' } }];
  /** The broadcast list answers empty this many times first (the stream has not started on YouTube yet). */
  emptyBroadcastLists = 0;
  chatId: string | undefined = 'chat-1';
  actualStartTime: string | undefined = at(0);
  actualEndTime: string | undefined;
  /** Videos of earlier streams that have ended, whatever the current one says (the id the request names). */
  endedVideos = new Set<string>();
  /** Errors for the next list calls: [status, reason]. */
  listErrors: Array<[number, string]> = [];
  listCalls = 0;
  /** Runs at the start of every list call (before the answer) to add messages or errors as a stream goes on. */
  onList: (call: number) => void = () => undefined;
  inserted: Array<{ text: string; liveChatId: string }> = [];
  insertFails = 0;
  firstStatus: number[] = [];

  // ---- liveChatMessages.streamList (GET /liveChat/messages/stream): a body that stays open and gets a response whenever `pump()` finds messages.
  /** false: the route answers 404 like a path that does not exist (the ear must fall back to polling). */
  streamEnabled = true;
  /** Errors for the next stream connects: [status, reason]. */
  streamErrors: Array<[number, string] | null> = [];
  /** Stream connections answered with a body no framing reads (before any error above). */
  streamGarbage = 0;
  framing: 'array' | 'ndjson' | 'sse' | 'wrapped' = 'array';
  /** The bytes of every written response are cut into pieces of this size (0: whole), which splits Japanese characters too. */
  splitBytes = 0;
  /** Messages in one response. */
  streamPage = 2000;
  /** A fresh connection (no pageToken) starts with this many of the latest messages (the chat's recent history). */
  historySize = Number.POSITIVE_INFINITY;
  /** One plan per connection, in order: close the connection (or tear it in the middle of a response, or break it) once `cutAfter` messages are sent. */
  plans: Array<{ cutAfter: number; how?: 'close' | 'tear' | 'error' }> = [];
  /** Objects written into the stream in place of the next responses, e.g. `{ error }` (as Google does for a failure after the start). */
  streamInject: unknown[] = [];
  /** Virtual time of every connect (set by the test world). */
  clock: () => number = () => 0;
  streamCalls = 0;
  connectTimes: number[] = [];
  streams: Array<{
    query: Record<string, string>; auth: string | null; sent: number; written: number; closed: boolean; cancelled: boolean; offlineSent: boolean;
    plan: { cutAfter: number; how?: 'close' | 'tear' | 'error' } | undefined; controller: ReadableStreamDefaultController<Uint8Array>;
  }> = [];
  onPump: (pump: number) => void = () => undefined;
  pumps = 0;

  private write(stream: FakeYoutube['streams'][number], object: unknown, torn = false): void {
    const json = JSON.stringify(this.framing === 'wrapped' ? { result: object } : object);
    const first = stream.written === 0;
    stream.written += 1;
    const text = this.framing === 'ndjson' ? `${json}\n` : this.framing === 'sse' ? `data: ${json}\n\n` : `${first ? '[' : ',\n'}${json}`;
    const bytes = new TextEncoder().encode(torn ? text.slice(0, Math.floor(text.length / 2)) : text);
    const size = this.splitBytes > 0 ? this.splitBytes : bytes.length || 1;
    for (let i = 0; i < bytes.length; i += size) stream.controller.enqueue(bytes.slice(i, i + size));
  }

  /** Hands every open stream what it has not been sent yet, and applies the plan of the connection (the test world calls this on every turn). */
  pump(): void {
    this.pumps += 1;
    this.onPump(this.pumps);
    for (const stream of this.streams) {
      if (stream.closed) continue;
      const injected = this.streamInject.shift();
      if (injected !== undefined) { this.write(stream, injected); continue; }
      if (stream.plan && stream.sent >= stream.plan.cutAfter) {
        if (stream.plan.how === 'tear') {
          // Half of the next response and then the end of the body: the connection was cut in the middle of an object.
          const batch = this.messages.slice(stream.sent, stream.sent + this.streamPage);
          if (batch.length === 0) continue;
          this.write(stream, { kind: 'youtube#liveChatMessageListResponse', nextPageToken: `t${stream.sent + batch.length}`, items: batch }, true);
          stream.controller.close();
        } else if (stream.plan.how === 'error') {
          stream.controller.error(new TypeError('terminated'));
        } else {
          stream.controller.close();
        }
        stream.closed = true;
        continue;
      }
      let limit = this.messages.length;
      if (stream.plan) limit = Math.min(limit, stream.plan.cutAfter);
      if (stream.sent < limit) {
        const batch = this.messages.slice(stream.sent, Math.min(limit, stream.sent + this.streamPage));
        stream.sent += batch.length;
        const done = this.offlineAt && stream.sent >= this.messages.length;
        this.write(stream, { kind: 'youtube#liveChatMessageListResponse', nextPageToken: `t${stream.sent}`, pollingIntervalMillis: 1000, items: batch, ...(done ? { offlineAt: this.offlineAt } : {}) });
        if (done) stream.offlineSent = true;
      } else if (this.offlineAt && !stream.offlineSent && stream.sent >= this.messages.length) {
        stream.offlineSent = true;
        this.write(stream, { kind: 'youtube#liveChatMessageListResponse', nextPageToken: `t${stream.sent}`, items: [], offlineAt: this.offlineAt });
      }
    }
  }

  private connect(query: Record<string, string>, auth: string | null, signal: AbortSignal | null | undefined): Response {
    const from = query.pageToken ? Number(query.pageToken.slice(1)) : Math.max(0, this.messages.length - this.historySize);
    let stream!: FakeYoutube['streams'][number];
    const body = new ReadableStream<Uint8Array>({
      start: controller => { stream = { query, auth, sent: from, written: 0, closed: false, cancelled: false, offlineSent: false, plan: this.plans.shift(), controller }; },
      cancel: () => { stream.cancelled = true; stream.closed = true; },
    });
    this.streams.push(stream);
    // Like a real fetch, an aborted request breaks the body.
    signal?.addEventListener('abort', () => {
      stream.cancelled = true;
      stream.closed = true;
      try { stream.controller.error(new DOMException('This operation was aborted', 'AbortError')); } catch { /* already closed */ }
    }, { once: true });
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  }

  fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const query = Object.fromEntries(url.searchParams.entries());
    const route = url.pathname.replace('/youtube/v3', '');
    this.calls.push({ method: init?.method ?? 'GET', path: route, query, auth: new Headers(init?.headers).get('authorization'), at: this.clock() });
    const forcedStatus = this.firstStatus.shift();
    if (forcedStatus) return googleError(forcedStatus, 'authError');
    if (route === '/liveBroadcasts') {
      if (this.emptyBroadcastLists > 0) { this.emptyBroadcastLists -= 1; return json(200, { items: [] }); }
      return json(200, { items: this.broadcasts });
    }
    if (route === '/videos') {
      const videoError = this.videoErrors.shift();
      if (videoError) return googleError(videoError[0], videoError[1]);
      return json(200, { items: [{ id: query.id, snippet: { title: '配信のタイトル', channelId: 'UCowner' }, liveStreamingDetails: { ...(this.chatId ? { activeLiveChatId: this.chatId } : {}), actualStartTime: this.actualStartTime, actualEndTime: this.endedVideos.has(String(query.id)) ? at(-3600) : this.actualEndTime } }] });
    }
    if (route === '/liveChat/messages/stream') {
      this.streamCalls += 1;
      this.connectTimes.push(this.clock());
      if (!this.streamEnabled) return new Response('<html>Not Found</html>', { status: 404, headers: { 'content-type': 'text/html' } });
      if (this.streamGarbage > 0) {
        this.streamGarbage -= 1;
        return new Response('<html><body>Service Unavailable</body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
      }
      const error = this.streamErrors.shift();
      if (error) return googleError(error[0], error[1]);
      return this.connect(query, new Headers(init?.headers).get('authorization'), init?.signal);
    }
    if (route === '/liveChat/messages' && (init?.method ?? 'GET') === 'GET') {
      this.listCalls += 1;
      this.onList(this.listCalls);
      const error = this.listErrors.shift();
      if (error) return googleError(error[0], error[1]);
      const from = query.pageToken ? Number(query.pageToken.slice(1)) : 0;
      const items = this.messages.slice(from, from + this.pageSize);
      return json(200, {
        items,
        nextPageToken: `t${from + items.length}`,
        pollingIntervalMillis: this.polling[Math.min(this.listCalls - 1, this.polling.length - 1)],
        ...(this.offlineAt ? { offlineAt: this.offlineAt } : {}),
      });
    }
    if (route === '/liveChat/messages') {
      const body = JSON.parse(String(init?.body));
      if (this.insertFails > 0) { this.insertFails -= 1; return googleError(500, 'backendError'); }
      this.inserted.push({ text: body.snippet.textMessageDetails.messageText, liveChatId: body.snippet.liveChatId });
      return json(200, { id: `own-${this.inserted.length}` });
    }
    return json(404, {});
  };
}

/**
 * `via: 'poll'` (the default, for the tests of what is the same in both ways of reading): the fake has no stream route, so the ear falls back
 * to polling at once. `via: 'stream'`: liveChatMessages.streamList works.
 */
function world(options: Partial<StreamEarOptions> & { via?: 'stream' | 'poll'; virtualIdle?: boolean } = {}) {
  const { via = 'poll', virtualIdle = false, ...earOptions } = options;
  let now = START;
  const sleeps: number[] = [];
  const logs: string[] = [];
  const head = new FakeHead();
  head.clock = () => now;
  const youtube = new FakeYoutube();
  youtube.streamEnabled = via === 'stream';
  youtube.clock = () => now;
  const methods: Array<ReadMethod | null> = [];
  const tokens: boolean[] = [];
  const meter = new ApiUnitMeter(() => now, () => undefined, () => undefined);
  // virtualIdle: streamList's idle timer runs on the virtual clock too (it fires when a sleep moves the clock past it), not on real time.
  const pendingTimers: Array<{ at: number; fn: () => void }> = [];
  const timers = virtualIdle ? {
    set: (fn: () => void, ms: number): unknown => { const timer = { at: now + ms, fn }; pendingTimers.push(timer); return timer; },
    clear: (handle: unknown): void => { const i = pendingTimers.indexOf(handle as { at: number; fn: () => void }); if (i >= 0) pendingTimers.splice(i, 1); },
  } : undefined;
  const api = new YoutubeLiveApi({
    baseUrl: YT, fetcher: youtube.fetcher, meter, ...(timers ? { timers } : {}),
    getAccessToken: async force => { tokens.push(Boolean(force)); return force ? 'fresh-token' : 'token'; },
  });
  const ear = new StreamEar({
    head: new HeadStreamClient({ url: `${HEAD}/v1/platform/turns`, token: 'bridge-token', fetcher: (input, init) => head.fetcher(input, init) }),
    youtube: api,
    now: () => now,
    sleep: async (ms, signal) => {
      if (signal.aborted) return;
      sleeps.push(ms);
      now += ms;
      for (const due of pendingTimers.filter(timer => timer.at <= now).sort((a, b) => a.at - b.at)) {
        const i = pendingTimers.indexOf(due);
        if (i >= 0) { pendingTimers.splice(i, 1); due.fn(); }
      }
      await tick();
    },
    log: { info: line => logs.push(line), warn: line => logs.push(`WARN ${line}`) },
    onMethodChange: method => methods.push(method),
    ...earOptions,
  });
  const run = async (done: () => boolean, max = 4000) => {
    ear.start();
    for (let i = 0; i < max && !done(); i += 1) { youtube.pump(); await tick(); }
    await ear.stop();
    if (!done()) throw new Error(`condition not reached; log: ${logs.join(' | ')}`);
  };
  return { ear, head, youtube, meter, sleeps, logs, tokens, methods, run, clock: () => now };
}

describe('the ear waits for the head', () => {
  it('asks the head for the stream every 5 s and never touches YouTube while no stream is started', async () => {
    const w = world();
    await w.run(() => w.head.stateCalls >= 6);
    expect(w.sleeps.slice(0, 5)).toEqual([5000, 5000, 5000, 5000, 5000]);
    expect(w.youtube.calls).toEqual([]);
    expect(w.head.headers.every(header => header === 'Bearer bridge-token')).toBe(true);
    expect(w.ear.status().mode).toBe('stopped');
  });

  it('a stream that has ended is not attached to', async () => {
    const w = world();
    w.head.start({ phase: 'ended' });
    await w.run(() => w.head.stateCalls >= 4);
    expect(w.youtube.calls).toEqual([]);
    expect(w.head.broadcasts).toEqual([]);
  });

  it('does not throw when the head is down, backs off 5 s, 10 s, 20 s, 30 s, and goes on when it is back', async () => {
    const w = world();
    w.head.down = true;
    const failing = w.run(() => w.sleeps.length >= 5 && w.ear.status().headReachable === false);
    await failing;
    expect(w.sleeps.slice(0, 5)).toEqual([5000, 10000, 20000, 30000, 30000]);

    const w2 = world();
    w2.head.down = true;
    w2.head.start();
    w2.youtube.messages = manyTexts(3);
    w2.ear.start();
    for (let i = 0; i < 40; i += 1) await tick();
    w2.head.down = false;
    for (let i = 0; i < 4000 && w2.head.received.length < 3; i += 1) await tick();
    await w2.ear.stop();
    expect(w2.head.received.map(c => c.id)).toEqual(['m1', 'm2', 'm3']);
    expect(w2.logs.some(line => line.includes('the head is back'))).toBe(true);
  });
});

describe('finding the broadcast', () => {
  it('looks every 15 s while the head waits for the chat, then tells the head and reads', async () => {
    const w = world();
    w.head.start();
    w.youtube.emptyBroadcastLists = 2;
    w.youtube.messages = manyTexts(2);
    await w.run(() => w.head.received.length >= 2);
    const lists = w.youtube.calls.filter(call => call.path === '/liveBroadcasts');
    expect(lists).toHaveLength(3);
    expect(lists[0].query).toMatchObject({ part: 'snippet,status', broadcastStatus: 'active', broadcastType: 'all' });
    // 15 s of virtual time between two looks (state is read every 5 s in between).
    expect(w.sleeps.slice(0, 6)).toEqual([5000, 5000, 5000, 5000, 5000, 5000]);
    expect(w.head.broadcasts).toEqual([{ streamId: 'st-1', videoId: 'vid00000001', liveChatId: 'chat-1', title: '配信のタイトル', channelId: 'UCowner', onAir: true }]);
    const videos = w.youtube.calls.find(call => call.path === '/videos');
    expect(videos?.query).toMatchObject({ part: 'liveStreamingDetails,snippet', id: 'vid00000001' });
    // The broadcast was told to the head before any comment.
    expect(w.head.log.indexOf('broadcast')).toBeLessThan(w.head.log.findIndex(entry => entry.startsWith('comments')));
    expect(w.youtube.calls.every(call => call.auth === 'Bearer token')).toBe(true);
  });

  it('keeps waiting while the video has no live chat yet', async () => {
    const w = world();
    w.head.start();
    w.youtube.chatId = undefined;
    w.youtube.broadcasts = [{ id: 'vid00000001', snippet: { title: 't', channelId: 'UCowner' }, status: { lifeCycleStatus: 'live' } }];
    await w.run(() => w.clock() - START >= 50_000);
    expect(w.head.broadcasts).toEqual([]);
    expect(w.ear.status().mode).toBe('stopped');
  });

  it('YOUTUBE_LIVE_URL wins: no liveBroadcasts.list is made', async () => {
    const w = world({ liveUrl: 'https://www.youtube.com/watch?v=abcdefghijk' });
    w.head.start();
    await w.run(() => w.head.broadcasts.length === 1);
    expect(w.youtube.calls.some(call => call.path === '/liveBroadcasts')).toBe(false);
    expect(w.head.broadcasts[0].videoId).toBe('abcdefghijk');
  });

  it('a stream the head already has live (the ear restarted) is read again from its liveChatId, without looking', async () => {
    const w = world();
    w.head.start({ phase: 'live', broadcast: { onAir: true, videoId: 'vid00000001', liveChatId: 'chat-9', title: 't', channelId: 'UCowner' } });
    w.youtube.messages = manyTexts(2);
    await w.run(() => w.head.received.length >= 2);
    expect(w.youtube.calls.some(call => call.path === '/liveBroadcasts' || call.path === '/videos')).toBe(false);
    expect(w.youtube.calls.find(call => call.path === '/liveChat/messages')?.query.liveChatId).toBe('chat-9');
    expect(w.head.broadcasts).toEqual([]);
  });

  it('a 409 on the broadcast stops the attempt: nothing is read and the ear stays watching', async () => {
    const w = world();
    w.head.start();
    const original = w.head.fetcher;
    w.head.fetcher = async (input, init) => {
      if (String(input).endsWith('/broadcast') && !String(init?.body).includes('ended')) return json(409, { error: 'STREAM_NOT_LIVE' });
      return original(input, init);
    };
    await w.run(() => w.clock() - START >= 40_000);
    expect(w.youtube.calls.filter(call => call.path === '/liveChat/messages')).toEqual([]);
  });
});

describe('reading the chat', () => {
  function live(w: ReturnType<typeof world>) {
    w.head.start({ phase: 'live', broadcast: { onAir: true, videoId: 'vid00000001', liveChatId: 'chat-1', title: 't', channelId: 'UCowner' } });
  }

  it('polling (the fallback): follows pageToken and the polling interval YouTube returns (kept between 8 s and 10 s) and loses nothing', async () => {
    const w = world();
    live(w);
    w.youtube.pageSize = 200;
    w.youtube.polling = [500, 20_000, 3_000];
    w.youtube.messages = manyTexts(450);
    await w.run(() => w.head.received.length >= 450 && w.youtube.listCalls >= 4);
    const lists = w.youtube.calls.filter(call => call.path === '/liveChat/messages');
    expect(lists[0].query.pageToken).toBeUndefined();
    expect(lists.slice(1, 4).map(call => call.query.pageToken)).toEqual(['t200', 't400', 't450']);
    expect(lists[0].query).toMatchObject({ part: 'snippet,authorDetails', liveChatId: 'chat-1', maxResults: '2000' });
    // 500 ms and 3 s are lifted to the 8 s floor (5 units a poll), 20 s is cut to 10 s.
    // (The first sleep is the 5 s tick of the one connection that was tried at streamList before the fallback.)
    expect(w.sleeps.slice(1, 4)).toEqual([8000, 10_000, 8000]);
    expect(w.head.received.map(c => c.id)).toEqual(Array.from({ length: 450 }, (_, i) => `m${i + 1}`));
    expect(w.ear.status().counters).toMatchObject({ itemsRead: 450, commentsEligible: 450, commentsSent: 450, commentsDropped: 0 });
  });

  it('a page of 450 goes to the head as 200 + 200 + 50 (no request over 200 comments)', async () => {
    const w = world();
    live(w);
    w.youtube.messages = manyTexts(450);
    await w.run(() => w.head.received.length >= 450);
    expect(w.head.batches).toEqual([200, 200, 50]);
  });

  it('keeps reading the new messages that arrive between polls, once each', async () => {
    const w = world();
    live(w);
    w.youtube.messages = manyTexts(5);
    w.youtube.onList = call => { if (call === 3) w.youtube.messages.push(...manyTexts(7, 6)); if (call === 5) w.youtube.messages.push(...manyTexts(3, 13)); };
    await w.run(() => w.head.received.length >= 15);
    expect(w.head.received.map(c => c.id)).toEqual(Array.from({ length: 15 }, (_, i) => `m${i + 1}`));
    expect(w.head.commentsPosted).toBeGreaterThanOrEqual(3);
  });

  it('does not send what was said before the stream started', async () => {
    const w = world();
    live(w);
    w.head.stream = { ...w.head.stream!, startedAt: at(100) };
    w.youtube.messages = [textItem('old1', 10), textItem('old2', 99), textItem('new1', 101), textItem('new2', 150)];
    await w.run(() => w.head.received.length >= 2);
    expect(w.head.received.map(c => c.id)).toEqual(['new1', 'new2']);
    expect(w.ear.status().counters.beforeStart).toBe(2);
  });

  it('writes super chats, stickers, memberships and gifts as the contract says, and sends no deletions or bans', async () => {
    const w = world();
    live(w);
    w.youtube.messages = [
      { id: 's1', snippet: { type: 'superChatEvent', publishedAt: at(1), hasDisplayContent: true, displayMessage: '¥500 ありがとう', superChatDetails: { amountMicros: '500000000', currency: 'JPY', amountDisplayString: '¥500', userComment: 'ありがとう', tier: 3 } }, authorDetails: author('UCa', { isChatSponsor: true }) },
      { id: 's2', snippet: { type: 'superStickerEvent', publishedAt: at(2), hasDisplayContent: true, superStickerDetails: { amountMicros: '200000000', currency: 'JPY', amountDisplayString: '¥200', superStickerMetadata: { stickerId: 'x', altText: 'ハート' } } }, authorDetails: author('UCb') },
      { id: 's3', snippet: { type: 'newSponsorEvent', publishedAt: at(3), hasDisplayContent: true, newSponsorDetails: { memberLevelName: 'ベーシック', isUpgrade: false } }, authorDetails: author('UCc', { isChatSponsor: true }) },
      { id: 's4', snippet: { type: 'memberMilestoneChatEvent', publishedAt: at(4), hasDisplayContent: true, memberMilestoneChatDetails: { userComment: '6か月です', memberMonth: 6, memberLevelName: 'ベーシック' } }, authorDetails: author('UCd', { isChatSponsor: true }) },
      { id: 's5', snippet: { type: 'membershipGiftingEvent', publishedAt: at(5), hasDisplayContent: true, membershipGiftingDetails: { giftMembershipsCount: 5, giftMembershipsLevelName: 'ベーシック' } }, authorDetails: author('UCe') },
      { id: 'x1', snippet: { type: 'messageDeletedEvent', publishedAt: at(6), hasDisplayContent: false, messageDeletedDetails: { deletedMessageId: 'm1' } }, authorDetails: author('UCmod') },
      { id: 'x2', snippet: { type: 'userBannedEvent', publishedAt: at(7), hasDisplayContent: false }, authorDetails: author('UCmod') },
      { id: 'x3', snippet: { type: 'sponsorOnlyModeStartedEvent', publishedAt: at(8), hasDisplayContent: false }, authorDetails: author('UCmod') },
      { id: 'o1', snippet: { type: 'textMessageEvent', publishedAt: at(9), hasDisplayContent: true, textMessageDetails: { messageText: 'こんにちは' } }, authorDetails: author('UCown', { isChatOwner: true, isChatModerator: true, isVerified: true }) },
    ];
    await w.run(() => w.head.received.length >= 6);
    await tick();
    const byId = Object.fromEntries(w.head.received.map(c => [c.id, c]));
    expect(Object.keys(byId)).toEqual(['s1', 's2', 's3', 's4', 's5', 'o1']);
    expect(byId.s1).toEqual({ id: 's1', authorId: 'UCa', authorName: 'Name UCa', text: 'ありがとう', publishedAt: at(1), kind: 'superchat', amount: { display: '¥500', micros: 500000000, currency: 'JPY' }, roles: ['member'] });
    expect(byId.s2).toMatchObject({ kind: 'supersticker', text: 'ハート', amount: { micros: 200000000, currency: 'JPY' } });
    expect(byId.s3).toMatchObject({ kind: 'membership', roles: ['member'], synthetic: true });
    expect(byId.s3.text).toContain('ベーシック');
    expect(byId.s4).toMatchObject({ kind: 'membership', text: '6か月です' });
    expect(byId.s4.synthetic).toBeUndefined();
    expect(byId.s5).toMatchObject({ kind: 'gift', synthetic: true });
    expect(byId.s5.text).toContain('5');
    expect(byId.o1).toMatchObject({ kind: 'text', roles: ['owner', 'moderator', 'verified'] });
    expect(byId.o1.amount).toBeUndefined();
  });

  it('cuts a long text at 300 characters without splitting a character', () => {
    const long = '😀'.repeat(400);
    const event = classifyChatMessage(textItem('long', 1, long));
    expect(event.class === 'comment' && Array.from(event.comment.text)).toHaveLength(300);
    expect(chunkComments(Array.from({ length: 450 }, (_, i) => ({ id: `${i}`, authorId: 'a', authorName: 'n', text: 'x'.repeat(300), publishedAt: at(1), kind: 'text', roles: [] }) as StreamComment)).every(chunk => chunk.length <= 200)).toBe(true);
    // 128 KB: 500-byte comments are cut into requests that stay under the limit.
    const big = chunkComments(Array.from({ length: 400 }, (_, i) => ({ id: `${i}`, authorId: 'a', authorName: 'n', text: 'あ'.repeat(300), publishedAt: at(1), kind: 'text', roles: [] }) as StreamComment));
    expect(big.length).toBeGreaterThan(2);
    for (const chunk of big) expect(Buffer.byteLength(JSON.stringify({ streamId: 's', comments: chunk }))).toBeLessThan(128 * 1024);
  });
});

describe('the end', () => {
  function live(w: ReturnType<typeof world>) {
    w.head.start({ phase: 'live', broadcast: { onAir: true, videoId: 'vid00000001', liveChatId: 'chat-1', title: 't', channelId: 'UCowner' } });
  }

  it('offlineAt: the last comments go first, then the head is told the chat ended', async () => {
    const w = world();
    live(w);
    w.youtube.messages = manyTexts(3);
    w.youtube.offlineAt = at(500);
    await w.run(() => w.head.ended.length === 1);
    expect(w.head.log).toEqual(['comments:3', 'ended']);
    expect(w.head.ended[0]).toEqual({ streamId: 'st-1', ended: true });
    expect(w.head.stream?.phase).toBe('ended');
  });

  it('liveChatEnded (403) ends it too', async () => {
    const w = world();
    live(w);
    w.youtube.listErrors = [[403, 'liveChatEnded']];
    await w.run(() => w.head.ended.length === 1);
    expect(w.head.ended).toEqual([{ streamId: 'st-1', ended: true }]);
  });

  it('liveChatNotFound (404) ends it', async () => {
    const w = world();
    live(w);
    w.youtube.listErrors = [[404, 'liveChatNotFound']];
    await w.run(() => w.head.ended.length === 1);
  });

  it('a chatEndedEvent in the messages ends it after the other messages are sent', async () => {
    const w = world();
    live(w);
    w.youtube.messages = [textItem('m1', 1), { id: 'end', snippet: { type: 'chatEndedEvent', publishedAt: at(2), hasDisplayContent: false }, authorDetails: author('UCsys') }];
    await w.run(() => w.head.ended.length === 1);
    expect(w.head.log).toEqual(['comments:1', 'ended']);
  });

  it('retries the end notice until the head acknowledges it', async () => {
    const w = world();
    live(w);
    w.youtube.listErrors = [[403, 'liveChatEnded']];
    const original = w.head.fetcher;
    let refused = 2;
    const wrapped: typeof fetch = async (input, init) => {
      if (String(init?.body ?? '').includes('"ended":true') && refused > 0) { refused -= 1; return json(503, {}); }
      return original(input, init);
    };
    const ear = new StreamEar({
      head: new HeadStreamClient({ url: HEAD, token: 'bridge-token', fetcher: wrapped }),
      youtube: new YoutubeLiveApi({ baseUrl: YT, fetcher: w.youtube.fetcher, getAccessToken: async () => 't' }),
      sleep: async (_ms, signal) => { if (!signal.aborted) await tick(); },
      log: { info: () => undefined, warn: () => undefined },
    });
    ear.start();
    for (let i = 0; i < 4000 && w.head.ended.length < 1; i += 1) await tick();
    await ear.stop();
    expect(refused).toBe(0);
    expect(w.head.ended).toHaveLength(1);
  });

  it('a 409 from the head on comments stops the reading for good and sends no end notice', async () => {
    const w = world();
    live(w);
    w.youtube.messages = manyTexts(3);
    w.head.commentStatuses = [409];
    await w.run(() => w.clock() - START >= 40_000);
    expect(w.youtube.listCalls).toBe(1);
    expect(w.head.ended).toEqual([]);
    expect(w.head.received).toEqual([]);
  });

  it('the head ending the stream (state says ended) stops the reading', async () => {
    const w = world();
    live(w);
    w.youtube.messages = manyTexts(2);
    w.youtube.onList = call => { if (call === 3) w.head.stream = { ...w.head.stream!, phase: 'ended' }; };
    await w.run(() => w.clock() - START >= 60_000 && w.ear.status().mode !== 'reading');
    const listsAfter = w.youtube.listCalls;
    expect(listsAfter).toBeLessThanOrEqual(6);
    expect(w.head.ended).toEqual([]);
  });

  it('a new stream after an ended one is attached to again', async () => {
    const w = world();
    live(w);
    w.youtube.onList = call => { if (call === 2) { w.head.stream = { ...w.head.stream!, phase: 'ended' }; } };
    await w.run(() => w.clock() - START >= 30_000);
    w.head.start({ streamId: 'st-2', phase: 'live', broadcast: { onAir: true, videoId: 'vid00000001', liveChatId: 'chat-2', title: 't', channelId: 'UCowner' } });
    w.youtube.messages = [textItem('late', 40)];
    await w.run(() => w.head.received.length >= 1);
    expect(w.head.received[0].id).toBe('late');
  });
});

describe('when something fails', () => {
  function live(w: ReturnType<typeof world>) {
    w.head.start({ phase: 'live', broadcast: { onAir: true, videoId: 'vid00000001', liveChatId: 'chat-1', title: 't', channelId: 'UCowner' } });
  }

  it('resends what the head refused with 503, in order, nothing lost and nothing twice', async () => {
    const w = world();
    live(w);
    w.youtube.messages = manyTexts(30);
    w.head.commentStatuses = [503, 503, 503];
    await w.run(() => w.head.received.length >= 30);
    expect(w.head.received.map(c => c.id)).toEqual(Array.from({ length: 30 }, (_, i) => `m${i + 1}`));
    expect(w.head.commentsPosted).toBe(4);
    expect(w.ear.status().counters.commentsDropped).toBe(0);
  });

  it('drops a batch the head refuses for its content (413) and goes on with the next', async () => {
    const w = world();
    live(w);
    w.youtube.messages = manyTexts(2);
    w.youtube.onList = call => { if (call === 2) w.youtube.messages.push(textItem('after', 50)); };
    w.head.commentStatuses = [413];
    await w.run(() => w.head.received.some(c => c.id === 'after'));
    expect(w.head.received.map(c => c.id)).toEqual(['after']);
    expect(w.ear.status().counters.commentsDropped).toBe(2);
  });

  it('keeps reading when YouTube errors, with growing waits, and does not throw', async () => {
    const w = world();
    live(w);
    w.youtube.listErrors = [[500, 'backendError'], [500, 'backendError'], [503, 'backendError']];
    w.youtube.messages = manyTexts(1);
    await w.run(() => w.head.received.length >= 1);
    expect(w.sleeps.slice(1, 4)).toEqual([2000, 4000, 8000]);
    expect(w.ear.status().lastError).toContain('liveChatMessages.list');
  });

  it('a spent quota is waited out a minute at a time', async () => {
    const w = world();
    live(w);
    w.youtube.listErrors = [[403, 'quotaExceeded'], [403, 'quotaExceeded']];
    w.youtube.messages = manyTexts(1);
    await w.run(() => w.head.received.length >= 1);
    expect(w.sleeps.slice(1, 3)).toEqual([60_000, 60_000]);
  });

  it('refreshes the token once when YouTube refuses it (401)', async () => {
    const w = world();
    live(w);
    w.youtube.messages = manyTexts(1);
    w.youtube.firstStatus = [401];
    await w.run(() => w.head.received.length >= 1);
    expect(w.tokens.slice(0, 2)).toEqual([false, true]);
    expect(w.youtube.calls[1].auth).toBe('Bearer fresh-token');
  });
});

describe('writing into the chat (chatPosts)', () => {
  function live(w: ReturnType<typeof world>, chatWrites: boolean) {
    w.head.start({ phase: 'live', chatWrites, broadcast: { onAir: true, videoId: 'vid00000001', liveChatId: 'chat-1', title: 't', channelId: 'UCowner' } });
  }

  it('posts what the head returns with the comments, then sends the receipt', async () => {
    const w = world();
    live(w, true);
    w.youtube.messages = manyTexts(1);
    w.head.commentPosts = [[{ id: 'cp-1', text: 'こんにちは！ようこそ' }]];
    await w.run(() => w.head.receipts.length >= 1);
    expect(w.youtube.inserted).toEqual([{ text: 'こんにちは！ようこそ', liveChatId: 'chat-1' }]);
    expect(w.head.receipts).toEqual([{ id: 'cp-1', outcome: 'posted' }]);
    const insert = w.youtube.calls.find(call => call.method === 'POST');
    expect(insert?.query.part).toBe('snippet');
  });

  it('also posts what comes with the state (her own topic comes without any comment)', async () => {
    const w = world();
    live(w, true);
    w.head.statePosts = [[], [], [{ id: 'cp-2', text: '今日の話題です' }]];
    await w.run(() => w.head.receipts.length >= 1);
    expect(w.youtube.inserted.map(p => p.text)).toEqual(['今日の話題です']);
  });

  it('never posts when the stream was not started with chatWrites, even if the head hands posts', async () => {
    const w = world();
    live(w, false);
    w.youtube.messages = manyTexts(1);
    w.head.commentPosts = [[{ id: 'cp-1', text: 'no' }]];
    await w.run(() => w.head.received.length >= 1 && w.clock() - START >= 20_000);
    expect(w.youtube.inserted).toEqual([]);
    expect(w.head.receipts).toEqual([]);
  });

  it('a failed insert gets a failed receipt; the same post id is handled once; the text is cut at 200 characters', async () => {
    const w = world();
    live(w, true);
    w.youtube.messages = manyTexts(1);
    w.youtube.insertFails = 1;
    w.head.commentPosts = [[{ id: 'cp-1', text: 'a' }], [{ id: 'cp-1', text: 'a' }, { id: 'cp-2', text: 'あ'.repeat(250) }]];
    w.youtube.onList = call => { if (call === 2) w.youtube.messages.push(textItem('m2', 9)); };
    await w.run(() => w.head.receipts.length >= 2);
    expect(w.head.receipts).toEqual([{ id: 'cp-1', outcome: 'failed' }, { id: 'cp-2', outcome: 'posted' }]);
    expect(Array.from(w.youtube.inserted[0].text)).toHaveLength(200);
    expect(w.ear.status().counters).toMatchObject({ chatPostsPosted: 1, chatPostsFailed: 1 });
  });

  it('does not read its own post back as a viewer comment (the channel is the owner\'s)', async () => {
    const w = world();
    live(w, true);
    w.youtube.messages = manyTexts(1);
    w.head.commentPosts = [[{ id: 'cp-1', text: '返事です' }]];
    w.youtube.onList = call => {
      if (call === 2) w.youtube.messages.push({ id: 'own-1', snippet: { type: 'textMessageEvent', publishedAt: at(5), hasDisplayContent: true, textMessageDetails: { messageText: '返事です' } }, authorDetails: author('UCowner', { isChatOwner: true }) });
      if (call === 3) w.youtube.messages.push({ id: 'human-owner', snippet: { type: 'textMessageEvent', publishedAt: at(6), hasDisplayContent: true, textMessageDetails: { messageText: '配信主のコメント' } }, authorDetails: author('UCowner', { isChatOwner: true }) });
    };
    await w.run(() => w.head.received.some(c => c.id === 'human-owner'));
    expect(w.head.received.map(c => c.id)).toEqual(['m1', 'human-owner']);
  });
});

describe('reading the chat over streamList', () => {
  function live(w: ReturnType<typeof world>, extra: Partial<HeadStreamState> = {}) {
    w.head.start({ phase: 'live', broadcast: { onAir: true, videoId: 'vid00000001', liveChatId: 'chat-1', title: 't', channelId: 'UCowner' }, ...extra });
  }
  const ids = (count: number, from = 1) => Array.from({ length: count }, (_, i) => `m${from + i}`);
  /** The first connection of a stream is made after the ear has asked for its 5 s tick, so every gap between two connects holds one. */
  const TICK = 5000;
  const gaps = (youtube: FakeYoutube) => youtube.connectTimes.slice(1).map((time, i) => time - youtube.connectTimes[i] - TICK);

  it('opens GET liveChat/messages/stream, reads the history and then each push once and in order, and never polls', async () => {
    const w = world({ via: 'stream' });
    live(w);
    w.youtube.messages = manyTexts(5);
    w.youtube.onPump = n => { if (n === 20) w.youtube.messages.push(...manyTexts(7, 6)); if (n === 40) w.youtube.messages.push(...manyTexts(3, 13)); };
    await w.run(() => w.head.received.length >= 15);
    expect(w.head.received.map(c => c.id)).toEqual(ids(15));
    expect(w.youtube.streamCalls).toBe(1);
    expect(w.youtube.listCalls).toBe(0);
    const call = w.youtube.calls.find(entry => entry.path === '/liveChat/messages/stream');
    expect(call).toMatchObject({ method: 'GET', auth: 'Bearer token', query: { part: 'snippet,authorDetails', liveChatId: 'chat-1' } });
    expect(w.methods).toEqual(['streamList', null]);
    expect(w.ear.status().counters).toMatchObject({ streamConnections: 1, itemsRead: 15, commentsEligible: 15, commentsSent: 15, commentsDropped: 0 });
    expect(w.ear.status().counters.streamPages).toBe(w.ear.status().counters.pagesRead);
  });

  it.each([
    ['array', 0], ['array', 1], ['array', 7], ['ndjson', 5], ['sse', 3], ['wrapped', 11],
  ] as const)('reads a %s stream cut into pieces of %s bytes (Japanese, emoji, quotes and braces in the text) without losing or doubling a message', async (framing, split) => {
    const w = world({ via: 'stream' });
    live(w);
    w.youtube.framing = framing;
    w.youtube.splitBytes = split;
    w.youtube.streamPage = 5;
    w.youtube.messages = Array.from({ length: 12 }, (_, i) => textItem(`m${i + 1}`, i + 1, `こんにちは😀 ${i + 1} "引用" \\ { } [x]`));
    await w.run(() => w.head.received.length >= 12);
    expect(w.head.received.map(c => c.id)).toEqual(ids(12));
    expect(w.head.received[3].text).toBe('こんにちは😀 4 "引用" \\ { } [x]');
    expect(w.ear.status().counters.streamPages).toBe(3);
  });

  it('a stream YouTube closes is opened again at once with the last token: nothing lost, nothing twice', async () => {
    const w = world({ via: 'stream' });
    live(w);
    w.youtube.messages = manyTexts(12);
    w.youtube.plans = [{ cutAfter: 5 }];
    await w.run(() => w.head.received.length >= 12);
    expect(w.head.received.map(c => c.id)).toEqual(ids(12));
    expect(w.youtube.streams.map(stream => stream.query.pageToken)).toEqual([undefined, 't5']);
    expect(w.ear.status().counters.streamConnections).toBe(2);
    expect(w.logs.filter(line => line.includes('closed by YouTube'))).toHaveLength(1);
  });

  it.each(['tear', 'error'] as const)('a connection that %ss in the middle of a response resumes from the last whole one: nothing lost, nothing twice', async how => {
    const w = world({ via: 'stream' });
    live(w);
    w.youtube.messages = manyTexts(12);
    w.youtube.plans = [{ cutAfter: 5, how }];
    await w.run(() => w.head.received.length >= 12);
    expect(w.head.received.map(c => c.id)).toEqual(ids(12));
    expect(w.youtube.streams.map(stream => stream.query.pageToken)).toEqual([undefined, 't5']);
    expect(w.ear.status().counters).toMatchObject({ commentsEligible: 12, commentsSent: 12, commentsDropped: 0 });
  });

  it('keeps failing: the first retry is at once, then 1, 2, 4, 8, 16 and 30 s', async () => {
    const w = world({ via: 'stream' });
    live(w);
    w.youtube.messages = manyTexts(1);
    w.youtube.streamErrors = Array.from({ length: 7 }, () => [500, 'backendError'] as [number, string]);
    await w.run(() => w.head.received.length >= 1);
    expect(gaps(w.youtube)).toEqual([0, 1000, 2000, 4000, 8000, 16000, 30000]);
    expect(w.ear.status().lastError).toContain('liveChatMessages.streamList');
    expect(w.logs.filter(line => line.includes('failed (liveChatMessages.streamList'))).toHaveLength(1);
  });

  it('a connection that lived 30 s or more was a good one: when it ends, the next try is at once, not after the old waits', async () => {
    const w = world({ via: 'stream' });
    live(w);
    w.youtube.streamErrors = Array.from({ length: 3 }, () => [500, 'backendError'] as [number, string]);
    let closedAt = 0;
    w.youtube.onPump = () => {
      const fourth = w.youtube.streams[0];
      if (fourth && !fourth.closed && w.clock() - w.youtube.connectTimes[3] > 40_000) { fourth.controller.close(); fourth.closed = true; closedAt = w.clock(); }
    };
    await w.run(() => w.youtube.streamCalls >= 5);
    // Failures 1, 2 and 3 waited 0, 1 s and 2 s. The 4th connection lived 40 s, so its end starts the count again: the 5th follows at once
    // (the only time between the close and the 5th connect is the 5 s tick that every connection asks for first).
    expect(gaps(w.youtube).slice(0, 2)).toEqual([0, 1000]);
    expect(w.youtube.connectTimes[4] - closedAt).toBe(TICK);
  });

  it('a spent quota on the stream is waited out for a minute, with the head still looked at meanwhile', async () => {
    const w = world({ via: 'stream' });
    live(w);
    w.youtube.messages = manyTexts(1);
    w.youtube.streamErrors = [[403, 'rateLimitExceeded']];
    await w.run(() => w.head.received.length >= 1);
    expect(gaps(w.youtube)).toEqual([60_000]);
    expect(w.head.stateCalls).toBeGreaterThanOrEqual(10);
  });

  it('refreshes the token once when the stream is refused with 401', async () => {
    const w = world({ via: 'stream' });
    live(w);
    w.youtube.messages = manyTexts(1);
    w.youtube.firstStatus = [401];
    await w.run(() => w.head.received.length >= 1);
    expect(w.tokens.slice(0, 2)).toEqual([false, true]);
    expect(w.youtube.calls[1].auth).toBe('Bearer fresh-token');
  });

  it('YouTube refusing the resume token (400 pageTokenInvalid): the stream starts again without it, and the history it sends again is not sent twice', async () => {
    const w = world({ via: 'stream' });
    live(w);
    w.youtube.messages = manyTexts(12);
    w.youtube.plans = [{ cutAfter: 5 }];
    w.youtube.streamErrors = [null, [400, 'pageTokenInvalid']];
    await w.run(() => w.head.received.length >= 12 && w.youtube.streams.length >= 2);
    expect(w.head.received.map(c => c.id)).toEqual(ids(12));
    expect(w.youtube.streams.map(stream => stream.query.pageToken)).toEqual([undefined, undefined]);
    expect(w.ear.status().counters).toMatchObject({ commentsEligible: 12, commentsSent: 12 });
    expect(w.logs.some(line => line.includes('refused the resume token'))).toBe(true);
  });

  it('a quiet stream is not silent for the head: its state is still read every 5 s and her own chat post is written', async () => {
    const w = world({ via: 'stream' });
    live(w, { chatWrites: true });
    w.head.statePosts = [[], [], [{ id: 'cp-9', text: '今日の話題です' }]];
    await w.run(() => w.head.receipts.length >= 1);
    expect(w.youtube.inserted.map(post => post.text)).toEqual(['今日の話題です']);
    expect(w.youtube.streamCalls).toBe(1);
  });

  it('a stream that says nothing for streamIdleMs is closed and opened again with the token', async () => {
    const w = world({ via: 'stream', streamIdleMs: 40 });
    live(w);
    w.youtube.messages = manyTexts(2);
    w.ear.start();
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && w.youtube.streamCalls < 3) { w.youtube.pump(); await new Promise(resolve => setTimeout(resolve, 5)); }
    await w.ear.stop();
    expect(w.youtube.streamCalls).toBeGreaterThanOrEqual(3);
    expect(w.youtube.streams[0].cancelled).toBe(true);
    expect(w.youtube.streams[1].query.pageToken).toBe('t2');
    expect(w.head.received.map(c => c.id)).toEqual(['m1', 'm2']);
    expect(w.logs.some(line => line.includes('was silent'))).toBe(true);
  });

  it('does not send what was said before the stream started, and does not read its own post back', async () => {
    const w = world({ via: 'stream' });
    live(w, { chatWrites: true, startedAt: at(100) });
    w.youtube.messages = [textItem('old1', 10), textItem('old2', 99), textItem('new1', 101), textItem('new2', 150)];
    w.head.commentPosts = [[{ id: 'cp-1', text: '返事です' }]];
    // Her post is written first; YouTube then shows it in the chat (as the owner's message with the id insert returned), and later the owner says something.
    let echoedAt = 0;
    w.youtube.onPump = n => {
      if (!echoedAt && w.youtube.inserted.length > 0) {
        echoedAt = n;
        w.youtube.messages.push({ id: 'own-1', snippet: { type: 'textMessageEvent', publishedAt: at(160), hasDisplayContent: true, textMessageDetails: { messageText: '返事です' } }, authorDetails: author('UCowner', { isChatOwner: true }) });
      }
      if (echoedAt && n === echoedAt + 30) w.youtube.messages.push({ id: 'human-owner', snippet: { type: 'textMessageEvent', publishedAt: at(170), hasDisplayContent: true, textMessageDetails: { messageText: '配信主のコメント' } }, authorDetails: author('UCowner', { isChatOwner: true }) });
    };
    await w.run(() => w.head.received.some(c => c.id === 'human-owner'));
    expect(w.head.received.map(c => c.id)).toEqual(['new1', 'new2', 'human-owner']);
    expect(w.ear.status().counters.beforeStart).toBe(2);
    expect(w.youtube.inserted.map(post => post.text)).toEqual(['返事です']);
  });

  describe('the end', () => {
    it('offlineAt in a response: the last comments go first, then the head is told, and the connection is let go', async () => {
      const w = world({ via: 'stream' });
      live(w);
      w.youtube.messages = manyTexts(3);
      w.youtube.offlineAt = at(500);
      await w.run(() => w.head.ended.length === 1);
      expect(w.head.log).toEqual(['comments:3', 'ended']);
      expect(w.head.ended[0]).toEqual({ streamId: 'st-1', ended: true });
      expect(w.youtube.streamCalls).toBe(1);
      expect(w.youtube.streams[0].cancelled).toBe(true);
    });

    it('a chatEndedEvent ends it after the other messages are sent', async () => {
      const w = world({ via: 'stream' });
      live(w);
      w.youtube.messages = [textItem('m1', 1), { id: 'end', snippet: { type: 'chatEndedEvent', publishedAt: at(2), hasDisplayContent: false }, authorDetails: author('UCsys') }];
      await w.run(() => w.head.ended.length === 1);
      expect(w.head.log).toEqual(['comments:1', 'ended']);
    });

    it.each([
      [403, 'liveChatEnded'], [404, 'liveChatNotFound'], [403, 'liveChatDisabled'], [400, 'FAILED_PRECONDITION'],
    ] as const)('%s %s when the stream is opened ends it, and does not fall back to polling', async (status, reason) => {
      const w = world({ via: 'stream' });
      live(w);
      w.youtube.streamErrors = [[status, reason]];
      await w.run(() => w.head.ended.length === 1);
      expect(w.youtube.listCalls).toBe(0);
      expect(w.youtube.streamCalls).toBe(1);
    });

    it('an error object inside the stream (liveChatEnded) ends it after the messages before it', async () => {
      const w = world({ via: 'stream' });
      live(w);
      w.youtube.messages = manyTexts(2);
      w.youtube.onPump = n => { if (n === 10) w.youtube.streamInject.push({ error: { code: 403, message: 'ended', errors: [{ reason: 'liveChatEnded' }] } }); };
      await w.run(() => w.head.ended.length === 1);
      expect(w.head.log).toEqual(['comments:2', 'ended']);
      expect(w.head.received.map(c => c.id)).toEqual(['m1', 'm2']);
    });

    it('a 409 from the head on comments stops the reading for good: the connection is closed, no end notice is sent', async () => {
      const w = world({ via: 'stream' });
      live(w);
      w.youtube.messages = manyTexts(3);
      w.head.commentStatuses = [409];
      await w.run(() => w.clock() - START >= 40_000);
      expect(w.youtube.streamCalls).toBe(1);
      expect(w.youtube.streams[0].cancelled).toBe(true);
      expect(w.head.ended).toEqual([]);
      expect(w.head.received).toEqual([]);
    });

    it('the head ending the stream (state says ended) lets the connection go', async () => {
      const w = world({ via: 'stream' });
      live(w);
      w.youtube.messages = manyTexts(2);
      w.youtube.onPump = n => { if (n === 30) w.head.stream = { ...w.head.stream!, phase: 'ended' }; };
      await w.run(() => w.clock() - START >= 60_000 && w.ear.status().mode !== 'reading');
      expect(w.youtube.streams[0].cancelled).toBe(true);
      expect(w.youtube.streamCalls).toBe(1);
      expect(w.head.ended).toEqual([]);
    });
  });

  describe('when streamList cannot be used', () => {
    it.each([
      [404, 'notFound'], [405, 'methodNotAllowed'], [501, 'unimplemented'], [403, 'forbidden'], [400, 'badRequest'], [400, 'INVALID_ARGUMENT'], [403, 'PERMISSION_DENIED'],
    ] as const)('%s %s: the chat is polled instead (said once, with the method in the status), and streamList is tried again later', async (status, reason) => {
      const w = world({ via: 'stream', streamRetryMs: 60_000 });
      live(w);
      w.youtube.streamErrors = [[status, reason]];
      w.youtube.messages = manyTexts(3);
      w.youtube.onPump = () => { if (w.youtube.streams.length === 1 && w.youtube.messages.length === 3) w.youtube.messages.push(...manyTexts(2, 4)); };
      await w.run(() => w.head.received.length >= 5);
      expect(w.head.received.map(c => c.id)).toEqual(ids(5));
      expect(w.methods).toEqual(['streamList', 'polling', 'streamList', null]);
      expect(w.logs.filter(line => line.includes('streamList cannot be used'))).toHaveLength(1);
      expect(w.logs.find(line => line.includes('streamList cannot be used'))).toContain(`${status}`);
      expect(w.youtube.listCalls).toBeGreaterThanOrEqual(1);
      // The token the polling had reached is the one the stream resumes from.
      expect(w.youtube.streams[0].query.pageToken).toBe('t3');
    });

    it('the status says polling while it polls, and a stream that is not there keeps being tried only every streamRetryMs', async () => {
      const w = world({ via: 'poll', streamRetryMs: 600_000 });
      live(w);
      await w.run(() => w.clock() - START >= 3_600_000, 20_000);
      expect(w.methods.slice(0, 2)).toEqual(['streamList', 'polling']);
      // First try plus a retry every 10 minutes of the hour.
      expect(w.youtube.calls.filter(call => call.path === '/liveChat/messages/stream').length).toBeGreaterThanOrEqual(6);
      expect(w.youtube.calls.filter(call => call.path === '/liveChat/messages/stream').length).toBeLessThanOrEqual(8);
    });

    it('a body no framing reads, three times running, is read by polling instead of retried forever', async () => {
      const w = world({ via: 'stream', streamRetryMs: 600_000 });
      live(w);
      w.youtube.streamGarbage = 3;
      w.youtube.messages = manyTexts(2);
      await w.run(() => w.head.received.length >= 2);
      expect(w.head.received.map(c => c.id)).toEqual(ids(2));
      expect(w.methods.slice(0, 2)).toEqual(['streamList', 'polling']);
      expect(w.youtube.listCalls).toBeGreaterThanOrEqual(1);
    });

    it('a 500 or a broken connection is not "cannot be used": it is retried as a stream', async () => {
      const w = world({ via: 'stream' });
      live(w);
      w.youtube.messages = manyTexts(1);
      w.youtube.streamErrors = [[500, 'backendError'], [503, 'backendError']];
      await w.run(() => w.head.received.length >= 1);
      expect(w.youtube.listCalls).toBe(0);
      expect(w.methods).toEqual(['streamList', null]);
    });
  });
});

describe('the stream parser', () => {
  const objects = [{ a: 1, s: '}{"\\' }, { b: [1, { c: 2 }], t: '[,]' }, { d: '日本語😀', e: null }];
  const framings: Record<string, (items: unknown[]) => string> = {
    array: items => `[${items.map(item => JSON.stringify(item)).join(',\n')}]`,
    'array that is still open': items => `[${items.map(item => JSON.stringify(item)).join(',\n')}`,
    ndjson: items => items.map(item => `${JSON.stringify(item)}\n`).join(''),
    sse: items => `: keepalive\n\nretry: 3000\n\n${items.map((item, i) => `event: message\nid: ${i}\ndata: ${JSON.stringify(item)}\n\n`).join('')}`,
    'objects with only blanks between them': items => items.map(item => JSON.stringify(item)).join('  '),
  };

  it.each(Object.keys(framings))('reads a %s, split at every possible character', name => {
    const text = framings[name](objects);
    for (let cut = 0; cut <= text.length; cut += 1) {
      const parser = new JsonStreamParser();
      const got = [...parser.push(text.slice(0, cut)), ...parser.push(text.slice(cut))];
      expect(got).toEqual(objects);
      expect(parser.remainder).toBe('');
    }
  });

  it('reads it one character at a time', () => {
    const text = framings.sse(objects);
    const parser = new JsonStreamParser();
    const got = Array.from(text).flatMap(char => parser.push(char));
    expect(got).toEqual(objects);
  });

  it('keeps what is half of an object as the remainder, and rejects what is not JSON at all', () => {
    const parser = new JsonStreamParser();
    expect(parser.push('[{"a":1},{"b":')).toEqual([{ a: 1 }]);
    expect(parser.remainder).toBe('{"b":');
    expect(() => new JsonStreamParser().push('<html>Not Found</html>')).toThrow(/unexpected/);
    expect(() => new JsonStreamParser().push('{"a": nope}')).toThrow(/not JSON/);
  });
});

describe('streamList at the API level', () => {
  const api = (youtube: FakeYoutube) => new YoutubeLiveApi({ baseUrl: YT, fetcher: youtube.fetcher, getAccessToken: async () => 'token' });

  it('throws what YouTube answers when the connection is refused, with the flags the ear decides by', async () => {
    const youtube = new FakeYoutube();
    youtube.streamErrors = [[403, 'liveChatEnded'], [404, 'liveChatNotFound'], [403, 'rateLimitExceeded'], [400, 'pageTokenInvalid'], [403, 'forbidden']];
    const flags: Array<Record<string, boolean>> = [];
    for (let i = 0; i < 5; i += 1) {
      const error = await api(youtube).streamMessages({ liveChatId: 'c' }).next().catch(e => e);
      expect(error).toBeInstanceOf(YoutubeApiError);
      flags.push({ ended: error.chatEnded, quota: error.quota, token: error.pageTokenInvalid, unavailable: error.streamUnavailable });
    }
    expect(flags).toEqual([
      { ended: true, quota: false, token: false, unavailable: false },
      { ended: true, quota: false, token: false, unavailable: false },
      { ended: false, quota: true, token: false, unavailable: false },
      { ended: false, quota: false, token: true, unavailable: false },
      { ended: false, quota: false, token: false, unavailable: true },
    ]);
  });

  it('YoutubeApiError: a 404 on streamList that is not a missing chat means "no such method"; on list it still means the chat is gone', () => {
    expect(new YoutubeApiError('liveChatMessages.streamList', 404, 'notFound').streamUnavailable).toBe(true);
    expect(new YoutubeApiError('liveChatMessages.streamList', 404, 'notFound').chatEnded).toBe(false);
    expect(new YoutubeApiError('liveChatMessages.list', 404, '').chatEnded).toBe(true);
    expect(new YoutubeApiError('liveChatMessages.list', 404, '').streamUnavailable).toBe(false);
    expect(new YoutubeApiError('liveChatMessages.streamList', 500, 'backendError').streamUnavailable).toBe(false);
    expect(new YoutubeApiError('liveChatMessages.streamList', 0, 'network').streamUnavailable).toBe(false);
  });

  it('ends quietly when the caller aborts, and does not hang on a connection that never answers', async () => {
    const youtube = new FakeYoutube();
    youtube.messages = manyTexts(1);
    const controller = new AbortController();
    const stream = api(youtube).streamMessages({ liveChatId: 'c', signal: controller.signal });
    const first = stream.next();
    for (let i = 0; i < 10; i += 1) { youtube.pump(); await tick(); }
    expect((await first).value?.items).toHaveLength(1);
    const second = stream.next();
    controller.abort();
    expect(await second).toEqual({ done: true, value: undefined });
  });
});

describe('the API units', () => {
  it('counts the units of the quota table and reports the hour', async () => {
    let now = START;
    const reports: string[] = [];
    const meter = new ApiUnitMeter(() => now, line => reports.push(line), () => undefined);
    const youtube = new FakeYoutube();
    youtube.messages = manyTexts(1);
    const api = new YoutubeLiveApi({ baseUrl: YT, fetcher: youtube.fetcher, meter, getAccessToken: async () => 't' });
    await api.findActiveBroadcast();
    await api.videoDetails('vid00000001');
    await api.listMessages({ liveChatId: 'chat-1' });
    await api.listMessages({ liveChatId: 'chat-1', pageToken: 't1' });
    await api.insertMessage('chat-1', 'hi');
    expect(meter.snapshot()).toMatchObject({ hourUnits: 1 + 1 + 5 + 5 + 20, hourCalls: 5, dayUnits: 32 });
    meter.tick();
    expect(reports).toEqual([]);
    now += 3_600_001;
    meter.tick();
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain('32 in 5 calls');
    expect(meter.snapshot().hourUnits).toBe(0);
    expect(meter.snapshot().totalUnits).toBe(32);
  });

  it('polling (the fallback) is 5 units a poll at no more than one poll in 8 s: about 2,250 units an hour', async () => {
    const w = world();
    w.head.start({ phase: 'live', broadcast: { onAir: true, videoId: 'vid00000001', liveChatId: 'chat-1', title: 't', channelId: 'UCowner' } });
    w.youtube.polling = [5000];
    await w.run(() => w.clock() - START >= 3_600_000, 20_000);
    // 8 s floor: 450 polls an hour, 5 units each, plus the 5 units of each try at streamList (every 15 minutes: 4 of them).
    expect(w.youtube.listCalls).toBeGreaterThan(440);
    expect(w.youtube.listCalls).toBeLessThan(460);
    expect(w.meter.snapshot().totalUnits).toBeGreaterThan(2250);
    expect(w.meter.snapshot().totalUnits).toBeLessThan(2350);
  });

  it('streamList is one 5-unit connection however long the stream is quiet: an hour of silence costs 5 units of streamList plus the on-air end check (1 unit a minute)', async () => {
    const w = world({ via: 'stream' });
    w.head.start({ phase: 'live', broadcast: { onAir: true, videoId: 'vid00000001', liveChatId: 'chat-1', title: 't', channelId: 'UCowner' } });
    await w.run(() => w.clock() - START >= 3_600_000, 20_000);
    expect(w.youtube.streamCalls).toBe(1);
    expect(w.youtube.listCalls).toBe(0);
    const endChecks = w.youtube.calls.filter(call => call.path === '/videos').length;
    expect(endChecks).toBeGreaterThanOrEqual(58);
    expect(endChecks).toBeLessThanOrEqual(61);
    expect(w.meter.snapshot().totalUnits).toBe(5 + endChecks);
    expect(w.ear.status().counters.streamConnections).toBe(1);
  });

  it('every streamList connection is counted as 5 units, and the hourly line says so', async () => {
    let now = START;
    const reports: string[] = [];
    const meter = new ApiUnitMeter(() => now, line => reports.push(line), () => undefined);
    const youtube = new FakeYoutube();
    youtube.messages = manyTexts(2);
    const api = new YoutubeLiveApi({ baseUrl: YT, fetcher: youtube.fetcher, meter, getAccessToken: async () => 't' });
    const first = api.streamMessages({ liveChatId: 'chat-1' });
    const pending = first.next();
    for (let i = 0; i < 20; i += 1) { youtube.pump(); await tick(); }
    expect((await pending).value?.items).toHaveLength(2);
    await first.return();
    const second = api.streamMessages({ liveChatId: 'chat-1', pageToken: 't2' });
    const next = second.next();
    youtube.messages.push(...manyTexts(1, 3));
    for (let i = 0; i < 20; i += 1) { youtube.pump(); await tick(); }
    expect((await next).value?.items.map((item: any) => item.id)).toEqual(['m3']);
    await second.return();
    expect(meter.snapshot()).toMatchObject({ hourUnits: 10, hourCalls: 2, dayUnits: 10 });
    now += 3_600_001;
    meter.tick();
    expect(reports[0]).toContain('10 in 2 calls');
  });
});

describe('small parts', () => {
  it('reads a video id from the live URL forms', () => {
    expect(videoIdOfUrl('https://www.youtube.com/watch?v=abcdefghijk')).toBe('abcdefghijk');
    expect(videoIdOfUrl('https://www.youtube.com/live/abcdefghijk?feature=share')).toBe('abcdefghijk');
    expect(videoIdOfUrl('https://youtu.be/abcdefghijk')).toBe('abcdefghijk');
    expect(videoIdOfUrl('abcdefghijk')).toBe('abcdefghijk');
    expect(videoIdOfUrl('')).toBeNull();
    expect(videoIdOfUrl(undefined)).toBeNull();
    expect(videoIdOfUrl('https://example.com/')).toBeNull();
  });

  it('the OAuth provider marks the cached token expired when a refresh is forced', async () => {
    const client: any = { credentials: { access_token: 'old', expiry_date: Date.now() + 3_600_000 }, getAccessToken: async () => ({ token: client.credentials.expiry_date < Date.now() ? 'new' : 'old' }) };
    const provider = oauthTokenProvider(client);
    expect(await provider()).toBe('old');
    expect(await provider(true)).toBe('new');
  });

  it('YoutubeApiError tells an ended chat and a spent quota apart', () => {
    expect(new YoutubeApiError('liveChatMessages.list', 403, 'liveChatEnded').chatEnded).toBe(true);
    expect(new YoutubeApiError('liveChatMessages.list', 404, '').chatEnded).toBe(true);
    expect(new YoutubeApiError('liveChatMessages.list', 403, 'forbidden').chatEnded).toBe(false);
    expect(new YoutubeApiError('videos.list', 404, '').chatEnded).toBe(false);
    expect(new YoutubeApiError('liveChatMessages.list', 403, 'quotaExceeded').quota).toBe(true);
  });
});

describe('over real HTTP', () => {
  it('reads a fake chat from a real server and reaches a real head server with the real fetch and timers', async () => {
    const received: any[] = [];
    const calls: string[] = [];
    const broadcastBodies: any[] = [];
    let stream: any = { streamId: 'st-http', platform: 'youtube', phase: 'waiting_for_chat', startedAt: at(0), title: 't', chatWrites: false, broadcast: null };
    const readBody = (request: IncomingMessage) => new Promise<any>(resolve => {
      let text = '';
      request.on('data', chunk => { text += chunk; });
      request.on('end', () => resolve(text ? JSON.parse(text) : undefined));
    });
    const headServer = createServer(async (request, response) => {
      const body = await readBody(request);
      const route = `${request.method} ${request.url}`;
      calls.push(route);
      const send = (status: number, value: unknown) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
      if (request.headers.authorization !== 'Bearer http-token') return send(401, {});
      if (route === 'GET /v1/platform/stream/state') return send(200, { stream, chatPosts: [] });
      if (route === 'POST /v1/platform/stream/broadcast') {
        if (body.ended) { stream = { ...stream, phase: 'ended' }; return send(200, { stream }); }
        broadcastBodies.push(body);
        stream = { ...stream, phase: body.onAir === true && stream.phase === 'waiting_for_chat' ? 'live' : stream.phase };
        return send(200, { stream });
      }
      if (route === 'POST /v1/platform/stream/comments') { received.push(...body.comments); return send(202, { accepted: body.comments.length, duplicates: 0, chatPosts: [] }); }
      return send(404, {});
    });
    const youtubeServer = createServer((request, response) => {
      const url = new URL(request.url ?? '', 'http://x');
      const send = (status: number, value: unknown) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
      if (url.pathname === '/youtube/v3/liveBroadcasts') return send(200, { items: [{ id: 'vid00000001', snippet: { title: 't', channelId: 'UCo' }, status: { lifeCycleStatus: 'live' } }] });
      if (url.pathname === '/youtube/v3/videos') return send(200, { items: [{ id: 'vid00000001', snippet: { title: 't', channelId: 'UCo' }, liveStreamingDetails: { activeLiveChatId: 'chat-http', actualStartTime: at(0) } }] });
      if (url.pathname === '/youtube/v3/liveChat/messages') {
        const first = !url.searchParams.get('pageToken');
        return send(200, first
          ? { items: manyTexts(3, 1), nextPageToken: 'p2', pollingIntervalMillis: 100 }
          : { items: [], nextPageToken: 'p3', pollingIntervalMillis: 100, offlineAt: at(900) });
      }
      return send(404, {});
    });
    const listen = (server: Server) => new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
    const [headPort, youtubePort] = [await listen(headServer), await listen(youtubeServer)];
    try {
      const ear = new StreamEar({
        head: new HeadStreamClient({ url: `http://127.0.0.1:${headPort}/v1/platform/turns`, token: 'http-token' }),
        youtube: new YoutubeLiveApi({ baseUrl: `http://127.0.0.1:${youtubePort}/youtube/v3`, getAccessToken: async () => 'tok' }),
        stateEveryMs: 20, discoveryEveryMs: 20, minPollMs: 20, maxPollMs: 200,
        log: { info: () => undefined, warn: () => undefined },
      });
      ear.start();
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline && stream.phase !== 'ended') await new Promise(resolve => setTimeout(resolve, 20));
      await ear.stop();
      expect(received.map(c => c.id)).toEqual(['m1', 'm2', 'm3']);
      expect(stream.phase).toBe('ended');
      expect(calls).toContain('POST /v1/platform/stream/broadcast');
      // Live only because the ear said onAir: true after seeing the video's actualStartTime.
      expect(broadcastBodies).toEqual([expect.objectContaining({ videoId: 'vid00000001', liveChatId: 'chat-http', onAir: true })]);
    } finally {
      headServer.close();
      youtubeServer.close();
    }
  });
});

describe('over real HTTP, streamList', () => {
  it('reads a chunked JSON array from a real server over real sockets, resumes by token after the server cuts the socket, and ends on offlineAt', async () => {
    const received: any[] = [];
    const broadcastBodies: any[] = [];
    const tokens: Array<string | null> = [];
    let stream: any = { streamId: 'st-http', platform: 'youtube', phase: 'waiting_for_chat', startedAt: at(0), title: 't', chatWrites: false, broadcast: null };
    const readBody = (request: IncomingMessage) => new Promise<any>(resolve => {
      let text = '';
      request.on('data', chunk => { text += chunk; });
      request.on('end', () => resolve(text ? JSON.parse(text) : undefined));
    });
    const headServer = createServer(async (request, response) => {
      const body = await readBody(request);
      const route = `${request.method} ${request.url}`;
      const send = (status: number, value: unknown) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
      if (route === 'GET /v1/platform/stream/state') return send(200, { stream, chatPosts: [] });
      if (route === 'POST /v1/platform/stream/broadcast') {
        if (!body.ended) broadcastBodies.push(body);
        stream = { ...stream, phase: body.ended ? 'ended' : body.onAir === true && stream.phase === 'waiting_for_chat' ? 'live' : stream.phase };
        return send(200, { stream });
      }
      if (route === 'POST /v1/platform/stream/comments') { received.push(...body.comments); return send(202, { accepted: body.comments.length, duplicates: 0, chatPosts: [] }); }
      return send(404, {});
    });
    const page = (from: number, count: number, extra: Record<string, unknown> = {}) => JSON.stringify({
      kind: 'youtube#liveChatMessageListResponse', items: manyTexts(count, from), nextPageToken: `p${from + count - 1}`, ...extra,
    });
    const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    const youtubeServer = createServer(async (request, response) => {
      const url = new URL(request.url ?? '', 'http://x');
      const send = (status: number, value: unknown) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
      if (url.pathname === '/youtube/v3/liveBroadcasts') return send(200, { items: [{ id: 'vid00000001', snippet: { title: 't', channelId: 'UCo' }, status: { lifeCycleStatus: 'live' } }] });
      if (url.pathname === '/youtube/v3/videos') return send(200, { items: [{ id: 'vid00000001', snippet: { title: 't', channelId: 'UCo' }, liveStreamingDetails: { activeLiveChatId: 'chat-http', actualStartTime: at(0) } }] });
      if (url.pathname !== '/youtube/v3/liveChat/messages/stream') return send(404, {});
      const token = url.searchParams.get('pageToken');
      tokens.push(token);
      response.writeHead(200, { 'content-type': 'application/json' });
      // A body of Transfer-Encoding: chunked, written in pieces with a pause between them, the pieces cut inside the objects.
      const writePieces = async (text: string) => {
        for (let i = 0; i < text.length; i += 37) { response.write(text.slice(i, i + 37)); await pause(2); }
      };
      if (!token) {
        await writePieces(`[${page(1, 2)}`);
        await writePieces(`,\n${page(3, 2)}`);
        await pause(20);
        request.socket.destroy();
        return;
      }
      await writePieces(`,\n${page(5, 2, { offlineAt: at(900) })}`);
      await pause(50);
      response.end(']');
    });
    const listen = (server: Server) => new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
    const [headPort, youtubePort] = [await listen(headServer), await listen(youtubeServer)];
    try {
      const ear = new StreamEar({
        head: new HeadStreamClient({ url: `http://127.0.0.1:${headPort}/v1/platform/turns`, token: 'http-token' }),
        youtube: new YoutubeLiveApi({ baseUrl: `http://127.0.0.1:${youtubePort}/youtube/v3`, getAccessToken: async () => 'tok' }),
        stateEveryMs: 20, discoveryEveryMs: 20,
        log: { info: () => undefined, warn: () => undefined },
      });
      ear.start();
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline && stream.phase !== 'ended') await new Promise(resolve => setTimeout(resolve, 20));
      const status = ear.status();
      await ear.stop();
      expect(received.map(c => c.id)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6']);
      expect(stream.phase).toBe('ended');
      // The first connection had no token; the second resumed from the last whole response of the cut one.
      expect(tokens).toEqual([null, 'p4']);
      expect(broadcastBodies).toEqual([expect.objectContaining({ videoId: 'vid00000001', onAir: true })]);
      expect(status.counters).toMatchObject({ streamConnections: 2, streamPages: 3, commentsSent: 6 });
    } finally {
      headServer.close();
      youtubeServer.closeAllConnections();
      youtubeServer.close();
    }
  });
});

describe('the legacy live-chat reply path is gone', () => {
  const backend = path.resolve(__dirname, '../..');
  const read = (relative: string) => readFileSync(path.join(backend, relative), 'utf8');

  it('the YouTube client has no "シャノン、" prefix, no random pick and no legacy reply', () => {
    const client = read('src/services/youtube/client.ts');
    expect(client).not.toContain('シャノン、');
    expect(client).not.toContain('Math.random');
    expect(client).not.toContain('deliverYoutubeMessageToLlm');
    expect(client).not.toContain('lastRepliedMessageIds');
    expect(client).toContain("registerServiceCommandHandler('youtube:live_chat'");
  });

  it('the live reply agent and its dispatch hooks are removed, and nothing reads its prompt', () => {
    expect(existsSync(path.join(backend, 'src/services/llm/agents/replyYoutubeLiveCommentAgent.ts'))).toBe(false);
    // The prompt file stays in backend/saves (the shared runtime place deploy-body.sh will not change), read by no code.
    const sources = (readdirSync(path.join(backend, 'src'), { recursive: true }) as string[]).filter(file => /\.(?:ts|js)$/u.test(file));
    expect(sources.filter(file => read(path.join('src', file)).includes('reply_youtube_live_comment'))).toEqual([]);
    expect(read('src/services/llm/agents/AgentOrchestrator.ts')).not.toContain('processYoutubeMessage');
    expect(read('src/services/llm/routing/EventRouter.ts')).not.toContain('handleYoutubeMessage');
    expect(read('src/services/runtime/llmInboundDispatch.ts')).not.toContain('deliverYoutubeMessageToLlm');
  });

  it('the hourly comment replies and the subscriber check stay as they were', () => {
    const client = read('src/services/youtube/client.ts');
    expect(client).toContain('public async checkComments');
    expect(client).toContain('public async checkSubscribers');
    expect(client).toContain('public async replyComment');
  });
});

describe('セッション指定の動画とYouTubeの開始確認', () => {
  it('環境の動画より配信主が指定した動画を優先し、開始まではonAirをfalseにする', async () => {
    const w = world({ liveUrl: 'old00000001' });
    w.head.start({ targetVideoId: 'AGenSh4kF9Y' });
    w.youtube.actualStartTime = undefined;
    await w.run(() => w.head.broadcasts.length >= 1);
    expect(w.youtube.calls.filter(c => c.path === '/liveBroadcasts')).toHaveLength(0);
    expect(w.youtube.calls.find(c => c.path === '/videos')?.query.id).toBe('AGenSh4kF9Y');
    expect(w.head.broadcasts[0]).toMatchObject({ videoId: 'AGenSh4kF9Y', onAir: false });
  });
  it('チャットを読みながら実開始を確認し、同じ動画をonAirに更新する', async () => {
    const w = world();
    w.head.start({ targetVideoId: 'AGenSh4kF9Y' });
    w.youtube.actualStartTime = undefined;
    w.youtube.onPump = () => { if (w.head.broadcasts.length) w.youtube.actualStartTime = at(2); };
    await w.run(() => w.head.broadcasts.some(b => b.onAir === true));
    expect(w.head.broadcasts[0].onAir).toBe(false);
    expect(w.head.broadcasts.at(-1)).toMatchObject({ videoId: 'AGenSh4kF9Y', onAir: true });
  });
});

/**
 * The review of the ear's on-air work (2026-11-02): the end of the chat while the head still fails, a video that is over already, an end the
 * chat does not announce, YouTube errors while the video is looked at, and the head's different 409s. The fake head answers like the real one
 * (streamService.broadcast): STREAM_VIDEO_MISMATCH for another video, live only for a waiting stream told onAir: true.
 */
describe('終わり際のコメントを落とさない', () => {
  function live(w: ReturnType<typeof world>) {
    w.head.start({ phase: 'live', broadcast: { onAir: true, videoId: 'vid00000001', liveChatId: 'chat-1', title: 't', channelId: 'UCowner' } });
  }
  const chatEnded = { id: 'end', snippet: { type: 'chatEndedEvent', publishedAt: at(5), hasDisplayContent: false }, authorDetails: author('UCsys') };

  it.each(['poll', 'stream'] as const)('%s: 最後のコメントが 503 のまま終わりが見つかっても、頭が戻れば送り切ってから終わりを知らせる', async via => {
    const w = world({ via });
    live(w);
    w.youtube.messages = [textItem('m1', 1), textItem('m2', 2), chatEnded];
    w.head.commentStatuses = [503, 503];
    await w.run(() => w.head.ended.length === 1);
    expect(w.head.received.map(c => c.id)).toEqual(['m1', 'm2']);
    expect(w.head.log.at(-1)).toBe('ended');
    expect(w.head.log.filter(entry => entry.startsWith('comments'))).toEqual(['comments:2']);
    expect(w.ear.status().counters.commentsDropped).toBe(0);
    expect(w.head.commentsPosted).toBeGreaterThanOrEqual(3);
  });

  it.each(['poll', 'stream'] as const)('%s: 終わりの後の送り直しは 1・2・4・8・16 秒、そのあとは 30 秒ごとで、頭が受けるまで続ける', async via => {
    const w = world({ via });
    live(w);
    w.youtube.messages = [textItem('m1', 1), textItem('m2', 2), chatEnded];
    w.head.commentStatuses = Array.from({ length: 9 }, () => 503);
    await w.run(() => w.head.ended.length === 1);
    expect(w.head.received.map(c => c.id)).toEqual(['m1', 'm2']);
    expect(w.sleeps.join(',')).toContain('1000,2000,4000,8000,16000,30000,30000');
    expect(w.ear.status().counters).toMatchObject({ commentsDropped: 0 });
    expect(w.ear.status().pending).toBe(0);
    expect(w.head.log.filter(entry => entry.startsWith('comments') || entry === 'ended')).toEqual(['comments:2', 'ended']);
  });

  it.each(['poll', 'stream'] as const)('%s: comments だけが 40 秒 503 で、終わりの知らせは通る: コメントが頭に届いてから終わりが届く（31 秒で捨てない）', async via => {
    const w = world({ via });
    live(w);
    w.youtube.messages = [textItem('m1', 1), textItem('m2', 2), chatEnded];
    w.head.commentsDownUntil = START + 40_000;
    await w.run(() => w.head.ended.length === 1);
    expect(w.head.received.map(c => c.id)).toEqual(['m1', 'm2']);
    expect(w.head.log.filter(entry => entry.startsWith('comments') || entry === 'ended')).toEqual(['comments:2', 'ended']);
    expect(w.ear.status().counters).toMatchObject({ commentsDropped: 0, commentsSent: 2 });
    expect(w.clock() - START).toBeGreaterThanOrEqual(40_000);
    expect(w.logs.some(line => line.includes('could not be sent'))).toBe(false);
  });

  it.each(['poll', 'stream'] as const)('%s: 10 分たっても頭が受けなければ、件数を数えて警告し、そのあとで終わりを知らせる', async via => {
    const w = world({ via });
    live(w);
    w.youtube.messages = [textItem('m1', 1), textItem('m2', 2), chatEnded];
    w.head.commentsDownUntil = Number.POSITIVE_INFINITY;
    await w.run(() => w.head.ended.length === 1);
    expect(w.head.received).toEqual([]);
    const waited = w.clock() - START;
    expect(waited).toBeGreaterThanOrEqual(600_000);
    expect(waited).toBeLessThan(600_000 + 60_000);
    // 1, 2, 4, 8, 16 s, then every 30 s, the last wait cut to the 10 minutes.
    expect(w.sleeps.join(',')).toContain('1000,2000,4000,8000,16000,30000,30000');
    expect(w.ear.status().counters).toMatchObject({ commentsDropped: 2, commentsSent: 0 });
    expect(w.ear.status().pending).toBe(0);
    expect(w.logs.some(line => line.startsWith('WARN') && line.includes('2 comments could not be sent before the stream ended') && line.includes('10 minutes'))).toBe(true);
    // The end is told after the comments were given up, not before.
    expect(w.head.log.at(-1)).toBe('ended');
  });

  it('終わりの後の送り直しの途中で頭が 409 STREAM_NOT_LIVE と言えば、そこで止めて件数を残す', async () => {
    const w = world();
    live(w);
    w.youtube.messages = [textItem('m1', 1), textItem('m2', 2), chatEnded];
    w.head.commentStatuses = [503, 409];
    await w.run(() => w.head.ended.length === 1);
    expect(w.head.received).toEqual([]);
    expect(w.head.commentsPosted).toBe(2);
    expect(w.ear.status().counters.commentsDropped).toBe(2);
    expect(w.logs.some(line => line.includes('the head says the stream is not live'))).toBe(true);
  });

  it('終わりの後の送り直しの待ちの途中で止められたら、そこで終わり、捨てた件数を残す', async () => {
    let t = START;
    const w = world({
      now: () => t,
      sleep: async (ms, signal) => {
        if (signal.aborted) return;
        // The first wait of the final send (1 s, with comments waiting) lasts until the ear is stopped.
        if (ms === 1000 && w.head.commentsPosted >= 2) { await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); return; }
        t += ms;
        await tick();
      },
    });
    live(w);
    w.youtube.messages = [textItem('m1', 1), chatEnded];
    w.head.commentStatuses = Array.from({ length: 30 }, () => 503);
    w.ear.start();
    for (let i = 0; i < 4000 && w.head.commentsPosted < 2; i += 1) { w.youtube.pump(); await tick(); }
    for (let i = 0; i < 20; i += 1) await tick();
    await w.ear.stop();
    expect(w.head.commentsPosted).toBe(2);
    expect(w.ear.status().counters.commentsDropped).toBe(1);
    expect(w.logs.some(line => line.includes('the ear was stopped'))).toBe(true);
    // Stopped is not ended: the head is told nothing, and its stream is still live.
    expect(w.head.ended).toEqual([]);
    expect(w.head.log).not.toContain('ended');
    expect(w.head.stream?.phase).toBe('live');
  });
});

describe('終了済みの動画と、チャットが知らせない終わり', () => {
  const TARGET = 'AGenSh4kF9Y';

  it.each([
    [undefined, undefined, 'waits'], [at(0), undefined, 'onAir'], [at(0), at(50), 'over'], [undefined, at(50), 'over'],
  ] as const)('指定の動画: 開始 %s・終了 %s -> %s', async (start, end, outcome) => {
    const w = world();
    w.head.start({ targetVideoId: TARGET });
    w.youtube.actualStartTime = start;
    w.youtube.actualEndTime = end;
    if (outcome === 'over') {
      await w.run(() => w.head.ended.length === 1);
      expect(w.head.broadcasts).toEqual([]);
      expect(w.youtube.calls.some(call => call.path.startsWith('/liveChat'))).toBe(false);
    } else {
      await w.run(() => w.head.broadcasts.length >= 1);
      expect(w.head.broadcasts[0].onAir).toBe(outcome === 'onAir');
    }
  });

  // The video the ear is connected to ending is this stream's end, whether the head named it (the target above), registered it as the stream's
  // broadcast, or the ear found it by searching the channel: the only video not taken as the stream's is a YOUTUBE_LIVE_URL left over (next test).
  it.each([
    [undefined, undefined], [at(0), undefined], [at(0), at(50)], [undefined, at(50)],
  ] as const)('探して見つけた放送: 開始 %s・終了 %s でも、終わった動画を onAir にせず、終わっていればそれをこの配信の終わりとして頭へ知らせる', async (start, end) => {
    const w = world();
    w.head.start();
    w.youtube.actualStartTime = start;
    w.youtube.actualEndTime = end;
    if (end) {
      await w.run(() => w.head.ended.length === 1);
      expect(w.head.broadcasts.every(body => body.onAir === false)).toBe(true);
    } else {
      await w.run(() => w.head.broadcasts.length >= 1);
      expect(w.head.broadcasts[0].onAir).toBe(Boolean(start));
    }
  });

  it('この配信のために指定された動画が初めから終わっていれば、activeLiveChatId が無くても待ち続けずに頭へ終わりを知らせる', async () => {
    const w = world();
    w.head.start({ targetVideoId: TARGET });
    w.youtube.chatId = undefined;
    w.youtube.actualEndTime = at(50);
    await w.run(() => w.head.ended.length === 1);
    expect(w.head.ended).toEqual([{ streamId: 'st-1', ended: true }]);
    expect(w.head.stream?.phase).toBe('ended');
    expect(w.head.broadcasts).toEqual([]);
    expect(w.youtube.calls.some(call => call.path.startsWith('/liveChat') || call.path === '/liveBroadcasts')).toBe(false);
  });

  it('常設の YOUTUBE_LIVE_URL に前の配信の終わった動画が残っていても（これだけはこの配信の動画として扱わない）、この配信を終わらせず、チャンネルの今のライブを探す（一度だけ知らせる）', async () => {
    const w = world({ liveUrl: 'https://youtu.be/abcdefghijk' });
    w.head.start({});
    w.youtube.endedVideos.add('abcdefghijk');
    await w.run(() => w.clock() - START >= 60_000);
    expect(w.head.ended).toEqual([]);
    expect(w.head.stream?.phase).not.toBe('ended');
    expect(w.youtube.calls.some(call => call.path === '/liveBroadcasts')).toBe(true);
    expect(w.logs.filter(line => line.includes('YOUTUBE_LIVE_URL names a video that has ended'))).toHaveLength(1);
  });

  it('開始が見えていない動画で chatId も無ければ、これまでどおり待つ（終わりを作らない）', async () => {
    const w = world();
    w.head.start({ targetVideoId: TARGET });
    w.youtube.chatId = undefined;
    w.youtube.actualStartTime = undefined;
    await w.run(() => w.clock() - START >= 60_000);
    expect(w.head.ended).toEqual([]);
    expect(w.head.broadcasts).toEqual([]);
  });

  it.each(['poll', 'stream'] as const)('%s: true を送ったあとに終わり、チャットが静かなままでも、動画側の終わりで検知する（60 秒ごと）', async via => {
    const w = world({ via });
    w.head.start({ targetVideoId: TARGET });
    w.youtube.onPump = () => { if (w.head.broadcasts.some(body => body.onAir) && !w.youtube.actualEndTime && w.clock() - START >= 200_000) w.youtube.actualEndTime = at(200); };
    await w.run(() => w.head.ended.length === 1);
    const videos = w.youtube.calls.filter(call => call.path === '/videos');
    expect(videos.length).toBeGreaterThanOrEqual(4);
    // After the first look (the discovery) the video is looked at no more often than every 60 s.
    for (let i = 1; i < videos.length; i += 1) expect(videos[i].at - videos[i - 1].at).toBeGreaterThanOrEqual(60_000);
    expect(w.clock() - (START + 200_000)).toBeLessThanOrEqual(80_000);
    expect(w.head.log.at(-1)).toBe('ended');
  });

  // The limit of this test: the clock is virtual (a sleep moves it) and, with virtualIdle, so is streamList's idle timer. What stays outside it:
  // the real YouTube may push something on a quiet chat (a heartbeat), which would keep one connection open for the hour; the fake pushes
  // nothing, so every idle period (5 minutes) is a new connection. That is the worst case, and it is what is counted here.
  it('onAir の後の動画の確かめは 1 時間に 60 回（60 units）で、何も流れてこない streamList は idle（5 分）ごとに開き直して 1 時間に約 12 接続（60 units）', async () => {
    const w = world({ via: 'stream', virtualIdle: true });
    w.head.start({ phase: 'live', broadcast: { onAir: true, videoId: 'vid00000001', liveChatId: 'chat-1', title: 't', channelId: 'UCowner' } });
    await w.run(() => w.clock() - START >= 3_600_000, 60_000);
    const videos = w.youtube.calls.filter(call => call.path === '/videos').length;
    expect(videos).toBeGreaterThanOrEqual(58);
    expect(videos).toBeLessThanOrEqual(61);
    expect(w.youtube.calls.filter(call => call.path === '/liveBroadcasts')).toEqual([]);
    expect(w.head.ended).toEqual([]);
    expect(w.youtube.streamCalls).toBeGreaterThanOrEqual(11);
    expect(w.youtube.streamCalls).toBeLessThanOrEqual(13);
    expect(w.youtube.connectTimes.slice(1).every((time, i) => time - w.youtube.connectTimes[i] >= 299_000)).toBe(true);
  });

  it.each(['poll', 'stream'] as const)('%s: 耳が再起動したとき、頭の broadcast が onAir:false なら同じ動画・チャットを引き継いで開始を確かめ直す', async via => {
    const w = world({ via });
    w.head.start({ phase: 'waiting_for_chat', broadcast: { onAir: false, videoId: 'vid00000001', liveChatId: 'chat-9', title: 't', channelId: 'UCowner' } });
    await w.run(() => w.head.stream?.phase === 'live');
    expect(w.youtube.calls.some(call => call.path === '/liveBroadcasts')).toBe(false);
    expect(w.head.broadcasts).toEqual([expect.objectContaining({ videoId: 'vid00000001', liveChatId: 'chat-9', onAir: true })]);
    expect(w.head.wentLive).toBe(1);
    const chatCall = w.youtube.calls.find(call => call.path.startsWith('/liveChat'));
    expect(chatCall?.query.liveChatId).toBe('chat-9');
  });

  it('頭が別の動画の broadcast を持っていても、state の targetVideoId を優先して探し直す', async () => {
    const w = world();
    w.head.start({ targetVideoId: TARGET, broadcast: { onAir: false, videoId: 'old00000001', liveChatId: 'chat-old', title: 't', channelId: 'UCowner' } });
    await w.run(() => w.head.stream?.phase === 'live');
    expect(w.head.broadcasts[0]).toMatchObject({ videoId: TARGET, onAir: true });
    expect(w.youtube.calls.find(call => call.path === '/videos')?.query.id).toBe(TARGET);
  });

  it('discovery の問い合わせに mine は無い（broadcastStatus だけ）', async () => {
    const w = world();
    w.head.start();
    w.youtube.emptyBroadcastLists = 2;
    await w.run(() => w.head.broadcasts.length >= 1);
    const lists = w.youtube.calls.filter(call => call.path === '/liveBroadcasts');
    expect(lists.length).toBeGreaterThanOrEqual(3);
    for (const call of lists) {
      expect('mine' in call.query).toBe(false);
      expect('id' in call.query).toBe(false);
      expect(Object.keys(call.query).sort()).toEqual(['broadcastStatus', 'broadcastType', 'part']);
    }
  });
});

describe('動画の確かめでの YouTube のエラー', () => {
  function restarted(w: ReturnType<typeof world>, onAir: boolean) {
    w.head.start({ phase: onAir ? 'live' : 'waiting_for_chat', broadcast: { onAir, videoId: 'vid00000001', liveChatId: 'chat-1', title: 't', channelId: 'UCowner' } });
  }

  it('quota: lastError とログに残り、5 分待つ。その間も頭の state とチャットは続き、戻れば開始を知らせる', async () => {
    const w = world({ via: 'stream' });
    restarted(w, false);
    w.youtube.videoErrors = [[403, 'quotaExceeded']];
    w.youtube.messages = manyTexts(3);
    await w.run(() => w.head.stream?.phase === 'live');
    const videos = w.youtube.calls.filter(call => call.path === '/videos');
    expect(videos).toHaveLength(2);
    expect(videos[1].at - videos[0].at).toBeGreaterThanOrEqual(300_000);
    expect(w.ear.status().lastError).toContain('quotaExceeded');
    expect(w.logs.some(line => line.startsWith('WARN') && line.includes('looking at video vid00000001 failed') && line.includes('quotaExceeded'))).toBe(true);
    expect(w.head.received.map(c => c.id)).toEqual(['m1', 'm2', 'm3']);
    expect(w.head.stateCalls).toBeGreaterThanOrEqual(50);
  });

  it('権限のエラーが続く: 初めの 1 回だけ警告し、待ちは長くなっていき、戻れば開始を知らせる', async () => {
    const w = world({ via: 'stream' });
    restarted(w, false);
    w.youtube.videoErrors = Array.from({ length: 6 }, () => [403, 'forbidden'] as [number, string]);
    await w.run(() => w.head.stream?.phase === 'live');
    const times = w.youtube.calls.filter(call => call.path === '/videos').map(call => call.at);
    const gaps = times.slice(1).map((time, i) => time - times[i]);
    expect(gaps).toHaveLength(6);
    for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(15_000);
    expect(gaps[5]).toBeGreaterThanOrEqual(55_000);
    expect(gaps[5]).toBeGreaterThan(gaps[2]);
    expect(w.ear.status().lastError).toContain('forbidden');
    expect(w.logs.filter(line => line.startsWith('WARN') && line.includes('looking at video'))).toHaveLength(1);
  });

  it('onAir の後の終わりの確かめが quota で外れても、待ったあとに終わりを見つける', async () => {
    const w = world({ via: 'stream' });
    restarted(w, true);
    w.youtube.videoErrors = [[403, 'quotaExceeded']];
    w.youtube.actualEndTime = at(1);
    await w.run(() => w.head.ended.length === 1);
    expect(w.clock() - START).toBeGreaterThanOrEqual(360_000);
    expect(w.ear.status().lastError).toContain('quotaExceeded');
    expect(w.logs.some(line => line.startsWith('WARN') && line.includes('quotaExceeded'))).toBe(true);
  });
});

describe('broadcast への頭の答えの区別', () => {
  const TARGET = 'AGenSh4kF9Y';
  const onAirBody = (body: any) => body.onAir === true;
  const waiting = (w: ReturnType<typeof world>) => w.head.start({ phase: 'waiting_for_chat', broadcast: { onAir: false, videoId: 'vid00000001', liveChatId: 'chat-1', title: 't', channelId: 'UCowner' } });

  it('開始の知らせが 503: 次の確かめでもう一度送り、挨拶は一度', async () => {
    const w = world();
    waiting(w);
    w.head.broadcastFaults = [{ when: onAirBody, times: 1, status: 503 }];
    await w.run(() => w.head.stream?.phase === 'live');
    expect(w.head.broadcasts.filter(onAirBody)).toHaveLength(2);
    expect(w.head.wentLive).toBe(1);
  });

  it('頭が受理したのに応答を失った: もう一度 true を送っても、live のままで挨拶は重ならない', async () => {
    const w = world();
    waiting(w);
    w.head.broadcastFaults = [{ when: onAirBody, times: 1, lose: true }];
    await w.run(() => w.head.broadcasts.filter(onAirBody).length >= 2);
    expect(w.head.stream?.phase).toBe('live');
    expect(w.head.wentLive).toBe(1);
    expect(w.head.stream?.broadcast).toMatchObject({ onAir: true });
  });

  it('偽の頭は本物と同じ: false を再送しても live を待ちに戻さず、true のときだけ live にする', async () => {
    const w = world();
    w.head.start();
    const post = (body: unknown) => w.head.fetcher(`${HEAD}/v1/platform/stream/broadcast`, { method: 'POST', body: JSON.stringify(body) });
    const base = { streamId: 'st-1', videoId: 'vid00000001', liveChatId: 'chat-1', title: 't', channelId: 'UCowner' };
    await post({ ...base, onAir: false });
    expect(w.head.stream?.phase).toBe('waiting_for_chat');
    await post({ ...base, onAir: true });
    expect(w.head.stream?.phase).toBe('live');
    await post({ ...base, onAir: false });
    expect(w.head.stream?.phase).toBe('live');
    expect(w.head.wentLive).toBe(1);
    w.head.stream = { ...w.head.stream!, targetVideoId: TARGET };
    const refused = await post({ ...base, onAir: true });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: 'STREAM_VIDEO_MISMATCH' });
  });

  it('開始の知らせへの 409 STREAM_NOT_LIVE: 配信は終わった。読むのをやめ、終わりの知らせも送らず、同じものを繰り返さない', async () => {
    const w = world();
    waiting(w);
    w.head.broadcastFaults = [{ when: onAirBody, times: 99, status: 409, code: 'STREAM_NOT_LIVE' }];
    await w.run(() => w.clock() - START >= 40_000);
    expect(w.head.broadcasts.filter(onAirBody)).toHaveLength(1);
    expect(w.head.ended).toEqual([]);
    expect(w.ear.status().headRefusal).toBeNull();
  });

  it('開始の知らせへの 409 STREAM_VIDEO_MISMATCH が 1 回: 止まらず、理由を status とログに出し、次に成功すれば消える', async () => {
    const w = world();
    waiting(w);
    w.youtube.messages = manyTexts(3);
    w.head.broadcastFaults = [{ when: onAirBody, times: 1, status: 409, code: 'STREAM_VIDEO_MISMATCH' }];
    let refusal: string | null = null;
    w.youtube.onPump = () => { refusal ??= w.ear.status().headRefusal; };
    await w.run(() => w.head.stream?.phase === 'live');
    expect(refusal).toContain('STREAM_VIDEO_MISMATCH');
    expect(w.logs.some(line => line.startsWith('WARN') && line.includes('STREAM_VIDEO_MISMATCH'))).toBe(true);
    expect(w.ear.status().lastError).toContain('STREAM_VIDEO_MISMATCH');
    expect(w.ear.status().headRefusal).toBeNull();
    expect(w.head.wentLive).toBe(1);
    expect(w.head.ended).toEqual([]);
  });

  it('頭が targetVideoId をまだ教えていない間に別の動画を送って 409 になっても、次の state の targetVideoId で探し直す', async () => {
    const w = world({ liveUrl: 'old00000001' });
    w.head.start({ targetVideoId: TARGET });
    w.head.hideTargetStates = 1;
    await w.run(() => w.head.stream?.phase === 'live');
    expect(w.head.broadcasts.map(body => body.videoId)).toEqual(['old00000001', TARGET]);
    expect(w.youtube.calls.filter(call => call.path === '/videos').map(call => call.query.id)).toEqual(['old00000001', TARGET]);
    expect(w.ear.status().headRefusal).toBeNull();
    expect(w.logs.some(line => line.includes('STREAM_VIDEO_MISMATCH') && line.includes('looking again'))).toBe(true);
  });

  it('同じ食い違いが続いても 60 秒ごとの無限の繰り返しにしない: 3 回で諦め、理由を status とログに残し、YouTube も頭も叩かなくなる', async () => {
    const w = world({ liveUrl: 'old00000001' });
    w.head.start({ targetVideoId: TARGET });
    w.head.hideTargetStates = 100_000;
    await w.run(() => w.clock() - START >= 600_000);
    expect(w.head.broadcasts).toHaveLength(3);
    expect(w.youtube.calls.filter(call => call.path === '/videos')).toHaveLength(3);
    expect(w.youtube.calls.some(call => call.path.startsWith('/liveChat'))).toBe(false);
    expect(w.ear.status().headRefusal).toContain('STREAM_VIDEO_MISMATCH');
    expect(w.ear.status().headRefusal).toContain('3 times in a row');
    expect(w.logs.filter(line => line.includes('giving up on stream st-1'))).toHaveLength(1);
    expect(w.head.ended).toEqual([]);
  });

  it('別の新しい配信は、前の配信で諦めていても普通に取りつく', async () => {
    const w = world({ liveUrl: 'old00000001' });
    w.head.start({ targetVideoId: TARGET });
    w.head.hideTargetStates = 100_000;
    await w.run(() => w.clock() - START >= 100_000);
    expect(w.head.broadcasts).toHaveLength(3);
    w.head.hideTargetStates = 0;
    w.head.start({ streamId: 'st-2' });
    await w.run(() => w.head.stream?.phase === 'live');
    expect(w.head.broadcasts.at(-1)).toMatchObject({ streamId: 'st-2', onAir: true });
  });

  it('開始の知らせへの 400: 同じものを送り続けず、読むのをやめ、理由を残す', async () => {
    const w = world();
    waiting(w);
    w.head.broadcastFaults = [{ when: onAirBody, times: 99, status: 400, code: 'STREAM_INPUT_INVALID' }];
    await w.run(() => w.clock() - START >= 600_000);
    expect(w.head.broadcasts.filter(onAirBody)).toHaveLength(1);
    expect(w.ear.status().headRefusal).toContain('STREAM_INPUT_INVALID');
    expect(w.ear.status().lastError).toContain('STREAM_INPUT_INVALID');
    expect(w.head.ended).toEqual([]);
  });

  it('最初の broadcast への 400: YouTube も頭も同じもので叩き続けない', async () => {
    const w = world();
    w.head.start({ targetVideoId: TARGET });
    w.head.broadcastFaults = [{ when: () => true, times: 99, status: 400, code: 'STREAM_INPUT_INVALID' }];
    await w.run(() => w.clock() - START >= 600_000);
    expect(w.head.broadcasts).toHaveLength(1);
    expect(w.youtube.calls.filter(call => call.path === '/videos')).toHaveLength(1);
    expect(w.ear.status().headRefusal).toContain('STREAM_INPUT_INVALID');
  });

  it('最初の broadcast への 503 は一時的な障害として送り直す', async () => {
    const w = world();
    w.head.start({ targetVideoId: TARGET });
    w.head.broadcastFaults = [{ when: () => true, times: 2, status: 503 }];
    await w.run(() => w.head.stream?.phase === 'live');
    expect(w.head.broadcasts).toHaveLength(3);
    expect(w.ear.status().headRefusal).toBeNull();
  });
});

describe('二度目の見直し: 拒否・指定の動画の変更・止めた時のコメント', () => {
  const A = 'AGenSh4kF9Y';
  const B = 'BGenSh4kF9Z';
  const onAirBody = (body: any) => body.onAir === true;
  const waiting = (w: ReturnType<typeof world>) => w.head.start({ phase: 'waiting_for_chat', broadcast: { onAir: false, videoId: 'vid00000001', liveChatId: 'chat-1', title: 't', channelId: 'UCowner' } });
  const changeTargetWhenLive = (w: ReturnType<typeof world>, after = 20_000) => {
    let changed = false;
    w.youtube.onPump = () => {
      if (changed || w.head.stream?.phase !== 'live' || w.clock() - START < after) return;
      changed = true;
      w.head.stream = { ...w.head.stream, targetVideoId: B };
      // The old video is over at the same moment: its end must not end the stream that is now for B.
      w.youtube.endedVideos.add(A);
    };
  };

  it('食い違いの回数は target が変わると 0 から数え直す（target が無い間に動画を 3 回拒否されて諦めた後、target がその動画になって 1 回拒否されても諦めない）', async () => {
    const w = world({ liveUrl: A });
    w.head.start({ targetVideoId: B });
    w.head.hideTargetStates = 100_000;
    await w.run(() => w.clock() - START >= 100_000);
    expect(w.head.broadcasts).toHaveLength(3);
    expect(w.logs.filter(line => line.includes('giving up on stream st-1'))).toHaveLength(1);
    // The head now says its target is A (what the ear sends), and refuses once more for a moment.
    w.head.hideTargetStates = 0;
    w.head.stream = { ...w.head.stream!, targetVideoId: A };
    w.head.broadcastFaults = [{ when: () => true, times: 1, status: 409, code: 'STREAM_VIDEO_MISMATCH' }];
    await w.run(() => w.head.stream?.phase === 'live');
    expect(w.head.broadcasts).toHaveLength(5);
    expect(w.logs.filter(line => line.includes('giving up on stream st-1'))).toHaveLength(1);
    expect(w.ear.status().headRefusal).toBeNull();
  });

  it('streamId が変わっても食い違いの回数は 0 から数え直す', async () => {
    const w = world({ liveUrl: A });
    w.head.start({ targetVideoId: B });
    w.head.hideTargetStates = 100_000;
    await w.run(() => w.clock() - START >= 100_000);
    w.head.hideTargetStates = 0;
    w.head.start({ streamId: 'st-2', targetVideoId: A });
    w.head.broadcastFaults = [{ when: () => true, times: 2, status: 409, code: 'STREAM_VIDEO_MISMATCH' }];
    await w.run(() => w.head.stream?.phase === 'live');
    expect(w.head.broadcasts.at(-1)).toMatchObject({ streamId: 'st-2', onAir: true });
  });

  it.each(['poll', 'stream'] as const)('%s: 読んでいる間に同じ streamId の指定の動画が A から B に変わったら、A の終わりで配信を終わらせず、B を探し直して取りつく', async via => {
    const w = world({ via });
    w.head.start({ targetVideoId: A });
    changeTargetWhenLive(w);
    await w.run(() => w.head.broadcasts.some(body => body.videoId === B) && w.clock() - START >= 300_000);
    expect(w.head.broadcasts.map(body => body.videoId)).toEqual([A, B]);
    expect(w.head.broadcasts.at(-1)).toMatchObject({ videoId: B, onAir: true });
    expect(w.head.ended).toEqual([]);
    expect(w.head.stream?.phase).toBe('live');
    expect(w.head.stream?.broadcast).toMatchObject({ videoId: B });
    expect(w.logs.some(line => line.includes(`target video is ${B} now`))).toBe(true);
    // B is the video looked at from then on.
    expect(w.youtube.calls.filter(call => call.path === '/videos').slice(-1)[0].query.id).toBe(B);
  });

  it('指定の動画が変わって抜ける時、頭に届いていないコメントは頭へ送ってから抜ける（捨てない）', async () => {
    const w = world();
    w.head.start({ targetVideoId: A });
    w.youtube.messages = [textItem('m1', 1), textItem('m2', 2)];
    w.head.commentsDownUntil = START + 30_000;
    changeTargetWhenLive(w, 10_000);
    await w.run(() => w.head.broadcasts.some(body => body.videoId === B) && w.clock() - START >= 300_000);
    expect(w.head.received.map(c => c.id)).toEqual(['m1', 'm2']);
    expect(w.ear.status().counters.commentsDropped).toBe(0);
    expect(w.ear.status().pending).toBe(0);
    expect(w.head.ended).toEqual([]);
  });

  it('開始の知らせが食い違いで抜ける時も、頭に届いていないコメントは頭へ送ってから抜ける', async () => {
    const w = world();
    waiting(w);
    w.youtube.messages = [textItem('m1', 1)];
    w.head.commentsDownUntil = START + 25_000;
    w.head.broadcastFaults = [{ when: onAirBody, times: 1, status: 409, code: 'STREAM_VIDEO_MISMATCH' }];
    await w.run(() => w.head.stream?.phase === 'live');
    expect(w.head.received.map(c => c.id)).toEqual(['m1']);
    const { counters, pending } = w.ear.status();
    expect(counters.commentsDropped).toBe(0);
    // Every comment taken in is accounted for (the chat's history is read again after the video is left, so m1 counts twice on both sides).
    expect(counters.commentsEligible).toBe(counters.commentsSent + counters.commentsDropped + pending);
    expect(w.head.log.indexOf('comments:1')).toBeLessThan(w.head.log.lastIndexOf('broadcast'));
  });

  it('開始の知らせが入力拒否(400)で諦める時は、待っていたコメントを捨てた件数に数えて理由をログに出す（eligible = sent + dropped + pending）', async () => {
    const w = world();
    waiting(w);
    w.youtube.messages = [textItem('m1', 1)];
    w.head.commentsDownUntil = Number.POSITIVE_INFINITY;
    w.head.broadcastFaults = [{ when: onAirBody, times: 99, status: 400, code: 'STREAM_INPUT_INVALID' }];
    await w.run(() => w.ear.status().headRefusal !== null);
    const { counters, pending } = w.ear.status();
    expect(counters.commentsEligible).toBe(1);
    expect(counters.commentsSent).toBe(0);
    expect(counters.commentsDropped).toBe(1);
    expect(pending).toBe(0);
    expect(counters.commentsEligible).toBe(counters.commentsSent + counters.commentsDropped + pending);
    expect(w.logs.some(line => line.startsWith('WARN') && line.includes('1 comments are dropped') && line.includes('STREAM_INPUT_INVALID'))).toBe(true);
  });

  it('頭が 409 STREAM_NOT_LIVE と言って読むのをやめる時も、待っていたコメントは捨てた件数に数える', async () => {
    const w = world();
    waiting(w);
    w.youtube.messages = [textItem('m1', 1)];
    w.head.commentsDownUntil = Number.POSITIVE_INFINITY;
    w.head.broadcastFaults = [{ when: onAirBody, times: 99, status: 409, code: 'STREAM_NOT_LIVE' }];
    await w.run(() => w.logs.some(line => line.includes('were still waiting')));
    const { counters, pending } = w.ear.status();
    expect(counters).toMatchObject({ commentsEligible: 1, commentsSent: 0, commentsDropped: 1 });
    expect(pending).toBe(0);
  });
});

describe('HeadStreamClient: broadcast の答えの分け方', () => {
  const clientFor = (fetcher: typeof fetch) => new HeadStreamClient({ url: HEAD, token: 'bridge-token', fetcher });
  const input = { streamId: 'st-1', videoId: 'vid00000001', liveChatId: 'chat-1', title: 't', channelId: 'UCo' };

  it.each([
    [200, {}, { status: 'ok' }],
    [409, { error: 'STREAM_NOT_LIVE' }, { status: 'not_live' }],
    [409, { error: 'STREAM_VIDEO_MISMATCH' }, { status: 'video_mismatch' }],
    [409, {}, { status: 'not_live' }],
    [409, { error: 'STREAM_ENDING' }, { status: 'unavailable' }],
    [400, { error: 'STREAM_INPUT_INVALID' }, { status: 'rejected', code: 'STREAM_INPUT_INVALID' }],
    [413, { error: 'STREAM_BODY_TOO_LARGE' }, { status: 'rejected', code: 'STREAM_BODY_TOO_LARGE' }],
    [422, {}, { status: 'rejected', code: 'HTTP_422' }],
    [401, { error: 'STREAM_PAIRING_REQUIRED' }, { status: 'unavailable' }],
    [503, {}, { status: 'unavailable' }],
  ] as const)('%s %j -> %j', async (status, body, expected) => {
    const client = clientFor(async () => json(status, body));
    expect(await client.postBroadcast(input)).toEqual(expected);
    expect(await client.postEnded('st-1')).toEqual(expected);
  });

  it('届かなければ unavailable', async () => {
    const client = clientFor(async () => { throw new TypeError('fetch failed'); });
    expect(await client.postBroadcast(input)).toEqual({ status: 'unavailable' });
  });
});
