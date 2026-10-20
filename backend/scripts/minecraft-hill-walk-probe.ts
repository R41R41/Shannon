#!/usr/bin/env node
// Model-free: the far walks of run 21 over a hill, in the same world (the seed of that run, natural terrain). The body is put on the ground
// at MINECRAFT_HILL_FROM="x,z" and told to move-to MINECRAFT_HILL_TO="x,y,z" (goalType near, range 2), then back to where it started.
// Reports for each walk the seconds, the path against the straight line, the blocks dug and laid, the stuck/path-reset counts.
// MINEBOT_ROCK_TRAVEL=off is the control (the route search as before). Lab ports 25670-25679 only. Setup commands are lab-only.
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

const [fromX, fromZ] = (process.env.MINECRAFT_HILL_FROM ?? '357,-220').split(',').map(Number);
const [toX, toY, toZ] = (process.env.MINECRAFT_HILL_TO ?? '362,58,-229').split(',').map(Number);
const limitMs = Number(process.env.MINECRAFT_HILL_LIMIT_MS ?? 150_000);
const actor: any = await createProbeBot(port, 'MinebotTrial');
const operator = await createProbeBot(port);
const oracle = new MinecraftCommandOracle(operator);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const report: any = { from: [fromX, fromZ], to: [toX, toY, toZ], rockTravel: process.env.MINEBOT_ROCK_TRAVEL ?? 'on' };
try {
  await oracle.verifyReady();
  for (const command of ['gamerule spawn_mobs false', 'time set day', 'effect clear MinebotTrial', 'clear MinebotTrial', 'gamemode survival MinebotTrial',
    'effect give MinebotTrial minecraft:instant_health 1 5']) await oracle.executeSetupCommand(command);
  const box = [Math.min(fromX, toX) - 24, Math.min(fromZ, toZ) - 24, Math.max(fromX, toX) + 24, Math.max(fromZ, toZ) + 24];
  await oracle.executeSetupCommand(`forceload add ${box.join(' ')}`);
  // Down onto the ground from the sky: slow falling, then wait until the body stands.
  await oracle.executeSetupCommand('effect give MinebotTrial minecraft:slow_falling 120 0 true');
  await oracle.executeSetupCommand(`tp MinebotTrial ${fromX + 0.5} 180 ${fromZ + 0.5}`);
  for (let i = 0; i < 80 && !(actor.entity.onGround && Math.abs(actor.entity.position.x - (fromX + 0.5)) < 3); i++) await sleep(500);
  await oracle.executeSetupCommand('effect clear MinebotTrial');
  await oracle.executeSetupCommand('give MinebotTrial minecraft:iron_pickaxe 1');
  await oracle.executeSetupCommand('give MinebotTrial minecraft:cobblestone 64');
  await sleep(2000);
  const start = actor.entity.position.clone();
  report.standing = start.toArray().map((v: number) => +v.toFixed(1));

  const stats = { digs: 0, placed: 0, resets: {} as Record<string, number> };
  actor.on('path_reset', (reason: string) => { stats.resets[reason] = (stats.resets[reason] ?? 0) + 1; });
  actor.on('diggingCompleted', () => { stats.digs++; });
  actor.on('blockPlaced', () => { stats.placed++; });
  const walk = async (from: any, to: { x: number; y: number; z: number }, label: string) => {
    const before = { digs: stats.digs, placed: stats.placed, resets: { ...stats.resets } };
    let travelled = 0, widest = 0, last = actor.entity.position.clone();
    const straight = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
    const sampler = setInterval(() => {
      const p = actor.entity.position;
      travelled += Math.hypot(p.x - last.x, p.y - last.y, p.z - last.z); last = p.clone();
      const ux = (to.x - from.x) / straight, uy = (to.y - from.y) / straight, uz = (to.z - from.z) / straight;
      const wx = p.x - from.x, wy = p.y - from.y, wz = p.z - from.z, along = wx * ux + wy * uy + wz * uz;
      widest = Math.max(widest, Math.hypot(wx - along * ux, wy - along * uy, wz - along * uz));
    }, 200);
    const started = Date.now();
    // The same call twice at most when the first ends "movement_incomplete" (what the planner does: the same goal again).
    let moved: any = null;
    for (let call = 1; call <= 3; call++) {
      moved = await Promise.race([actor.instantSkills.getSkill('move-to')!.run(to.x, to.y, to.z, 2, 'near'), sleep(limitMs).then(() => ({ result: 'probe time limit', success: false }))]);
      if (moved?.success || moved?.failureType !== 'movement_incomplete' || Date.now() - started > limitMs) break;
    }
    const ms = Date.now() - started;
    clearInterval(sampler);
    const here = actor.entity.position;
    const resets: Record<string, number> = {};
    for (const [reason, count] of Object.entries(stats.resets)) if (count > (before.resets[reason] ?? 0)) resets[reason] = count - (before.resets[reason] ?? 0);
    report[label] = { seconds: +(ms / 1000).toFixed(1), success: moved?.success ?? null, failureType: moved?.failureType ?? null, result: String(moved?.result).slice(0, 200),
      endDistance: +Math.hypot(here.x - to.x, here.y - to.y, here.z - to.z).toFixed(1), straightM: +straight.toFixed(1), pathM: +travelled.toFixed(1),
      pathOverStraight: +(travelled / straight).toFixed(2), widestFromLineM: +widest.toFixed(1), blocksDug: stats.digs - before.digs, blocksLaid: stats.placed - before.placed, pathResets: resets };
  };
  await walk(start, { x: toX, y: toY, z: toZ }, 'there');
  const home = { x: Math.floor(start.x), y: Math.floor(start.y), z: Math.floor(start.z) };
  await sleep(1500);
  await walk(actor.entity.position.clone(), home, 'back');
  report.passed = report.there?.success === true && report.back?.success === true;
  await oracle.executeSetupCommand(`forceload remove ${box.join(' ')}`);
} catch (error) { report.error = String(error); process.exitCode = 1; }
finally {
  closeProbeBot(operator);
  closeProbeBot(actor);
  console.log(`HILL_REPORT ${JSON.stringify(report)}`);
}
