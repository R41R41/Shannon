import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { createRadarClient, decodeSources, decodePreview, safeRadarLink, sourceInput, RadarClientError,
  type SourcesSnapshot, type PreviewSnapshot } from '../src/features/radar/radarClient';
import { RadarController } from '../src/features/radar/radarController';
import { RadarDashboard } from '../src/features/radar/RadarDashboard';
import { SourceEditor } from '../src/features/radar/SourceEditor';

const now = 1800000000000;
const input = { enabled: true, consentExpiresAt: now + 86400000, kind: 'web' as const, locator: 'https://example.org/feed',
  articleHosts: ['example.org'], topicIds: ['science'], maxItems: 10, retentionMs: 86400000 };
const rawSources = () => ({ revision: 4, sources: [{ id: 'science', source: { ...input, id: 'science', revision: 2,
  audience: { kind: 'personal', subjectId: 'private-owner' }, irrelevant: 'secret' } }], audit: [{ private: 'secret' }] });
const rawPreview = () => ({ revision: 4, notify: false as const, servedAt: now, validUntil: now + 120000,
  items: [{ contentId: 'c1', sourceId: 'science', sourceRevision: 2, score: 0.6, matchedTopicIds: ['science'], card: {
    title: 'Fixture science <script>alert(1)</script>', fact: '登録ソースの掲載情報です。', sourceUrl: 'https://example.org/article', metadata: ['2026-08-28'], tags: ['science'],
    mentions: 'none' as const, notify: false as const, thread: 'none' as const } }] });
function fixture() {
  vi.useFakeTimers(); let time = 0; let current = true;
  const api = { sources: vi.fn(async () => decodeSources(rawSources())), preview: vi.fn(async () => decodePreview(rawPreview())),
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
  it('uses only fixed same-origin endpoints and exact CAS input, with no fetch/post endpoint', async () => {
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
  it('performs two explicit reads, exposes consistent snapshots and does not poll', async () => {
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
