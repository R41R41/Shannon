'use strict';
// Copy VITE_FIREBASE_PROJECT_ID from frontend/.env into backend/.env as FIREBASE_PROJECT_ID.
// Does not print secret values.
const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');

const root = fs.realpathSync(path.join(__dirname, '..'));
if (root !== '/home/azureuser/Shannon-dev') throw new Error('DEV_CHECKOUT_REQUIRED');

function upsertKey(text, key, value) {
  const lines = text.split('\n');
  let found = false;
  const next = lines.map((line) => {
    if (line.startsWith(`${key}=`)) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!found) {
    if (next.length && next[next.length - 1] !== '') next.push('');
    next.push('# Synced from frontend/.env by scripts/sync-dev-firebase-env.cjs');
    next.push(`${key}=${value}`);
  }
  return next.join('\n');
}

const frontendEnv = dotenv.parse(fs.readFileSync(path.join(root, 'frontend/.env'), 'utf8'));
const projectId = frontendEnv.VITE_FIREBASE_PROJECT_ID;
if (!projectId || /\s/.test(projectId)) throw new Error('FRONTEND_PROJECT_ID_MISSING');

const backendEnvPath = path.join(root, 'backend/.env');
const backendEnv = fs.readFileSync(backendEnvPath, 'utf8');
const updated = upsertKey(backendEnv, 'FIREBASE_PROJECT_ID', projectId);
if (updated !== backendEnv) fs.writeFileSync(backendEnvPath, updated, { mode: 0o600 });

console.log(JSON.stringify({
  ok: true,
  updated: updated !== backendEnv,
  backendKey: 'FIREBASE_PROJECT_ID',
  note: 'Value not printed; must match frontend VITE_FIREBASE_PROJECT_ID',
}));
