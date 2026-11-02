#!/usr/bin/env node
// join-bot.mjs <port> <name> <seconds> — a bare mineflayer client that joins an isolated lab server and stays for <seconds>.
// It stands in for the body when something else (scripts/minecraft-trials/sections_smoke.py, an RCON session) needs a player in the world:
// no skills, no reflexes, no model. Prints JOINED when it has spawned and LEFT when it goes. node_modules: BODY_NODE_MODULES or ../../node_modules.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(process.env.BODY_NODE_MODULES || path.resolve(here, '..', '..', 'node_modules'), 'x.js'));
const mineflayer = require('mineflayer');
const [port, name, seconds] = [Number(process.argv[2]), process.argv[3], Number(process.argv[4] || 300)];
if (!Number.isInteger(port) || port < 25570 || port > 25599 || !/^[A-Za-z0-9_]{3,16}$/.test(name || '')) { console.error('usage: join-bot.mjs <port 25570-25599> <name> <seconds>'); process.exit(2); }
const bot = mineflayer.createBot({ host: '127.0.0.1', port, version: '1.21.11', username: name, auth: 'offline', checkTimeoutInterval: 180000 });
bot.once('spawn', () => console.log('JOINED ' + name));
bot.on('kicked', reason => { console.error('KICKED ' + JSON.stringify(reason)); });
bot.on('error', error => { console.error('ERROR ' + String(error)); });
bot.on('death', () => { console.log('DIED'); bot.respawn?.(); });
setTimeout(() => { console.log('LEFT'); bot.quit(); setTimeout(() => process.exit(0), 500); }, seconds * 1000);
