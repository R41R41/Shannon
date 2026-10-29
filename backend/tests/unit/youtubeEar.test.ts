import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { chunkComments, classifyChatMessage, type StreamComment } from '../../src/services/youtube/ear/chatMessages.js';
import { HeadStreamClient } from '../../src/services/youtube/ear/headStreamClient.js';
import { oauthTokenProvider } from '../../src/services/youtube/ear/oauthTokenProvider.js';
import { StreamEar, videoIdOfUrl, type StreamEarOptions } from '../../src/services/youtube/ear/streamEar.js';
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

interface HeadStreamState { streamId: string; platform: 'youtube'; phase: string; startedAt: string; title: string; chatWrites: boolean; broadcast: unknown }

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
  /** A request to the head that is made while `down` throws like a refused connection. */
  fetcher: typeof fetch = async (input, init) => {
    if (this.down) throw new TypeError('fetch failed');
    const url = new URL(String(input));
    this.headers.push(new Headers(init?.headers).get('authorization'));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const route = `${init?.method ?? 'GET'} ${url.pathname}`;
    if (route === 'GET /v1/platform/stream/state') {
      this.stateCalls += 1;
      return json(200, { stream: this.stream, chatPosts: this.statePosts.shift() ?? [] });
    }
    if (route === 'POST /v1/platform/stream/broadcast') {
      if (body.ended) {
        this.log.push('ended');
        this.ended.push(body);
        if (this.stream?.streamId !== body.streamId) return json(409, { error: 'STREAM_NOT_LIVE' });
        this.stream = { ...this.stream, phase: 'ended' };
        return json(200, { stream: this.stream });
      }
      this.log.push('broadcast');
      this.broadcasts.push(body);
      if (this.stream?.streamId !== body.streamId) return json(409, { error: 'STREAM_NOT_LIVE' });
      this.stream = { ...this.stream, phase: 'live', broadcast: { videoId: body.videoId, liveChatId: body.liveChatId, title: body.title, channelId: body.channelId } };
      return json(200, { stream: this.stream });
    }
    if (route === 'POST /v1/platform/stream/comments') {
      this.commentsPosted += 1;
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
  calls: Array<{ method: string; path: string; query: Record<string, string>; auth: string | null }> = [];
  broadcasts: any[] = [{ id: 'vid00000001', snippet: { title: '配信', channelId: 'UCowner', liveChatId: 'chat-from-broadcast' }, status: { lifeCycleStatus: 'live' } }];
  /** The broadcast list answers empty this many times first (the stream has not started on YouTube yet). */
  emptyBroadcastLists = 0;
  chatId: string | undefined = 'chat-1';
  /** Errors for the next list calls: [status, reason]. */
  listErrors: Array<[number, string]> = [];
  listCalls = 0;
  /** Runs at the start of every list call (before the answer) to add messages or errors as a stream goes on. */
  onList: (call: number) => void = () => undefined;
  inserted: Array<{ text: string; liveChatId: string }> = [];
  insertFails = 0;
  firstStatus: number[] = [];

  fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const query = Object.fromEntries(url.searchParams.entries());
    const route = url.pathname.replace('/youtube/v3', '');
    this.calls.push({ method: init?.method ?? 'GET', path: route, query, auth: new Headers(init?.headers).get('authorization') });
    const forcedStatus = this.firstStatus.shift();
    if (forcedStatus) return googleError(forcedStatus, 'authError');
    if (route === '/liveBroadcasts') {
      if (this.emptyBroadcastLists > 0) { this.emptyBroadcastLists -= 1; return json(200, { items: [] }); }
      return json(200, { items: this.broadcasts });
    }
    if (route === '/videos') {
      return json(200, { items: [{ id: query.id, snippet: { title: '配信のタイトル', channelId: 'UCowner' }, liveStreamingDetails: this.chatId ? { activeLiveChatId: this.chatId } : {} }] });
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

function world(options: Partial<StreamEarOptions> = {}) {
  let now = START;
  const sleeps: number[] = [];
  const logs: string[] = [];
  const head = new FakeHead();
  const youtube = new FakeYoutube();
  const tokens: boolean[] = [];
  const meter = new ApiUnitMeter(() => now, () => undefined, () => undefined);
  const api = new YoutubeLiveApi({
    baseUrl: YT, fetcher: youtube.fetcher, meter,
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
      await tick();
    },
    log: { info: line => logs.push(line), warn: line => logs.push(`WARN ${line}`) },
    ...options,
  });
  const run = async (done: () => boolean, max = 4000) => {
    ear.start();
    for (let i = 0; i < max && !done(); i += 1) await tick();
    await ear.stop();
    if (!done()) throw new Error(`condition not reached; log: ${logs.join(' | ')}`);
  };
  return { ear, head, youtube, meter, sleeps, logs, tokens, run, clock: () => now };
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
    expect(lists[0].query).toMatchObject({ part: 'snippet,status', mine: 'true', broadcastStatus: 'active' });
    // 15 s of virtual time between two looks (state is read every 5 s in between).
    expect(w.sleeps.slice(0, 6)).toEqual([5000, 5000, 5000, 5000, 5000, 5000]);
    expect(w.head.broadcasts).toEqual([{ streamId: 'st-1', videoId: 'vid00000001', liveChatId: 'chat-1', title: '配信のタイトル', channelId: 'UCowner' }]);
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
    w.head.start({ phase: 'live', broadcast: { videoId: 'vid00000001', liveChatId: 'chat-9', title: 't', channelId: 'UCowner' } });
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
    w.head.start({ phase: 'live', broadcast: { videoId: 'vid00000001', liveChatId: 'chat-1', title: 't', channelId: 'UCowner' } });
  }

  it('follows pageToken and the polling interval YouTube returns (kept between 1 s and 10 s) and loses nothing', async () => {
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
    expect(w.sleeps.slice(0, 3)).toEqual([1000, 10_000, 3000]);
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
    expect(byId.s3).toMatchObject({ kind: 'membership', roles: ['member'] });
    expect(byId.s3.text).toContain('ベーシック');
    expect(byId.s4).toMatchObject({ kind: 'membership', text: '6か月です' });
    expect(byId.s5).toMatchObject({ kind: 'gift' });
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
    w.head.start({ phase: 'live', broadcast: { videoId: 'vid00000001', liveChatId: 'chat-1', title: 't', channelId: 'UCowner' } });
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
    w.head.start({ streamId: 'st-2', phase: 'live', broadcast: { videoId: 'vid00000001', liveChatId: 'chat-2', title: 't', channelId: 'UCowner' } });
    w.youtube.messages = [textItem('late', 40)];
    await w.run(() => w.head.received.length >= 1);
    expect(w.head.received[0].id).toBe('late');
  });
});

