#!/usr/bin/env node
// Model-free: a few nether bricks (a fortress's marker blocks) 150 blocks east on flat ground, out of the loaded range.
// find-structure cannot see them from the start; explore-for-structure should walk east in legs and find them.
// Setup commands are lab-only.
import fs from 'node:fs';
import path from 'node:path';
import { createProbeBot, closeProbeBot } from '../src/services/minebot/testing/MinecraftProbeBot.js';
import { MinecraftCommandOracle } from '../src/services/minebot/testing/MinecraftCommandOracle.js';

const port = Number(process.env.MINECRAFT_OUTAGE_PORT);
const worldDirectory = process.env.MINECRAFT_OUTAGE_WORLD_DIRECTORY ?? '';
if (process.env.MINECRAFT_OUTAGE_NO_LLM !== 'true' || !Number.isInteger(port) || port < 25577 || port > 25651
  || !/^\/home\/azureuser\/minecraft\/progressive-lab-[A-Za-z0-9]+$/.test(worldDirectory)) throw new Error('ISOLATED_PROBE_WORLD_REQUIRED');
const properties = fs.readFileSync(path.join(worldDirectory, 'server.properties'), 'utf8').split('\n');
if (!properties.includes('server-ip=127.0.0.1') || !properties.includes(`server-port=${port}`)) throw new Error('ISOLATED_PROBE_WORLD_CONFIGURATION_INVALID');
const distance = Number(process.env.MINECRAFT_EXPLORE_DISTANCE ?? 150);
if (!Number.isInteger(distance) || distance < 100 || distance > 300) throw new Error('EXPLORE_PROBE_SHAPE_INVALID');
const actor = await createProbeBot(port, 'MinebotTrial');
const operator = await createProbeBot(port);
const oracle = new MinecraftCommandOracle(operator);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const report: any = { distance };
try {
  await oracle.verifyReady();
  for (const command of ['gamerule spawn_mobs false', 'time set day', 'gamemode spectator ShannonProbe', 'kill @e[type=!minecraft:player]',
    'clear MinebotTrial', 'effect clear MinebotTrial', 'gamemode survival MinebotTrial']) await oracle.executeSetupCommand(command);
  await oracle.executeSetupCommand('tp MinebotTrial 0.5 -60 0.5');
  await sleep(2000);
  const y = Math.floor(actor.entity.position.y);
  await oracle.executeSetupCommand(`forceload add ${distance - 2} -2 ${distance + 2} 2`);
  await oracle.executeSetupCommand(`fill ${distance} ${y} 0 ${distance} ${y + 2} 0 nether_bricks`);
  await oracle.executeSetupCommand(`forceload remove ${distance - 2} -2 ${distance + 2} 2`);
  await sleep(1000);
  const before: any = await actor.instantSkills.getSkill('find-structure')!.run('fortress');
  report.findBefore = String(before?.result).slice(0, 120);
  const started = Date.now();
  const explored: any = await Promise.race([actor.instantSkills.getSkill('explore-for-structure')!.run('fortress', 'east', 240),
    sleep(280_000).then(() => ({ result: 'probe time limit' }))]);
  const at = actor.entity.position;
  Object.assign(report, { explore: { success: explored?.success, result: String(explored?.result).slice(0, 240) }, ms: Date.now() - started,
    at: `${at.x.toFixed(1)},${at.y.toFixed(1)},${at.z.toFixed(1)}` });
  report.passed = explored?.success === true && /\(\s*\d+, -?\d+, 0\)|座標\(\d+/.test(String(explored?.result)) && String(explored?.result).includes(String(distance));
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
} finally {
  console.log(JSON.stringify(report));
  for (const bot of [actor, operator]) { try { await closeProbeBot(bot); } catch { /* already gone */ } }
  setTimeout(() => process.exit(0), 1000).unref();
}
