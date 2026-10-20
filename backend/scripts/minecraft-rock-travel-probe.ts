#!/usr/bin/env node
// Model-free: how a far walk through rock goes (run 21: seven far walks of 37-43 m over a hill took 58-82 s each, zigzagging, laying blocks).
// A slab of rock (MINECRAFT_RT_ROCK, default stone) is built in a flat lab world, the body is put in a pocket at one end with an iron pickaxe
// and told to walk to a pocket MINECRAFT_RT_LENGTH (default 30) blocks away through the rock, MINECRAFT_RT_RISE (default -24, negative =
// lower) blocks higher; with MINECRAFT_RT_RETURN=1 it then walks back to the first pocket. Reports for each walk the seconds, the path the
// body took against the straight line (length, widest deviation), the blocks dug and laid, and the route searches.
// MINEBOT_ROCK_TRAVEL=off (a control: the route search as before run 21) is read by the body itself.
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

const length = Number(process.env.MINECRAFT_RT_LENGTH ?? 30);
const rise = Number(process.env.MINECRAFT_RT_RISE ?? -24);
const rock = process.env.MINECRAFT_RT_ROCK ?? 'stone';
const pickaxe = process.env.MINECRAFT_RT_PICKAXE ?? 'iron_pickaxe';
const wantBack = process.env.MINECRAFT_RT_RETURN === '1';
const limitMs = Number(process.env.MINECRAFT_RT_LIMIT_MS ?? 200_000);
const actor: any = await createProbeBot(port, 'MinebotTrial');
const operator = await createProbeBot(port);
const oracle = new MinecraftCommandOracle(operator);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const report: any = { length, rise, rock, pickaxe, rockTravel: process.env.MINEBOT_ROCK_TRAVEL ?? 'on' };
try {
  await oracle.verifyReady();
  for (const command of ['gamerule spawn_mobs false', 'time set day', 'effect clear MinebotTrial', 'clear MinebotTrial', 'gamemode survival MinebotTrial',
    'effect give MinebotTrial minecraft:instant_health 1 5']) await oracle.executeSetupCommand(command);
  const x0 = 10, z0 = 10, y0 = 40;
  const low = Math.min(0, rise), high = Math.max(0, rise);
  await oracle.executeSetupCommand(`forceload add ${x0 - 8} ${z0 - 8} ${x0 + length + 8} ${z0 + 8}`);
  await oracle.executeSetupCommand('effect give MinebotTrial minecraft:slow_falling 20 0 true');
  await oracle.executeSetupCommand(`tp MinebotTrial ${x0 + 0.5} ${y0 + high + 6} ${z0 + 0.5}`);
  await sleep(2500);
  // The slab: rock from 3 below the lowest pocket to 4 above the highest, 7 wide; two pockets of air (the start and the target).
  await oracle.executeSetupCommand(`fill ${x0 - 3} ${y0 + low - 3} ${z0 - 3} ${x0 + length + 3} ${y0 + high + 4} ${z0 + 3} minecraft:${rock}`);
  await oracle.executeSetupCommand(`fill ${x0} ${y0} ${z0} ${x0} ${y0 + 1} ${z0} minecraft:air`);
  await oracle.executeSetupCommand(`fill ${x0 + length} ${y0 + rise} ${z0} ${x0 + length} ${y0 + rise + 1} ${z0} minecraft:air`);
  await oracle.executeSetupCommand(`tp MinebotTrial ${x0 + 0.5} ${y0} ${z0 + 0.5}`);
  await oracle.executeSetupCommand('effect clear MinebotTrial');
  await oracle.executeSetupCommand(`give MinebotTrial minecraft:${pickaxe} 1`);
  await oracle.executeSetupCommand('give MinebotTrial minecraft:cobblestone 32');
  await sleep(2500);

  const stats = { digs: 0, placed: 0, resets: {} as Record<string, number>, updates: 0 };
  actor.on('path_reset', (reason: string) => { stats.resets[reason] = (stats.resets[reason] ?? 0) + 1; });
  actor.on('path_update', () => { stats.updates++; });
  actor.on('diggingCompleted', () => { stats.digs++; });
  actor.on('blockPlaced', () => { stats.placed++; });

  /** One move-to, with the body's path sampled every 200 ms against the straight line between the ends. */
  const walk = async (from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }, label: string) => {
    const before = { digs: stats.digs, placed: stats.placed, updates: stats.updates, resets: { ...stats.resets } };
    let travelled = 0, widest = 0, last = actor.entity.position.clone();
    const straight = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
    const sampler = setInterval(() => {
      const p = actor.entity.position;
      travelled += Math.hypot(p.x - last.x, p.y - last.y, p.z - last.z);
      last = p.clone();
      // distance from the straight line from -> to
      const ux = (to.x - from.x) / straight, uy = (to.y - from.y) / straight, uz = (to.z - from.z) / straight;
      const wx = p.x - from.x, wy = p.y - from.y, wz = p.z - from.z;
      const along = wx * ux + wy * uy + wz * uz;
      widest = Math.max(widest, Math.hypot(wx - along * ux, wy - along * uy, wz - along * uz));
    }, 200);
    const started = Date.now();
    const moved: any = await Promise.race([actor.instantSkills.getSkill('move-to')!.run(to.x, to.y, to.z, 1, 'near'),
      sleep(limitMs).then(() => ({ result: 'probe time limit', success: false }))]);
    const ms = Date.now() - started;
    clearInterval(sampler);
    const here = actor.entity.position;
    const resets: Record<string, number> = {};
    for (const [reason, count] of Object.entries(stats.resets)) if (count > (before.resets[reason] ?? 0)) resets[reason] = count - (before.resets[reason] ?? 0);
    report[label] = { ms, seconds: +(ms / 1000).toFixed(1), success: moved?.success ?? null, failureType: moved?.failureType ?? null, result: String(moved?.result).slice(0, 240),
      endDistance: +Math.hypot(here.x - to.x, here.y - to.y, here.z - to.z).toFixed(1), straightM: +straight.toFixed(1), pathM: +travelled.toFixed(1),
      pathOverStraight: +(travelled / straight).toFixed(2), widestFromLineM: +widest.toFixed(1),
      blocksDug: stats.digs - before.digs, blocksLaid: stats.placed - before.placed, pathUpdates: stats.updates - before.updates, pathResets: resets };
    return moved;
  };

  const start = { x: x0, y: y0, z: z0 }, target = { x: x0 + length, y: y0 + rise, z: z0 };
  const first = await walk(start, target, 'there');
  report.passed = first?.success === true;
  if (wantBack && first?.success === true) {
    await sleep(1500);
    const back = await walk(target, start, 'back');
    report.passed = report.passed && back?.success === true;
  }
  await oracle.executeSetupCommand(`forceload remove ${x0 - 8} ${z0 - 8} ${x0 + length + 8} ${z0 + 8}`);
} catch (error) { report.error = String(error); process.exitCode = 1; }
finally {
  closeProbeBot(operator);
  closeProbeBot(actor);
  console.log(`RT_REPORT ${JSON.stringify(report)}`);
}
