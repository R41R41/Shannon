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
function setup() {
  let now = initialNow;
  const refresh = vi.fn(async (c: RequestContext) => c);
  class FixtureRadar extends PersonalRadarService {
    configure(c: RequestContext, id: string, body: unknown, auth: ReauthorizeRadar = () => refresh(c)) { return super.configure(c, id, body, auth); }
    revoke(c: RequestContext, id: string, expected: unknown, auth: ReauthorizeRadar = () => refresh(c)) { return super.revoke(c, id, expected, auth); }
    collect(c: RequestContext, id: string, connector: FeedConnectorPort, signal: AbortSignal, auth: ReauthorizeRadar = () => refresh(c)) { return super.collect(c, id, connector, signal, auth); }
  }
  const store = new FixtureStore(); const service = new FixtureRadar(store, () => now);
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
    await f.configure('alice', 2, { ...configuration(), topicIds: ['science'] });
    const row = f.store.rows.get(personalRadarOwner(context()))!;
    expect(row.revision).toBe(3); expect(row.sources[0].source?.revision).toBe(2); expect(row.sources[0].records).toEqual([]);
    await f.collect(); expect((await f.service.preview(context())).items[0].matchedTopicIds).toEqual(['science']);
  });
  it('disables reads and deletes metadata immediately; re-enable requires a new collection', async () => {
    const f = setup(); await f.configure(); await f.collect();
    await f.configure('alice', 2, { ...configuration(), enabled: false });
    await errorCode(f.collect(), 'NOT_FOUND'); expect((await f.service.preview(context())).items).toEqual([]);
    await f.configure('alice', 3); expect((await f.service.preview(context())).items).toEqual([]);
  });
  it('removes settings/content on revoke, prevents ID resurrection and rejects stale CAS', async () => {
    const f = setup(); await f.configure(); await f.collect();
    await errorCode(f.service.revoke(context(), 'feed', 1), 'CONFLICT');
    await f.service.revoke(context(), 'feed', 2);
    const row = f.store.rows.get(personalRadarOwner(context()))!;
    expect(row.sources).toEqual([{ id: 'feed', source: null, records: [] }]);
    expect(JSON.stringify(row)).not.toMatch(/example.org|Fixture game|games/);
    await errorCode(f.configure('alice', 3), 'CONFLICT'); await errorCode(f.collect(), 'NOT_FOUND');
  });
  it('rejects an in-flight collection revoked while fetching, without restoring content', async () => {
    const f = setup(); await f.configure();
    f.http.get.mockImplementation(async () => { await f.service.revoke(context(), 'feed', 1); return xml(); });
    await errorCode(f.collect(), 'CONFLICT'); expect(f.store.rows.get(personalRadarOwner(context()))!.sources[0].source).toBeNull();
  });
  it('allows only one concurrent collection/configuration winner, without silent retry', async () => {
    const f = setup(); const creates = await Promise.allSettled([f.configure(), f.configure()]);
    expect(creates.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const collects = await Promise.allSettled(Array.from({ length: 8 }, () => f.collect()));
    expect(collects.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(f.store.rows.get(personalRadarOwner(context()))!.revision).toBe(2);
  });
  it('also fences revocation between final registry read and commit', async () => {
    const f = setup(); await f.configure(); const original = f.store.compareAndSwap.getMockImplementation()!;
    f.store.compareAndSwap.mockImplementationOnce(async (...args) => {
      f.store.compareAndSwap.mockImplementation(original); await f.service.revoke(context(), 'feed', 1); return original(...args);
    });
    await errorCode(f.collect(), 'CONFLICT'); expect((await f.service.preview(context())).items).toEqual([]);
  });
  it.each(['before', 'during'] as const)('does not store cancelled collection %s fetch', async when => {
    const f = setup(); await f.configure(); const abort = new AbortController();
    if (when === 'before') abort.abort(); else f.http.get.mockImplementation(async () => { abort.abort(); return xml(); });
    await errorCode(f.collect('alice', abort.signal), 'CANCELLED'); expect(f.store.rows.get(personalRadarOwner(context()))!.revision).toBe(1);
  });
  it('checks identity expiry after I/O before committing', async () => {
    const f = setup(); await f.configure(); f.http.get.mockImplementation(async () => { f.advance(86400001); return xml(); });
    await expect(f.collect()).rejects.toBeInstanceOf(AccessError);
    expect(f.store.rows.get(personalRadarOwner(context()))!.revision).toBe(1);
  });
  it.each(['revoked', 'changed-owner'] as const)('renews identity before saving after collection: %s', async kind => {
    const f = setup(); await f.configure();
    f.http.get.mockImplementation(async () => {
      if (kind === 'revoked') f.refresh.mockRejectedValue(new AccessError('FORBIDDEN'));
      else f.refresh.mockResolvedValue(context('bob'));
      return xml();
    });
    await errorCode(f.collect(), kind === 'revoked' ? 'FORBIDDEN' : 'CONFLICT');
    expect(f.store.rows.get(personalRadarOwner(context()))!.revision).toBe(1);
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
    await errorCode(f.collect('alice', abort.signal), kind === 'cancel' ? 'CANCELLED' : 'CONFLICT');
    expect(f.store.rows.get(personalRadarOwner(context()))!.revision).toBe(1);
  });
  it('hides expired sources without physical deletion claims', async () => {
    const f = setup(); await f.configure('alice', 0, { ...configuration(), consentExpiresAt: initialNow + 1000 }); await f.collect();
    f.advance(1001); expect((await f.service.preview(context())).items).toEqual([]); await errorCode(f.collect(), 'NOT_FOUND');
    expect(f.store.rows.get(personalRadarOwner(context()))!.sources[0].records).toHaveLength(1);
  });
  it('discards a preview when its aggregate changes during the read', async () => {
    const f = setup(); await f.configure(); await f.collect(); const original = f.store.read.getMockImplementation()!;
    f.store.read.mockImplementationOnce(async owner => { const row = await original(owner); await f.service.revoke(context(), 'feed', 2); return row; });
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
    expect(f.store.rows.get(personalRadarOwner(context()))!.revision).toBe(1);
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
    expect((await f.request('/api/radar/sources/feed', 'alice', 'DELETE', { expectedRevision: 2 })).status).toBe(200);
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
    let n = 0; f.verify.mockImplementation(async token => { if (++n === 2) await f.service.revoke(context(), 'feed', 2); return original(token); });
    expect((await f.request('/api/radar/preview')).status).toBe(409);
  });
  it('has no live collect, publication, identity-linking or scheduler endpoint', async () => {
    const f = await api();
    for (const path of ['/api/radar/collect', '/api/radar/publish', '/api/radar/link']) expect((await f.request(path, 'alice', 'POST', {})).status).toBe(404);
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
    expect(c.replaceOne.mock.calls[0][2]).toEqual({ upsert: false });
  });
  it('treats insert duplicate as a conflict, propagates database failure, never retries', async () => {
    const owner = personalRadarOwner(context()); const row = { owner, revision: 1, sources: [], audit: [] };
    const c = { insertOne: vi.fn().mockRejectedValueOnce({ code: 11000 }).mockRejectedValueOnce(new Error('fixture failure')) };
    const repo = new MongoPersonalCatalog({ collection: () => c } as any);
    expect(await repo.compareAndSwap(owner, 0, row)).toBe(false); await expect(repo.compareAndSwap(owner, 0, row)).rejects.toThrow('fixture failure');
    expect(c.insertOne).toHaveBeenCalledTimes(2);
  });
});
