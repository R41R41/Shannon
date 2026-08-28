import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { AccessError, AccessService, type RequestContext } from '../../src/modules/access/index.js';
import type { PersonalCatalog, PersonalCatalogPort } from '../../src/modules/radar/catalog.js';
import { MongoPersonalCatalog } from '../../src/services/radar/mongoPersonalCatalog.js';
import { PersonalRadarService, personalRadarOwner, checkedRecord } from '../../src/services/radar/personalRadar.js';
import { PublicFeedConnector, parseFeed } from '../../src/services/radar/feedConnector.js';
import type { FeedConnectorPort } from '../../src/services/radar/feedConnector.js';
import type { ReauthorizeRadar } from '../../src/services/radar/personalRadar.js';
import { reserveAcquisition, releaseAcquisition, validAcquisitionState, type AcquisitionPolicy } from '../../src/modules/radar/acquisition.js';
import { RadarSessionRunner, RADAR_SESSION_MAX_MS } from '../../src/services/radar/sessionRunner.js';
import { RADAR_AUDIT_RETENTION_MS, catalogAuditView } from '../../src/modules/radar/audit.js';
import { registerRadarRoutes } from '../../src/routes/radarRoutes.js';

const initialNow = Date.now();
const context = (uid = 'alice', projectId = 'fixture'): RequestContext => ({ requestId: 'r',
  principal: { uid, projectId, name: 'Same name', email: 'same@example.test' }, capabilities: ['profile:read'], expiresAtMs: initialNow + 86400000 });
const configuration = (now = initialNow) => ({ enabled: true, consentExpiresAt: now + 7 * 86400000, kind: 'web',
  locator: 'https://example.org/feed.xml', articleHosts: ['example.org'], topicIds: ['games'], maxItems: 20, retentionMs: 7 * 86400000 });
const xml = (title = 'Fixture game', published = initialNow - 60000, updated = published, id = 'item-1') =>
  `<feed><entry><id>${id}</id><title>${title}</title><link href="https://example.org/${id}"/><published>${new Date(published).toISOString()}</published><updated>${new Date(updated).toISOString()}</updated></entry></feed>`;
class FixtureStore implements PersonalCatalogPort {
  rows = new Map<string, PersonalCatalog>();
  read = vi.fn(async (owner: string) => structuredClone(this.rows.get(owner) ?? null));
  compareAndSwap = vi.fn(async (owner: string, expected: number, next: PersonalCatalog) => {
    if ((this.rows.get(owner)?.revision ?? 0) !== expected) return false;
    this.rows.set(owner, structuredClone(next)); return true;
  });
}
const fixturePolicy: AcquisitionPolicy = { maxPer24Hours: 256, minimumIntervalMs: 0, leaseMs: 30000 };
function setup(policy: AcquisitionPolicy = fixturePolicy) {
  let now = initialNow;
  const refresh = vi.fn(async (c: RequestContext) => c);
  class FixtureRadar extends PersonalRadarService {
    configure(c: RequestContext, id: string, body: unknown, auth: ReauthorizeRadar = () => refresh(c)) { return super.configure(c, id, body, auth); }
    revoke(c: RequestContext, id: string, expected: unknown, auth: ReauthorizeRadar = () => refresh(c)) { return super.revoke(c, id, expected, auth); }
    collect(c: RequestContext, id: string, connector: FeedConnectorPort, signal: AbortSignal, auth: ReauthorizeRadar = () => refresh(c), expected?: number) { return super.collect(c, id, connector, signal, auth, expected); }
  }
  const store = new FixtureStore(); const service = new FixtureRadar(store, () => now, policy);
  const http = { get: vi.fn(async () => xml()) }; const connector = new PublicFeedConnector(http, () => now);
  return { store, service, http, connector, refresh, now: () => now, advance: (ms: number) => { now += ms; },
    configure: (uid = 'alice', expectedRevision = 0, source = configuration()) => service.configure(context(uid), 'feed', { expectedRevision, source }),
    collect: (uid = 'alice', signal = new AbortController().signal) => service.collect(context(uid), 'feed', connector, signal) };
}
const errorCode = (promise: Promise<unknown>, code: string) => expect(promise).rejects.toMatchObject({ code });

