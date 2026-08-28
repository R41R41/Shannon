'use strict';
// Standalone, synthetic fixture only. Never imports app bootstrap or connects to normal DB listeners.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
async function main() {
  const root = fs.realpathSync(path.join(__dirname, '..'));
  assert.equal(root, '/home/azureuser/Shannon-dev');
  assert.deepEqual(process.argv.slice(2), ['--isolated-fixture']);
  assert(fs.existsSync(path.join(root, '.dev-runtime-lock')));
  const mongoose = require('mongoose');
  const client = new mongoose.mongo.MongoClient('mongodb://127.0.0.1:37029/shannon_radar_fixture', { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  try {
    const db = client.db('shannon_radar_fixture');
    assert.deepEqual(await db.listCollections({}, { nameOnly: true }).toArray(), [], 'New empty fixture database required');
    const load = file => import(pathToFileURL(path.join(root, 'backend/dist', file)).href);
    const { MongoPersonalCatalog } = await load('services/radar/mongoPersonalCatalog.js');
    const { PersonalRadarService, personalRadarOwner } = await load('services/radar/personalRadar.js');
    const { parseFeed } = await load('services/radar/feedConnector.js');
    const now = Date.now();
    const context = uid => ({ requestId: 'fixture', principal: { projectId: 'fixture', uid, name: 'same', email: 'fixture@example.test' }, capabilities: ['profile:read'], expiresAtMs: now + 3600000 });
    const alice = context('alice'); const bob = context('bob');
    const config = { enabled: true, consentExpiresAt: now + 86400000, kind: 'web', locator: 'https://example.org/feed',
      articleHosts: ['example.org'], topicIds: ['games'], maxItems: 20, retentionMs: 86400000 };
    // Synthetic authority callbacks; this is not a Firebase integration test.
    class FixtureRadar extends PersonalRadarService {
      configure(c, id, body) { return super.configure(c, id, body, async () => c); }
      revoke(c, id, expected) { return super.revoke(c, id, expected, async () => c); }
      collect(c, id, connector, signal) { return super.collect(c, id, connector, signal, async () => c); }
    }
    let clock = now;
    const fixturePolicy = { maxPer24Hours: 2, minimumIntervalMs: 0, leaseMs: 30000 };
    const service = new FixtureRadar(new MongoPersonalCatalog(db), () => clock, fixturePolicy);
    const creates = await Promise.allSettled(Array.from({ length: 8 }, () => service.configure(alice, 'feed', { expectedRevision: 0, source: config })));
    assert.equal(creates.filter(r => r.status === 'fulfilled').length, 1);
    const xml = `<feed><entry><id>fixture-1</id><title>Fixture only</title><link href="https://example.org/fixture"/><published>${new Date(now - 1000).toISOString()}</published></entry></feed>`;
    let arrived = 0;
    const connector = { read: async source => { ++arrived; return parseFeed(xml, source, clock); } };
    const collects = await Promise.allSettled(Array.from({ length: 8 }, () => service.collect(alice, 'feed', connector, new AbortController().signal)));
    assert.equal(collects.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(arrived, 1, 'Only the reserved winner may contact the connector');
    const reloaded = new PersonalRadarService(new MongoPersonalCatalog(db), () => clock, fixturePolicy);
    assert.equal((await reloaded.preview(alice)).items.length, 1);
    assert.deepEqual((await reloaded.preview(bob)).items, []);
    assert.equal(await db.collection('radarpersonalcatalogs').countDocuments({}), 1);
    const row = await db.collection('radarpersonalcatalogs').findOne({ _id: personalRadarOwner(alice) });
    assert.equal(row.revision, 3); assert.equal(row.sources[0].records.length, 1);
    assert.deepEqual(row.audit.map(e => e.action), ['configure', 'reserve', 'collect']);
    assert(!JSON.stringify(row.audit).includes('example.org'));
    const edits = await Promise.allSettled([service.configure(alice, 'feed', { expectedRevision: 3, source: config }), service.revoke(alice, 'feed', 3)]);
    assert.equal(edits.filter(r => r.status === 'fulfilled').length, 1);
    const state = await service.sources(alice);
    if (state.sources[0].source) await service.revoke(alice, 'feed', state.revision);
    const tombstone = await db.collection('radarpersonalcatalogs').findOne({ _id: personalRadarOwner(alice) });
    assert.deepEqual(tombstone.sources, [{ id: 'feed', source: null, records: [] }]);
    assert(!JSON.stringify(tombstone).includes('example.org'));
    await assert.rejects(service.configure(alice, 'feed', { expectedRevision: tombstone.revision, source: config }), { code: 'CONFLICT' });
    assert.deepEqual((await service.preview(alice)).items, []);
    // The next source shares the same owner budget, including after all previous sources were revoked.
    await service.configure(alice, 'second', { expectedRevision: tombstone.revision, source: config });
    const ownerId = personalRadarOwner(alice);
    const repository = new MongoPersonalCatalog(db);
    const { reserveAcquisition } = await load('modules/radar/acquisition.js');
    const beforeCrash = await repository.read(ownerId);
    const lease = { id: 'crashed-fixture', sourceId: 'second', sourceRevision: 1, startedAt: clock, expiresAt: clock + 30000 };
    const acquisition = reserveAcquisition(beforeCrash.acquisition, fixturePolicy, lease);
    assert(await repository.compareAndSwap(ownerId, beforeCrash.revision, { ...beforeCrash, revision: beforeCrash.revision + 1, acquisition }));
    const restart = new PersonalRadarService(new MongoPersonalCatalog(db), () => clock, fixturePolicy);
    clock += 30001;
    const recoveries = await Promise.allSettled(Array.from({ length: 8 }, () => restart.maintain(alice, beforeCrash.revision + 1, async () => alice)));
    assert.equal(recoveries.filter(r => r.status === 'fulfilled').length, 1);
    await assert.rejects(restart.collect(alice, 'second', connector, new AbortController().signal, async () => alice), { code: 'RATE_LIMITED' });
    assert.equal(arrived, 1);
    const restored = await new MongoPersonalCatalog(db).read(ownerId);
    assert.equal(restored.acquisition.lease, null); assert.equal(restored.acquisition.starts.length, 2);
    // Purge only the expired content of a different owner, preserving that owner's configuration and budget.
    await service.configure(bob, 'expiry', { expectedRevision: 0, source: { ...config, consentExpiresAt: clock + 1000 } });
    await service.collect(bob, 'expiry', connector, new AbortController().signal);
    clock += 1001;
    const bobId = personalRadarOwner(bob); const bobBefore = await repository.read(bobId);
    const aliceBefore = JSON.stringify(await repository.read(ownerId));
    const purges = await Promise.allSettled(Array.from({ length: 8 }, () => restart.maintain(bob, bobBefore.revision, async () => bob)));
    assert.equal(purges.filter(r => r.status === 'fulfilled').length, 1);
    const bobAfter = await repository.read(bobId);
    assert.equal(bobAfter.sources[0].records.length, 0); assert(bobAfter.sources[0].source);
    assert.equal(bobAfter.acquisition.starts.length, 1); assert(!JSON.stringify(bobAfter).includes('Fixture only'));
    assert.equal(JSON.stringify(await repository.read(ownerId)), aliceBefore);
    const indexes = await db.collection('radarpersonalcatalogs').indexes(); assert.deepEqual(indexes.map(i => i.name), ['_id_']);
    assert.deepEqual((await db.listCollections({}, { nameOnly: true }).toArray()).map(c => c.name), ['radarpersonalcatalogs']);
    console.log(JSON.stringify({ fixtureOnly: true, isolatedPort: 37029, concurrentCreates: 8, concurrentCollections: 8, concurrentRecoveries: 8, concurrentPurges: 8,
      singleConnectorCallForEightClaims: true, reservationSurvivesReload: true, recoveryDoesNotRefund: true, ownerScopedPhysicalPurge: true,
      singleCASWinner: true, ownerIsolation: true, repositoryReloadRead: true, contentAndAuditAtomic: true,
      revocationErasesMetadata: true, tombstoneReplayDenied: true, onlyFixtureCollection: true, noSecondaryIndex: true }));
  } finally { await client.close(); }
}
main().catch(error => { console.error('ISOLATED_RADAR_CATALOG_PROBE_FAILED', error.code ?? error.name); process.exitCode = 1; });
