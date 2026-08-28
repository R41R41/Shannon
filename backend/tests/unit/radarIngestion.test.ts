import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, writeFile, chmod, symlink, rm, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { SafeFeedHttp, MAX_FEED_BYTES, publicFeedUrl, publicIPv4 } from '../../src/services/radar/safeFeedHttp.js';
import { feedUrl, parseFeed, PublicFeedConnector } from '../../src/services/radar/feedConnector.js';
import { FeedCollector, previewCollectedFeed } from '../../src/services/radar/collectFeed.js';
import { JsonFeedRegistry } from '../../src/services/radar/jsonFeedRegistry.js';
import { snapshotSubscription, subscriptionVersion, validFeedSubscription, type FeedSubscription } from '../../src/modules/radar/sourceRegistry.js';
import type { RadarAudience } from '../../src/modules/radar/content.js';

const now = Date.parse('2026-08-28T10:00:00Z');
const personal: RadarAudience = { kind: 'personal', subjectId: 'discord:300' };
const signal = () => new AbortController().signal;
const channel = 'UCabcdefghijklmnopqrstuv';
const source = (patch: Partial<FeedSubscription> = {}): FeedSubscription => ({ id: 'source-1', revision: 1, audience: personal,
  enabled: true, consentExpiresAt: now + 86400000, kind: 'web', locator: 'https://news.example.org/feed.xml',
  articleHosts: ['news.example.org'], topicIds: ['nintendo'], maxItems: 3, retentionMs: 86400000, ...patch });
const youtube = () => source({ kind: 'youtube', locator: channel, articleHosts: ['www.youtube.com'] });
const rssItem = (title = '新作の情報', url = 'https://news.example.org/a', date = 'Fri, 28 Aug 2026 09:00:00 GMT') =>
  `<item><guid>${url}</guid><title>${title}</title><link>${url.replace(/&/g, '&amp;')}</link><pubDate>${date}</pubDate><description>DO NOT STORE THIS</description></item>`;
const rss = (items = rssItem()) => `<rss version="2.0"><channel><title>Fixture feed</title>${items}</channel></rss>`;
const atom = (channelId = channel, videoId = 'abcdefghijk') => `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:yt="http://www.youtube.com/xml/schemas/2015"><entry>
  <id>yt:video:${videoId}</id><yt:videoId>${videoId}</yt:videoId><yt:channelId>${channelId}</yt:channelId><title>研究の紹介動画</title>
  <published>2026-08-28T09:00:00Z</published><updated>2026-08-28T09:10:00Z</updated><link rel="alternate" href="http://malicious.example/ignored"/>
  </entry></feed>`;
afterEach(() => { vi.useRealTimers(); });

describe('read-only source registry contracts', () => {
  it('snapshots subscription and captures every policy field in the version', () => {
    const original = source(); const snap = snapshotSubscription(original);
    (original.topicIds as string[]).push('trpg');
    expect(snap.topicIds).toEqual(['nintendo']); expect(Object.isFrozen(snap.audience)).toBe(true);
    expect(subscriptionVersion(source({ maxItems: 1 }))).not.toBe(subscriptionVersion(source()));
    expect(validFeedSubscription(snap, personal, now)).toBe(true);
  });
  it.each([
    { enabled: false }, { revision: 0 }, { consentExpiresAt: now }, { retentionMs: Infinity }, { retentionMs: 8 * 86400000 },
    { maxItems: 0 }, { maxItems: 21 }, { articleHosts: [] }, { articleHosts: ['*.example.org'] },
    { locator: 'file:///etc/passwd' }, { kind: 'calendar' }, { kind: 'weather' }, { topicIds: [''] },
    { audience: { kind: 'personal', subjectId: 'other' } },
  ])('rejects unavailable, private or malformed registry input %j', patch => {
    expect(validFeedSubscription(source(patch as Partial<FeedSubscription>), personal, now)).toBe(false);
  });
  it('only builds the selected YouTube channel feed and rejects signed Web endpoints', () => {
    expect(feedUrl(youtube())).toBe(`https://www.youtube.com/feeds/videos.xml?channel_id=${channel}`);
    expect(() => feedUrl(source({ locator: 'https://news.example.org/feed?token=secret' }))).toThrow('TARGET');
    expect(validFeedSubscription(youtube(), personal, now)).toBe(true);
    expect(validFeedSubscription({ ...youtube(), articleHosts: ['evil.example.org'] }, personal, now)).toBe(false);
  });
});

