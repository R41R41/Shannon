import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const devBackend = resolve(import.meta.dirname, '..');
if (!realpathSync(devBackend).endsWith('/Shannon-dev/backend')) throw new Error('DEV_CHECKOUT_REQUIRED');

const manifestPath = resolve(devBackend, 'scripts/prod-user-binding-manifest.json');
const prodBackend = '/home/azureuser/Shannon-prod/backend';

async function loadDotenv(filePath) {
  const mod = await import('dotenv');
  return mod.parse(readFileSync(filePath, 'utf8'));
}

async function main() {
  if (!existsSync(manifestPath)) throw new Error('MANIFEST_MISSING');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const prodEnv = await loadDotenv(resolve(prodBackend, '.env'));
  const devEnv = await loadDotenv(resolve(devBackend, '.env'));
  if (prodEnv.GOOGLE_APPLICATION_CREDENTIALS || devEnv.GOOGLE_APPLICATION_CREDENTIALS) {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = prodEnv.GOOGLE_APPLICATION_CREDENTIALS || devEnv.GOOGLE_APPLICATION_CREDENTIALS;
  }

  const { planBindings, verifyIdentities } = await import('./user-binding-migration.mjs');
  const sourceUri = process.argv.includes('--source-uri')
    ? process.argv[process.argv.indexOf('--source-uri') + 1]
    : 'mongodb://127.0.0.1:27017/shannon';

  const mongoose = (await import('mongoose')).default;
  const client = new mongoose.mongo.MongoClient(sourceUri, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  try {
    const db = client.db();
    if (db.databaseName === 'shannon_dev') throw new Error('DEV_DATABASE_FORBIDDEN');
    const users = await db.collection('users').find({}).sort({ _id: 1 }).toArray();
    const plan = planBindings(users, manifest);

    const { initializeApp, applicationDefault } = await import('firebase-admin/app');
    const { getAuth } = await import('firebase-admin/auth');
    const app = initializeApp({ projectId: manifest.projectId, credential: applicationDefault() }, 'validate-prod-manifest');
    await verifyIdentities(plan, (uid) => getAuth(app).getUser(uid));

    console.log(JSON.stringify({
      ok: true,
      readOnly: true,
      database: db.databaseName,
      operationCount: plan.operations.length,
      unboundAfter: plan.unboundAfter,
      sha256: plan.sha256,
      reviewedBy: manifest.reviewedBy,
    }));
  } finally {
    await client.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message ?? 'VALIDATE_PROD_MANIFEST_FAILED');
    process.exitCode = 1;
  });
}
