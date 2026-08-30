import { readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const devBackend = resolve(import.meta.dirname, '..');
if (!realpathSync(devBackend).endsWith('/Shannon-dev/backend')) throw new Error('DEV_CHECKOUT_REQUIRED');

const prodBackend = '/home/azureuser/Shannon-prod/backend';
const templatePath = resolve(devBackend, 'scripts/prod-user-binding-manifest.template.json');
const outPath = resolve(devBackend, 'scripts/prod-user-binding-manifest.json');

function parseEnv(filePath) {
  const dotenv = readFileSync(filePath, 'utf8');
  const env = {};
  for (const line of dotenv.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq);
    let value = trimmed.slice(eq + 1);
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

async function loadDotenv(filePath) {
  const mod = await import('dotenv');
  return mod.parse(readFileSync(filePath, 'utf8'));
}

async function main() {
  const createMissing = process.argv.includes('--create-missing');
  if (!existsSync(templatePath)) throw new Error('TEMPLATE_MISSING');
  const template = JSON.parse(readFileSync(templatePath, 'utf8'));
  const details = template._reviewNotes?.bindingsDetail;
  if (!Array.isArray(details) || details.length === 0) throw new Error('BINDINGS_DETAIL_MISSING');

  const prodEnv = await loadDotenv(resolve(prodBackend, '.env'));
  const devEnv = await loadDotenv(resolve(devBackend, '.env'));
  const projectId = prodEnv.FIREBASE_PROJECT_ID || template.projectId;
  if (!projectId) throw new Error('PROJECT_ID_MISSING');
  if (process.env.FIREBASE_AUTH_EMULATOR_HOST) throw new Error('EMULATOR_NOT_ALLOWED');
  const credentialsPath = prodEnv.GOOGLE_APPLICATION_CREDENTIALS || devEnv.GOOGLE_APPLICATION_CREDENTIALS;
  if (credentialsPath && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = credentialsPath;
  }
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) throw new Error('GOOGLE_APPLICATION_CREDENTIALS_MISSING');

  const { initializeApp, applicationDefault } = await import('firebase-admin/app');
  const { getAuth } = await import('firebase-admin/auth');
  const app = initializeApp({ projectId, credential: applicationDefault() }, 'fill-prod-uid-manifest');
  const auth = getAuth(app);

  const resolved = [];
  for (const row of details) {
    let identity;
    let created = false;
    try {
      identity = await auth.getUserByEmail(row.email);
    } catch (error) {
      if (error.code !== 'auth/user-not-found') throw error;
      if (!createMissing) throw new Error(`FIREBASE_USER_NOT_FOUND:${row.email}`);
      identity = await auth.createUser({
        email: row.email,
        emailVerified: true,
        disabled: false,
      });
      created = true;
    }
    if (identity.uid !== row.uid && row.uid !== 'REPLACE_WITH_REVIEWED_FIREBASE_UID') {
      throw new Error(`UID_MISMATCH:${row.email}`);
    }
    if (!identity.emailVerified || identity.disabled) throw new Error(`FIREBASE_IDENTITY_INVALID:${row.email}`);
    if (identity.email !== row.email) throw new Error(`EMAIL_MISMATCH:${row.email}`);
    resolved.push({
      userId: row.userId,
      uid: identity.uid,
      isAuthorized: row.isAuthorized,
      isAdmin: row.isAdmin,
      email: row.email,
      created,
    });
  }

  const manifest = {
    version: 1,
    projectId,
    reviewedBy: template.reviewedBy === 'rai-dev-prep' ? 'rai-prod-uid-review' : template.reviewedBy,
    bindings: resolved.map(({ userId, uid, isAuthorized, isAdmin }) => ({ userId, uid, isAuthorized, isAdmin })),
  };

  const { planBindings } = await import('./user-binding-migration.mjs');
  const users = resolved.map(({ userId, email, isAuthorized, isAdmin }) => ({
    _id: userId,
    email,
    isAuthorized,
    isAdmin,
  }));
  const plan = planBindings(users, manifest);

  writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
    flag: existsSync(outPath) ? 'w' : 'wx',
  });

  console.log(JSON.stringify({
    ok: true,
    projectId,
    bindingCount: manifest.bindings.length,
    out: outPath,
    planSha256: plan.sha256,
    resolved: resolved.map(({ email, userId, isAdmin, created }) => ({ email, userId, isAdmin, uidBound: true, created: !!created })),
    note: 'UID values not printed; see gitignored manifest file',
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message ?? 'FILL_PROD_MANIFEST_FAILED');
    process.exitCode = 1;
  });
}