describe('feed target and DNS boundaries', () => {
  it.each(['http://news.example.org/feed', 'file:///etc/passwd', 'https://u:p@news.example.org/', 'https://127.0.0.1/',
    'https://2130706433/', 'https://0x7f000001/', 'https://[::1]/', 'https://news.example.org:444/feed',
    'https://news.example.org/feed#x', 'https://localhost/', 'https://service.internal/feed', 'https://news.example.org/\nfoo',
    'https://news.example.org\\@127.0.0.1/', 'not-a-url'])('rejects URL %s before network', url => {
    expect(() => publicFeedUrl(url)).toThrow('TARGET');
  });
  it.each(['0.1.2.3', '10.1.2.3', '100.64.0.1', '100.127.255.255', '127.0.0.1', '169.254.169.254',
    '172.16.0.1', '172.31.255.255', '192.168.1.1', '192.0.0.1', '192.0.2.1', '192.88.99.1',
    '198.18.0.1', '198.19.255.255', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255',
    '168.63.129.16', '::ffff:127.0.0.1', '2606:4700::1111', 'not-ip'])('rejects private/reserved/unsupported IP %s', ip => {
    expect(publicIPv4(ip)).toBe(false);
  });
  it.each(['1.1.1.1', '8.8.8.8', '100.128.0.1', '172.32.0.1'])('accepts a global IPv4 address %s', ip => expect(publicIPv4(ip)).toBe(true));
});

