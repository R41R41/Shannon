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
    collect(c: RequestContext, id: string, connector: FeedConnectorPort, signal: AbortSignal, auth: ReauthorizeRadar = () => refresh(c)) { return super.collect(c, id, connector, signal, auth); }
  }
  const store = new FixtureStore(); const service = new FixtureRadar(store, () => now, policy);
  const http = { get: vi.fn(async () => xml()) }; const connector = new PublicFeedConnector(http, () => now);
  return { store, service, http, connector, refresh, advance: (ms: number) => { now += ms; },
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
afterEach(async () => { if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined; } });
async function api() {
  const f = setup(); const verify = vi.fn(async (token: string) => {
    if (token === 'revoked') throw new AccessError('UNAUTHENTICATED');
    return { projectId: 'fixture', uid: token, email: 'same@example.test', emailVerified: true, expiresAtMs: initialNow + 86400000 };
  });
  const users = vi.fn(async (projectId: string, uid: string) => ({ projectId, uid, name: 'Same', email: 'same@example.test', isAuthorized: uid !== 'blocked', isAdmin: uid === 'admin' }));
  const access = new AccessService({ verify }, { findByIdentity: users }, () => 'request');
  const app = express(); registerRadarRoutes(app, access, f.service);
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${(server!.address() as { port: number }).port}`;
  const request = (path: string, token = 'alice', method = 'GET', body?: unknown) => fetch(url + path, {
    method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { ...f, request, users, verify };
}
describe('personal Radar HTTP boundary (isolated Express fixture only)', () => {
  it.each([['GET', '/api/radar/sources'], ['GET', '/api/radar/preview'], ['PUT', '/api/radar/sources/feed'], ['DELETE', '/api/radar/sources/feed']])
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
