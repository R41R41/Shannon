'use strict';
// Standalone, synthetic fixture only. Never imports app bootstrap or connects to normal DB listeners.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
async function main() {
  const root = fs.realpathSync(path.join(__dirname, '..'));
  assert.equal(root, '/home/azureuser/Shannon-dev');
  assert.deepEqual(process.argv.slice(2), ['--isolated-fixture']);
  assert(fs.existsSync(path.join(root, '.dev-runtime-lock')));
  await new Promise((resolve, reject) => { const probe = net.createServer(); probe.once('error', reject); probe.listen(37029, '127.0.0.1', () => probe.close(resolve)); });
  const out = '/home/azureuser/.codex-shannon-preservation/radar-catalog-20260830';
  fs.mkdirSync(out, { recursive: true, mode: 0o700 });
  const data = fs.mkdtempSync(path.join(out, 'mongo-'));
  fs.chmodSync(data, 0o700);
  const mongoChild = spawn('mongod', ['--dbpath', data, '--bind_ip', '127.0.0.1', '--port', '37029', '--journal', '--logpath', path.join(data, 'mongod.log')], { stdio: 'ignore' });
  const mongoose = require('mongoose');
  let client;
  try {
    for (let i = 0; i < 50; i++) {
      client = new mongoose.mongo.MongoClient('mongodb://127.0.0.1:37029/shannon_radar_fixture', { serverSelectionTimeoutMS: 200, socketTimeoutMS: 5000 });
      try { await client.connect(); break; } catch { await client.close(); client = undefined; await new Promise(r => setTimeout(r, 100)); }
    }
    assert(client);
    const db = client.db('shannon_radar_fixture');
    assert.deepEqual(await db.listCollections({}, { nameOnly: true }).toArray(), [], 'New empty fixture database required');
    const load = file => import(pathToFileURL(path.join(root, 'backend/dist', file)).href);
    const { MongoPersonalCatalog } = await load('services/radar/mongoPersonalCatalog.js');
    const { PersonalRadarService, personalRadarOwner } = await load('services/radar/personalRadar.js');
    const { parseFeed } = await load('services/radar/feedConnector.js');
    const { CATALOG_VALIDATOR } = await load('modules/radar/catalogVersion.js');
    const { PersonalTemporalRadar } = await load('services/radar/personalTemporalRadar.js');
    const { PersonalTemporalReaders } = await load('services/radar/personalTemporalReaders.js');
    const { WeatherReadAdapter } = await load('services/radar/weatherReadAdapter.js');
    const { dateAt, nextDate } = await load('services/radar/temporalParsing.js');
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
    // No auto-install: prove fail-closed writes before installing the reviewed fixture-only fence.
    await assert.rejects(service.configure(alice, 'feed', { expectedRevision: 0, source: config }), /RADAR_CATALOG_FENCE_REQUIRED/);
    const legacyContext = context('legacy'); const legacyId = personalRadarOwner(legacyContext);
    const legacy = { _id: legacyId, owner: legacyId, revision: 1,
      sources: [{ id: 'old', source: null, records: [] }], audit: [{ revision: 1, at: clock, action: 'revoke', sourceId: 'old', added: 0, updated: 0, unchanged: 0 }],
      acquisition: { version: 1, policy: fixturePolicy, starts: [clock], observedAt: clock, lease: null } };
    await db.collection('radarpersonalcatalogs').insertOne(legacy);
    await db.command({ collMod: 'radarpersonalcatalogs', validator: CATALOG_VALIDATOR, validationLevel: 'strict', validationAction: 'error' });
    const legacyProjection = structuredClone(legacy);
    await assert.rejects(db.collection('radarpersonalcatalogs').replaceOne({ _id: legacyId }, { ...legacyProjection, revision: 2 }), { code: 121 });
    assert.equal((await db.collection('radarpersonalcatalogs').findOne({ _id: legacyId })).schemaVersion, undefined, 'Fence installation must not rewrite existing documents');
    await service.configure(legacyContext, 'new', { expectedRevision: 1, source: config });
    const migrated = await db.collection('radarpersonalcatalogs').findOne({ _id: legacyId });
    assert.equal(migrated.schemaVersion, 2); assert.deepEqual(migrated.temporalSources, []);
    assert.deepEqual(migrated.sources.find(s => s.id === 'old'), legacy.sources[0]);
    assert.deepEqual(migrated.acquisition.starts, legacy.acquisition.starts);
    await assert.rejects(db.collection('radarpersonalcatalogs').replaceOne({ _id: legacyId }, { ...legacyProjection, revision: 3 }), { code: 121 });
    assert.equal((await db.collection('radarpersonalcatalogs').findOne({ _id: legacyId })).revision, 2);
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
    assert.equal(await db.collection('radarpersonalcatalogs').countDocuments({}), 2);
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
    assert(await repository.compareAndSwap(ownerId, beforeCrash.revision, { ...beforeCrash, revision: beforeCrash.revision + 1, acquisition,
      audit: [...beforeCrash.audit, { revision: beforeCrash.revision + 1, at: clock, sourceId: 'second', action: 'reserve',
        attemptId: lease.id, added: 0, updated: 0, unchanged: 0 }].slice(-64) }));
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
    // Foreground runner uses AccessService with synthetic verifier/repository, never Firebase.
    const { AccessService } = await load('modules/access/index.js');
    const { RadarSessionRunner } = await load('services/radar/sessionRunner.js');
    const { RADAR_AUDIT_RETENTION_MS } = await load('modules/radar/audit.js');
    const carol = context('carol');
    await service.configure(carol, 'feed', { expectedRevision: 0, source: config });
    let verified = 0;
    const access = new AccessService({ verify: async () => { verified++; return {
      projectId: 'fixture', uid: 'carol', email: 'fixture@example.test', emailVerified: true, expiresAtMs: clock + 60000 }; } },
      { findByIdentity: async (projectId, uid) => ({ projectId, uid, name: 'fixture', email: 'fixture@example.test', isAuthorized: true, isAdmin: false }) }, () => 'fixture', () => clock);
    const runner = new RadarSessionRunner(access, restart, connector, () => clock);
    const arrivalsBefore = arrived;
    const runs = await Promise.allSettled(Array.from({ length: 8 }, () => runner.run('synthetic-token', { expectedRevision: 1, sourceIds: ['feed'] }, new AbortController().signal)));
    assert.equal(runs.filter(r => r.status === 'fulfilled').length, 1); assert.equal(arrived - arrivalsBefore, 1); assert(verified > 8);
    const carolId = personalRadarOwner(carol); const carolRow = await repository.read(carolId);
    assert.equal(carolRow.revision, 3); assert(!JSON.stringify(carolRow).includes('synthetic-token'));
    const aliceFrozen = JSON.stringify(await repository.read(ownerId)); const bobFrozen = JSON.stringify(await repository.read(bobId));
    clock += RADAR_AUDIT_RETENTION_MS;
    const freshCarol = { ...carol, expiresAtMs: clock + 60000 };
    const audit = await restart.audit(freshCarol, async () => freshCarol);
    assert.deepEqual(audit.events, []); assert.equal(audit.omittedThroughRevision, 3);
    const auditPurges = await Promise.allSettled(Array.from({ length: 8 }, () => restart.maintain(freshCarol, 3, async () => freshCarol)));
    assert.equal(auditPurges.filter(r => r.status === 'fulfilled').length, 1);
    const afterAuditPurge = await new MongoPersonalCatalog(db).read(carolId);
    assert.equal(afterAuditPurge.audit.length, 1); assert.equal(afterAuditPurge.audit[0].action, 'maintain');
    assert.equal(afterAuditPurge.sources[0].records.length, 0); assert.equal(afterAuditPurge.acquisition.starts.length, 1);
    assert.equal((await restart.audit(freshCarol, async () => freshCarol)).omittedThroughRevision, 3);
    assert.equal(JSON.stringify(await repository.read(ownerId)), aliceFrozen); assert.equal(JSON.stringify(await repository.read(bobId)), bobFrozen);
    // Temporal and feed acquisitions must contend on the same durable owner document and policy.
    const dana = { ...context('dana'), expiresAtMs: clock + 3600000 }; const danaId = personalRadarOwner(dana);
    let weatherCalls = 0;
    const weather = new WeatherReadAdapter({ get: async () => {
      weatherCalls++;
      return JSON.stringify({ latitude: 35, longitude: 139, timezone: 'Asia/Tokyo', daily_units: { time: 'iso8601', weather_code: 'wmo code', temperature_2m_min: '°C', temperature_2m_max: '°C', precipitation_probability_max: '%' },
        daily: { time: [0,1,2].map(i => nextDate(dateAt(clock, 'Asia/Tokyo'), i)), weather_code: [0,1,2], temperature_2m_min: [10,11,12], temperature_2m_max: [20,21,22], precipitation_probability_max: [0,10,20] } });
    } }, () => clock);
    const temporal = new PersonalTemporalRadar(new MongoPersonalCatalog(db), new PersonalTemporalReaders(weather), () => clock, fixturePolicy);
    const weatherConfig = { kind: 'weather', enabled: true, consentExpiresAt: clock + 86400000, latitudeTenth: 350, longitudeTenth: 1390, timeZone: 'Asia/Tokyo' };
    await temporal.configure(dana, 'weather', { expectedRevision: 0, source: weatherConfig }, async () => dana, new AbortController().signal);
    await service.configure(dana, 'feed', { expectedRevision: 1, source: { ...config, consentExpiresAt: clock + 86400000 } });
    const mixed = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => i % 2
      ? temporal.collect(dana, 'weather', 2, async () => dana, new AbortController().signal)
      : restart.collect(dana, 'feed', connector, new AbortController().signal, async () => dana, 2)));
    assert.equal(mixed.filter(r => r.status === 'fulfilled').length, 1);
    const mixedRow = await repository.read(danaId); assert.equal(mixedRow.acquisition.starts.length, 1);
    // Ensure a temporal snapshot exists even if the feed request won the race.
    await temporal.collect(dana, 'weather', mixedRow.revision, async () => dana, new AbortController().signal);
    const temporalRow = await repository.read(danaId); assert.equal(temporalRow.acquisition.starts.length, 2);
    assert.equal((await temporal.preview(dana, async () => dana, new AbortController().signal)).entries.length, 1);
    const temporalBeforeDenied = weatherCalls;
    await assert.rejects(temporal.collect(dana, 'weather', temporalRow.revision, async () => dana, new AbortController().signal), { code: 'RATE_LIMITED' });
    await assert.rejects(restart.collect(dana, 'feed', connector, new AbortController().signal, async () => dana, temporalRow.revision), { code: 'RATE_LIMITED' });
    assert.equal(weatherCalls, temporalBeforeDenied);
    const allOtherOwners = await db.collection('radarpersonalcatalogs').find({ _id: { $ne: danaId } }).sort({ _id: 1 }).toArray();
    clock += 900001;
    assert.deepEqual((await temporal.preview(dana, async () => dana, new AbortController().signal)).entries, []);
    const temporalPurges = await Promise.allSettled(Array.from({ length: 8 }, () => restart.maintain(dana, temporalRow.revision, async () => dana)));
    assert.equal(temporalPurges.filter(r => r.status === 'fulfilled').length, 1);
    const temporalAfterPurge = await repository.read(danaId);
    assert.equal(temporalAfterPurge.temporalSources[0].snapshot, null); assert(temporalAfterPurge.temporalSources[0].source);
    assert.equal(temporalAfterPurge.acquisition.starts.length, 2);
    assert.deepEqual(await db.collection('radarpersonalcatalogs').find({ _id: { $ne: danaId } }).sort({ _id: 1 }).toArray(), allOtherOwners);
    const indexes = await db.collection('radarpersonalcatalogs').indexes(); assert.deepEqual(indexes.map(i => i.name), ['_id_']);
    assert.deepEqual((await db.listCollections({}, { nameOnly: true }).toArray()).map(c => c.name), ['radarpersonalcatalogs']);
    console.log(JSON.stringify({ fixtureOnly: true, isolatedPort: 37029, schemaFenceRequired: true, legacyReplacementRejectedBeforeAndAfterMigration: true, lazyMigrationPreservesBudgetAndTombstones: true,
      mixedTemporalFeedClaims: 8, sharedTemporalBudget: true, temporalSnapshotRoundTrip: true, temporalPhysicalPurgePreservesOtherOwners: true, concurrentCreates: 8, concurrentCollections: 8, concurrentRecoveries: 8, concurrentPurges: 8,
      concurrentSessionRuns: 8, sessionSingleConnector: true, syntheticAccessReauthentication: true,
      concurrentAuditPurges: 8, auditRetentionAndCoverage: true, otherOwnerAuditUnchanged: true,
      singleConnectorCallForEightClaims: true, reservationSurvivesReload: true, recoveryDoesNotRefund: true, ownerScopedPhysicalPurge: true,
      singleCASWinner: true, ownerIsolation: true, repositoryReloadRead: true, contentAndAuditAtomic: true,
      revocationErasesMetadata: true, tombstoneReplayDenied: true, onlyFixtureCollection: true, noSecondaryIndex: true }));
  } finally {
    await client?.close();
    if (mongoChild.exitCode === null) {
      mongoChild.kill('SIGTERM');
      await new Promise(resolve => mongoChild.once('exit', resolve));
    }
  }
}
main().catch(error => { console.error('ISOLATED_RADAR_CATALOG_PROBE_FAILED', error.code ?? error.name); process.exitCode = 1; });
