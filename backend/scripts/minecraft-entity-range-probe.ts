#!/usr/bin/env node
// Model-free: how far away does the body learn of a mob? Zombies that cannot move are put at set distances from
// the body along a platform, half of them behind a stone wall, and the body's own list of entities is read.
// The answer is the range a threat picture can be built from without any new sense (the emergency layer uses
// sixteen blocks of it). Setup commands are lab-only.
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
const actor = await createProbeBot(port, 'MinebotTrial');
const operator = await createProbeBot(port);
const oracle = new MinecraftCommandOracle(operator);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const report: any = { viewDistance: properties.find(line => line.startsWith('view-distance=')), simulationDistance: properties.find(line => line.startsWith('simulation-distance=')) };
try {
  await oracle.verifyReady();
  for (const command of ['gamerule spawn_mobs false', 'time set midnight', 'gamemode spectator ShannonProbe', 'kill @e[type=!minecraft:player]',
    'effect clear MinebotTrial', 'gamemode survival MinebotTrial', 'effect give MinebotTrial minecraft:instant_health 1 5']) await oracle.executeSetupCommand(command);
  const x0 = 200, z = 300, y = 230;
  // Loaded a strip at a time: one command over the whole length did not come back in time.
  for (let from = x0 - 8; from < x0 + 136; from += 48) await oracle.executeSetupCommand(`forceload add ${from} ${z - 8} ${Math.min(from + 47, x0 + 136)} ${z + 8}`);
  await sleep(4000);
  await oracle.executeSetupCommand('effect give MinebotTrial minecraft:slow_falling 8 0 true');
  await oracle.executeSetupCommand(`tp MinebotTrial ${x0 + 0.5} ${y + 3} ${z + 0.5}`);
  await sleep(3000);
  for (let from = x0 - 4; from < x0 + 132; from += 30) await oracle.executeSetupCommand(`fill ${from} ${y - 1} ${z - 2} ${Math.min(from + 29, x0 + 131)} ${y - 1} ${z + 2} stone`);
  await oracle.executeSetupCommand(`tp MinebotTrial ${x0 + 0.5} ${y} ${z + 0.5}`);
  // A wall three high right in front of the body: everything beyond it is out of sight.
  await oracle.executeSetupCommand(`fill ${x0 + 2} ${y} ${z - 2} ${x0 + 2} ${y + 3} ${z + 2} stone`);
  const distances = [12, 24, 36, 48, 64, 80, 96, 112, 128];
  for (const d of distances) await oracle.executeSetupCommand(`summon minecraft:zombie ${x0 + d + 0.5} ${y} ${z + 0.5} {NoAI:1b,PersistenceRequired:1b,Silent:1b}`);
  await sleep(6000);
  const seen = Object.values(actor.entities).filter((entity: any) => entity.name === 'zombie')
    .map((entity: any) => Math.round(entity.position.distanceTo(actor.entity.position))).sort((a, b) => a - b);
  report.placedAt = distances; report.seenAt = seen; report.farthestSeen = seen.length ? Math.max(...seen) : null;
  await oracle.executeSetupCommand('kill @e[type=minecraft:zombie]');
  await oracle.executeSetupCommand(`fill ${x0 + 2} ${y} ${z - 2} ${x0 + 2} ${y + 3} ${z + 2} air`);
} catch (error) {
  report.error = String((error as Error)?.stack ?? error).slice(0, 500);
} finally {
  console.log(`ENTITY_RANGE ${JSON.stringify(report)}`);
  closeProbeBot(operator); closeProbeBot(actor);
  setTimeout(() => process.exit(0), 500);
}
