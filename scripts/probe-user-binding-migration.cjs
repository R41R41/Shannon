'use strict';
// Isolated UID migration rehearsal. Never writes to shannon/shannon_prod or prod users.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const PORT = 37031;
const DB = 'shannon_uid_fixture';
const URI = `mongodb://127.0.0.1:${PORT}/${DB}`;

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForMongo(client, attempts = 30) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      await client.db('admin').command({ ping: 1 });
      return;
    } catch {
      await sleep(200);
    }
  }
  throw new Error('MONGO_FIXTURE_UNAVAILABLE');
}

async function main() {
  const root = fs.realpathSync(path.join(__dirname, '..'));
  assert.equal(root, '/home/azureuser/Shannon-dev');
  assert.deepEqual(process.argv.slice(2), ['--isolated-fixture']);
  assert(fs.existsSync(path.join(root, '.dev-runtime-lock')));

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shannon-uid-fixture-'));
  const logPath = path.join(dataDir, 'mongod.log');
  const mongod = spawn('mongod', [
    '--dbpath', dataDir,
    '--bind_ip', '127.0.0.1',
    '--port', String(PORT),
    '--logpath', logPath,
    '--logappend',
  ], { stdio: 'ignore' });

  const cleanup = () => {
    try { mongod.kill('SIGTERM'); } catch {}
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(130); });
  process.on('SIGTERM', () => { cleanup(); process.exit(143); });

  const mongoose = require('mongoose');
  const client = new mongoose.mongo.MongoClient(URI, { serverSelectionTimeoutMS: 5000 });
  try {
    await waitForMongo(client);
    await client.connect();
    const db = client.db(DB);
    assert.deepEqual(await db.listCollections({}, { nameOnly: true }).toArray(), []);

    const users = await db.collection('users').insertMany([
      { name: 'Fixture Admin', email: 'admin@fixture.test', isAuthorized: true, isAdmin: true, createdAt: new Date() },
      { name: 'Fixture User A', email: 'user-a@fixture.test', isAuthorized: true, isAdmin: false, createdAt: new Date() },
      { name: 'Fixture User B', email: 'user-b@fixture.test', isAuthorized: true, isAdmin: false, createdAt: new Date() },
    ]);
    const ids = Object.values(users.insertedIds).map(String);
    const manifest = {
      version: 1,
      projectId: 'shannon-dev-fixture',
      reviewedBy: 'uid-rehearsal-probe',
      bindings: [
        { userId: ids[0], uid: 'fixture-uid-admin', isAuthorized: true, isAdmin: true },
        { userId: ids[1], uid: 'fixture-uid-user-a', isAuthorized: true, isAdmin: false },
        { userId: ids[2], uid: 'fixture-uid-user-b', isAuthorized: true, isAdmin: false },
      ],
    };

    const { planBindings, verifyIdentities } = await import(pathToFileURL(path.join(root, 'backend/scripts/user-binding-migration.mjs')).href);
    const rows = await db.collection('users').find({}).sort({ _id: 1 }).toArray();
    const plan = planBindings(rows, manifest);
    assert.equal(plan.operations.length, 3);
    assert.equal(plan.unboundAfter, 0);

    const firebase = new Map([
      ['fixture-uid-admin', { uid: 'fixture-uid-admin', email: 'admin@fixture.test', emailVerified: true, disabled: false }],
      ['fixture-uid-user-a', { uid: 'fixture-uid-user-a', email: 'user-a@fixture.test', emailVerified: true, disabled: false }],
      ['fixture-uid-user-b', { uid: 'fixture-uid-user-b', email: 'user-b@fixture.test', emailVerified: true, disabled: false }],
    ]);
    await verifyIdentities(plan, async (uid) => {
      const row = firebase.get(uid);
      if (!row) throw new Error('FIREBASE_IDENTITY_MISMATCH');
      return row;
    });

    await db.collection('users').createIndex(
      { firebaseProjectId: 1, firebaseUid: 1 },
      {
        name: 'firebase_identity_unique',
        unique: true,
        partialFilterExpression: { firebaseProjectId: { $type: 'string' }, firebaseUid: { $type: 'string' } },
      },
    );

    for (const op of plan.operations) {
      const filter = {
        _id: new mongoose.mongo.ObjectId(op.userId),
        email: op.email,
        ...op.before,
      };
      const result = await db.collection('users').updateOne(filter, { $set: op.after });
      assert.equal(result.matchedCount, 1);
    }

    const bound = await db.collection('users').find({}).sort({ email: 1 }).toArray();
    assert(bound.every((user) => user.firebaseProjectId === 'shannon-dev-fixture' && user.firebaseUid));
    assert.equal(bound.filter((user) => user.isAdmin).length, 1);

    await assert.rejects(
      () => db.collection('users').insertOne({
        name: 'Dup',
        email: 'dup@fixture.test',
        isAuthorized: true,
        isAdmin: false,
        firebaseProjectId: 'shannon-dev-fixture',
        firebaseUid: 'fixture-uid-admin',
      }),
      /duplicate key/i,
    );

    const rebindManifest = {
      version: 1,
      projectId: 'shannon-dev-fixture',
      reviewedBy: 'uid-rehearsal-probe',
      bindings: [{ userId: ids[2], uid: 'fixture-uid-admin', isAuthorized: true, isAdmin: false }],
    };
    assert.throws(() => planBindings(bound, rebindManifest), /REBIND_REQUIRES_SEPARATE_REVIEW/);

    console.log(JSON.stringify({
      ok: true,
      isolatedPort: PORT,
      database: DB,
      operationCount: plan.operations.length,
      sha256: plan.sha256,
      boundUsers: bound.length,
      uniqueIndex: 'firebase_identity_unique',
      note: 'Fixture rehearsal only; prod/shannon_dev unchanged',
    }, null, 2));
  } finally {
    await client.close().catch(() => {});
    cleanup();
    await sleep(300);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message?.match(/^[A-Z_]+$/)?.[0] ?? error.message ?? 'UID_REHEARSAL_FAILED');
  process.exitCode = 1;
});
