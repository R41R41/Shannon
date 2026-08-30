import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { planBindings, verifyIdentities } from './user-binding-migration.mjs';

const prodBackend = resolve('/home/azureuser/Shannon-prod/backend');
const devBackend = resolve(import.meta.dirname, '..');

async function loadDotenv(filePath) {
  const mod = await import('dotenv');
  return mod.parse(readFileSync(filePath, 'utf8'));
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.includes('--production-cutover')) throw new Error('Usage: apply-prod-user-binding.mjs --production-cutover MANIFEST OUTPUT [--apply EXPECTED_SHA256]');
  if (!realpathSync(prodBackend).endsWith('/Shannon-prod/backend')) throw new Error('PROD_CHECKOUT_REQUIRED');

  const cutoverIdx = args.indexOf('--production-cutover');
  const manifestFile = args[cutoverIdx + 1];
  const output = args[cutoverIdx + 2];
  const applyIdx = args.indexOf('--apply');
  const mode = applyIdx !== -1;
  const expectedHash = mode ? args[applyIdx + 1] : undefined;
  if (!manifestFile || !output) {
    throw new Error('Usage: apply-prod-user-binding.mjs --production-cutover MANIFEST OUTPUT [--apply EXPECTED_SHA256]');
  }

  const prodEnv = await loadDotenv(resolve(prodBackend, '.env'));
  const devEnv = await loadDotenv(resolve(devBackend, '.env'));
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  const projectId = prodEnv.FIREBASE_PROJECT_ID || devEnv.FIREBASE_PROJECT_ID || manifest.projectId;
  if (!projectId || projectId !== manifest.projectId) throw new Error('PROJECT_ID_MISMATCH');
  if (process.env.FIREBASE_AUTH_EMULATOR_HOST) throw new Error('EMULATOR_NOT_ALLOWED');

  const credentialsPath = prodEnv.GOOGLE_APPLICATION_CREDENTIALS || devEnv.GOOGLE_APPLICATION_CREDENTIALS;
  if (credentialsPath && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = credentialsPath;
  }
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) throw new Error('GOOGLE_APPLICATION_CREDENTIALS_MISSING');

  const mongoose = (await import('mongoose')).default;
  const client = new mongoose.mongo.MongoClient(prodEnv.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  try {
    const db = client.db();
    if (db.databaseName !== 'shannon') throw new Error('PROD_DATABASE_REQUIRED');
    const users = await db.collection('users').find({}).sort({ _id: 1 }).toArray();
    const plan = planBindings(users, manifest);
    writeFileSync(output, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify({ mode: mode ? 'apply' : 'dry-run', count: plan.operations.length, unboundAfter: plan.unboundAfter, sha256: plan.sha256 }));

    if (!mode) return;
    if (plan.sha256 !== expectedHash) throw new Error('REVIEW_OR_PROJECT_MISMATCH');

    const { initializeApp, applicationDefault } = await import('firebase-admin/app');
    const { getAuth } = await import('firebase-admin/auth');
    const app = initializeApp({ projectId: plan.projectId, credential: applicationDefault() }, 'shannon-prod-user-migration');
    await verifyIdentities(plan, (uid) => getAuth(app).getUser(uid));

    await db.collection('users').createIndex(
      { firebaseProjectId: 1, firebaseUid: 1 },
      {
        name: 'firebase_identity_unique',
        unique: true,
        partialFilterExpression: { firebaseProjectId: { $type: 'string' }, firebaseUid: { $type: 'string' } },
      },
    );

    for (const op of plan.operations) {
      const filter = { _id: new mongoose.mongo.ObjectId(op.userId), email: op.email, ...op.before };
      const result = await db.collection('users').updateOne(filter, { $set: op.after });
      if (result.matchedCount !== 1) throw new Error('CONCURRENT_CHANGE_STOPPED_REMAINING_OPERATIONS');
    }
    console.log('Applied reviewed production bindings.');
  } finally {
    await client.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message?.match(/^[A-Z_]+$/)?.[0] ?? 'PROD_MIGRATION_FAILED');
    process.exitCode = 1;
  });
}