function httpFixture(options: { addresses?: readonly string[]; status?: number; type?: string; encoding?: string;
  body?: Buffer | string; length?: string; complete?: boolean; hang?: boolean } = {}) {
  const resolve = vi.fn(async () => options.addresses ?? ['8.8.8.8']);
  const response = Object.assign(new PassThrough(), { statusCode: options.status ?? 200, complete: options.complete ?? true,
    headers: { 'content-type': options.type ?? 'application/rss+xml; charset=utf-8', 'content-encoding': options.encoding, 'content-length': options.length } });
  const req = Object.assign(new EventEmitter(), { destroy: vi.fn(), end: vi.fn() });
  const makeRequest = vi.fn((_url, _options, callback: (r: IncomingMessage) => void) => {
    req.end.mockImplementation(() => queueMicrotask(() => {
      callback(response as unknown as IncomingMessage);
      if (!options.hang && !response.destroyed) response.end(options.body ?? rss());
    }));
    return req as unknown as ClientRequest;
  });
  return { http: new SafeFeedHttp(resolve, makeRequest), resolve, makeRequest, req, response };
}
describe('bounded public HTTPS adapter', () => {
  it('pins vetted DNS, validates TLS, issues GET only, and sends no cookies/authorization', async () => {
    const f = httpFixture();
    expect(f.resolve).not.toHaveBeenCalled(); expect(f.makeRequest).not.toHaveBeenCalled();
    expect(await f.http.get(source().locator, signal())).toContain('<rss');
    const options = f.makeRequest.mock.calls[0][1];
    expect(options).toMatchObject({ method: 'GET', agent: false, family: 4, servername: 'news.example.org', rejectUnauthorized: true });
    expect(options.headers).not.toHaveProperty('authorization'); expect(options.headers).not.toHaveProperty('cookie');
    const done = vi.fn(); options.lookup('news.example.org', {}, done); expect(done).toHaveBeenCalledWith(null, '8.8.8.8', 4);
  });
  it.each([[], ['127.0.0.1'], ['8.8.8.8', '169.254.169.254']].map(addresses => ({ addresses })))('rejects mixed/empty/non-public DNS without opening socket %j', async ({ addresses }) => {
    const f = httpFixture({ addresses }); await expect(f.http.get(source().locator, signal())).rejects.toThrow('DNS');
    expect(f.makeRequest).not.toHaveBeenCalled();
  });
  it.each([301, 302, 307, 308, 401, 429, 500])('does not follow redirects or retry HTTP %s', async status => {
    const f = httpFixture({ status }); await expect(f.http.get(source().locator, signal())).rejects.toThrow('HTTP');
    expect(f.makeRequest).toHaveBeenCalledTimes(1);
  });
  it.each([{ type: 'text/html' }, { type: 'application/json' }, { encoding: 'gzip' }, { body: Buffer.from([0xff]) }])('rejects unsuitable/encoded content %j', async options => {
    await expect(httpFixture(options).http.get(source().locator, signal())).rejects.toThrow('FORMAT');
  });
  it.each([{ length: String(MAX_FEED_BYTES + 1) }, { body: Buffer.alloc(MAX_FEED_BYTES + 1) }])('enforces declared and streamed size %#', async options => {
    await expect(httpFixture(options).http.get(source().locator, signal())).rejects.toThrow('SIZE');
  });
  it('rejects incomplete response and sanitizes network error details', async () => {
    await expect(httpFixture({ complete: false }).http.get(source().locator, signal())).rejects.toThrow('NETWORK');
    const h = new SafeFeedHttp(async () => { throw new Error('secret-token'); });
    await expect(h.get(source().locator, signal())).rejects.toThrow(/^RADAR_FEED_NETWORK$/);
  });
  it('aborts before DNS, during DNS, and during body, without retry', async () => {
    const c = new AbortController(); c.abort(); const f = httpFixture();
    await expect(f.http.get(source().locator, c.signal)).rejects.toThrow('ABORTED'); expect(f.resolve).not.toHaveBeenCalled();
    const c2 = new AbortController(); const dns = new SafeFeedHttp(() => new Promise(() => {}));
    const pending = dns.get(source().locator, c2.signal); c2.abort(); await expect(pending).rejects.toThrow('ABORTED');
    const c3 = new AbortController(); const body = httpFixture({ hang: true }); const pendingBody = body.http.get(source().locator, c3.signal);
    await vi.waitFor(() => expect(body.req.end).toHaveBeenCalled()); c3.abort();
    await expect(pendingBody).rejects.toThrow('ABORTED'); expect(body.req.destroy).toHaveBeenCalled();
  });
  it('has an overall deadline including stuck DNS', async () => {
    vi.useFakeTimers(); const h = new SafeFeedHttp(() => new Promise(() => {}));
    const pending = expect(h.get(source().locator, signal())).rejects.toThrow('TIMEOUT');
    await vi.advanceTimersByTimeAsync(8001); await pending;
  });
});