describe('personal Radar aggregate and metadata lifecycle', () => {
  it('derives separate Firebase identities, ignoring equal email/name/admin and never linking Discord', () => {
    expect(personalRadarOwner(context())).toMatch(/^firebase:[a-f0-9]{64}$/);
    expect(personalRadarOwner(context())).not.toBe(personalRadarOwner(context('bob')));
    expect(personalRadarOwner(context())).not.toBe(personalRadarOwner(context('alice', 'other')));
    expect(personalRadarOwner(context())).not.toContain('alice');
  });
  it.each(['expired', 'capability'] as const)('rejects %s before repository access', async kind => {
    const f = setup(); const c = { ...context(), ...(kind === 'expired' ? { expiresAtMs: 0 } : { capabilities: [] }) };
    await expect(f.service.sources(c)).rejects.toBeInstanceOf(AccessError); expect(f.store.read).not.toHaveBeenCalled();
  });
  it('starts empty and configuring does not fetch anything', async () => {
    const f = setup(); expect((await f.service.preview(context())).items).toEqual([]);
    expect(await f.configure()).toEqual({ revision: 1 }); expect(f.http.get).not.toHaveBeenCalled();
    expect((await f.service.sources(context())).sources[0].source?.audience).toEqual({ kind: 'personal', subjectId: personalRadarOwner(context()) });
  });
  it.each([
    { audience: { kind: 'personal', subjectId: 'bob' } }, { owner: 'bob' }, { revision: 5 }, { isAdmin: true },
    { kind: 'calendar' }, { kind: 'weather' }, { enabled: 'true' }, { consentExpiresAt: initialNow },
    { consentExpiresAt: initialNow + 31 * 86400000 }, { locator: 'http://example.org/' },
    { locator: 'https://127.0.0.1/' }, { locator: 'https://example.org/feed?token=secret' },
    { maxItems: 21 }, { retentionMs: 0 }, { articleHosts: [] }, { topicIds: ['private topic'] },
  ])('rejects unsafe/unknown configuration %j', async change => {
    const f = setup(); await errorCode(f.configure('alice', 0, { ...configuration(), ...change }), 'INVALID_INPUT');
    expect(f.store.compareAndSwap).not.toHaveBeenCalled();
  });
  it.each([null, {}, { expectedRevision: 0 }, { expectedRevision: -1, source: configuration() },
    { expectedRevision: 0, source: configuration(), owner: 'bob' }])('rejects malformed outer input %j', async body => {
    const f = setup(); await errorCode(f.service.configure(context(), 'feed', body), 'INVALID_INPUT');
  });
  it('isolates same source ID across owners, including reads and revocation', async () => {
    const f = setup(); await f.configure(); await f.collect();
    expect((await f.service.sources(context('bob'))).sources).toEqual([]);
    expect((await f.service.preview(context('bob'))).items).toEqual([]);
    await errorCode(f.service.revoke(context('bob'), 'feed', 0), 'NOT_FOUND');
    await f.configure('bob'); expect(f.store.rows.size).toBe(2);
    expect((await f.service.preview(context())).items).toHaveLength(1);
  });
  it('persists bounded metadata and private reasons; repeated reads across days do not duplicate/extend retention', async () => {
    const f = setup(); await f.configure(); await f.collect();
    const before = structuredClone(f.store.rows.get(personalRadarOwner(context()))!);
    f.advance(12 * 3600000); await f.collect();
    const row = f.store.rows.get(before.owner)!;
    expect(row.sources[0].records).toEqual(before.sources[0].records);
    expect(row.audit.at(-1)).toMatchObject({ added: 0, updated: 0, unchanged: 1 });
    const preview = await f.service.preview(context());
    expect(preview.items).toHaveLength(1); expect(preview.items[0].matchedTopicIds).toEqual(['games']);
    expect(preview.items[0].card).toMatchObject({ mentions: 'none', notify: false, thread: 'none' });
    expect(JSON.stringify(row.audit)).not.toMatch(/https|Fixture game|example.org/);
  });
  it('replaces updated metadata, refuses upstream timestamp rollback and keeps missing entries until expiry', async () => {
    const f = setup(); await f.configure(); await f.collect();
    f.http.get.mockResolvedValue(xml('Corrected', initialNow - 60000, initialNow - 1000)); await f.collect();
    expect(f.store.rows.get(personalRadarOwner(context()))!.audit.at(-1)).toMatchObject({ updated: 1 });
    f.http.get.mockResolvedValue(xml()); await f.collect();
    expect((await f.service.preview(context())).items[0].card.title).toBe('Corrected');
    f.http.get.mockResolvedValue('<feed/>'); await f.collect();
    expect((await f.service.preview(context())).items).toHaveLength(1);
  });
  it('invalidates derived records on any edit and keeps source and owner revisions distinct', async () => {
    const f = setup(); await f.configure(); await f.collect();
    await f.configure('alice', 3, { ...configuration(), topicIds: ['science'] });
    const row = f.store.rows.get(personalRadarOwner(context()))!;
    expect(row.revision).toBe(4); expect(row.sources[0].source?.revision).toBe(2); expect(row.sources[0].records).toEqual([]);
    await f.collect(); expect((await f.service.preview(context())).items[0].matchedTopicIds).toEqual(['science']);
  });
  it('disables reads and deletes metadata immediately; re-enable requires a new collection', async () => {
    const f = setup(); await f.configure(); await f.collect();
    await f.configure('alice', 3, { ...configuration(), enabled: false });
    await errorCode(f.collect(), 'NOT_FOUND'); expect((await f.service.preview(context())).items).toEqual([]);
    await f.configure('alice', 4); expect((await f.service.preview(context())).items).toEqual([]);
  });
  it('removes settings/content on revoke, prevents ID resurrection and rejects stale CAS', async () => {
    const f = setup(); await f.configure(); await f.collect();
    await errorCode(f.service.revoke(context(), 'feed', 1), 'CONFLICT');
    await f.service.revoke(context(), 'feed', 3);
    const row = f.store.rows.get(personalRadarOwner(context()))!;
    expect(row.sources).toEqual([{ id: 'feed', source: null, records: [] }]);
    expect(JSON.stringify(row)).not.toMatch(/example.org|Fixture game|games/);
    await errorCode(f.configure('alice', 4), 'CONFLICT'); await errorCode(f.collect(), 'NOT_FOUND');
  });
  it('rejects an in-flight collection revoked while fetching, without restoring content', async () => {
    const f = setup(); await f.configure();
    f.http.get.mockImplementation(async () => { await f.service.revoke(context(), 'feed', 2); return xml(); });
    await errorCode(f.collect(), 'CONFLICT'); expect(f.store.rows.get(personalRadarOwner(context()))!.sources[0].source).toBeNull();
  });
  it('allows only one concurrent collection/configuration winner, without silent retry', async () => {
    const f = setup(); const creates = await Promise.allSettled([f.configure(), f.configure()]);
    expect(creates.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const collects = await Promise.allSettled(Array.from({ length: 8 }, () => f.collect()));
    expect(collects.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(f.store.rows.get(personalRadarOwner(context()))!.revision).toBe(3);
    expect(f.http.get).toHaveBeenCalledTimes(1);
  });
  it('also fences revocation between final registry read and commit', async () => {
    const f = setup(); await f.configure(); const original = f.store.compareAndSwap.getMockImplementation()!;
    f.store.compareAndSwap.mockImplementation(async (...args) => {
      if (args[2].audit.at(-1)?.action === 'collect') {
        f.store.compareAndSwap.mockImplementation(original); await f.service.revoke(context(), 'feed', 2);
      }
      return original(...args);
    });
    await errorCode(f.collect(), 'CONFLICT'); expect((await f.service.preview(context())).items).toEqual([]);
  });
  it.each(['before', 'during'] as const)('does not store cancelled collection %s fetch', async when => {
    const f = setup(); await f.configure(); const abort = new AbortController();
    if (when === 'before') abort.abort(); else f.http.get.mockImplementation(async () => { abort.abort(); return xml(); });
    await errorCode(f.collect('alice', abort.signal), 'CANCELLED'); expect(f.store.rows.get(personalRadarOwner(context()))!.revision).toBe(when === 'before' ? 1 : 3);
    expect(f.store.rows.get(personalRadarOwner(context()))!.sources[0].records).toEqual([]);
  });
  it('checks identity expiry after I/O before committing', async () => {
    const f = setup(); await f.configure(); f.http.get.mockImplementation(async () => { f.advance(86400001); return xml(); });
    await expect(f.collect()).rejects.toBeInstanceOf(AccessError);
    expect(f.store.rows.get(personalRadarOwner(context()))!.revision).toBe(3);
    expect(f.store.rows.get(personalRadarOwner(context()))!.sources[0].records).toEqual([]);
  });
  it.each(['revoked', 'changed-owner'] as const)('renews identity before saving after collection: %s', async kind => {
    const f = setup(); await f.configure();
    f.http.get.mockImplementation(async () => {
      if (kind === 'revoked') f.refresh.mockRejectedValue(new AccessError('FORBIDDEN'));
      else f.refresh.mockResolvedValue(context('bob'));
      return xml();
    });
    await errorCode(f.collect(), kind === 'revoked' ? 'FORBIDDEN' : 'CONFLICT');
    expect(f.store.rows.get(personalRadarOwner(context()))!.revision).toBe(3);
    expect(f.store.rows.get(personalRadarOwner(context()))!.sources[0].records).toEqual([]);
  });
  it('refuses missing renewal callback instead of treating a context as continuing authorization', async () => {
    const f = setup(); await f.configure(); const service = new PersonalRadarService(f.store, () => initialNow);
    await errorCode(service.collect(context(), 'feed', f.connector, new AbortController().signal, undefined as any), 'CONFLICT');
    expect(f.http.get).not.toHaveBeenCalled();
  });
  it.each(['cancel', 'consent'] as const)('checks %s again after authorization renewal', async kind => {
    const f = setup(); await f.configure('alice', 0, { ...configuration(), consentExpiresAt: initialNow + 1000 });
    const abort = new AbortController(); let count = 0;
    f.refresh.mockImplementation(async c => { if (++count === 2) { if (kind === 'cancel') abort.abort(); else f.advance(1001); } return c; });
    await errorCode(f.collect('alice', abort.signal), kind === 'cancel' ? 'CANCELLED' : 'LEASE_EXPIRED');
    expect(f.store.rows.get(personalRadarOwner(context()))!.revision).toBe(1);
  });
  it('hides expired sources without physical deletion claims', async () => {
    const f = setup(); await f.configure('alice', 0, { ...configuration(), consentExpiresAt: initialNow + 1000 }); await f.collect();
    f.advance(1001); expect((await f.service.preview(context())).items).toEqual([]); await errorCode(f.collect(), 'NOT_FOUND');
    expect(f.store.rows.get(personalRadarOwner(context()))!.sources[0].records).toHaveLength(1);
  });
  it('discards a preview when its aggregate changes during the read', async () => {
    const f = setup(); await f.configure(); await f.collect(); const original = f.store.read.getMockImplementation()!;
    f.store.read.mockImplementationOnce(async owner => { const row = await original(owner); await f.service.revoke(context(), 'feed', 3); return row; });
    await errorCode(f.service.preview(context()), 'CONFLICT');
  });
  it('bounds source count and audit history, with atomic writes still required', async () => {
    const f = setup();
    for (let n = 0; n < 10; n++) await f.service.configure(context(), `s${n}`, { expectedRevision: n, source: configuration() });
    await errorCode(f.service.configure(context(), 'extra', { expectedRevision: 10, source: configuration() }), 'LIMIT');
    for (let n = 10; n < 76; n++) await f.service.configure(context(), 's0', { expectedRevision: n, source: configuration() });
    expect((await f.service.sources(context())).audit).toHaveLength(64);
  });
  it('keeps at most 20 recent entities and displays at most three cards', async () => {
    const f = setup(); await f.configure();
    for (let n = 0; n < 25; n++) { f.http.get.mockResolvedValue(xml(`Item ${n}`, initialNow - 1000 + n, initialNow - 1000 + n, `id-${n}`)); await f.collect(); }
    expect(f.store.rows.get(personalRadarOwner(context()))!.sources[0].records).toHaveLength(20);
    expect((await f.service.preview(context())).items).toHaveLength(3);
  });
  it('rejects corrupted/other-owner repository documents before returning data', async () => {
    const f = setup(); await f.configure(); f.store.read.mockResolvedValueOnce({ ...f.store.rows.values().next().value!, owner: 'other' });
    await errorCode(f.service.sources(context()), 'UNAVAILABLE');
  });
  it.each(['hash', 'host', 'scope', 'timestamp', 'revision'] as const)('rejects tampered connector metadata: %s', async kind => {
    const f = setup(); await f.configure();
    const source = f.store.rows.get(personalRadarOwner(context()))!.sources[0].source!;
    const record = structuredClone(parseFeed(xml(), source, initialNow)[0]) as any;
    if (kind === 'hash') record.provenance.entityKey = 'forged';
    if (kind === 'host') record.content.sourceUrl = 'https://other.example/item';
    if (kind === 'scope') record.content.visibility = { kind: 'personal', subjectId: 'other' };
    if (kind === 'timestamp') record.provenance.updatedAt = initialNow + 1;
    if (kind === 'revision') record.provenance.sourceRevision = 12;
    await errorCode(f.service.collect(context(), 'feed', { read: async () => [record] }, new AbortController().signal), 'UNAVAILABLE');
    expect(f.store.rows.get(personalRadarOwner(context()))!.revision).toBe(3);
    expect(f.store.rows.get(personalRadarOwner(context()))!.sources[0].records).toEqual([]);
  });
  it('does not preserve arbitrary connector extras or free-form fact/reasons', async () => {
    const f = setup(); await f.configure(); const source = f.store.rows.get(personalRadarOwner(context()))!.sources[0].source!;
    const record = structuredClone(parseFeed(xml(), source, initialNow)[0]) as any;
    record.raw = 'private'; record.content.secret = 'private'; record.content.fact = 'Untrusted instruction'; record.provenance.cookie = 'private';
    const checked = checkedRecord(record, source, initialNow);
    expect(JSON.stringify(checked)).not.toMatch(/private|Untrusted/);
  });
});

let server: Server | undefined;
afterEach(async () => { vi.useRealTimers(); if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined; } });
async function api(withCollection = false) {
  const f = setup(); const verify = vi.fn(async (token: string) => {
    if (token === 'revoked') throw new AccessError('UNAUTHENTICATED');
    return { projectId: 'fixture', uid: token, email: 'same@example.test', emailVerified: true, expiresAtMs: initialNow + 86400000 };
  });
  const users = vi.fn(async (projectId: string, uid: string) => ({ projectId, uid, name: 'Same', email: 'same@example.test', isAuthorized: uid !== 'blocked', isAdmin: uid === 'admin' }));
  const access = new AccessService({ verify }, { findByIdentity: users }, () => 'request');
  const app = express(); registerRadarRoutes(app, access, f.service, withCollection ? new RadarSessionRunner(access, f.service, f.connector, f.now) : undefined);
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${(server!.address() as { port: number }).port}`;
  const request = (path: string, token = 'alice', method = 'GET', body?: unknown) => fetch(url + path, {
    method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { ...f, request, users, verify, url };
}
describe('explicit foreground collection HTTP (injected runner only)', () => {
  it('advertises opt-in, collects one selected source and returns an exact receipt with private audit', async () => {
    const f = await api(true); await f.configure();
    expect((await (await f.request('/api/radar/sources')).json() as any).collectionAvailable).toBe(true);
    const res = await f.request('/api/radar/collect', 'alice', 'POST', { expectedRevision: 1, sourceIds: ['feed'] });
    expect(res.status).toBe(200); expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ revision: 3, completedSourceIds: ['feed'] }); expect(f.http.get).toHaveBeenCalledTimes(1);
    const audit = await (await f.request('/api/radar/audit')).json() as any;
    expect(audit.events.map((e: any) => e.action)).toEqual(['configure', 'reserve', 'collect']);
    expect((await (await f.request('/api/radar/audit', 'bob')).json() as any).events).toEqual([]);
  });
  it.each([['', 401], ['blocked', 403], ['revoked', 401]])('rejects credential %s before storage or fetching', async (token, status) => {
    const f = await api(true);
    expect((await f.request('/api/radar/collect', String(token), 'POST', { expectedRevision: 0, sourceIds: ['feed'] })).status).toBe(status);
    expect(f.store.read).not.toHaveBeenCalled(); expect(f.http.get).not.toHaveBeenCalled();
  });
  it.each(['query', 'owner', 'duplicate', 'stale', 'other-owner', 'oversize'] as const)('rejects %s without acquisition', async kind => {
    const f = await api(true); await f.configure();
    const body: any = { expectedRevision: kind === 'stale' || kind === 'other-owner' ? 0 : 1, sourceIds: kind === 'duplicate' ? ['feed', 'feed'] : ['feed'] };
    if (kind === 'owner') body.owner = 'alice'; if (kind === 'oversize') body.extra = 'x'.repeat(1100);
    const res = await f.request('/api/radar/collect' + (kind === 'query' ? '?owner=alice' : ''), kind === 'other-owner' ? 'bob' : 'alice', 'POST', body);
    expect(res.status).toBe(kind === 'stale' ? 409 : kind === 'other-owner' ? 404 : kind === 'oversize' ? 413 : 400);
    expect(f.http.get).not.toHaveBeenCalled(); expect(f.store.rows.get(personalRadarOwner(context()))!.revision).toBe(1);
  });
  it('reauthenticates after I/O and does not expose or persist metadata after revocation', async () => {
    const f = await api(true); await f.configure();
    f.http.get.mockImplementation(async () => { f.verify.mockRejectedValue(new AccessError('UNAUTHENTICATED')); return xml(); });
    const res = await f.request('/api/radar/collect', 'alice', 'POST', { expectedRevision: 1, sourceIds: ['feed'] });
    expect(res.status).toBe(401); expect(await res.text()).not.toContain('Fixture game');
    expect(f.store.rows.get(personalRadarOwner(context()))!.sources[0].records).toEqual([]);
    expect(f.store.rows.get(personalRadarOwner(context()))!.acquisition!.starts).toHaveLength(1);
  });
  it('propagates a closed HTTP client to acquisition, retaining the charged attempt but not late content', async () => {
    const f = await api(true); await f.configure(); const abort = new AbortController();
    let entered!: () => void; let release!: (s: string) => void;
    const started = new Promise<void>(r => { entered = r; });
    f.http.get.mockImplementation(() => new Promise<string>(r => { release = r; entered(); }));
    const request = fetch(f.url + '/api/radar/collect', { method: 'POST', signal: abort.signal,
      headers: { Authorization: 'Bearer alice', 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: 1, sourceIds: ['feed'] }) });
    const rejected = expect(request).rejects.toThrow(); await started; abort.abort(); await rejected;
    await vi.waitFor(() => expect(f.store.rows.get(personalRadarOwner(context()))!.audit.at(-1)?.action).toBe('collect_failed'));
    release(xml()); await new Promise(resolve => setImmediate(resolve));
    const row = f.store.rows.get(personalRadarOwner(context()))!;
    expect(row.sources[0].records).toEqual([]); expect(row.acquisition!.starts).toHaveLength(1); expect(f.http.get).toHaveBeenCalledTimes(1);
  });
});
describe('personal Radar HTTP boundary (isolated Express fixture only)', () => {
  it.each([['GET', '/api/radar/audit'], ['GET', '/api/radar/sources'], ['GET', '/api/radar/preview'], ['PUT', '/api/radar/sources/feed'], ['DELETE', '/api/radar/sources/feed']])
   ('rejects missing credentials: %s %s', async (method, path) => {
      const f = await api(); const res = await f.request(path, '', method); expect(res.status).toBe(401);
      expect(res.headers.get('cache-control')).toBe('no-store'); expect(f.store.read).not.toHaveBeenCalled();
    });
  it.each([['blocked', 403], ['revoked', 401]])('rejects %s with %s', async (token, status) => {
    const f = await api(); expect((await f.request('/api/radar/preview', token)).status).toBe(status); expect(f.store.read).not.toHaveBeenCalled();
  });
  it('allows authorized non-admin owner only, returning metadata and private preview; admin cannot browse another owner', async () => {
    const f = await api(); expect((await f.request('/api/radar/sources/feed', 'alice', 'PUT', { expectedRevision: 0, source: configuration() })).status).toBe(200);
    await f.collect(); const result = await f.request('/api/radar/preview'); expect(result.status).toBe(200);
    const preview = await result.json() as any;
    expect(preview.items).toHaveLength(1); expect(preview.servedAt).toBeGreaterThan(0); expect(preview.servedAt).toBeLessThan(preview.validUntil);
    const admin = await f.request('/api/radar/preview', 'admin'); expect((await admin.json() as any).items).toEqual([]);
    expect((await f.request('/api/radar/preview?owner=alice', 'admin')).status).toBe(400);
    expect((await f.request('/api/radar/sources/feed', 'alice', 'DELETE', { expectedRevision: 3 })).status).toBe(200);
  });
  it('rechecks authorization after data access and fails closed on revocation', async () => {
    const f = await api(); await f.configure(); await f.collect();
    f.verify.mockImplementationOnce(async () => ({ projectId: 'fixture', uid: 'alice', email: 'same@example.test', emailVerified: true, expiresAtMs: initialNow + 86400000 }));
    f.verify.mockRejectedValueOnce(new AccessError('UNAUTHENTICATED'));
    const res = await f.request('/api/radar/preview'); expect(res.status).toBe(401); expect(await res.text()).not.toContain('Fixture game');
  });
  it('reauthenticates before the configuration write, not just after it', async () => {
    const f = await api(); const original = f.verify.getMockImplementation()!;
    f.verify.mockImplementationOnce(original).mockRejectedValueOnce(new AccessError('FORBIDDEN'));
    const res = await f.request('/api/radar/sources/feed', 'alice', 'PUT', { expectedRevision: 0, source: configuration() });
    expect(res.status).toBe(403); expect(f.store.compareAndSwap).not.toHaveBeenCalled();
  });
  it('rechecks catalog after final authentication and rejects stale cards', async () => {
    const f = await api(); await f.configure(); await f.collect(); const original = f.verify.getMockImplementation()!;
    let n = 0; f.verify.mockImplementation(async token => { if (++n === 2) await f.service.revoke(context(), 'feed', 3); return original(token); });
    expect((await f.request('/api/radar/preview')).status).toBe(409);
  });
  it('has no live collect, publication, identity-linking or scheduler endpoint', async () => {
    const f = await api();
    for (const path of ['/api/radar/collect', '/api/radar/publish', '/api/radar/link', '/api/radar/maintain']) expect((await f.request(path, 'alice', 'POST', {})).status).toBe(404);
    expect(f.http.get).not.toHaveBeenCalled();
  });
  it('rejects unknown delete fields, stale revision and oversize configuration', async () => {
    const f = await api(); await f.configure();
    expect((await f.request('/api/radar/sources/feed', 'alice', 'DELETE', { expectedRevision: 1, owner: 'bob' })).status).toBe(400);
    expect((await f.request('/api/radar/sources/feed', 'alice', 'PUT', { expectedRevision: 0, source: configuration() })).status).toBe(409);
    expect((await f.request('/api/radar/sources/feed', 'alice', 'PUT', { data: 'x'.repeat(9000) })).status).toBe(413);
  });
});

describe('Mongo catalog adapter scoped CAS contract', () => {
  it('injects one explicit collection with no constructor I/O and filters every operation by owner', async () => {
    const owner = personalRadarOwner(context()); const row = { owner, revision: 1, sources: [], audit: [] };
    const c = { findOne: vi.fn(async () => ({ ...row, _id: owner })), insertOne: vi.fn(), replaceOne: vi.fn(async () => ({ matchedCount: 1 })) };
    const db = { collection: vi.fn(() => c) }; const repo = new MongoPersonalCatalog(db as any);
    expect(db.collection).toHaveBeenCalledWith('radarpersonalcatalogs'); expect(c.findOne).not.toHaveBeenCalled();
    expect(await repo.read(owner)).toEqual(row); expect(c.findOne.mock.calls[0][0]).toEqual({ _id: owner, owner });
    expect(await repo.compareAndSwap(owner, 1, { ...row, revision: 2 })).toBe(true);
    expect(c.replaceOne.mock.calls[0][0]).toEqual({ _id: owner, owner, revision: 1 });
    expect(c.replaceOne.mock.calls[0][2]).toEqual({ upsert: false, writeConcern: { w: 'majority', j: true, wtimeoutMS: 5000 } });
  });
  it('treats insert duplicate as a conflict, propagates database failure, never retries', async () => {
    const owner = personalRadarOwner(context()); const row = { owner, revision: 1, sources: [], audit: [] };
    const c = { insertOne: vi.fn().mockRejectedValueOnce({ code: 11000 }).mockRejectedValueOnce(new Error('fixture failure')) };
    const repo = new MongoPersonalCatalog({ collection: () => c } as any);
    expect(await repo.compareAndSwap(owner, 0, row)).toBe(false); await expect(repo.compareAndSwap(owner, 0, row)).rejects.toThrow('fixture failure');
    expect(c.insertOne).toHaveBeenCalledTimes(2);
  });
});

describe('acquisition reservations and recovery', () => {
  const policy = { maxPer24Hours: 2, minimumIntervalMs: 1000, leaseMs: 30000 };
  const lease = (startedAt = 10000) => ({ id: 'attempt', sourceId: 'feed', sourceRevision: 1, startedAt, expiresAt: startedAt + 30000 });
  const row = (f: ReturnType<typeof setup>) => f.store.rows.get(personalRadarOwner(context()))!;
  it.each([
    { maxPer24Hours: 0 }, { maxPer24Hours: 257 }, { minimumIntervalMs: -1 }, { minimumIntervalMs: 86400001 },
    { leaseMs: 99 }, { leaseMs: 60001 }, { leaseMs: NaN }, { owner: 'self-selected' },
  ])('rejects invalid server policy %j', change => {
    expect(() => reserveAcquisition(undefined, { ...policy, ...change }, lease())).toThrow();
  });
  it('counts failed reservations in a sliding window, not a midnight-reset bucket', () => {
    let state = releaseAcquisition(reserveAcquisition(undefined, policy, lease()), 10000);
    expect(() => reserveAcquisition(state, policy, lease(10999))).toThrow('RATE_LIMITED');
    state = releaseAcquisition(reserveAcquisition(state, policy, lease(11000)), 11000);
    expect(() => reserveAcquisition(state, policy, lease(86409999))).toThrow('RATE_LIMITED');
    expect(reserveAcquisition(state, policy, lease(86410000)).starts).toEqual([11000, 86410000]);
  });
  it('requires explicit recovery of expired leases and rejects clock rollback or changed policy', () => {
    const state = reserveAcquisition(undefined, policy, lease());
    expect(() => reserveAcquisition(state, policy, lease(50000))).toThrow('BUSY');
    const released = releaseAcquisition(state, 50000);
    expect(() => reserveAcquisition(released, policy, lease(49999))).toThrow('CLOCK_ROLLBACK');
    expect(() => reserveAcquisition(released, { ...policy, maxPer24Hours: 3 }, lease(51000))).toThrow('POLICY_MISMATCH');
  });
  it.each([null, { version: 9 }, { starts: [20, 10] }, { starts: [10001] }, { lease: { id: 'partial' } }, { starts: Array(257).fill(10) }])
    ('fails closed on corrupt durable acquisition state %j', change => {
      const state = reserveAcquisition(undefined, policy, lease());
      expect(validAcquisitionState(change === null ? null : { ...state, ...change })).toBe(false);
    });
  it('has no unbudgeted collect path by default, without affecting settings/preview reads', async () => {
    const f = setup(); await f.configure(); const off = new PersonalRadarService(f.store, () => initialNow);
    await errorCode(off.collect(context(), 'feed', f.connector, new AbortController().signal, async () => context()), 'UNAVAILABLE');
    expect(f.http.get).not.toHaveBeenCalled(); expect((await off.sources(context())).sources).toHaveLength(1);
  });
  it('records a reservation and outcome atomically with content; hides leases/budgets from browser DTO', async () => {
    const f = setup(); await f.configure(); await f.collect();
    expect(row(f).audit.map(a => a.action)).toEqual(['configure', 'reserve', 'collect']);
    expect(row(f).acquisition).toMatchObject({ starts: [initialNow], lease: null });
    expect(row(f).audit[1].attemptId).toBe(row(f).audit[2].attemptId);
    expect(await f.service.sources(context())).not.toHaveProperty('acquisition');
  });
  it('limits across source IDs, configuration changes and revocation, while isolating other owners', async () => {
    const f = setup({ ...fixturePolicy, maxPer24Hours: 1 }); await f.configure(); await f.collect();
    await f.service.revoke(context(), 'feed', 3);
    await f.service.configure(context(), 'other', { expectedRevision: 4, source: configuration() }, async () => context());
    await errorCode(f.service.collect(context(), 'other', f.connector, new AbortController().signal), 'RATE_LIMITED');
    await f.configure('bob'); await f.collect('bob'); expect(f.http.get).toHaveBeenCalledTimes(2);
  });
  it('does not refund failed HTTP or expose raw errors in persisted audit', async () => {
    const f = setup({ ...fixturePolicy, maxPer24Hours: 1 }); await f.configure(); f.http.get.mockRejectedValue(new Error('secret payload'));
    await errorCode(f.collect(), 'UNAVAILABLE'); await errorCode(f.collect(), 'RATE_LIMITED');
    expect(f.http.get).toHaveBeenCalledTimes(1); expect(row(f).acquisition?.lease).toBeNull();
    expect(row(f).audit.at(-1)).toMatchObject({ action: 'collect_failed', outcome: 'failed' });
    expect(JSON.stringify(row(f).audit)).not.toContain('secret');
  });
  it('does not fetch after an acknowledged write is lost, and recovery does not refund or fetch', async () => {
    const f = setup({ ...fixturePolicy, maxPer24Hours: 1 }); await f.configure(); const cas = f.store.compareAndSwap.getMockImplementation()!;
    f.store.compareAndSwap.mockImplementationOnce(async (...args) => { await cas(...args); throw new Error('lost acknowledgement'); });
    await expect(f.collect()).rejects.toThrow('lost acknowledgement'); expect(f.http.get).not.toHaveBeenCalled();
    expect(row(f).revision).toBe(2); f.advance(30001);
    const reloaded = new PersonalRadarService(f.store, () => initialNow + 30001, { ...fixturePolicy, maxPer24Hours: 1 });
    await errorCode(reloaded.collect(context(), 'feed', f.connector, new AbortController().signal, async () => context()), 'BUSY');
    expect(await reloaded.maintain(context(), 2, async () => context())).toEqual({ revision: 3, removed: 0, recovered: true });
    await errorCode(reloaded.collect(context(), 'feed', f.connector, new AbortController().signal, async () => context()), 'RATE_LIMITED');
    expect(f.http.get).not.toHaveBeenCalled(); expect(row(f).audit.at(-1)?.outcome).toBe('recovered');
  });
  it('does not release another attempt or persist a stale result after recovery and a newer collection', async () => {
    const f = setup(); await f.configure(); let enter!: () => void; let finish!: (value: string) => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    f.http.get.mockImplementationOnce(() => { enter(); return new Promise<string>(resolve => { finish = resolve; }); });
    const old = f.collect(); const rejection = errorCode(old, 'LEASE_EXPIRED'); await entered;
    f.advance(30001); await f.service.maintain(context(), 2, async () => context());
    f.http.get.mockResolvedValue(xml('New result')); await f.collect();
    const newer = structuredClone(row(f)); finish(xml('Stale result')); await rejection;
    expect(row(f)).toEqual(newer); expect((await f.service.preview(context())).items[0].card.title).toBe('New result');
  });
  it('bounds an uncooperative connector and leaves no late persistence continuation', async () => {
    const f = setup({ ...fixturePolicy, leaseMs: 100 }); await f.configure(); let finish!: (v: string) => void;
    f.http.get.mockImplementationOnce(() => new Promise<string>(resolve => { finish = resolve; }));
    await errorCode(f.collect(), 'LEASE_EXPIRED'); const settled = structuredClone(row(f));
    expect(settled.sources[0].records).toEqual([]); finish(xml());
    await Promise.resolve(); await Promise.resolve(); expect(row(f)).toEqual(settled);
  });
  it('leaves a recoverable lease when failure settlement cannot be written', async () => {
    const f = setup(); await f.configure(); const cas = f.store.compareAndSwap.getMockImplementation()!;
    f.store.compareAndSwap.mockImplementation(async (...args) => args[2].audit.at(-1)?.action === 'collect_failed' ? false : cas(...args));
    f.http.get.mockRejectedValue(new Error('fixture'));
    await errorCode(f.collect(), 'UNAVAILABLE'); expect(row(f).acquisition?.lease).not.toBeNull();
    f.advance(30001); await f.service.maintain(context(), 2, async () => context());
    expect(row(f).acquisition?.lease).toBeNull(); expect(row(f).acquisition?.starts).toHaveLength(1);
  });
  it.each(['cancel', 'expire'] as const)('checks %s after the final authorization await, before metadata commit', async kind => {
    const f = setup({ ...fixturePolicy, leaseMs: 1000 }); await f.configure();
    let calls = 0; const abort = new AbortController();
    f.refresh.mockImplementation(async c => { if (++calls === 3) { if (kind === 'cancel') abort.abort(); else f.advance(1001); } return c; });
    await errorCode(f.collect('alice', abort.signal), kind === 'cancel' ? 'CANCELLED' : 'LEASE_EXPIRED');
    expect(f.http.get).toHaveBeenCalledTimes(1); expect(row(f).sources[0].records).toEqual([]);
    expect(row(f).acquisition?.starts).toHaveLength(1);
  });
  it('refuses a corrupt persisted budget before connector I/O instead of resetting it', async () => {
    const f = setup(); await f.configure(); f.store.rows.set(row(f).owner, { ...row(f), acquisition: { version: 9 } as any });
    await errorCode(f.collect(), 'UNAVAILABLE'); expect(f.http.get).not.toHaveBeenCalled();
  });
});

describe('owner-scoped expiry maintenance', () => {
  it('purges retention-expired records even when source consent remains valid', async () => {
    const f = setup(); await f.configure('alice', 0, { ...configuration(), retentionMs: 300000 }); await f.collect();
    f.advance(240001);
    expect(await f.service.maintain(context(), 3, async () => context())).toEqual({ revision: 4, removed: 1, recovered: false });
    expect((await f.service.sources(context())).sources[0].source?.enabled).toBe(true);
  });
  it('never overwrites a concurrent configuration while purging an older snapshot', async () => {
    const f = setup(); await f.configure('alice', 0, { ...configuration(), consentExpiresAt: initialNow + 1000 }); await f.collect(); f.advance(1001);
    const original = f.store.read.getMockImplementation()!;
    f.store.read.mockImplementationOnce(async owner => {
      const before = await original(owner); await f.configure('alice', 3, { ...configuration(), topicIds: ['science'] }); return before;
    });
    await errorCode(f.service.maintain(context(), 3, async () => context()), 'CONFLICT');
    expect((await f.service.sources(context())).sources[0].source?.topicIds).toEqual(['science']);
  });
  it('physically removes expired metadata, retaining settings, IDs and consumed attempts', async () => {
    const f = setup(); await f.configure('alice', 0, { ...configuration(), consentExpiresAt: initialNow + 1000 }); await f.collect();
    const owner = personalRadarOwner(context()); f.advance(1001);
    expect((await f.service.preview(context())).items).toEqual([]); expect(f.store.rows.get(owner)!.sources[0].records).toHaveLength(1);
    expect(await f.service.maintain(context(), 3, async () => context())).toEqual({ revision: 4, removed: 1, recovered: false });
    const row = f.store.rows.get(owner)!; expect(row.sources[0].records).toEqual([]); expect(row.sources[0].source).not.toBeNull();
    expect(row.acquisition?.starts).toHaveLength(1); expect(row.audit.at(-1)).toMatchObject({ action: 'maintain', removed: 1 });
    expect(JSON.stringify(row)).not.toContain('Fixture game');
  });
  it('retains unexpired metadata, performs no no-op writes, and cannot select another owner', async () => {
    const f = setup(); await f.configure(); await f.collect(); const casCount = f.store.compareAndSwap.mock.calls.length;
    expect(await f.service.maintain(context(), 3, async () => context())).toEqual({ revision: 3, removed: 0, recovered: false });
    expect(await f.service.maintain(context('bob'), 0, async () => context('bob'))).toEqual({ revision: 0, removed: 0, recovered: false });
    expect(f.store.compareAndSwap).toHaveBeenCalledTimes(casCount);
    expect((await f.service.preview(context())).items).toHaveLength(1);
  });
  it.each(['stale', 'reauth', 'missing'] as const)('rejects %s maintenance without deleting', async kind => {
    const f = setup(); await f.configure('alice', 0, { ...configuration(), consentExpiresAt: initialNow + 1000 }); await f.collect(); f.advance(1001);
    const owner = personalRadarOwner(context()); const before = structuredClone(f.store.rows.get(owner));
    await errorCode(f.service.maintain(context(), kind === 'stale' ? 2 : 3,
      kind === 'missing' ? undefined as any : async () => context(kind === 'reauth' ? 'bob' : 'alice')), 'CONFLICT');
    expect(f.store.rows.get(owner)).toEqual(before);
  });
  it('preserves an ID tombstone during expiry cleanup', async () => {
    const f = setup(); await f.configure(); await f.collect(); await f.service.revoke(context(), 'feed', 3);
    await f.service.maintain(context(), 4, async () => context());
    await errorCode(f.configure('alice', 4), 'CONFLICT');
  });
});

async function sessionFixture(count = 1) {
  const f = setup();
  const ids = ['feed', 'second', 'third'].slice(0, count);
  for (let i = 0; i < ids.length; i++) await f.service.configure(context(), ids[i], { expectedRevision: i, source: configuration() });
  const verify = vi.fn(async (_token: string) => ({ projectId: 'fixture', uid: 'alice', email: 'same@example.test',
    emailVerified: true, expiresAtMs: f.now() + 3600000 }));
  const users = vi.fn(async (projectId: string, uid: string) => ({ projectId, uid, name: 'fixture', email: 'same@example.test', isAuthorized: true, isAdmin: false }));
  const access = new AccessService({ verify }, { findByIdentity: users }, () => 'fixture', f.now);
  const runner = new RadarSessionRunner(access, f.service, f.connector, f.now);
  const request = { expectedRevision: count, sourceIds: ids };
  const run = (body: unknown = request, signal = new AbortController().signal, token: unknown = 'fixture-token') => runner.run(token, body, signal);
  f.store.read.mockClear(); f.store.compareAndSwap.mockClear();
  return { ...f, ids, verify, users, runner, request, run };
}

describe('foreground Radar session runner with real AccessService and synthetic identity verifier', () => {
  it('executes only the selected sources sequentially and reauthenticates through the access boundary', async () => {
    const f = await sessionFixture(3); let active = 0; let max = 0;
    f.http.get.mockImplementation(async () => { active++; max = Math.max(max, active); await Promise.resolve(); active--; return xml(); });
    expect(await f.run()).toEqual({ revision: 9, completedSourceIds: f.ids });
    expect(max).toBe(1); expect(f.http.get).toHaveBeenCalledTimes(3);
    expect(f.verify.mock.calls.length).toBeGreaterThanOrEqual(11); expect(f.users).toHaveBeenCalledTimes(f.verify.mock.calls.length);
    const row = f.store.rows.get(personalRadarOwner(context()))!;
    expect(row.acquisition?.starts).toHaveLength(3); expect(JSON.stringify(row)).not.toContain('fixture-token');
  });
  it.each([null, {}, { expectedRevision: 1, sourceIds: [] }, { expectedRevision: 1, sourceIds: ['feed', 'feed'] },
    { expectedRevision: 1, sourceIds: ['a', 'b', 'c', 'd'] }, { expectedRevision: -1, sourceIds: ['feed'] },
    { expectedRevision: 1, sourceIds: ['feed'], owner: 'bob' }, { expectedRevision: 1, sourceIds: ['../feed'] }])
    ('rejects malformed or self-selected authority input before auth/catalog: %j', async body => {
      const f = await sessionFixture(); await errorCode(f.run(body), 'INVALID_INPUT');
      expect(f.verify).not.toHaveBeenCalled(); expect(f.store.read).not.toHaveBeenCalled(); expect(f.http.get).not.toHaveBeenCalled();
    });
  it.each(['missing-token', 'blocked', 'unverified'] as const)('rejects %s before reading the catalog', async kind => {
    const f = await sessionFixture();
    if (kind === 'blocked') f.users.mockImplementation(async (projectId, uid) => ({ projectId, uid, name: '', email: '', isAuthorized: false, isAdmin: false }));
    if (kind === 'unverified') f.verify.mockImplementation(async () => ({ projectId: 'fixture', uid: 'alice', email: 'x@example.test', emailVerified: false, expiresAtMs: f.now() + 1000 }));
    await errorCode(f.run(f.request, new AbortController().signal, kind === 'missing-token' ? null : 'fixture-token'), kind === 'blocked' ? 'FORBIDDEN' : 'UNAUTHENTICATED');
    expect(f.store.read).not.toHaveBeenCalled(); expect(f.http.get).not.toHaveBeenCalled();
  });
  it.each(['stale', 'missing', 'disabled'] as const)('preflights the entire selection without collection: %s', async kind => {
    const f = await sessionFixture(2);
    if (kind === 'disabled') { await f.service.configure(context(), 'second', { expectedRevision: 2, source: { ...configuration(), enabled: false } }); f.request.expectedRevision = 3; }
    await errorCode(f.run(kind === 'stale' ? { ...f.request, expectedRevision: 0 } : kind === 'missing' ? { ...f.request, sourceIds: ['feed', 'missing'] } : f.request), kind === 'stale' ? 'CONFLICT' : 'NOT_FOUND');
    expect(f.http.get).not.toHaveBeenCalled();
  });
  it('clones selection before any asynchronous boundary', async () => {
    const f = await sessionFixture(); const original = f.verify.getMockImplementation()!;
    f.verify.mockImplementationOnce(async t => { f.request.sourceIds[0] = 'injected'; return original(t); });
    expect(await f.run()).toEqual({ revision: 3, completedSourceIds: ['feed'] });
  });
  it('fences catalog edits between preflight and reservation, without collecting replacement configuration', async () => {
    const f = await sessionFixture(); const original = f.verify.getMockImplementation()!;
    let n = 0; f.verify.mockImplementation(async t => {
      if (++n === 2) await f.service.configure(context(), 'feed', { expectedRevision: 1, source: { ...configuration(), locator: 'https://example.org/new' } });
      return original(t);
    });
    await errorCode(f.run(), 'CONFLICT'); expect(f.http.get).not.toHaveBeenCalled();
  });
  it.each(['revoked', 'owner', 'project'] as const)('halts after acquisition on changed authorization: %s', async kind => {
    const f = await sessionFixture(2);
    f.http.get.mockImplementation(async () => {
      if (kind === 'revoked') f.verify.mockRejectedValue(new AccessError('FORBIDDEN'));
      else f.verify.mockResolvedValue({ projectId: kind === 'project' ? 'other' : 'fixture', uid: kind === 'owner' ? 'bob' : 'alice', email: 'same@example.test', emailVerified: true, expiresAtMs: f.now() + 10000 });
      return xml();
    });
    await errorCode(f.run(), kind === 'revoked' ? 'FORBIDDEN' : 'CONFLICT'); expect(f.http.get).toHaveBeenCalledTimes(1);
    expect(f.store.rows.get(personalRadarOwner(context()))!.sources.every(s => !s.records.length)).toBe(true);
  });
  it('never retries an unknown reservation ACK and strips raw repository errors', async () => {
    const f = await sessionFixture(2); const original = f.store.compareAndSwap.getMockImplementation()!;
    f.store.compareAndSwap.mockImplementationOnce(async (...args) => { await original(...args); throw new Error('fixture-token secret'); });
    await errorCode(f.run(), 'UNAVAILABLE'); expect(f.http.get).not.toHaveBeenCalled(); expect(f.store.compareAndSwap).toHaveBeenCalledTimes(1);
    expect(f.store.rows.get(personalRadarOwner(context()))!.acquisition?.lease).not.toBeNull();
  });
  it('keeps earlier committed success when later source fails, without retrying or claiming batch success', async () => {
    const f = await sessionFixture(3); f.http.get.mockResolvedValueOnce(xml()).mockRejectedValueOnce(new Error('failed'));
    await errorCode(f.run(), 'UNAVAILABLE'); expect(f.http.get).toHaveBeenCalledTimes(2);
    const row = f.store.rows.get(personalRadarOwner(context()))!;
    expect(row.sources.map(s => s.records.length)).toEqual([1, 0, 0]); expect(row.acquisition?.starts).toHaveLength(2);
  });
  it('rereads the catalog after final auth instead of returning stale success', async () => {
    const f = await sessionFixture(); const original = f.verify.getMockImplementation()!;
    f.verify.mockImplementation(async t => {
      const row = f.store.rows.get(personalRadarOwner(context()))!;
      if (row.revision === 3) await f.service.revoke(context(), 'feed', 3);
      return original(t);
    });
    await errorCode(f.run(), 'CONFLICT'); expect(f.http.get).toHaveBeenCalledTimes(1);
  });
  it('cancels before initial auth without catalog reads', async () => {
    const f = await sessionFixture(); const abort = new AbortController(); abort.abort();
    await errorCode(f.run(f.request, abort.signal), 'CANCELLED'); expect(f.verify).not.toHaveBeenCalled();
  });
  it('bounds hung authentication and blocks its late continuation', async () => {
    vi.useFakeTimers(); const f = await sessionFixture(); let finish!: (value: any) => void;
    const identity = await f.verify('fixture-token');
    f.verify.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = errorCode(f.run(), 'CANCELLED'); await vi.advanceTimersByTimeAsync(RADAR_SESSION_MAX_MS); await pending;
    finish(identity); await vi.advanceTimersByTimeAsync(1);
    expect(f.store.read).not.toHaveBeenCalled(); expect(f.http.get).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('cancels hung connector and suppresses late metadata after returning', async () => {
    vi.useFakeTimers(); const f = await sessionFixture(); let finish!: (v: string) => void; let enter!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    f.http.get.mockImplementation(() => { enter(); return new Promise(resolve => { finish = resolve; }); });
    const abort = new AbortController(); const pending = errorCode(f.run(f.request, abort.signal), 'CANCELLED');
    await entered; abort.abort(); await pending; await vi.advanceTimersByTimeAsync(1);
    finish(xml()); await vi.advanceTimersByTimeAsync(1);
    const row = f.store.rows.get(personalRadarOwner(context()))!;
    expect(row.sources[0].records).toEqual([]); expect(row.acquisition?.starts).toHaveLength(1); expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['deadline', 'rollback'] as const)('rejects wall clock %s even before the real timer fires', async kind => {
    const f = await sessionFixture(); const original = f.verify.getMockImplementation()!;
    f.verify.mockImplementationOnce(async t => { const identity = await original(t); f.advance(kind === 'deadline' ? RADAR_SESSION_MAX_MS : -1); return identity; });
    await errorCode(f.run(), 'CANCELLED'); expect(f.store.read).not.toHaveBeenCalled();
  });
  it('allows only one concurrent claim for the same selected catalog revision', async () => {
    const f = await sessionFixture(); const results = await Promise.allSettled(Array.from({ length: 8 }, () => f.run()));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1); expect(f.http.get).toHaveBeenCalledTimes(1);
  });
});

describe('owner audit coverage and bounded retention', () => {
  it('reports capacity truncation explicitly and exposes fixed attempt outcomes without content or identity', async () => {
    const f = setup(); await f.configure();
    for (let n = 1; n < 70; n++) await f.configure('alice', n);
    const view = await f.service.audit(context(), async () => context());
    expect(view).toMatchObject({ revision: 70, omittedThroughRevision: 6, completeFromRevisionOne: false, capacity: 64 });
    expect(view.events).toHaveLength(64);
    await f.collect(); const collected = await f.service.audit(context(), async () => context());
    expect(collected.events.at(-1)?.attemptId).toBe(collected.events.at(-2)?.attemptId);
    expect(JSON.stringify(collected)).not.toMatch(/https|Fixture game|example.org|firebase:|alice|email|token/);
    expect((await f.service.audit(context('bob'), async () => context('bob'))).events).toEqual([]);
  });
  it('filters at the retention boundary and physically purges only on explicit owner maintenance', async () => {
    const f = setup(); await f.configure(); await f.configure('bob'); f.advance(RADAR_AUDIT_RETENTION_MS);
    const c = { ...context(), expiresAtMs: f.now() + 10000 };
    const view = await f.service.audit(c, async () => c);
    expect(view).toMatchObject({ revision: 1, events: [], omittedThroughRevision: 1, completeFromRevisionOne: false });
    expect((await f.service.sources(c)).audit).toEqual([]);
    expect(f.store.rows.get(personalRadarOwner(context()))!.audit).toHaveLength(1);
    const bob = structuredClone(f.store.rows.get(personalRadarOwner(context('bob')))!), owner = personalRadarOwner(c, f.now());
    expect(await f.service.maintain(c, 1, async () => c)).toEqual({ revision: 2, removed: 0, recovered: false });
    expect(f.store.rows.get(owner)!.audit.map(e => e.action)).toEqual(['maintain']);
    expect(f.store.rows.get(personalRadarOwner(context('bob')))).toEqual(bob);
    expect((await f.service.audit(c, async () => c)).omittedThroughRevision).toBe(1);
  });
  it('retains an event until just before its boundary, and distinguishes empty legacy history from completeness', () => {
    const event = { revision: 1, at: initialNow, sourceId: 'feed', action: 'configure' as const, added: 0, updated: 0, unchanged: 0 };
    expect(catalogAuditView([event], 1, initialNow + RADAR_AUDIT_RETENTION_MS - 1).events).toHaveLength(1);
    expect(catalogAuditView([], 12, initialNow)).toMatchObject({ omittedThroughRevision: 12, completeFromRevisionOne: false });
    expect(catalogAuditView([], 0, initialNow)).toMatchObject({ omittedThroughRevision: 0, completeFromRevisionOne: true });
  });
  it.each(['reauth', 'identity', 'concurrent'] as const)('withholds audit after %s changes', async kind => {
    const f = setup(); await f.configure();
    await errorCode(f.service.audit(context(), async () => {
      if (kind === 'reauth') throw new AccessError('FORBIDDEN');
      if (kind === 'concurrent') await f.configure('alice', 1);
      return kind === 'identity' ? context('bob') : context();
    }), kind === 'reauth' ? 'FORBIDDEN' : 'CONFLICT');
  });
  it.each([{ action: 'arbitrary' }, { extra: 'secret' }, { at: -1 }, { revision: 2 }, { removed: -1 }, { outcome: 'secret' }])
    ('fails closed on malformed audit without writes: %j', change => {
      // Checked asynchronously below; no connector is involved.
      return (async () => {
        const f = setup(); await f.configure(); const row = f.store.rows.get(personalRadarOwner(context()))!;
        (row.audit as any)[0] = { ...row.audit[0], ...change }; f.store.compareAndSwap.mockClear();
        await errorCode(f.service.audit(context(), async () => context()), 'UNAVAILABLE'); expect(f.store.compareAndSwap).not.toHaveBeenCalled();
      })();
    });
  it('serves audit only after HTTP reauthorization, no-store, and never honors owner query', async () => {
    const f = await api(); await f.configure(); await f.collect();
    const res = await f.request('/api/radar/audit'); expect(res.status).toBe(200); expect(res.headers.get('cache-control')).toBe('no-store');
    expect((await res.json() as any).events.at(-1)).toMatchObject({ action: 'collect', added: 1 });
    expect((await f.request('/api/radar/audit?owner=alice', 'admin')).status).toBe(400);
    expect((await (await f.request('/api/radar/audit', 'admin')).json() as any).events).toEqual([]);
    f.verify.mockResolvedValueOnce({ projectId: 'fixture', uid: 'alice', email: 'x@example.test', emailVerified: true, expiresAtMs: initialNow + 86400000 });
    f.verify.mockRejectedValueOnce(new AccessError('FORBIDDEN'));
    const denied = await f.request('/api/radar/audit'); expect(denied.status).toBe(403); expect(await denied.text()).not.toContain('attemptId');
  });
});

describe('audit response expiry fences', () => {
  it('caps response lifetime by the earliest audit retention deadline', async () => {
    const f = setup(); await f.configure(); f.advance(RADAR_AUDIT_RETENTION_MS - 50);
    const c = { ...context(), expiresAtMs: f.now() + 100000 };
    expect((await f.service.audit(c, async () => c)).validUntil).toBe(initialNow + RADAR_AUDIT_RETENTION_MS);
  });
  it('rejects expiry of the refreshed identity during final catalog read', async () => {
    const f = setup(); await f.configure(); const read = f.store.read.getMockImplementation()!; let count = 0;
    f.store.read.mockImplementation(async owner => { const row = await read(owner); if (++count === 2) f.advance(51); return row; });
    await errorCode(f.service.audit(context(), async () => ({ ...context(), expiresAtMs: initialNow + 50 })), 'UNAUTHENTICATED');
  });
  it('does not prune or return audit when the clock regresses', async () => {
    const f = setup(); await f.configure(); f.advance(-1); f.store.compareAndSwap.mockClear();
    await expect(f.service.audit(context(), async () => context())).rejects.toThrow('RADAR_AUDIT_CLOCK');
    await expect(f.service.maintain(context(), 1, async () => context())).rejects.toThrow('RADAR_AUDIT_CLOCK');
    expect(f.store.compareAndSwap).not.toHaveBeenCalled();
  });
});
