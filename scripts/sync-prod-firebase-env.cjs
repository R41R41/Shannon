'use strict';
const fs = require('node:fs');
const dotenv = require('dotenv');

const prodEnvPath = '/home/azureuser/Shannon-prod/backend/.env';
const front = dotenv.parse(fs.readFileSync('/home/azureuser/Shannon-prod/frontend/.env', 'utf8'));
const devEnv = dotenv.parse(fs.readFileSync('/home/azureuser/Shannon-dev/backend/.env', 'utf8'));
let text = fs.readFileSync(prodEnvPath, 'utf8');

function upsert(key, value) {
  const line = `${key}=${value}`;
  if (new RegExp(`^${key}=`, 'm').test(text)) {
    text = text.replace(new RegExp(`^${key}=.*`, 'm'), line);
  } else {
    text += `\n# UID cutover\n${line}\n`;
  }
}

upsert('FIREBASE_PROJECT_ID', front.VITE_FIREBASE_PROJECT_ID);
if (!/^GOOGLE_APPLICATION_CREDENTIALS=/m.test(text) && devEnv.GOOGLE_APPLICATION_CREDENTIALS) {
  upsert('GOOGLE_APPLICATION_CREDENTIALS', devEnv.GOOGLE_APPLICATION_CREDENTIALS);
}
fs.writeFileSync(prodEnvPath, text, { mode: 0o600 });
console.log(JSON.stringify({
  ok: true,
  firebaseProjectIdSet: true,
  adcSet: /^GOOGLE_APPLICATION_CREDENTIALS=/m.test(text),
}));