describe('RSS/Atom provenance normalization', () => {
  it('returns bounded immutable metadata without raw descriptions and deduplicates tracking URLs', () => {
    const rows = parseFeed(rss(rssItem() + rssItem('別タイトル', 'https://news.example.org/a?utm_source=x')), source(), now);
    expect(rows).toHaveLength(1); expect(rows[0].content).toMatchObject({ sourceKind: 'web', visibility: 'public', novelty: 0 });
    expect(rows[0].provenance).toMatchObject({ sourceRevision: 1, fetchedUrl: source().locator, fetchedAt: now });
    expect(JSON.stringify(rows)).not.toContain('DO NOT STORE'); expect(Object.isFrozen(rows[0].content.topicIds)).toBe(true);
  });
  it('makes retry IDs stable, changed versions distinct, and retains canonical cluster', () => {
    const a = parseFeed(rss(), source(), now)[0]; const retry = parseFeed(rss(), source(), now + 1)[0];
    const changed = parseFeed(rss(rssItem('更新タイトル')), source(), now)[0];
    expect(a.content.id).toBe(retry.content.id); expect(a.content.id).not.toBe(changed.content.id);
    expect(a.content.clusterId).toBe(changed.content.clusterId); expect(a.provenance.entityKey).toBe(changed.provenance.entityKey);
  });
  it('validates YouTube channel/video identity instead of following entry-provided links', () => {
    expect(parseFeed(atom(), youtube(), now)[0].content.sourceUrl).toBe('https://www.youtube.com/watch?v=abcdefghijk');
    expect(parseFeed(atom('UCzyxwvutsrqponmlkjihgfe'), youtube(), now)).toEqual([]);
    expect(parseFeed(atom(channel, 'bad-id'), youtube(), now)).toEqual([]);
  });
  it('supports selected Web Atom feeds', () => {
    const xml = '<feed><entry><id>one</id><title>公式のお知らせ</title><link rel="alternate" href="https://news.example.org/a"/><published>2026-08-28T09:00:00Z</published></entry></feed>';
    expect(parseFeed(xml, source(), now)).toHaveLength(1);
  });
  it.each(['https://evil.example.org/a', 'http://news.example.org/a', 'https://127.0.0.1/a', 'https://u:p@news.example.org/a',
    'https://news.example.org/a?access_token=secret', 'https://news.example.org/a?X-Amz-Credential=secret',
    'https://news.example.org/a?api_key=secret', 'https://news.example.org/a?signature=secret'])('does not expose unapproved article link %s', url => {
    expect(parseFeed(rss(rssItem('title', url)), source(), now)).toEqual([]);
  });
  it.each(['bad-date', 'Fri, 28 Aug 2026 11:00:00 GMT', 'Wed, 26 Aug 2026 09:00:00 GMT'])('does not invent timestamps or extend stale content %s', date => {
    expect(parseFeed(rss(rssItem('title', undefined, date)), source(), now)).toEqual([]);
  });
  it.each(['<!DOCTYPE rss SYSTEM "file:///etc/passwd"><rss/>', '<!ENTITY x "secret"><rss/>', '<html><body>no</body></html>', '\u0000<rss/>'])('rejects hostile/unrelated feed syntax %s', xml => {
    expect(() => parseFeed(xml, source(), now)).toThrow('FORMAT');
  });
  it('bounds entries and consent expiry and gives no claim of novelty or article truth', () => {
    const rows = parseFeed(rss(rssItem() + rssItem('second', 'https://news.example.org/b')), source({ maxItems: 1, consentExpiresAt: now + 10 }), now);
    expect(rows).toHaveLength(1); expect(rows[0].content.expiresAt).toBe(now + 10); expect(rows[0].content.fact).toContain('フィード');
    expect(() => parseFeed('x'.repeat(MAX_FEED_BYTES + 1), source(), now)).toThrow('SIZE');
  });
});

