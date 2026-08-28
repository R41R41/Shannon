import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { createRadarClient, decodeSources, decodePreview, decodeAudit, safeRadarLink, sourceInput, RadarClientError,
  type SourcesSnapshot, type PreviewSnapshot, type AuditSnapshot } from '../src/features/radar/radarClient';
import { RadarController } from '../src/features/radar/radarController';
import { RadarDashboard } from '../src/features/radar/RadarDashboard';
import { SourceEditor } from '../src/features/radar/SourceEditor';
import { StandaloneRadarSession, type RadarIdentityUser } from '../src/features/radar/standaloneSession';
import { StandaloneRadarApp } from '../src/features/radar/StandaloneRadarApp';

const now = 1800000000000;
const input = { enabled: true, consentExpiresAt: now + 86400000, kind: 'web' as const, locator: 'https://example.org/feed',
  articleHosts: ['example.org'], topicIds: ['science'], maxItems: 10, retentionMs: 86400000 };
const rawSources = () => ({ revision: 4, collectionAvailable: true, sources: [{ id: 'science', source: { ...input, id: 'science', revision: 2,
  audience: { kind: 'personal', subjectId: 'private-owner' }, irrelevant: 'secret' } }], audit: [{ private: 'secret' }] });
const rawPreview = () => ({ revision: 4, notify: false as const, servedAt: now, validUntil: now + 120000,
  items: [{ contentId: 'c1', sourceId: 'science', sourceRevision: 2, score: 0.6, matchedTopicIds: ['science'], card: {
    title: 'Fixture science <script>alert(1)</script>', fact: '登録ソースの掲載情報です。', sourceUrl: 'https://example.org/article', metadata: ['2026-08-28'], tags: ['science'],
    mentions: 'none' as const, notify: false as const, thread: 'none' as const } }] });
