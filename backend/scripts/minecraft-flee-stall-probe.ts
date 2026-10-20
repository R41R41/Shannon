#!/usr/bin/env node
// Model-free: does flee-from freeze the event loop? (run 21: four stalls of 1.0-4.4 s, one with a 12.9 s gap between ticks, all inside flee-from,
// in a cave system with hundreds of chunk loads.) A cavern is cut in a rock box in a flat lab world (MINECRAFT_STALL_SIZE across, default 36 (the fill command takes 32768 blocks at most), with
// scattered pillars), a zombie without AI is put MINECRAFT_STALL_DISTANCE (default 8) blocks from the body, and flee-from is called
// MINECRAFT_STALL_RUNS times (default 3, minDistance 32). The longest gap between two turns of the event loop (a 20 ms timer), the seconds
// each call took and how far it got are reported. MINEBOT_FLEE_SEARCH_LIMIT=off is the control (the route search without its limits).
// Lab ports 25670-25679 only. Setup commands are lab-only.
import fs from 'node:fs';
import path from 'node:path';
import { createProbeBot, closeProbeBot } from '../src/services/minebot/testing/MinecraftProbeBot.js';
import { MinecraftCommandOracle } from '../src/services/minebot/testing/MinecraftCommandOracle.js';

const port = Number(process.env.MINECRAFT_OUTAGE_PORT);
const worldDirectory = process.env.MINECRAFT_OUTAGE_WORLD_DIRECTORY ?? '';
if (process.env.MINECRAFT_OUTAGE_NO_LLM !== 'true' || !Number.isInteger(port) || port < 25670 || port > 25679
  || !/^\/home\/azureuser\/minecraft\/progressive-lab-[A-Za-z0-9]+$/.test(worldDirectory)) throw new Error('ISOLATED_PROBE_WORLD_REQUIRED');
const properties = fs.readFileSync(path.join(worldDirectory, 'server.properties'), 'utf8').split('\n');
if (!properties.includes('server-ip=127.0.0.1') || !properties.includes(`server-port=${port}`)) throw new Error('ISOLATED_PROBE_WORLD_CONFIGURATION_INVALID');

const size = Number(process.env.MINECRAFT_STALL_SIZE ?? 36);
const distance = Number(process.env.MINECRAFT_STALL_DISTANCE ?? 8);
const runs = Number(process.env.MINECRAFT_STALL_RUNS ?? 3);
const half = Math.floor(size / 2);
const actor: any = await createProbeBot(port, 'MinebotTrial');
const operator = await createProbeBot(port);
const oracle = new MinecraftCommandOracle(operator);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const report: any = { size, distance, limit: process.env.MINEBOT_FLEE_SEARCH_LIMIT ?? 'on', runs: [] };
let seed = 12345;
const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
try {
  await oracle.verifyReady();
  for (const command of ['gamerule spawn_mobs false', 'difficulty easy', 'time set day', 'effect clear MinebotTrial', 'clear MinebotTrial', 'gamemode survival MinebotTrial',
    'effect give MinebotTrial minecraft:instant_health 1 5', 'kill @e[type=minecraft:zombie]']) await oracle.executeSetupCommand(command);
  const x0 = 16, z0 = 16, y0 = 40, ceiling = 8;
  await oracle.executeSetupCommand(`forceload add ${x0 - half - 8} ${z0 - half - 8} ${x0 + half + 8} ${z0 + half + 8}`);
  await oracle.executeSetupCommand('effect give MinebotTrial minecraft:slow_falling 20 0 true');
  await oracle.executeSetupCommand(`tp MinebotTrial ${x0 + 0.5} ${y0 + ceiling + 12} ${z0 + 0.5}`);
  await sleep(3000);
  await oracle.executeSetupCommand(`fill ${x0 - half - 3} ${y0 - 3} ${z0 - half - 3} ${x0 + half + 3} ${y0 + ceiling + 3} ${z0 + half + 3} minecraft:stone`);
  await oracle.executeSetupCommand(`fill ${x0 - half} ${y0} ${z0 - half} ${x0 + half} ${y0 + ceiling} ${z0 + half} minecraft:air`);
  // pillars and ledges so that the cavern is not an empty box
  for (let i = 0; i < 40; i++) {
    const px = x0 - half + 2 + Math.floor(random() * (size - 4)), pz = z0 - half + 2 + Math.floor(random() * (size - 4));
    if (Math.abs(px - x0) < 3 && Math.abs(pz - z0) < 3) continue;
    await oracle.executeSetupCommand(`fill ${px} ${y0} ${pz} ${px + 1} ${y0 + 1 + Math.floor(random() * ceiling)} ${pz + 1} minecraft:stone`);
  }
  await oracle.executeSetupCommand(`tp MinebotTrial ${x0 + 0.5} ${y0} ${z0 + 0.5}`);
  await oracle.executeSetupCommand('effect clear MinebotTrial');
  await oracle.executeSetupCommand('give MinebotTrial minecraft:iron_pickaxe 1');
  await oracle.executeSetupCommand('give MinebotTrial minecraft:cobblestone 64');
  await sleep(2500);

  let worstGap = 0, last = Date.now();
  const watch = setInterval(() => { const now = Date.now(); worstGap = Math.max(worstGap, now - last); last = now; }, 20);
  for (let run = 1; run <= runs; run++) {
    await oracle.executeSetupCommand('kill @e[type=minecraft:zombie]');
    await oracle.executeSetupCommand(`tp MinebotTrial ${x0 + 0.5} ${y0} ${z0 + 0.5}`);
    await sleep(1200);
    await oracle.executeSetupCommand(`summon minecraft:zombie ${x0 + 0.5 + distance} ${y0} ${z0 + 0.5} {NoAI:1b,PersistenceRequired:1b}`);
    await sleep(1200);
    worstGap = 0; last = Date.now();
    report.debug = { pos: actor.entity.position.toArray().map((v: number) => +v.toFixed(1)), feet: actor.blockAt(actor.entity.position.floored())?.name, zombies: Object.values(actor.entities).filter((e: any) => e.name === 'zombie').map((e: any) => e.position.toArray().map((v: number) => +v.toFixed(1))) };
    const from = actor.entity.position.clone();
    const started = Date.now();
    const result: any = await Promise.race([actor.instantSkills.getSkill('flee-from')!.run('zombie', 32, 12_000),
      sleep(30_000).then(() => ({ result: 'probe time limit', success: false }))]);
    const ms = Date.now() - started;
    const here = actor.entity.position;
    report.runs.push({ run, seconds: +(ms / 1000).toFixed(1), success: result?.success ?? null, failureType: result?.failureType ?? null,
      movedM: +here.distanceTo(from).toFixed(1), worstEventLoopGapMs: worstGap, result: String(result?.result).slice(0, 160) });
  }
  clearInterval(watch);
  report.worstGapMs = Math.max(...report.runs.map((r: any) => r.worstEventLoopGapMs));
  await oracle.executeSetupCommand('kill @e[type=minecraft:zombie]');
  await oracle.executeSetupCommand(`forceload remove ${x0 - half - 8} ${z0 - half - 8} ${x0 + half + 8} ${z0 + half + 8}`);
} catch (error) { report.error = String(error); process.exitCode = 1; }
finally {
  closeProbeBot(operator);
  closeProbeBot(actor);
  console.log(`STALL_REPORT ${JSON.stringify(report)}`);
}
