#!/usr/bin/env node
// end-check.mjs — does a lab world start the dragon fight when someone is sent to The End? (S4, 2026-11-02)
//
// No model, no body code: a bare mineflayer client joins an isolated lab server as ShannonProbe (the op the lab writes into ops.json),
// builds the arrival platform the way vanilla does on a portal trip (5x5 obsidian at y 48, three layers of air), teleports itself to
// (100, 49, 0) in the End with /execute in, and reads the server's answers until the dragon is there. The same steps a probe of the
// End (S1) starts from. Prints one line  END_CHECK {json}  and exits 0 when the dragon was found.
//
//   cd backend && node scripts/lab/end-check.mjs <port> [--survival] [--seconds 150]
//   node_modules: ../node_modules of this script, or BODY_NODE_MODULES=<dir> (a body checkout's backend/node_modules)
//
// The lab server comes from scripts/minecraft-isolated-lab.mjs (natural terrain) or lab/lab-wsl.sh start; it has no RCON, so the
// commands go through the op's own chat. Creative by default so the fight cannot end the check; --survival to be a target.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const modules = process.env.BODY_NODE_MODULES || path.resolve(here, '..', '..', 'node_modules');
const require = createRequire(path.join(modules, 'x.js'));
const mineflayer = require('mineflayer');

const args = process.argv.slice(2);
const port = Number(args[0]);
if (!Number.isInteger(port) || port < 25570 || port > 25599) { console.error('usage: end-check.mjs <port 25570-25599> [--survival] [--seconds N]'); process.exit(2); }
const survival = args.includes('--survival');
const limitSeconds = Number(args[args.indexOf('--seconds') + 1]) || 150;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const bot = mineflayer.createBot({ host: '127.0.0.1', port, version: '1.21.11', username: 'ShannonProbe', auth: 'offline', checkTimeoutInterval: 180000 });
const heard = [];
bot.on('messagestr', text => heard.push({ t: Date.now(), text }));
bot.on('kicked', reason => { console.error('kicked', JSON.stringify(reason)); process.exit(3); });
bot.on('error', error => { console.error('error', String(error)); });

/** Sends a command as the op and returns what the server said back (the lines that arrived within the wait). */
async function run(command, wait = 700) {
  const from = heard.length;
  bot.chat(command);
  await sleep(wait);
  return heard.slice(from).map(h => h.text).join(' | ');
}
const passed = text => /Test passed/i.test(text);

const report = { port, survival, steps: {} };
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no spawn in 40 s')), 40000);
    bot.once('spawn', () => { clearTimeout(timer); resolve(); });
  });
  await sleep(1500);
  report.joined = { dimension: bot.game.dimension, position: bot.entity.position };
  report.steps.tickBefore = await run('/tick query', 900);
  if (!survival) await run('/gamemode creative');
  // the platform: chunks of the arrival area loaded first (a fill into a chunk that is not loaded is refused)
  await run('/execute in minecraft:the_end run forceload add 90 -12 110 12');
  const loadStart = Date.now();
  let loaded = false;
  while (Date.now() - loadStart < 90000) {
    loaded = passed(await run('/execute in minecraft:the_end if loaded 100 64 0', 500));
    if (loaded) break;
    await sleep(1500);
  }
  report.steps.arrivalChunkLoadedSeconds = loaded ? Math.round((Date.now() - loadStart) / 100) / 10 : null;
  // what is at the arrival before anything is built: the platform is made on a portal trip, not by the generator
  const blockAt = async (x, y, z) => {
    for (const name of ['obsidian', 'air', 'end_stone']) if (passed(await run(`/execute in minecraft:the_end if block ${x} ${y} ${z} minecraft:${name}`, 400))) return name;
    return 'other';
  };
  report.steps.platformBefore = { floor: await blockAt(100, 48, 0), above: await blockAt(100, 49, 0) };
  report.steps.platform = [await run('/execute in minecraft:the_end run fill 98 48 -2 102 48 2 minecraft:obsidian'),
                           await run('/execute in minecraft:the_end run fill 98 49 -2 102 52 2 minecraft:air')];
  report.steps.platformAfter = { floor: await blockAt(100, 48, 0), above: await blockAt(100, 49, 0), corner: await blockAt(102, 48, 2) };
  const t0 = Date.now();
  report.steps.tp = await run('/execute in minecraft:the_end run tp @s 100 49 0', 1500);
  for (let i = 0; i < 40 && bot.game.dimension !== 'the_end'; i++) await sleep(500);
  report.arrived = { dimension: bot.game.dimension, secondsAfterTp: Math.round((Date.now() - t0) / 100) / 10, position: bot.entity?.position };
  // the dragon: the server's own answer, and what the client was told
  let dragonAt = null;
  while ((Date.now() - t0) / 1000 < limitSeconds) {
    if (passed(await run('/execute in minecraft:the_end if entity @e[type=minecraft:ender_dragon]', 600))) { dragonAt = Math.round((Date.now() - t0) / 100) / 10; break; }
    await sleep(2000);
  }
  report.dragonFoundSeconds = dragonAt;
  if (dragonAt !== null) {
    await sleep(3000);
    report.steps.health = await run('/data get entity @e[type=minecraft:ender_dragon,limit=1] Health');
    report.steps.position = await run('/data get entity @e[type=minecraft:ender_dragon,limit=1] Pos');
    // counts through command storage: the chat text of a scoreboard answer loses its numbers in mineflayer, a data answer keeps them
    await run('/execute in minecraft:the_end store result storage lab:endcheck crystals int 1 if entity @e[type=minecraft:end_crystal]', 500);
    report.steps.crystals = await run('/data get storage lab:endcheck crystals');
    await run('/execute in minecraft:the_end store result storage lab:endcheck dragons int 1 if entity @e[type=minecraft:ender_dragon]', 500);
    report.steps.dragons = await run('/data get storage lab:endcheck dragons');
    // the client only hears of an entity inside the server's view distance (the lab default of 5 chunks = 80 blocks keeps the dragon
    // out of sight while it circles at ~100): wait for it, and say how long it took
    const seeStart = Date.now();
    let seen = null;
    while (Date.now() - seeStart < 60000) {
      seen = Object.values(bot.entities).find(e => e && e.name === 'ender_dragon');
      if (seen) break;
      await sleep(500);
    }
    report.clientSawDragonAfterSeconds = seen ? Math.round((Date.now() - seeStart) / 100) / 10 : null;
    if (seen) report.dragonEntity = { id: seen.id, type: seen.type, position: seen.position, height: seen.height, width: seen.width, metadataSlots: (seen.metadata || []).length };
    report.steps.exitPortal = await run('/execute in minecraft:the_end if block 0 62 0 minecraft:bedrock');
    report.steps.tickAfter = await run('/tick query', 900);
    const visible = Object.values(bot.entities).filter(e => e && ['ender_dragon', 'end_crystal'].includes(e.name));
    report.clientSees = { dragons: visible.filter(e => e.name === 'ender_dragon').map(e => ({ id: e.id, position: e.position, metadata: (e.metadata || []).length })),
                          crystals: visible.filter(e => e.name === 'end_crystal').length,
                          bossBars: Object.values(bot.bossBars || {}).map(b => ({ title: b.title?.toString?.() ?? String(b.title), health: b.health })) };
  }
  report.ok = dragonAt !== null;
} catch (error) {
  report.error = String(error);
  report.ok = false;
} finally {
  console.log('END_CHECK ' + JSON.stringify(report));
  bot.quit();
  setTimeout(() => process.exit(report.ok ? 0 : 1), 500);
}