const rawAudit = (revision = 4) => ({ revision, omittedThroughRevision: revision, completeFromRevisionOne: revision === 0, retentionMs: 604800000, capacity: 64, servedAt: now, validUntil: now + 60000, events: [] });
function fixture() {
  vi.useFakeTimers(); let time = 0; let current = true;
  const api = { sources: vi.fn(async () => decodeSources(rawSources())), preview: vi.fn(async () => decodePreview(rawPreview())),
    audit: vi.fn(async () => decodeAudit(rawAudit())), collect: vi.fn(async () => ({ revision: 6 })),
    save: vi.fn(async () => ({ revision: 5 })), revoke: vi.fn(async () => ({ revision: 5 })) };
  const controller = new RadarController(api, () => current, () => time); controller.activate();
  return { api, controller, moveClock: (ms: number) => { time += ms; }, invalidate: () => { current = false; } };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('Radar DTO and transport boundary', () => {
  it('drops owner/audit/unknown fields instead of exposing full backend objects', () => {
    expect(JSON.stringify(decodeSources(rawSources()))).not.toMatch(/secret|private-owner|audience|audit/);
    expect(decodePreview(rawPreview()).items).toHaveLength(1);
  });
  it.each(['http://example.org', 'javascript:alert(1)', '//other.org', 'https://user:pass@example.org/', 'https://127.0.0.1/',
    'https://example.org/#private', 'https://example.org:444/', 'https://local.internal/', 'https://example.org/\nprivate'])('refuses unsafe link %s', url => {
    expect(safeRadarLink(url)).toBe(false);
  });
  it.each([{ kind: 'calendar' }, { kind: 'weather' }, { maxItems: 21 }, { articleHosts: [] }, { topicIds: ['private topic'] },
    { locator: 'https://example.org/feed?token=secret' }, { kind: 'youtube', locator: 'UCinvalid' }, { retentionMs: -1 }])('rejects bad source configuration %j', patch => {
    expect(() => sourceInput({ ...input, ...patch })).toThrow(RadarClientError);
  });
  it.each(['duplicates', 'mismatch', 'too-many', 'bad-revision'] as const)('rejects invalid source envelope %s', kind => {
    const raw = rawSources();
    if (kind === 'duplicates') raw.sources.push(raw.sources[0]);
    if (kind === 'mismatch') raw.sources[0].source.id = 'different';
    if (kind === 'too-many') raw.sources = Array.from({ length: 33 }, (_, n) => ({ ...raw.sources[0], id: `s${n}` }));
    if (kind === 'bad-revision') raw.revision = -1;
    expect(() => decodeSources(raw)).toThrow(RadarClientError);
  });
  it.each(['expired', 'missing-server-time', 'too-many', 'duplicate', 'unsafe-link', 'notify', 'mentions', 'score'] as const)('rejects invalid preview %s', kind => {
    const raw = rawPreview();
    if (kind === 'expired') raw.validUntil = now;
    if (kind === 'missing-server-time') delete (raw as any).servedAt;
    if (kind === 'too-many') raw.items = Array(4).fill(raw.items[0]);
    if (kind === 'duplicate') raw.items.push(raw.items[0]);
    if (kind === 'unsafe-link') raw.items[0].card.sourceUrl = 'javascript:alert(1)';
    if (kind === 'notify') (raw as any).notify = true;
    if (kind === 'mentions') (raw.items[0].card as any).mentions = 'everyone';
    if (kind === 'score') raw.items[0].score = NaN;
    expect(() => decodePreview(raw)).toThrow(RadarClientError);
  });
  it('uses only fixed same-origin endpoints and exact CAS input, without a publication endpoint', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ revision: 5 })));
    const client = createRadarClient(fetcher); const signal = new AbortController().signal;
    await client.save('science', 4, input, signal);
    const [path, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe('/api/radar/sources/science'); expect(options.method).toBe('PUT');
    expect(JSON.parse(String(options.body))).toEqual({ expectedRevision: 4, source: input }); expect(options.cache).toBe('no-store');
    await client.revoke('science', 4, signal); expect((fetcher.mock.calls[1] as any)[1].method).toBe('DELETE');
    await expect(client.save('../other', 4, input, signal)).rejects.toThrow('invalid'); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it.each([[401, 'authorization'], [403, 'authorization'], [409, 'conflict'], [400, 'invalid'], [404, 'unavailable'], [503, 'unavailable'], [500, 'network']])('maps %s without surfacing raw error data', async (status, code) => {
    const client = createRadarClient(async () => new Response('sensitive diagnostic', { status: Number(status) }));
    await expect(client.sources(new AbortController().signal)).rejects.toMatchObject({ code });
  });
  it('rejects oversized and non-JSON responses, and never auto retries', async () => {
    const fetcher = vi.fn(async () => new Response('x'.repeat(131073))); const client = createRadarClient(fetcher);
    await expect(client.sources(new AbortController().signal)).rejects.toThrow(); expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('session-owned Radar controller', () => {
  it('performs three explicit reads, exposes consistent snapshots and does not poll', async () => {
    const f = fixture(); await f.controller.load(); expect(f.controller.getSnapshot().status).toBe('ready');
    expect(f.controller.isReadable()).toBe(true); const state = f.controller.getSnapshot(); expect(f.controller.getSnapshot()).toBe(state);
    await vi.advanceTimersByTimeAsync(60001); expect(f.controller.getSnapshot().data).toBeNull();
    expect(f.api.sources).toHaveBeenCalledTimes(1); expect(f.api.preview).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
  it('expires relative to server time minus round-trip elapsed, without client wall-clock assumptions', async () => {
    const f = fixture(); f.api.preview.mockImplementation(async () => { f.moveClock(400); return { ...decodePreview(rawPreview()), validUntil: now + 1000 }; });
    await f.controller.load(); await vi.advanceTimersByTimeAsync(599); expect(f.controller.getSnapshot().status).toBe('ready');
    await vi.advanceTimersByTimeAsync(1); expect(f.controller.getSnapshot().status).toBe('expired');
  });
  it('refuses content already expired by receipt', async () => {
    const f = fixture(); f.api.preview.mockImplementation(async () => { f.moveClock(200000); return decodePreview(rawPreview()); });
    await f.controller.load(); expect(f.controller.getSnapshot().status).toBe('expired');
  });
  it.each(['revision', 'source-revision', 'host', 'disabled'] as const)('rejects inconsistent preview boundary %s', async kind => {
    const f = fixture(); const preview = decodePreview(rawPreview()); const sources = decodeSources(rawSources());
    if (kind === 'revision') preview.revision++;
    if (kind === 'source-revision') preview.items[0].sourceRevision++;
    if (kind === 'host') preview.items[0].card.sourceUrl = 'https://other.org/article';
    if (kind === 'disabled') sources.sources[0].source!.enabled = false;
    f.api.preview.mockResolvedValue(preview); f.api.sources.mockResolvedValue(sources);
    await f.controller.load(); expect(f.controller.getSnapshot().data).toBeNull(); expect(f.controller.getSnapshot().status).toBe('error');
  });
  it('erases ready content synchronously when refreshing and rejects a late previous response', async () => {
    const f = fixture(); await f.controller.load(); let release!: (value: SourcesSnapshot) => void;
    f.api.sources.mockImplementationOnce(() => new Promise(r => { release = r; }));
    const old = f.controller.load(); expect(f.controller.getSnapshot().data).toBeNull();
    await f.controller.load(); const fresh = f.controller.getSnapshot(); release({ revision: 99, sources: [] }); await old;
    expect(f.controller.getSnapshot()).toBe(fresh); expect(f.api.preview).toHaveBeenCalledTimes(2);
  });
  it.each(['logout', 'hidden', 'session-change'] as const)('rejects pending content after %s', async kind => {
    const f = fixture(); let release!: (v: PreviewSnapshot) => void; let entered!: () => void;
    const started = new Promise<void>(r => { entered = r; });
    f.api.preview.mockImplementationOnce(() => new Promise(r => { release = r; entered(); }));
    const pending = f.controller.load(); await started;
    if (kind === 'logout') f.controller.stop(); else if (kind === 'hidden') f.controller.visibility(false); else f.invalidate();
    release(decodePreview(rawPreview())); await pending; expect(f.controller.getSnapshot().data).toBeNull(); expect(f.controller.isReadable()).toBe(false);
  });
  it('resumes after StrictMode setup/cleanup without letting old work overwrite the next generation', async () => {
    const f = fixture(); f.controller.stop(); f.controller.activate(); await f.controller.load(); expect(f.controller.getSnapshot().status).toBe('ready');
    f.controller.stop(); expect(vi.getTimerCount()).toBe(0);
  });
  it('requires a manual read after returning to the page', async () => {
    const f = fixture(); await f.controller.load(); f.controller.visibility(false); expect(f.controller.getSnapshot().data).toBeNull();
    await f.controller.load(); expect(f.api.sources).toHaveBeenCalledTimes(1);
    f.controller.visibility(true); expect(f.controller.getSnapshot().status).toBe('expired'); expect(f.api.sources).toHaveBeenCalledTimes(1);
    await f.controller.load(); expect(f.controller.getSnapshot().status).toBe('ready');
  });
  it('clears data before mutation, sends one CAS write, then reads back', async () => {
    const f = fixture(); await f.controller.load(); let saved!: (v: { revision: number }) => void;
    f.api.save.mockImplementationOnce(() => new Promise(r => { saved = r; }));
    const pending = f.controller.save('science', input); expect(f.controller.getSnapshot()).toMatchObject({ status: 'saving', data: null });
    await f.controller.save('science', input); await f.controller.load(); expect(f.api.save).toHaveBeenCalledTimes(1);
    f.api.sources.mockResolvedValue({ ...decodeSources(rawSources()), revision: 5 });
    f.api.preview.mockResolvedValue({ ...decodePreview(rawPreview()), revision: 5, items: [] });
    f.api.audit.mockResolvedValue(decodeAudit(rawAudit(5)));
    saved({ revision: 5 }); await pending; expect(f.api.sources).toHaveBeenCalledTimes(2); expect(f.api.save.mock.calls[0][1]).toBe(4);
    expect(f.controller.getSnapshot().data?.preview.items).toEqual([]);
  });
  it('rejects an older readback after a successful mutation', async () => {
    const f = fixture(); await f.controller.load(); await f.controller.save('science', input);
    expect(f.controller.getSnapshot()).toMatchObject({ status: 'error', error: 'conflict', data: null });
    expect(f.api.save).toHaveBeenCalledTimes(1);
  });
  it.each(['conflict', 'authorization', 'network'] as const)('keeps mutation failure %s empty and never repeats it', async code => {
    const f = fixture(); await f.controller.load(); f.api.revoke.mockRejectedValueOnce(new RadarClientError(code));
    await f.controller.revoke('science'); expect(f.controller.getSnapshot()).toMatchObject({ status: 'error', data: null, error: code === 'network' ? 'uncertain' : code });
    await vi.advanceTimersByTimeAsync(120000); expect(f.api.revoke).toHaveBeenCalledTimes(1); expect(f.api.sources).toHaveBeenCalledTimes(1);
  });
  it('does not write after the display deadline even if a browser timer was delayed', async () => {
    const f = fixture(); await f.controller.load(); f.moveClock(60001); await f.controller.revoke('science');
    expect(f.api.revoke).not.toHaveBeenCalled(); expect(f.controller.getSnapshot().data).toBeNull();
  });
  it('notifies subscribers on erasure and removes subscriptions', async () => {
    const f = fixture(); const subscriber = vi.fn(); const stop = f.controller.subscribe(subscriber);
    await f.controller.load(); stop(); const calls = subscriber.mock.calls.length; f.controller.stop(); expect(subscriber).toHaveBeenCalledTimes(calls);
  });
});

describe('Radar presentation', () => {
  it('escapes source text, renders safe links and does not render private owner/audit or operational controls', async () => {
    const f = fixture(); await f.controller.load(); const html = renderToString(<RadarDashboard controller={f.controller} onLogout={() => {}} />);
    expect(html).toContain('&lt;script&gt;'); expect(html).not.toContain('<script>'); expect(html).toContain('noopener noreferrer'); expect(html).toContain('no-referrer');
    expect(html).not.toMatch(/private-owner|secret|管理コンソール|送信ボタン/); expect(html).toContain('最大3件');
    f.controller.stop(); expect(renderToString(<RadarDashboard controller={f.controller} onLogout={() => {}} />)).not.toContain('Fixture science');
  });
  it('starts a new source without consent selected and explains non-activation', () => {
    const html = renderToString(<SourceEditor onSave={() => {}} onClose={() => {}} />);
    expect(html).not.toContain('checked=""'); expect(html).toContain('この操作で情報取得や通知は始まりません'); expect(html).toContain('type="datetime-local"');
  });
});

describe('explicit collection and private audit boundary', () => {
  const withEvent = () => ({ ...rawAudit(), omittedThroughRevision: 3, events: [{ revision: 4, at: now - 1000, sourceId: 'science', action: 'collect', added: 1, updated: 0, unchanged: 0 }] });
  it('decodes a bounded contiguous audit tail, dropping unknown/private fields', () => {
    const raw = { ...withEvent(), owner: 'secret', events: [{ ...withEvent().events[0], raw: 'secret' }] };
    expect(JSON.stringify(decodeAudit(raw))).not.toContain('secret'); expect(decodeAudit(raw).events).toHaveLength(1);
  });
  it.each(['gap', 'future', 'expired', 'coverage', 'capacity', 'long-deadline', 'expiry-deadline', 'negative', 'action', 'order'] as const)('rejects unsafe audit %s', kind => {
    const raw: any = withEvent();
    if (kind === 'gap') raw.events[0].revision = 2;
    if (kind === 'future') raw.events[0].at = now + 1;
    if (kind === 'expired') raw.events[0].at = now - raw.retentionMs;
    if (kind === 'coverage') raw.completeFromRevisionOne = true;
    if (kind === 'capacity') raw.capacity = 65;
    if (kind === 'long-deadline') raw.validUntil = now + 60001;
    if (kind === 'expiry-deadline') raw.events[0].at = now - raw.retentionMs + 500;
    if (kind === 'negative') raw.events[0].added = -1;
    if (kind === 'action') raw.events[0].action = 'publish';
    if (kind === 'order') { raw.omittedThroughRevision = 2; raw.events.unshift({ ...raw.events[0], revision: 3, at: now }); }
    expect(() => decodeAudit(raw)).toThrow(RadarClientError);
  });
  it('treats absent collection capability as disabled and rejects non-boolean capability', () => {
    const raw: any = rawSources(); delete raw.collectionAvailable; expect(decodeSources(raw).collectionAvailable).toBe(false);
    raw.collectionAvailable = 'true'; expect(() => decodeSources(raw)).toThrow();
  });
  it('posts an exact copied selection once and validates the receipt before readback', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ revision: 8, completedSourceIds: ['science', 'games'] })));
    const client = createRadarClient(fetcher); const signal = new AbortController().signal;
    expect(await client.collect(['science', 'games'], 4, signal)).toEqual({ revision: 8 });
    const [path, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe('/api/radar/collect'); expect(options).toMatchObject({ method: 'POST', cache: 'no-store', credentials: 'omit', signal });
    expect(JSON.parse(String(options.body))).toEqual({ expectedRevision: 4, sourceIds: ['science', 'games'] });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([[], ['science', 'science'], ['../private'], ['a', 'b', 'c', 'd']].map(ids => [ids]))('refuses invalid selection %j before network', async ids => {
    const fetcher = vi.fn(); await expect(createRadarClient(fetcher).collect(ids, 4, new AbortController().signal)).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([{ revision: 5, completedSourceIds: ['science'] }, { revision: 6, completedSourceIds: ['other'] }, { revision: 6 }, { revision: 6, completedSourceIds: ['science', 'other'] }])('rejects a mismatched receipt %j without retry', async receipt => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(receipt)));
    await expect(createRadarClient(fetcher).collect(['science'], 4, new AbortController().signal)).rejects.toThrow(); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('erases before collection, suppresses duplicate operations, then rereads all three views', async () => {
    const f = fixture(); await f.controller.load(); let release!: (v: { revision: number }) => void;
    f.api.collect.mockImplementationOnce(() => new Promise(r => { release = r; }));
    const ids = ['science']; const pending = f.controller.collect(ids); ids.push('other');
    expect(f.controller.getSnapshot()).toMatchObject({ status: 'collecting', data: null });
    await f.controller.collect(['science']); await f.controller.save('science', input); await f.controller.load();
    expect(f.api.collect).toHaveBeenCalledTimes(1); expect(f.api.save).not.toHaveBeenCalled();
    expect(f.api.collect.mock.calls[0]).toEqual([['science'], 4, expect.any(AbortSignal)]);
    f.api.sources.mockResolvedValue({ ...decodeSources(rawSources()), revision: 6 });
    f.api.preview.mockResolvedValue({ ...decodePreview(rawPreview()), revision: 6 }); f.api.audit.mockResolvedValue(decodeAudit(rawAudit(6)));
    release({ revision: 6 }); await pending; expect(f.controller.getSnapshot().status).toBe('ready');
    for (const read of [f.api.sources, f.api.preview, f.api.audit]) expect(read).toHaveBeenCalledTimes(2);
  });
  it.each(['unavailable', 'disabled', 'expired', 'missing', 'duplicate'] as const)('does not collect %s selection', async kind => {
    const f = fixture(); const sources = decodeSources(rawSources());
    if (kind === 'unavailable') sources.collectionAvailable = false;
    if (kind === 'disabled') sources.sources[0].source!.enabled = false;
    if (kind === 'expired') sources.sources[0].source!.consentExpiresAt = now;
    f.api.sources.mockResolvedValue(sources); f.api.preview.mockResolvedValue({ ...decodePreview(rawPreview()), items: [] });
    await f.controller.load(); await f.controller.collect(kind === 'missing' ? ['other'] : kind === 'duplicate' ? ['science', 'science'] : ['science']);
    expect(f.api.collect).not.toHaveBeenCalled();
  });
  it.each(['cancel', 'logout', 'hidden', 'new-session'] as const)('discards late collection receipt after %s', async kind => {
    const f = fixture(); await f.controller.load(); let release!: (v: { revision: number }) => void;
    f.api.collect.mockImplementationOnce(() => new Promise(r => { release = r; })); const pending = f.controller.collect(['science']);
    if (kind === 'cancel') f.controller.cancelCollection(); else if (kind === 'logout') f.controller.stop(); else if (kind === 'hidden') f.controller.visibility(false); else f.invalidate();
    release({ revision: 6 }); await pending; expect(f.controller.getSnapshot().data).toBeNull(); expect(f.api.sources).toHaveBeenCalledTimes(1);
    if (kind === 'cancel') expect(f.controller.getSnapshot().error).toBe('uncertain');
    if (kind !== 'new-session') expect((f.api.collect.mock.calls[0] as any)[2].aborted).toBe(true);
  });
  it('leaves partial/unknown failure empty without automatic repetition or readback', async () => {
    const f = fixture(); await f.controller.load(); f.api.collect.mockRejectedValueOnce(new RadarClientError('unavailable'));
    await f.controller.collect(['science']); await vi.advanceTimersByTimeAsync(120000);
    expect(f.controller.getSnapshot()).toMatchObject({ status: 'error', error: 'uncertain', data: null });
    expect(f.api.collect).toHaveBeenCalledTimes(1); expect(f.api.sources).toHaveBeenCalledTimes(1);
  });
  it('rejects mismatched audit revision and uses the shorter audit expiry', async () => {
    const f = fixture(); f.api.audit.mockResolvedValue(decodeAudit(rawAudit(3))); await f.controller.load();
    expect(f.controller.getSnapshot().error).toBe('conflict');
    f.api.audit.mockResolvedValue(decodeAudit({ ...rawAudit(), validUntil: now + 400 })); await f.controller.load();
    await vi.advanceTimersByTimeAsync(400); expect(f.controller.getSnapshot().data).toBeNull();
  });
  it('renders finite audit history and unavailable collection without exposing owner or attempt IDs', async () => {
    const f = fixture(); f.api.sources.mockResolvedValue({ ...decodeSources(rawSources()), collectionAvailable: false });
    f.api.audit.mockResolvedValue(decodeAudit({ ...withEvent(), events: [{ ...withEvent().events[0], attemptId: 'hidden-attempt' }] }));
    await f.controller.load(); const html = renderToString(<RadarDashboard controller={f.controller} onLogout={() => {}} />);
    expect(html).toContain('取得機能はまだ接続されていません'); expect(html.replace(/<!-- -->/g, '')).toContain('最近の操作履歴（1件）');
    expect(html).toContain('完全な監査ではありません'); expect(html).not.toContain('hidden-attempt');
  });
});


const weatherSource = {kind:'weather' as const,enabled:true,consentExpiresAt:now+86400000,timeZone:'Asia/Tokyo',latitudeTenth:350,longitudeTenth:1390};
const rawTemporalSources = () => ({weatherAvailable:true,calendarAvailable:false,calendars:[],servedAt:now,validUntil:now+60000,
  sources:[{id:'weather',source:{...weatherSource,id:'weather',revision:1}}]});
const rawTemporalPreview = () => [{sourceId:'weather',sourceRevision:1,timeZone:'Asia/Tokyo',content:{kind:'weather',sourceId:'weather',sourceRevision:1,
  fetchedAt:now,validUntil:now+900000,visibility:'owner-only',notify:false,partial:false,attribution:'Weather data by Open-Meteo.com',providerUrl:'https://open-meteo.com/',licenseUrl:'https://creativecommons.org/licenses/by/4.0/',
  items:['2027-01-15','2027-01-16','2027-01-17'].map(date=>({date,weatherCode:1,minimumC:10,maximumC:20,precipitationPercent:30}))}}];
function workspaceFixture(){
  const f=fixture();const api=Object.assign(f.api,{saveTemporal:vi.fn(async()=>({revision:5})),revokeTemporal:vi.fn(async()=>({revision:5}))});
  const views=(revision=4)=>{
    api.sources.mockResolvedValue(decodeSources({...rawSources(),revision,temporal:rawTemporalSources()}));
    api.preview.mockResolvedValue(decodePreview({...rawPreview(),revision,validUntil:now+60000,temporal:rawTemporalPreview()}));
    api.audit.mockResolvedValue(decodeAudit(rawAudit(revision)));
  };views();return {...f,api,views};
}
describe('integrated personal weather/calendar experience',()=>{
  it('decodes separate private content without retaining owner, grant or unknown fields',()=>{
    const v:any=rawTemporalPreview();v[0].content.owner='secret-owner';v[0].content.grant='secret-grant';
    const decoded=decodePreview({...rawPreview(),validUntil:now+60000,temporal:v});
    expect(decoded.temporal).toHaveLength(1);expect(JSON.stringify(decoded)).not.toMatch(/secret-owner|secret-grant/);
  });
  it.each(['duplicate-id','expired-choice','invalid-zone','unknown-kind','too-many'] as const)('rejects invalid temporal sources %s',kind=>{
    const temporal:any=rawTemporalSources();
    if(kind==='duplicate-id')temporal.sources[0].id=temporal.sources[0].source.id='science';
    if(kind==='expired-choice'){temporal.calendarAvailable=true;temporal.calendars=[{id:'bound',label:'Test',timeZone:'UTC',expiresAt:now}];}
    if(kind==='invalid-zone')temporal.sources[0].source.timeZone='bad-zone';if(kind==='unknown-kind')temporal.sources[0].source.kind='people';
    if(kind==='too-many')temporal.sources=Array(33).fill(temporal.sources[0]);
    expect(()=>decodeSources({...rawSources(),temporal})).toThrow();
  });
  it.each(['owner-scope','source-revision','future','expired','provider','bad-day','duplicate','item-count'] as const)('rejects invalid private content %s',kind=>{
    const temporal:any=rawTemporalPreview();const c=temporal[0].content;
    if(kind==='owner-scope')c.visibility='public';if(kind==='source-revision')c.sourceRevision=9;if(kind==='future')c.fetchedAt=now+1;
    if(kind==='expired')c.validUntil=now;if(kind==='provider')c.providerUrl='javascript:bad';if(kind==='bad-day')c.items[0].date='2026-02-30';
    if(kind==='duplicate')temporal.push(temporal[0]);if(kind==='item-count')c.items.push(c.items[0]);
    expect(()=>decodePreview({...rawPreview(),validUntil:now+60000,temporal})).toThrow();
  });
  it('renders weather alongside feed cards, preserves attribution and explains Calendar absence',async()=>{
    const f=workspaceFixture();await f.controller.load();expect(f.controller.getSnapshot().status).toBe('ready');
    const html=renderToString(<RadarDashboard controller={f.controller} onLogout={()=>{}}/>);
    expect(html).toContain('3日間の天気');expect(html).toContain('CC BY 4.0');expect(html).toContain('Calendar連携は未接続');
    expect(html).toContain('Fixture science');expect(html).not.toContain('secret-owner');
    f.controller.stop();expect(renderToString(<RadarDashboard controller={f.controller} onLogout={()=>{}}/>)).not.toContain('3日間の天気');
  });
  it('uses one mixed selection and rechecks a single revision across feed/private/audit views',async()=>{
    const f=workspaceFixture();await f.controller.load();f.views(8);f.api.collect.mockResolvedValue({revision:8});
    await f.controller.collect(['science','weather']);expect(f.api.collect).toHaveBeenCalledWith(['science','weather'],4,expect.any(AbortSignal));
    expect(f.controller.getSnapshot().status).toBe('ready');expect(f.controller.getSnapshot().data?.sources.revision).toBe(8);
  });
  it('saves and deletes private source settings with exact owner revision and rereads, without acquisition',async()=>{
    const f=workspaceFixture();await f.controller.load();f.views(5);await f.controller.saveTemporal('weather',weatherSource);
    expect(f.api.saveTemporal).toHaveBeenCalledWith('weather',4,weatherSource,expect.any(AbortSignal));expect(f.api.collect).not.toHaveBeenCalled();
    f.views(6);f.api.revokeTemporal.mockResolvedValue({revision:6});await f.controller.revokeTemporal('weather');
    expect(f.api.revokeTemporal).toHaveBeenCalledWith('weather',5,expect.any(AbortSignal));
  });
  it.each(['missing-source','wrong-kind','wrong-version','short-consent'] as const)('rejects private/source mismatch %s',async kind=>{
    const f=workspaceFixture();const s=decodeSources({...rawSources(),temporal:rawTemporalSources()});
    if(kind==='missing-source')s.temporal!.sources=[];if(kind==='wrong-kind')s.temporal!.sources[0].source={kind:'calendar',enabled:true,timeZone:'Asia/Tokyo',consentExpiresAt:now+86400000,bindingId:'test',days:3,revision:1};
    if(kind==='wrong-version')s.temporal!.sources[0].source!.revision=2;if(kind==='short-consent')s.temporal!.sources[0].source!.consentExpiresAt=now+1;
    f.api.sources.mockResolvedValue(s);await f.controller.load();expect(f.controller.getSnapshot().error).toBe('invalid');expect(f.controller.getSnapshot().data).toBeNull();
  });
  it('expires all views at the shorter connection deadline',async()=>{
    const f=workspaceFixture();f.api.sources.mockResolvedValue(decodeSources({...rawSources(),temporal:{...rawTemporalSources(),validUntil:now+300}}));
    await f.controller.load();await vi.advanceTimersByTimeAsync(300);expect(f.controller.getSnapshot().data).toBeNull();
  });
  it('posts private settings only to the explicit route and never sends owner or a credential',async()=>{
    const fetcher=vi.fn(async()=>new Response(JSON.stringify({revision:5})));const client=createRadarClient(fetcher);const signal=new AbortController().signal;
    await client.saveTemporal!('weather',4,weatherSource,signal);const [path,init]=fetcher.mock.calls[0] as any;
    expect(path).toBe('/api/radar/temporal/sources/weather');expect(JSON.parse(init.body)).toEqual({expectedRevision:4,source:weatherSource});
    expect(init.credentials).toBe('omit');await client.revokeTemporal!('weather',4,signal);expect((fetcher.mock.calls[1] as any)[1].method).toBe('DELETE');
  });
});

function standaloneFixture() {
  vi.useFakeTimers(); vi.setSystemTime(now);
  let user: RadarIdentityUser | null = {uid:'alice',getIdToken:vi.fn(async()=> 'fake-token')};
  let callback: (user: RadarIdentityUser | null)=>void = ()=>undefined;
  const identity = {projectId:'radar-fixture',currentUser:()=>user,observe:(cb:typeof callback)=>{callback=cb;cb(user);return ()=>{callback=()=>undefined;};},
    signIn:vi.fn(async()=>undefined),signOut:vi.fn(async()=>{user=null;callback(null);})};
  const fetcher = vi.fn(async (path:string) => new Response(JSON.stringify(path.endsWith('/session')
    ? {projectId:'radar-fixture',uid:'alice',expiresAt:now+3600000} : path.endsWith('/sources') ? rawSources() : path.endsWith('/preview') ? rawPreview() : rawAudit())));
  const session = new StandaloneRadarSession(identity,fetcher as unknown as typeof fetch);
  return {session,identity,fetcher,change:(next:RadarIdentityUser|null)=>{user=next;callback(next);},getUser:()=>user};
}
const settleSession = async () => { for(let i=0;i<12;i++)await Promise.resolve(); };
describe('standalone Radar HTTP login and session ownership',()=>{
  it('calls the default browser fetch with its global receiver',async()=>{
    const f=standaloneFixture();vi.spyOn(globalThis,'fetch').mockImplementation(function(this:unknown,...args:Parameters<typeof fetch>){
      expect(this).toBe(globalThis);return f.fetcher(String(args[0]));
    });
    const session=new StandaloneRadarSession(f.identity);session.start();await vi.advanceTimersByTimeAsync(0);
    expect(session.getSnapshot().kind).toBe('ready');session.stop();
  });
  it('ends verification on deadline even if the SDK token promise never settles, and discards late success',async()=>{
    const f=standaloneFixture();let finish!:(token:string)=>void;
    f.getUser()!.getIdToken=()=>new Promise(resolve=>{finish=resolve;});
    f.session.start();await vi.advanceTimersByTimeAsync(15000);
    expect(f.session.getSnapshot()).toMatchObject({kind:'error',error:'認証確認がタイムアウトしました。'});
    finish('fake-token');await settleSession();expect(f.fetcher).not.toHaveBeenCalled();expect(f.session.getSnapshot().kind).toBe('error');f.session.stop();
  });
  it('renders a dedicated login with no operational console or socket provider',()=>{
    const f=standaloneFixture();const html=renderToString(<StandaloneRadarApp identity={f.identity}/>);
    expect(html).toContain('Radar にログイン');expect(html).toContain('メールアドレス');expect(html).not.toContain('今回のダイジェスト');
  });
  it('verifies profile via HTTP before showing Radar, carries bearer only to own API, then clears on logout',async()=>{
    const f=standaloneFixture();f.session.start();await settleSession();const state=f.session.getSnapshot();expect(state.kind).toBe('ready');
    if(state.kind!=='ready')throw Error();state.controller.activate();await state.controller.load();expect(state.controller.getSnapshot().status).toBe('ready');
    for(const [path,init] of f.fetcher.mock.calls as unknown as [string,RequestInit][]){expect(path.startsWith('/api/radar/')).toBe(true);expect(init.credentials).toBe('omit');expect(init.redirect).toBe('error');}
    await f.session.logout();expect(f.session.getSnapshot().kind).toBe('login');expect(state.controller.getSnapshot().data).toBeNull();f.session.stop();
  });
  it.each(['uid','project','expired','overlong','missing-expiry','unauthorized'])('rejects %s session response',async kind=>{
    const f=standaloneFixture();const value:any={projectId:'radar-fixture',uid:'alice',expiresAt:now+3600000};
    if(kind==='uid')value.uid='bob';if(kind==='project')value.projectId='shannonui';if(kind==='expired')value.expiresAt=now;
    if(kind==='overlong')value.expiresAt=now+3600001;if(kind==='missing-expiry')delete value.expiresAt;
    f.fetcher.mockResolvedValue(new Response(JSON.stringify(value),{status:kind==='unauthorized'?403:200}));
    f.session.start();await settleSession();expect(f.session.getSnapshot().kind).toBe('error');f.session.stop();
  });
  it('discards profile completion after owner change',async()=>{
    const f=standaloneFixture();let finish!:(r:Response)=>void;f.fetcher.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
    f.session.start();await settleSession();f.change(null);finish(new Response(JSON.stringify({projectId:'radar-fixture',uid:'alice',expiresAt:now+3600000})));
    await settleSession();expect(f.session.getSnapshot().kind).toBe('login');f.session.stop();
  });
  it('expires the authenticated session and its loaded data',async()=>{
    const f=standaloneFixture();f.fetcher.mockImplementation(async()=>new Response(JSON.stringify({projectId:'radar-fixture',uid:'alice',expiresAt:now+1000})));
    f.session.start();await settleSession();expect(f.session.getSnapshot().kind).toBe('ready');await vi.advanceTimersByTimeAsync(1000);
    expect(f.session.getSnapshot().kind).toBe('error');f.session.stop();
  });
  it('keeps data closed when signout fails and token refresh arrives afterwards',async()=>{
    const f=standaloneFixture();f.session.start();await settleSession();const user=f.getUser();f.identity.signOut.mockRejectedValue(Error('private provider error'));
    await f.session.logout();expect(JSON.stringify(f.session.getSnapshot())).not.toContain('private provider');
    f.change(user);await settleSession();expect(f.session.getSnapshot().kind).toBe('login');f.session.stop();
  });
  it('redacts login errors and erases state on unmount',async()=>{
    const f=standaloneFixture();f.change(null);f.session.start();f.identity.signIn.mockRejectedValue(Error('private account'));
    await f.session.login('fixture@example.test','fake-password');expect(f.session.getSnapshot().kind).toBe('error');expect(JSON.stringify(f.session.getSnapshot())).not.toContain('private account');
    f.session.stop();expect(f.session.getSnapshot().kind).toBe('login');
  });
});
