'use strict';
// Uses only a separately started, empty fixture mongod. Never connects to the app DB/port.
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
  await mongoose.connect('mongodb://127.0.0.1:37028/shannon_person_fixture', { serverSelectionTimeoutMS: 5000, autoIndex: false, autoCreate: false });
  try {
    const db = mongoose.connection.db;
    assert.deepEqual(await db.listCollections({}, { nameOnly: true }).toArray(), [], 'Fixture DB must be new and empty');
    const load = file => import(pathToFileURL(path.join(root, 'backend/dist', file)).href);
    const { createRequestPersonMemory } = await load('services/memory/requestPersonMemory.js');
    const request = (user = '100', channel = '300') => ({
      requestId: 'fixture-request', channel: 'discord', sourceUserId: user, sourceDisplayName: 'same fixture name',
      conversationId: `discord:200:${channel}`, threadId: `discord:${channel}`, tags: [],
      text: 'fixture tea; fixture coffee; fixture water', timestampIso: '2026-08-28T00:00:00.000Z',
      discord: { guildId: '200', channelId: channel, messageId: '400', isDM: false },
    });
    const a = createRequestPersonMemory(request());
    const saves = await Promise.all(Array.from({ length: 8 }, () => a.remember('fixture tea')));
    assert(saves.every(row => row.saved)); assert.equal(new Set(saves.map(row => row.statement.id)).size, 1);
    const id = saves[0].statement.id;
    assert.equal(await db.collection('scopedpersonstatements').countDocuments({}), 1);
    assert.deepEqual(await createRequestPersonMemory(request('101')).recall(), []);
    assert.deepEqual(await createRequestPersonMemory(request('100', '301')).recall(), []);
    const b = createRequestPersonMemory(request('101')); assert((await b.remember('fixture water')).saved);
    assert(!(await b.forget(id, 1)).saved);
    const edits = await Promise.all([a.correct(id, 1, 'fixture coffee'), a.correct(id, 1, 'fixture water')]);
    assert.equal(edits.filter(row => row.saved).length, 1);
    assert.equal((await a.recall())[0].revision, 2);
    assert(!(await a.forget(id, 1)).saved); assert((await a.forget(id, 2)).saved);
    assert.deepEqual(await a.recall(), []);
    assert(!(await a.remember('fixture tea')).saved); assert(!(await a.remember('fixture coffee')).saved);
    assert(!(await a.correct(id, 3, 'fixture water')).saved);
    const tombstone = await db.collection('scopedpersonstatements').findOne({ _id: id });
    assert.equal(tombstone.status, 'forgotten'); assert(!('quote' in tombstone)); assert(!('source' in tombstone));
    assert.equal((await b.recall()).length, 1);
    const collections = await db.listCollections({}, { nameOnly: true }).toArray();
    assert.deepEqual(collections.map(row => row.name), ['scopedpersonstatements']);
    assert.deepEqual((await db.collection('scopedpersonstatements').indexes()).map(row => row.name), ['_id_']);
    console.log(JSON.stringify({ isolatedPort: 37028, fixtureOnly: true, concurrentRetries: 8,
      oneOriginRecord: true, subjectAndAudienceIsolation: true, oneRevisionWinner: true,
      forgottenTextRemoved: true, sameSourceReplayDenied: true, legacyCollectionUntouched: true, noSecondaryIndexCreated: true }));
  } finally { await mongoose.disconnect(); }
}
main().catch(() => { console.error('ISOLATED_PERSON_MEMORY_PROBE_FAILED'); process.exitCode = 1; });
