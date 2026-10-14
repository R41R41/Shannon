#!/usr/bin/env node
// Model-free: the body stands on a lone log high above the ground (common run 7: a jungle branch 12 blocks up).
// Every way off is a drop the route planner will not take, so move-to has no path. Reports what move-to and
// check-path-to say there, and whether climb-down brings the body to the ground, how, and at what cost in health.
// MINECRAFT_PERCH_MODE: fall (bare drop), vine (a vine column down one side), water (a pool under one side).
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
const mode = process.env.MINECRAFT_PERCH_MODE ?? 'fall';
const drop = Number(process.env.MINECRAFT_PERCH_DROP ?? 12);
if (!['fall', 'vine', 'water'].includes(mode) || !Number.isInteger(drop) || drop < 5 || drop > 30) throw new Error('PERCH_PROBE_SHAPE_INVALID');
const actor = await createProbeBot(port, 'MinebotTrial');
const operator = await createProbeBot(port);
const oracle = new MinecraftCommandOracle(operator);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const report: any = { mode, drop };
try {
  await oracle.verifyReady();
  for (const command of ['gamerule spawn_mobs false', 'time set day', 'gamemode spectator ShannonProbe', 'kill @e[type=!minecraft:player]',
    'clear MinebotTrial', 'effect clear MinebotTrial', 'gamemode survival MinebotTrial', 'effect give MinebotTrial minecraft:instant_health 1 5']) await oracle.executeSetupCommand(command);
  const y = 200, ground = y - drop - 1;
  await oracle.executeSetupCommand(`fill -8 ${ground} -8 8 ${y + 4} 8 air`);
  await oracle.executeSetupCommand(`fill -8 ${ground} -8 8 ${ground} 8 grass_block`);
  await oracle.executeSetupCommand(`setblock 0 ${y - 1} 0 jungle_log`);
  if (mode === 'vine') {
    // A pillar east of the column carries the vines; the column itself (x=1) is open, as on a jungle trunk.
    await oracle.executeSetupCommand(`fill 2 ${ground + 1} 0 2 ${y - 1} 0 jungle_log`);
    await oracle.executeSetupCommand(`fill 1 ${ground + 1} 0 1 ${y} 0 vine[east=true]`);
  }
  if (mode === 'water') {
    // A pool two deep, flush with the ground, under the cell north of the log: nothing to step down onto.
    await oracle.executeSetupCommand(`fill -1 ${ground - 3} -3 1 ${ground - 3} -1 stone`);
    await oracle.executeSetupCommand(`fill 0 ${ground - 2} -1 0 ${ground} -1 water`);
  }
  await oracle.executeSetupCommand(`tp MinebotTrial 0.5 ${y} 0.5`);
  await oracle.executeSetupCommand('give MinebotTrial minecraft:jungle_planks 16');
  await sleep(2000);
  await oracle.executeSetupCommand('effect give MinebotTrial minecraft:instant_health 1 5');
  await sleep(1000);
  const skill = (name: string) => actor.instantSkills.getSkill(name)!;
  const target = [6, ground + 1, 6] as const;
  const moved: any = await Promise.race([skill('move-to').run(...target, 1, 'near'), sleep(30_000).then(() => ({ result: 'probe time limit' }))]);
  report.moveTo = { success: moved?.success, result: String(moved?.result).slice(0, 220) };
  const checked: any = await skill('check-path-to').run(...target);
  report.checkPathTo = String(checked?.result).slice(0, 220);
  const healthBefore = actor.health, startY = actor.entity.position.y;
  let lowestHealth = actor.health;
  const onHealth = () => { lowestHealth = Math.min(lowestHealth, actor.health); };
  actor.on('health', onHealth);
  const started = Date.now();
  const descended: any = await Promise.race([skill('climb-down').run(), sleep(30_000).then(() => ({ result: 'probe time limit' }))]);
  await sleep(1500);
  actor.removeListener('health', onHealth);
  const at = actor.entity.position;
  Object.assign(report, { climbDown: { success: descended?.success, result: String(descended?.result).slice(0, 220) }, ms: Date.now() - started,
    startY, endY: +at.y.toFixed(2), healthBefore, healthAfter: actor.health, lowestHealth, edgeGuardEnabled: (actor as any).edgeGuard?.enabled });
  const afterwards: any = await Promise.race([skill('move-to').run(...target, 1, 'near'), sleep(30_000).then(() => ({ result: 'probe time limit' }))]);
  report.moveToAfter = { success: afterwards?.success, result: String(afterwards?.result).slice(0, 160) };
  report.passed = descended?.success === true && at.y < ground + 2.5 && actor.health > 0 && report.edgeGuardEnabled === true;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
} finally {
  console.log(JSON.stringify(report));
  for (const bot of [actor, operator]) { try { await closeProbeBot(bot); } catch { /* already gone */ } }
  setTimeout(() => process.exit(0), 1000).unref();
}
