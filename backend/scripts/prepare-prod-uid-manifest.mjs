import { readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
if (!realpathSync(root).endsWith('/Shannon-dev/backend')) throw new Error('DEV_CHECKOUT_REQUIRED');

const defaultOut = resolve(root, 'scripts/prod-user-binding-manifest.template.json');

function parseArgs(argv) {
  const flags = new Set(argv.filter(arg => arg.startsWith('--')));
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--project-id') options.projectId = argv[++i];
    else if (argv[i] === '--reviewed-by') options.reviewedBy = argv[++i];
    else if (argv[i] === '--out') options.out = argv[++i];
    else if (argv[i] === '--source-uri') options.sourceUri = argv[++i];
  }
  if (!flags.has('--read-only')) throw new Error('Usage: prepare-prod-uid-manifest.mjs --read-only [--source-uri mongodb://127.0.0.1:27017/shannon] [--project-id ID] [--reviewed-by NAME] [--out PATH]');
  return {
    sourceUri: options.sourceUri ?? 'mongodb://127.0.0.1:27017/shannon',
    projectId: options.projectId ?? '',
    reviewedBy: options.reviewedBy ?? 'prod-migration-reviewer',
    out: options.out ?? defaultOut,
  };
}

async function main() {
  const { sourceUri, projectId, reviewedBy, out } = parseArgs(process.argv.slice(2));
  const dbName = new URL(sourceUri).pathname.replace(/^\//, '') || 'shannon';
  if (dbName === 'shannon_dev') throw new Error('DEV_DATABASE_FORBIDDEN');
  if (!projectId) throw new Error('PROJECT_ID_REQUIRED');

  const mongoose = (await import('mongoose')).default;
  const client = new mongoose.mongo.MongoClient(sourceUri, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  try {
    const db = client.db();
    if (db.databaseName !== dbName) throw new Error('DATABASE_NAME_MISMATCH');
    const users = await db.collection('users').find({}).sort({ _id: 1 }).project({
      email: 1, isAdmin: 1, isAuthorized: 1, firebaseUid: 1, firebaseProjectId: 1,
    }).toArray();
    if (users.length === 0) throw new Error('NO_USERS_FOUND');

    const bindings = users.map((user) => ({
      userId: String(user._id),
      email: user.email,
      uid: 'REPLACE_WITH_REVIEWED_FIREBASE_UID',
      isAuthorized: user.isAuthorized === true,
      isAdmin: user.isAdmin === true,
      existingFirebaseUid: user.firebaseUid ?? null,
      existingFirebaseProjectId: user.firebaseProjectId ?? null,
    }));

    const manifest = {
      version: 1,
      projectId,
      reviewedBy,
      bindings: bindings.map(({ userId, uid, isAuthorized, isAdmin }) => ({ userId, uid, isAuthorized, isAdmin })),
      _reviewNotes: {
        generatedAt: new Date().toISOString(),
        sourceUri: sourceUri.replace(/\/\/.*@/, '//***@'),
        operatorChecklist: [
          'Replace every REPLACE_WITH_REVIEWED_FIREBASE_UID with reviewed Firebase UID from Admin Console',
          'Confirm email matches Firebase user and emailVerified=true',
          'Confirm isAuthorized/isAdmin explicitly (no implicit inheritance)',
          'Run dry-run only until plan hash is reviewed',
          'Never apply from Shannon-dev checkout against production database',
        ],
        bindingsDetail: bindings,
      },
    };

    if (existsSync(out)) throw new Error('OUTPUT_EXISTS');
    writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify({
      ok: true,
      readOnly: true,
      userCount: users.length,
      alreadyBound: users.filter((u) => u.firebaseUid && u.firebaseProjectId).length,
      out,
      note: 'Template includes _reviewNotes for operator only; strip before validate-manifest/apply',
    }));
  } finally {
    await client.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message?.match(/^[A-Z_:$]+/)?.[0] ?? 'PREPARE_PROD_MANIFEST_FAILED');
    process.exitCode = 1;
  });
}
