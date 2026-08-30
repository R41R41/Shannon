'use strict';
// Verify shannon_dev UID bindings: Firebase sign-in -> token verify -> Mongo lookup.
// Does not print passwords, API keys, or tokens.
const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');

const root = fs.realpathSync(path.join(__dirname, '..'));
if (root !== '/home/azureuser/Shannon-dev') throw new Error('DEV_CHECKOUT_REQUIRED');
if (!fs.existsSync(path.join(root, '.dev-runtime-lock'))) throw new Error('DEV_RUNTIME_LOCK_REQUIRED');
if (!process.argv.slice(2).every(arg => arg === '--check-login')) throw new Error('Usage: verify-dev-uid-login.cjs --check-login');

async function main() {
  const backendEnv = dotenv.parse(fs.readFileSync(path.join(root, 'backend/.env'), 'utf8'));
  const frontendEnv = dotenv.parse(fs.readFileSync(path.join(root, 'frontend/.env'), 'utf8'));
  const configPath = path.join(root, 'backend/scripts/dev-uid-rehearsal-users.json');
  if (!fs.existsSync(configPath)) throw new Error('REHEARSAL_CONFIG_MISSING');
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const projectId = backendEnv.FIREBASE_PROJECT_ID;
  const apiKey = frontendEnv.VITE_FIREBASE_API_KEY;
  if (!projectId || !apiKey) throw new Error('FIREBASE_CONFIG_MISSING');

  if (backendEnv.GOOGLE_APPLICATION_CREDENTIALS && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = backendEnv.GOOGLE_APPLICATION_CREDENTIALS;
  }
  const { initializeApp, applicationDefault } = await import('firebase-admin/app');
  const { getAuth } = await import('firebase-admin/auth');
  const app = initializeApp({ projectId, credential: applicationDefault() }, 'verify-dev-uid-login');

  async function checkUser(spec) {
    const signIn = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: spec.email, password: spec.password, returnSecureToken: true }),
    });
    const body = await signIn.json();
    if (!signIn.ok || !body.idToken) {
      return { email: spec.email, ok: false, error: body.error?.message ?? 'SIGN_IN_FAILED' };
    }
    const decoded = await getAuth(app).verifyIdToken(body.idToken, true);
    const mongoose = (await import('mongoose')).default;
    const client = new mongoose.mongo.MongoClient(backendEnv.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
    await client.connect();
    const user = await client.db().collection('users').findOne({ firebaseProjectId: projectId, firebaseUid: decoded.uid });
    await client.close();
    return {
      email: spec.email,
      ok: true,
      tokenVerified: decoded.aud === projectId,
      mongoMatch: !!user,
      isAdmin: user?.isAdmin === true,
      isAuthorized: user?.isAuthorized === true,
      emailMatches: user?.email === spec.email,
    };
  }

  const results = [];
  for (const spec of cfg.users) results.push(await checkUser(spec));
  const summary = {
    ok: results.every((row) => row.ok),
    database: 'shannon_dev',
    checked: results.length,
    results: results.map(({ email, ok, error, isAdmin, isAuthorized, mongoMatch, tokenVerified, emailMatches }) => ({
      email, ok, error, isAdmin, isAuthorized, mongoMatch, tokenVerified, emailMatches,
    })),
  };
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message?.match(/^[A-Z_]+$/)?.[0] ?? 'VERIFY_FAILED');
  process.exitCode = 1;
});
