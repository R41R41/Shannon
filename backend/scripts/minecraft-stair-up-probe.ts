#!/usr/bin/env node
// Model-free: the way up from underground (run 20: after a descent to y -58 with no water at hand, the head asks for stair-mine upward with a direction).
// A slab of rock (MINECRAFT_UP_ROCK, default deepslate) is built in a flat lab world; the body stands in a pocket at the bottom with a pickaxe and
// cobblestone, and is told to go MINECRAFT_UP_LEVELS (default 30) levels up: stair-mine {targetY, direction: east} (MINECRAFT_UP_SKILL=stair-mine), or
// tower-up {height} (a straight pillar, 20 at most per call) for a comparison. Reports seconds, levels climbed, the metres gone sideways, and what the
// skill said. Lab ports 25660-25669 only. Setup commands are lab-only.
import fs from 'node:fs';
import path from 'node:path';
import { createProbeBot, closeProbeBot } from '../src/services/minebot/testing/MinecraftProbeBot.js';
import { MinecraftCommandOracle } from '../src/services/minebot/testing/MinecraftCommandOracle.js';

const port = Number(process.env.MINECRAFT_OUTAGE_PORT);
const worldDirectory = process.env.MINECRAFT_OUTAGE_WORLD_DIRECTORY ?? '';
if (process.env.MINECRAFT_OUTAGE_NO_LLM !== 'true' || !Number.isInteger(port) || port < 25660 || port > 25669
  || !/^\/home\/azureuser\/minecraft\/progressive-lab-[A-Za-z0-9]+$/.test(worldDirectory)) throw new Error('ISOLATED_PROBE_WORLD_REQUIRED');
const properties = fs.readFileSync(path.join(worldDirectory, 'server.properties'), 'utf8').split('\n');
if (!properties.includes('server-ip=127.0.0.1') || !properties.includes(`server-port=${port}`)) throw new Error('ISOLATED_PROBE_WORLD_CONFIGURATION_INVALID');

const levels = Number(process.env.MINECRAFT_UP_LEVELS ?? 30);
const rock = process.env.MINECRAFT_UP_ROCK ?? 'deepslate';
const skill = process.env.MINECRAFT_UP_SKILL ?? 'stair-mine';
const blocksGiven = Number(process.env.MINECRAFT_UP_BLOCKS ?? 64);
const actor: any = await createProbeBot(port, 'MinebotTrial');
const operator = await createProbeBot(port);
const oracle = new MinecraftCommandOracle(operator);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const report: any = { levels, rock, skill, blocksGiven };
try {
  await oracle.verifyReady();
  for (const command of ['gamerule spawn_mobs false', 'time set day', 'effect clear MinebotTrial', 'clear MinebotTrial', 'gamemode survival MinebotTrial',
    'effect give MinebotTrial minecraft:instant_health 1 5']) await oracle.executeSetupCommand(command);
  const x0 = 10, z0 = 10, y0 = 0;
  await oracle.executeSetupCommand(`forceload add ${x0 - 8} ${z0 - 8} ${x0 + levels + 8} ${z0 + 8}`);
  await oracle.executeSetupCommand('effect give MinebotTrial minecraft:slow_falling 20 0 true');
  await oracle.executeSetupCommand(`tp MinebotTrial ${x0 + 0.5} ${y0 + 6} ${z0 + 0.5}`);
  await sleep(2500);
  const top = y0 + levels + 4;
  await oracle.executeSetupCommand(`fill ${x0 - 3} ${y0 - 3} ${z0 - 3} ${x0 + levels + 3} ${top} ${z0 + 3} minecraft:${rock}`);
  await oracle.executeSetupCommand(`fill ${x0} ${y0} ${z0} ${x0} ${y0 + 1} ${z0} minecraft:air`);
  // The air above the slab, where the stair comes out (the lab world's own surface is far below: the slab stands in empty sky above it).
  await oracle.executeSetupCommand(`fill ${x0 - 3} ${top + 1} ${z0 - 3} ${x0 + levels + 3} ${top + 6} ${z0 + 3} minecraft:air`);
  await oracle.executeSetupCommand(`tp MinebotTrial ${x0 + 0.5} ${y0} ${z0 + 0.5}`);
  await oracle.executeSetupCommand('effect clear MinebotTrial');
  await oracle.executeSetupCommand('give MinebotTrial minecraft:diamond_pickaxe 1');
  await oracle.executeSetupCommand(`give MinebotTrial minecraft:cobblestone ${blocksGiven}`);
  await sleep(2500);
  const startY = Math.floor(actor.entity.position.y);
  const started = Date.now();
  const args = skill === 'stair-mine' ? [startY + levels, 'east'] : [Math.min(20, levels)];
  const moved: any = await Promise.race([actor.instantSkills.getSkill(skill)!.run(...args), sleep(Number(process.env.MINECRAFT_UP_LIMIT_MS ?? 280_000)).then(() => ({ result: 'probe time limit' }))]);
  const ms = Date.now() - started;
  const here = actor.entity.position;
  const climbed = Math.floor(here.y) - startY;
  report.climb = { ms, success: moved?.success ?? null, failureType: moved?.failureType ?? null, result: String(moved?.result).slice(0, 320), climbed, sidewaysM: +(here.x - (x0 + 0.5)).toFixed(1),
    secondsPerLevel: climbed > 0 ? +(ms / 1000 / climbed).toFixed(2) : null, cobbleLeft: actor.inventory.items().filter((i: any) => i.name === 'cobblestone').reduce((n: number, i: any) => n + i.count, 0) };
  report.passed = moved?.success === true && climbed >= levels;
  await oracle.executeSetupCommand(`forceload remove ${x0 - 8} ${z0 - 8} ${x0 + levels + 8} ${z0 + 8}`);
} catch (error) { report.error = String(error); process.exitCode = 1; }
finally {
  closeProbeBot(operator);
  closeProbeBot(actor);
  console.log(`STAIR_UP_REPORT ${JSON.stringify(report)}`);
}
