import { readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
if (!realpathSync(root).endsWith('/Shannon-dev/backend')) throw new Error('DEV_CHECKOUT_REQUIRED');

const defaultConfig = resolve(root, 'scripts/dev-uid-rehearsal-users.json');
const defaultManifest = resolve(root, 'scripts/user-binding-manifest.json');

function parseArgs(argv) {
  const flags = new Set();
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--seed' || arg === '--provision-firebase' || arg === '--write-manifest' || arg === '--all') flags.add(arg);
    else if (arg === '--config') options.config = argv[++i];
    else if (arg === '--manifest-out') options.manifestOut = argv[++i];
    else throw new Error(`UNKNOWN_ARG:${arg}`);
  }
  if (flags.has('--all')) {
    flags.add('--seed');
    flags.add('--provision-firebase');
    flags.add('--write-manifest');
  }
  if (!flags.size) throw new Error('Usage: prepare-dev-uid-rehearsal.mjs (--seed | --provision-firebase | --write-manifest | --all) [--config PATH] [--manifest-out PATH]');
  return { flags, configPath: options.config ?? defaultConfig, manifestOut: options.manifestOut ?? defaultManifest };
}

function loadConfig(path) {
  const config = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(config.users) || config.users.length === 0) throw new Error('INVALID_CONFIG');
  for (const user of config.users) {
    if (!user.name || !user.email || typeof user.isAuthorized !== 'boolean' || typeof user.isAdmin !== 'boolean') throw new Error('INVALID_USER');
    if (user.isAdmin && !user.isAuthorized) throw new Error('INVALID_ADMIN_BINDING');
  }
  if (!config.reviewedBy || /\s/.test(config.reviewedBy)) throw new Error('INVALID_REVIEWED_BY');
  return config;
}

async function loadEnv() {
  const dotenv = await import('dotenv');
  return dotenv.parse(readFileSync(resolve(root, '.env'), 'utf8'));
}

async function connectDevDb(env) {
  const mongoose = (await import('mongoose')).default;
  const client = new mongoose.mongo.MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  const db = client.db();
  if (db.databaseName !== 'shannon_dev') throw new Error('DEV_DATABASE_REQUIRED');
  return { client, db };
}

async function seedUsers(db, config) {
  const collection = db.collection('users');
  const seeded = [];
  for (const spec of config.users) {
    const existing = await collection.findOne({ email: spec.email });
    if (existing) {
      if (existing.firebaseUid || existing.firebaseProjectId) throw new Error(`ALREADY_BOUND:${spec.email}`);
      seeded.push({ userId: String(existing._id), email: spec.email, inserted: false });
      continue;
    }
    const doc = {
      name: spec.name,
      email: spec.email,
      isAuthorized: spec.isAuthorized,
      isAdmin: spec.isAdmin,
      createdAt: new Date(),
    };
    const result = await collection.insertOne(doc);
    seeded.push({ userId: String(result.insertedId), email: spec.email, inserted: true });
  }
  return seeded;
}

async function provisionFirebase(env, config) {
  if (!env.FIREBASE_PROJECT_ID) throw new Error('FIREBASE_PROJECT_ID_MISSING');
  if (process.env.FIREBASE_AUTH_EMULATOR_HOST) throw new Error('EMULATOR_NOT_ALLOWED');
  if (env.GOOGLE_APPLICATION_CREDENTIALS && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = env.GOOGLE_APPLICATION_CREDENTIALS;
  }
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) throw new Error('GOOGLE_APPLICATION_CREDENTIALS_MISSING');

  const { initializeApp, applicationDefault } = await import('firebase-admin/app');
  const { getAuth } = await import('firebase-admin/auth');
  const app = initializeApp({ projectId: env.FIREBASE_PROJECT_ID, credential: applicationDefault() }, 'shannon-dev-uid-rehearsal');
  const auth = getAuth(app);
  const provisioned = [];

  for (const spec of config.users) {
    if (!spec.password || spec.password.startsWith('REPLACE_')) throw new Error(`PASSWORD_REQUIRED:${spec.email}`);
    let record;
    let created = false;
    try {
      record = await auth.getUserByEmail(spec.email);
      await auth.updateUser(record.uid, {
        password: spec.password,
        emailVerified: true,
        disabled: false,
      });
    } catch (error) {
      if (error.code !== 'auth/user-not-found') throw error;
      record = await auth.createUser({
        email: spec.email,
        password: spec.password,
        emailVerified: true,
        disabled: false,
        displayName: spec.name,
      });
      created = true;
    }
    provisioned.push({ email: spec.email, uid: record.uid, created });
  }
  return provisioned;
}

async function writeManifest(env, config, db, manifestOut) {
  const rows = await db.collection('users').find({ email: { $in: config.users.map((u) => u.email) } }).sort({ _id: 1 }).toArray();
  const byEmail = new Map(rows.map((row) => [row.email, row]));
  const bindings = [];
  for (const spec of config.users) {
    const row = byEmail.get(spec.email);
    if (!row) throw new Error(`USER_NOT_SEEDED:${spec.email}`);
    if (!spec.uid || /\s/.test(spec.uid)) throw new Error(`UID_REQUIRED:${spec.email}`);
    bindings.push({
      userId: String(row._id),
      uid: spec.uid,
      isAuthorized: spec.isAuthorized,
      isAdmin: spec.isAdmin,
    });
  }
  const manifest = {
    version: 1,
    projectId: env.FIREBASE_PROJECT_ID,
    reviewedBy: config.reviewedBy,
    bindings,
  };
  writeFileSync(manifestOut, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
    flag: existsSync(manifestOut) ? 'w' : 'wx',
  });
  return { manifestOut, bindingCount: bindings.length };
}

async function main() {
  const { flags, configPath, manifestOut } = parseArgs(process.argv.slice(2));
  if (!existsSync(configPath)) throw new Error(`CONFIG_MISSING:${configPath}`);
  const config = loadConfig(configPath);
  const env = await loadEnv();
  const { client, db } = await connectDevDb(env);

  try {
    const summary = { ok: true, database: 'shannon_dev' };

    if (flags.has('--seed')) {
      summary.seed = await seedUsers(db, config);
    }

    if (flags.has('--provision-firebase')) {
      const provisioned = await provisionFirebase(env, config);
      summary.firebase = provisioned.map(({ email, uid, created }) => ({ email, uid, created }));
      const merged = loadConfig(configPath);
      const uidByEmail = new Map(provisioned.map((row) => [row.email, row.uid]));
      merged.users = merged.users.map((user) => ({ ...user, uid: uidByEmail.get(user.email) }));
      writeFileSync(configPath, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
      summary.configUpdated = configPath;
    }

    if (flags.has('--write-manifest')) {
      const refreshed = loadConfig(configPath);
      summary.manifest = await writeManifest(env, refreshed, db, manifestOut);
    }

    console.log(JSON.stringify(summary));
  } finally {
    await client.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    const code = error.message?.match(/^[A-Z_:$]+/)?.[0];
    console.error(code && code.length > 1 ? code : (error.message ?? 'PREPARE_FAILED'));
    process.exitCode = 1;
  });
}
