#!/usr/bin/env node
// Signs the lab bot in to a real Minecraft account once, for a public lab server (online-mode=true), and keeps the
// tokens in a cache of its own (~/.cache/minebot-lab/msa, not the main Shannon's ~/.minecraft/nmp-cache).
// The owner opens the printed address and types the printed code; nothing is printed of the tokens themselves.
//   MINECRAFT_LAB_ACCOUNT_EMAIL=a.ryo0523@gmail.com node scripts/lab/minecraft-account-login.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Authflow, Titles } = require('prismarine-auth');
const email = process.env.MINECRAFT_LAB_ACCOUNT_EMAIL ?? '';
if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw new Error('MINECRAFT_LAB_ACCOUNT_EMAIL required');
const cache = process.env.MINECRAFT_LAB_ACCOUNT_CACHE ?? path.join(os.homedir(), '.cache/minebot-lab/msa');
fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
// The same client minecraft-protocol signs in as, so a bot started later finds these tokens and uses them.
const flow = new Authflow(email, cache, { authTitle: Titles.MinecraftNintendoSwitch, deviceType: 'Nintendo', flow: 'live' },
  code => console.log(`ACCOUNT_SIGN_IN ${JSON.stringify({ url: code.verification_uri, code: code.user_code, expiresInMinutes: Math.round(code.expires_in / 60) })}`));
const { profile } = await flow.getMinecraftJavaToken({ fetchProfile: true });
console.log(`ACCOUNT_READY ${JSON.stringify({ name: profile?.name ?? null, id: profile?.id ?? null })}`);