describe('collection and personal digest pipeline', () => {
  it('runs registry -> read-only connector -> provenance -> rank/policy -> private digest preview', async () => {
    const registry = { get: vi.fn(async () => source()) }; const http = { get: vi.fn(async () => rss()) };
    const collector = new FeedCollector(registry, new PublicFeedConnector(http, () => now), () => now);
    const result = await collector.collect('source-1', personal, signal());
    expect(result.status).toBe('collected'); expect(registry.get).toHaveBeenCalledTimes(2); expect(http.get).toHaveBeenCalledTimes(1);
    const p = { audience: personal, revision: 1, enabled: true, allowedSourceIds: ['source-1'], minimumScore: 0.5,
      maxPerHour: 0, maxPerDay: 0, minimumGapMs: 0, maxDigestItems: 3 };
    const ctx = { now, focusMode: true, quietUntil: now + 1, usedThisHour: 0, usedToday: 0, lastDeliveryAt: null, deliveredOrReservedClusterIds: [] };
    const cards = previewCollectedFeed(result, p, ctx, [{ topicId: 'nintendo', weight: 1 }]);
    expect(cards).toHaveLength(1); expect(cards[0]).toMatchObject({ notify: false, mentions: 'none', thread: 'none' });
    expect(previewCollectedFeed(result, { ...p, audience: { kind: 'personal', subjectId: 'other' } }, ctx, [])).toEqual([]);
    expect(result.audit).toMatchObject({ outcome: 'collected', count: 1 }); expect(JSON.stringify(result.audit)).not.toContain('title');
  });
  it.each([null, source({ enabled: false }), source({ id: 'wrong' }), source({ audience: { kind: 'personal', subjectId: 'other' } })])('does no external read for denied registry %#', async stored => {
    const connector = { read: vi.fn(async () => []) };
    expect((await new FeedCollector({ get: async () => stored }, connector, () => now).collect('source-1', personal, signal())).status).toBe('denied');
    expect(connector.read).not.toHaveBeenCalled();
  });
  it.each([source({ enabled: false }), source({ revision: 2 }), source({ maxItems: 2 }), source({ consentExpiresAt: now }), null])('discards in-flight output after source revocation/change %#', async next => {
    const get = vi.fn().mockResolvedValueOnce(source()).mockResolvedValueOnce(next);
    const result = await new FeedCollector({ get }, new PublicFeedConnector({ get: async () => rss() }, () => now), () => now).collect('source-1', personal, signal());
    expect(result).toMatchObject({ status: 'denied', records: [] });
  });
  it('cancels late results and never includes provider errors/secrets in audit', async () => {
    const c = new AbortController();
    const result = await new FeedCollector({ get: async () => source() }, { read: async () => { c.abort(); return []; } }, () => now).collect('source-1', personal, c.signal);
    expect(result.status).toBe('cancelled');
    const fail = await new FeedCollector({ get: async () => source() }, { read: async () => { throw new Error('token-private-url'); } }, () => now).collect('source-1', personal, signal());
    expect(fail.status).toBe('failed'); expect(JSON.stringify(fail)).not.toContain('token');
  });
  it('rejects a connector returning records from a different source', async () => {
    const wrong = parseFeed(rss(), source({ id: 'wrong' }), now);
    const result = await new FeedCollector({ get: async () => source() }, { read: async () => wrong }, () => now).collect('source-1', personal, signal());
    expect(result).toMatchObject({ status: 'failed', records: [] });
  });
  it('records receipt time and rechecks consent after a delayed download', async () => {
    let time = now;
    const connector = new PublicFeedConnector({ get: async () => { time += 100; return rss(); } }, () => time);
    expect((await connector.read(source(), signal()))[0].provenance.fetchedAt).toBe(now + 100);
    time = now;
    await expect(connector.read(source({ consentExpiresAt: now + 50 }), signal())).rejects.toThrow('TARGET');
  });
});

describe('private JSON source registry adapter', () => {
  async function withRegistry(run: (path: string, registry: JsonFeedRegistry) => Promise<void>) {
    const dir = await mkdtemp(join(tmpdir(), 'radar-registry-'));
    const path = join(dir, 'sources.json');
    try {
      await writeFile(path, JSON.stringify([source()]), { mode: 0o600 });
      await run(path, new JsonFeedRegistry(path, () => now));
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
  it('reads only the exact audience and observes an atomic revocation while a feed is in flight', async () => {
    await withRegistry(async (path, registry) => {
      expect((await registry.get('source-1', personal))?.id).toBe('source-1');
      expect(await registry.get('source-1', { kind: 'personal', subjectId: 'other' })).toBeNull();
      const connector = new PublicFeedConnector({ get: async () => {
        await writeFile(path + '.next', JSON.stringify([source({ enabled: false })]), { mode: 0o600 });
        await rename(path + '.next', path); return rss();
      } }, () => now);
      expect((await new FeedCollector(registry, connector, () => now).collect('source-1', personal, signal())).status).toBe('denied');
    });
  });
  it('fails closed on ambiguous records and malformed or oversized files', async () => {
    await withRegistry(async (path, registry) => {
      await writeFile(path, JSON.stringify([source(), source()])); expect(await registry.get('source-1', personal)).toBeNull();
      await writeFile(path, '{broken-secret'); await expect(registry.get('source-1', personal)).rejects.toThrow(/^RADAR_REGISTRY_UNAVAILABLE$/);
      await writeFile(path, ' '.repeat(65537)); await expect(registry.get('source-1', personal)).rejects.toThrow('UNAVAILABLE');
    });
  });
  it('refuses broadly readable or symlinked configuration', async () => {
    await withRegistry(async (path, registry) => {
      await chmod(path, 0o644); await expect(registry.get('source-1', personal)).rejects.toThrow('UNAVAILABLE');
      await chmod(path, 0o600); await symlink(path, path + '.link');
      await expect(new JsonFeedRegistry(path + '.link', () => now).get('source-1', personal)).rejects.toThrow();
    });
  });
});