describe('when something fails', () => {
  function live(w: ReturnType<typeof world>) {
    w.head.start({ phase: 'live', broadcast: { videoId: 'vid00000001', liveChatId: 'chat-1', title: 't', channelId: 'UCowner' } });
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
    expect(w.sleeps.slice(0, 3)).toEqual([2000, 4000, 8000]);
    expect(w.ear.status().lastError).toContain('liveChatMessages.list');
  });

  it('a spent quota is waited out a minute at a time', async () => {
    const w = world();
    live(w);
    w.youtube.listErrors = [[403, 'quotaExceeded'], [403, 'quotaExceeded']];
    w.youtube.messages = manyTexts(1);
    await w.run(() => w.head.received.length >= 1);
    expect(w.sleeps.slice(0, 2)).toEqual([60_000, 60_000]);
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
    w.head.start({ phase: 'live', chatWrites, broadcast: { videoId: 'vid00000001', liveChatId: 'chat-1', title: 't', channelId: 'UCowner' } });
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

  it('a long stream of polling is 5 units a poll, so the interval decides the day', async () => {
    const w = world();
    w.head.start({ phase: 'live', broadcast: { videoId: 'vid00000001', liveChatId: 'chat-1', title: 't', channelId: 'UCowner' } });
    w.youtube.polling = [5000];
    await w.run(() => w.clock() - START >= 3_600_000);
    // 5 s interval: about 720 polls an hour, 5 units each.
    expect(w.meter.snapshot().totalUnits).toBeGreaterThan(3500);
    expect(w.meter.snapshot().totalUnits).toBeLessThan(3700);
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
        stream = { ...stream, phase: 'live' };
        return send(200, { stream });
      }
      if (route === 'POST /v1/platform/stream/comments') { received.push(...body.comments); return send(202, { accepted: body.comments.length, duplicates: 0, chatPosts: [] }); }
      return send(404, {});
    });
    const youtubeServer = createServer((request, response) => {
      const url = new URL(request.url ?? '', 'http://x');
      const send = (status: number, value: unknown) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
      if (url.pathname === '/youtube/v3/liveBroadcasts') return send(200, { items: [{ id: 'vid00000001', snippet: { title: 't', channelId: 'UCo' }, status: { lifeCycleStatus: 'live' } }] });
      if (url.pathname === '/youtube/v3/videos') return send(200, { items: [{ id: 'vid00000001', snippet: { title: 't', channelId: 'UCo' }, liveStreamingDetails: { activeLiveChatId: 'chat-http' } }] });
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
    } finally {
      headServer.close();
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

  it('the live reply agent, its prompt and its dispatch hooks are removed', () => {
    expect(existsSync(path.join(backend, 'src/services/llm/agents/replyYoutubeLiveCommentAgent.ts'))).toBe(false);
    expect(existsSync(path.join(backend, 'saves/prompts/others/reply_youtube_live_comment.md'))).toBe(false);
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
