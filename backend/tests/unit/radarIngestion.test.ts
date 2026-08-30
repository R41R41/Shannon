import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, writeFile, chmod, symlink, rm, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { SafeFeedHttp, SafePublicJsonHttp, MAX_FEED_BYTES, publicFeedUrl, publicIPv4 } from '../../src/services/radar/safeFeedHttp.js';
import { feedUrl, parseFeed, PublicFeedConnector } from '../../src/services/radar/feedConnector.js';
import { FeedCollector, previewCollectedFeed } from '../../src/services/radar/collectFeed.js';
import { JsonFeedRegistry } from '../../src/services/radar/jsonFeedRegistry.js';
import { snapshotSubscription, subscriptionVersion, validFeedSubscription, type FeedSubscription } from '../../src/modules/radar/sourceRegistry.js';
import { validTemporalSource, type WeatherSource, type CalendarSource } from '../../src/modules/radar/temporalSources.js';
import { WeatherReadAdapter, parseWeather, weatherRequestUrl } from '../../src/services/radar/weatherReadAdapter.js';
import { CalendarReadAdapter, parseCalendar, calendarListRequest, CALENDAR_READ_SCOPE, type CalendarBinding } from '../../src/services/radar/calendarReadAdapter.js';
import { dateAt, nextDate } from '../../src/services/radar/temporalParsing.js';
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
  body?: Buffer | string; length?: string; complete?: boolean; hang?: boolean; json?: boolean } = {}) {
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
  return { http: options.json ? new SafePublicJsonHttp(resolve, makeRequest) : new SafeFeedHttp(resolve, makeRequest), resolve, makeRequest, req, response };
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

const owner = 'firebase:' + 'a'.repeat(64);
const weatherSource = (patch: Partial<WeatherSource> = {}): WeatherSource => ({ id: 'weather', revision: 1, owner, enabled: true,
  consentExpiresAt: now + 86400000, timeZone: 'Asia/Tokyo', kind: 'weather', latitudeTenth: 357, longitudeTenth: 1397, ...patch });
const calendarSource = (patch: Partial<CalendarSource> = {}): CalendarSource => ({ id: 'calendar', revision: 1, owner, enabled: true,
  consentExpiresAt: now + 86400000, timeZone: 'Asia/Tokyo', kind: 'calendar', bindingId: 'fixture-binding', days: 3, ...patch });
const weatherBody = (s = weatherSource(), fetchedAt = now) => ({ latitude: s.latitudeTenth / 10, longitude: s.longitudeTenth / 10,
  timezone: s.timeZone, daily_units: { time: 'iso8601', weather_code: 'wmo code', temperature_2m_min: '°C', temperature_2m_max: '°C', precipitation_probability_max: '%' },
  daily: { time: [0, 1, 2].map(n => nextDate(dateAt(fetchedAt, s.timeZone), n)), weather_code: [0, 3, 61],
    temperature_2m_min: [20, 21, 22], temperature_2m_max: [30, 31, 29], precipitation_probability_max: [0, 10, 90] } });
const binding = (s = calendarSource()): CalendarBinding => ({ id: s.bindingId, owner: s.owner, sourceId: s.id, sourceRevision: s.revision,
  version: 1, calendarId: 'fixture@example.test', timeZone: s.timeZone, expiresAt: now + 100000, scopes: [CALENDAR_READ_SCOPE] });
const event = (patch: Record<string, unknown> = {}) => ({ id: 'fixture-event', status: 'confirmed', eventType: 'default', summary: 'Fixture event',
  start: { dateTime: '2026-08-28T20:00:00+09:00' }, end: { dateTime: '2026-08-28T21:00:00+09:00' }, updated: '2026-08-28T09:00:00Z', ...patch });
const calendarBody = (items: unknown[] = [event()], patch: Record<string, unknown> = {}) => ({ kind: 'calendar#events', timeZone: 'Asia/Tokyo', accessRole: 'reader', items, ...patch });
function calendarFixture(s = calendarSource()) {
  let time = now;
  const read = vi.fn(async () => JSON.stringify(calendarBody()));
  const authorize = vi.fn(async () => ({ binding: binding(s), read }));
  return { adapter: new CalendarReadAdapter({ authorize }, () => time), read, authorize, advance: (ms: number) => { time += ms; } };
}

describe('personal temporal source separation', () => {
  it('keeps weather/calendar out of public feed registry and rejects community identity', () => {
    expect(validTemporalSource(weatherSource(), now)).toBe(true); expect(validTemporalSource(calendarSource(), now)).toBe(true);
    expect(validFeedSubscription(weatherSource() as any, personal, now)).toBe(false);
    expect(validTemporalSource(weatherSource({ owner: 'discord:123' }), now)).toBe(false);
  });
  it.each([{ latitudeTenth: 35.7 }, { latitudeTenth: 901 }, { longitudeTenth: 1801 }, { timeZone: 'Mars/Unknown' },
    { enabled: false }, { consentExpiresAt: now }, { endpoint: 'https://evil.example.org' }, { token: 'secret' }])
    ('rejects unsafe weather source before network %j', async patch => {
      const http = { get: vi.fn() }; const adapter = new WeatherReadAdapter(http, () => now);
      await expect(adapter.read(weatherSource(patch), signal())).rejects.toThrow('INVALID_SOURCE'); expect(http.get).not.toHaveBeenCalled();
    });
  it.each([{ days: 0 }, { days: 8 }, { bindingId: 'https://calendar.google.com/' }, { calendarId: 'self-selected' }, { scopes: [CALENDAR_READ_SCOPE] }])
    ('rejects unsafe calendar source before broker %j', async patch => {
      const f = calendarFixture(); await expect(f.adapter.read(calendarSource(patch), signal())).rejects.toThrow('INVALID_SOURCE'); expect(f.authorize).not.toHaveBeenCalled();
    });
  it('rejects the wrong connector kind before any broker or HTTP call', async () => {
    const http = { get: vi.fn() }; const f = calendarFixture();
    await expect(new WeatherReadAdapter(http, () => now).read(calendarSource() as any, signal())).rejects.toThrow('INVALID_SOURCE');
    await expect(f.adapter.read(weatherSource() as any, signal())).rejects.toThrow('INVALID_SOURCE');
    expect(http.get).not.toHaveBeenCalled(); expect(f.authorize).not.toHaveBeenCalled();
  });
});

describe('public JSON transport and weather normalization', () => {
  it('uses JSON-only GET with the same public DNS pinning, no auth and no redirect', async () => {
    const f = httpFixture({ json: true, type: 'application/json', body: '{}' });
    expect(await f.http.get(weatherRequestUrl(weatherSource(), now), signal())).toBe('{}');
    const options = f.makeRequest.mock.calls[0][1]; expect(options.headers.accept).toBe('application/json');
    expect(options.headers).not.toHaveProperty('authorization'); expect(options.method).toBe('GET');
    const done = vi.fn(); options.lookup('api.open-meteo.com', {}, done); expect(done).toHaveBeenCalledWith(null, '8.8.8.8', 4);
  });
  it.each([{ type: 'text/html' }, { type: 'application/rss+xml' }, { encoding: 'gzip' }, { status: 302 },
    { body: Buffer.alloc(MAX_FEED_BYTES + 1) }, { addresses: ['8.8.8.8', '127.0.0.1'] }])
    ('does not weaken transport constraints for JSON %j', async options => {
      const f = httpFixture({ json: true, type: 'application/json', body: '{}', ...options });
      await expect(f.http.get(weatherRequestUrl(weatherSource(), now), signal())).rejects.toThrow();
      expect(f.makeRequest.mock.calls.length).toBeLessThanOrEqual(1);
    });
  it('requests only three days of selected daily fields and explicit coarse location/timezone without keys or identity', () => {
    const url = new URL(weatherRequestUrl(weatherSource(), now)); expect(url.origin + url.pathname).toBe('https://api.open-meteo.com/v1/forecast');
    expect(url.searchParams.get('forecast_days')).toBe('3'); expect(url.searchParams.get('latitude')).toBe('35.7');
    expect(url.searchParams.get('longitude')).toBe('139.7'); expect(url.searchParams.get('timezone')).toBe('Asia/Tokyo');
    expect(url.search).not.toMatch(/owner|firebase|key|token/);
  });
  it('preserves zero and explicit unknown values, and strips unneeded provider payload', async () => {
    const body = weatherBody(); (body.daily.temperature_2m_min as any)[1] = null;
    const http = { get: vi.fn(async () => JSON.stringify({ ...body, secret: 'DO NOT RETAIN' })) };
    const result = await new WeatherReadAdapter(http, () => now).read(weatherSource(), signal());
    expect(result).toMatchObject({ kind: 'weather', visibility: 'owner-only', owner, notify: false, partial: true, validUntil: now + 900000 });
    expect(result.items[0].precipitationPercent).toBe(0); expect(result.items[1].minimumC).toBeNull();
    expect(JSON.stringify(result)).not.toMatch(/DO NOT RETAIN|latitude|longitude|daily_units/);
    expect(result.licenseUrl).toBe('https://creativecommons.org/licenses/by/4.0/'); expect(result.attribution).toContain('Open-Meteo'); expect(Object.isFrozen(result.items[0])).toBe(true);
  });
  it.each(['units', 'date', 'length', 'code', 'temperature', 'rain', 'coordinates', 'zone', 'error'] as const)
    ('rejects invalid weather %s instead of inventing facts', kind => {
      const body = weatherBody();
      if (kind === 'units') body.daily_units.temperature_2m_min = '°F';
      if (kind === 'date') body.daily.time[0] = '2026-02-30';
      if (kind === 'length') body.daily.weather_code.pop();
      if (kind === 'code') body.daily.weather_code[0] = 999;
      if (kind === 'temperature') body.daily.temperature_2m_min[0] = 50;
      if (kind === 'rain') body.daily.precipitation_probability_max[0] = -1;
      if (kind === 'coordinates') body.latitude = 0;
      if (kind === 'zone') body.timezone = 'UTC';
      if (kind === 'error') (body as any).error = true;
      expect(() => parseWeather(JSON.stringify(body), weatherSource(), now)).toThrow('UNAVAILABLE');
    });
  it('uses local forecast dates at the Japan day boundary and rejects yesterday on late arrival', () => {
    const later = Date.parse('2026-08-28T15:00:00Z');
    const parsed = parseWeather(JSON.stringify(weatherBody(weatherSource(), later)), weatherSource(), later);
    expect(parsed[0].date).toBe('2026-08-29');
    expect(() => parseWeather(JSON.stringify(weatherBody()), weatherSource(), later)).toThrow('UNAVAILABLE');
  });
  it.each(['abort', 'expiry', 'clock'] as const)('rejects %s after weather I/O', async kind => {
    let clock = now; const c = new AbortController();
    const http = { get: vi.fn(async () => { if (kind === 'abort') c.abort(); else clock += kind === 'expiry' ? 86400000 : -1; return JSON.stringify(weatherBody()); }) };
    await expect(new WeatherReadAdapter(http, () => clock).read(weatherSource(), c.signal)).rejects.toThrow(kind === 'abort' ? 'CANCELLED' : 'DENIED');
  });
  it('bounds an uncooperative weather HTTP port without returning late data', async () => {
    vi.useFakeTimers(); let done!: (v: string) => void;
    const get = vi.fn(() => new Promise<string>(resolve => { done = resolve; }));
    const pending = expect(new WeatherReadAdapter({ get }, () => now).read(weatherSource(), signal())).rejects.toThrow('CANCELLED');
    await vi.advanceTimersByTimeAsync(8001); await pending; done(JSON.stringify(weatherBody())); await vi.advanceTimersByTimeAsync(1);
    expect(vi.getTimerCount()).toBe(0); expect(get).toHaveBeenCalledTimes(1);
  });
});

describe('Google Calendar read-only contract and personal projection', () => {
  it('requests one expanded page in a bounded window with only needed fields', async () => {
    const f = calendarFixture(); const result = await f.adapter.read(calendarSource(), signal());
    expect(f.authorize).toHaveBeenCalledTimes(2); expect(f.read).toHaveBeenCalledTimes(1);
    const request = f.read.mock.calls[0][0] as any;
    expect(request).toMatchObject({ calendarId: 'fixture@example.test', singleEvents: true, showDeleted: false, maxResults: 20, orderBy: 'startTime', eventTypes: ['default'] });
    expect(request.fields).not.toMatch(/description|attendees|location|conference|htmlLink/);
    expect(request).not.toHaveProperty('pageToken'); expect(request).not.toHaveProperty('syncToken');
    expect(Date.parse(request.timeMax) - Date.parse(request.timeMin)).toBe(3 * 86400000);
    expect(result).toMatchObject({ kind: 'calendar', owner, visibility: 'owner-only', notify: false, validUntil: now + 60000 });
  });
  it('removes private extra fields, raw event IDs and calendar identity while retaining a safe title/time', async () => {
    const f = calendarFixture(); f.read.mockResolvedValue(JSON.stringify(calendarBody([event({ summary: '<b>Meeting</b>\nname',
      description: 'PRIVATE BODY', attendees: [{ email: 'private@example.test' }], location: 'PRIVATE LOCATION',
      conferenceData: { link: 'https://meet.google.com/private' }, htmlLink: 'https://evil.example.org/' })])));
    const snapshot = await f.adapter.read(calendarSource(), signal());
    expect(snapshot.items[0]).toMatchObject({ title: 'Meeting name', when: { kind: 'timed', start: '2026-08-28T11:00:00.000Z', end: '2026-08-28T12:00:00.000Z' } });
    expect(snapshot.items[0].id).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(snapshot)).not.toMatch(/PRIVATE|private@|fixture-event|fixture@example|evil|meet.google/);
  });
  it('preserves exclusive all-day end dates without guessing UTC midnight', () => {
    const s = calendarSource(); const q = calendarListRequest(s, binding(), now);
    const result = parseCalendar(JSON.stringify(calendarBody([event({ start: { date: '2026-08-28' }, end: { date: '2026-08-30' } })])), s, q, now);
    expect(result.items[0].when).toEqual({ kind: 'all-day', startDate: '2026-08-28', endDateExclusive: '2026-08-30', timeZone: 'Asia/Tokyo' });
  });
  it('handles explicit DST offsets and includes an event that began before the window but has not ended', () => {
    const s = calendarSource({ timeZone: 'America/New_York' }); const q = calendarListRequest(s, binding(s), now);
    const page = calendarBody([event({ start: { dateTime: '2026-08-28T05:00:00-04:00' }, end: { dateTime: '2026-08-28T07:00:00-04:00' } })], { timeZone: s.timeZone });
    expect(parseCalendar(JSON.stringify(page), s, q, now).items[0].when).toMatchObject({ start: '2026-08-28T09:00:00.000Z', end: '2026-08-28T11:00:00.000Z' });
  });
  it('does not follow pagination or treat absent/cancelled entries as a deletion stream', async () => {
    const f = calendarFixture(); f.read.mockResolvedValue(JSON.stringify(calendarBody([event({ status: 'cancelled' }), event({ id: 'other', eventType: 'birthday' })], { nextPageToken: 'PRIVATE CURSOR' })));
    const snapshot = await f.adapter.read(calendarSource(), signal()); expect(snapshot.items).toEqual([]); expect(snapshot.partial).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain('PRIVATE CURSOR'); expect(f.read).toHaveBeenCalledTimes(1);
  });
  it.each([{ owner: 'firebase:' + 'b'.repeat(64) }, { sourceId: 'other' }, { sourceRevision: 2 }, { id: 'other-binding' },
    { scopes: ['https://www.googleapis.com/auth/calendar'] }, { scopes: [CALENDAR_READ_SCOPE, 'extra'] },
    { expiresAt: now }, { timeZone: 'UTC' }, { calendarId: 'https://evil.example.org/' }])
    ('rejects wrong/expired/broad binding before provider read %j', async patch => {
      const f = calendarFixture(); f.authorize.mockResolvedValue({ binding: { ...binding(), ...patch }, read: f.read });
      await expect(f.adapter.read(calendarSource(), signal())).rejects.toThrow('DENIED'); expect(f.read).not.toHaveBeenCalled();
    });
  it.each(['version', 'revoke', 'scope', 'expiry', 'calendar'] as const)('rechecks %s after provider I/O and withholds the page', async kind => {
    const f = calendarFixture();
    f.authorize.mockResolvedValueOnce({ binding: binding(), read: f.read });
    if (kind === 'revoke') f.authorize.mockRejectedValueOnce(new Error('private credential failure'));
    else f.authorize.mockResolvedValueOnce({ binding: { ...binding(), ...(kind === 'version' ? { version: 2 } : kind === 'scope' ? { scopes: [] } : kind === 'expiry' ? { expiresAt: now } : { calendarId: 'other@example.test' }) }, read: f.read });
    await expect(f.adapter.read(calendarSource(), signal())).rejects.toThrow(kind === 'revoke' ? 'UNAVAILABLE' : 'DENIED'); expect(f.read).toHaveBeenCalledTimes(1);
  });
  it.each(['mixed-date', 'invalid-day', 'no-offset', 'reverse', 'future-update', 'too-many', 'free-busy', 'wrong-zone', 'duplicate'] as const)
    ('rejects unsupported/malformed response %s', kind => {
      const page = calendarBody(); const e = page.items[0] as any;
      if (kind === 'mixed-date') e.start.date = '2026-08-28';
      if (kind === 'invalid-day') e.start = { dateTime: '2026-02-30T10:00:00Z' };
      if (kind === 'no-offset') e.start = { dateTime: '2026-08-28T20:00:00', timeZone: 'Asia/Tokyo' };
      if (kind === 'reverse') e.end = e.start;
      if (kind === 'future-update') e.updated = '2026-08-30T10:00:00Z';
      if (kind === 'too-many') page.items = Array.from({ length: 21 }, () => event());
      if (kind === 'free-busy') page.accessRole = 'freeBusyReader';
      if (kind === 'wrong-zone') page.timeZone = 'UTC';
      if (kind === 'duplicate') page.items.push(event({ summary: 'Conflicting title' }));
      expect(() => parseCalendar(JSON.stringify(page), calendarSource(), calendarListRequest(calendarSource(), binding(), now), now)).toThrow('UNAVAILABLE');
    });
  it('deduplicates identical instances but keeps distinct occurrences and hashes by owner', () => {
    const s = calendarSource(); const q = calendarListRequest(s, binding(), now);
    const page = JSON.stringify(calendarBody([event(), event(), event({ id: 'fixture-event-2' })]));
    const items = parseCalendar(page, s, q, now).items; expect(items).toHaveLength(2);
    const other = calendarSource({ owner: 'firebase:' + 'b'.repeat(64) });
    expect(parseCalendar(page, other, calendarListRequest(other, binding(other), now), now).items[0].id).not.toBe(items[0].id);
  });
  it('filters exclusive time bounds and uses a placeholder for missing title', () => {
    const s = calendarSource(); const q = calendarListRequest(s, binding(), now);
    const page = calendarBody([event({ id: 'ended', end: { dateTime: q.timeMin }, start: { dateTime: '2026-08-28T08:00:00Z' } }),
      event({ id: 'future', start: { dateTime: q.timeMax }, end: { dateTime: '2026-09-01T10:00:00Z' } }), event({ summary: undefined })]);
    const items = parseCalendar(JSON.stringify(page), s, q, now).items; expect(items).toHaveLength(1); expect(items[0].title).toBe('（無題の予定）');
  });
  it('does not parse a late response after cancellation or consent expiry', async () => {
    const f = calendarFixture(); f.read.mockImplementation(async () => { f.advance(86400000); return JSON.stringify(calendarBody()); });
    await expect(f.adapter.read(calendarSource(), signal())).rejects.toThrow('DENIED'); expect(f.authorize).toHaveBeenCalledTimes(1);
  });
  it('bounds a hanging authority call and never reads after its late result', async () => {
    vi.useFakeTimers(); const f = calendarFixture(); let finish!: (v: any) => void;
    f.authorize.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = expect(f.adapter.read(calendarSource(), signal())).rejects.toThrow('CANCELLED');
    await vi.advanceTimersByTimeAsync(8001); await pending; finish({ binding: binding(), read: f.read }); await vi.advanceTimersByTimeAsync(1);
    expect(f.read).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
});

describe('temporal edge cases and cancellation', () => {
  it.each(['not-json', '[]', '{"error":"private"}', JSON.stringify({ oversized: 'x'.repeat(256 * 1024) })])
    ('rejects invalid/oversized provider text %# without returning private details', text => {
      expect(() => parseWeather(text, weatherSource(), now)).toThrow('UNAVAILABLE');
      expect(() => parseCalendar(text, calendarSource(), calendarListRequest(calendarSource(), binding(), now), now)).toThrow('UNAVAILABLE');
    });
  it('keeps tentative status rather than presenting it as confirmed', async () => {
    const f = calendarFixture(); f.read.mockResolvedValue(JSON.stringify(calendarBody([event({ status: 'tentative' })])));
    expect((await f.adapter.read(calendarSource(), signal())).items[0].status).toBe('tentative');
  });
  it('preserves an hour across the autumn DST repeated hour', () => {
    const autumn = Date.parse('2026-11-01T04:00:00Z');
    const s = calendarSource({ timeZone: 'America/New_York', consentExpiresAt: autumn + 86400000 });
    const b = { ...binding(s), expiresAt: autumn + 100000 };
    const q = calendarListRequest(s, b, autumn);
    const page = calendarBody([event({ updated: '2026-11-01T03:00:00Z', start: { dateTime: '2026-11-01T01:30:00-04:00' }, end: { dateTime: '2026-11-01T01:30:00-05:00' } })], { timeZone: s.timeZone });
    const when = parseCalendar(JSON.stringify(page), s, q, autumn).items[0].when;
    expect(when).toEqual({ kind: 'timed', start: '2026-11-01T05:30:00.000Z', end: '2026-11-01T06:30:00.000Z' });
  });
  it('excludes an all-day event starting exactly at the upper local-midnight boundary', () => {
    const midnight = Date.parse('2026-08-28T15:00:00Z'); const s = calendarSource({ days: 1 });
    const q = calendarListRequest(s, { ...binding(s), expiresAt: midnight + 100000 }, midnight);
    const page = calendarBody([event({ start: { date: '2026-08-30' }, end: { date: '2026-08-31' } })]);
    expect(parseCalendar(JSON.stringify(page), s, q, midnight).items).toEqual([]);
  });
  it('does not contact weather or calendar services for a pre-cancelled operation', async () => {
    const c = new AbortController(); c.abort(); const f = calendarFixture(); const get = vi.fn();
    await expect(f.adapter.read(calendarSource(), c.signal)).rejects.toThrow('CANCELLED');
    await expect(new WeatherReadAdapter({ get }, () => now).read(weatherSource(), c.signal)).rejects.toThrow('CANCELLED');
    expect(f.authorize).not.toHaveBeenCalled(); expect(get).not.toHaveBeenCalled();
  });
  it('cannot return a calendar page after cancellation during provider I/O', async () => {
    const f = calendarFixture(); const c = new AbortController();
    f.read.mockImplementation(async () => { c.abort(); return JSON.stringify(calendarBody()); });
    await expect(f.adapter.read(calendarSource(), c.signal)).rejects.toThrow('CANCELLED'); expect(f.authorize).toHaveBeenCalledTimes(1);
  });
});
