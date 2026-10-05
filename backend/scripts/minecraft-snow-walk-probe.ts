#!/usr/bin/env node
// Model-free: walk across strips of snow layers of each thickness and count how often the server puts the
// body back, with the collision height the client holds for each thickness. Setup commands are lab-only.
import fs from 'node:fs';
import path from 'node:path';
import { Vec3 } from 'vec3';
import { createProbeBot, closeProbeBot } from '../src/services/minebot/testing/MinecraftProbeBot.js';
import { MinecraftCommandOracle } from '../src/services/minebot/testing/MinecraftCommandOracle.js';
import { forcedMoves } from '../src/services/minebot/utils/motionRecorder.js';

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
const report: any = { strips: [] };
try {
  await oracle.verifyReady();
  for (const command of ['gamerule spawn_mobs false', 'time set day', 'weather clear', 'gamemode spectator ShannonProbe', 'kill @e[type=!minecraft:player]',
    'effect clear MinebotTrial', 'gamemode survival MinebotTrial']) await oracle.executeSetupCommand(command);
  const y = 150, x0 = 1000, z0 = 3000;
  await oracle.executeSetupCommand(`tp ShannonProbe ${x0} ${y + 12} ${z0}`);
  await sleep(4000);
  await oracle.executeSetupCommand(`fill ${x0 - 4} ${y - 1} ${z0 - 3} ${x0 + 30} ${y - 1} ${z0 + 20} stone`);
  await oracle.executeSetupCommand(`fill ${x0 - 4} ${y} ${z0 - 3} ${x0 + 30} ${y + 4} ${z0 + 20} air`);
  // One lane per thickness: twelve cells of snow of that many layers along x, on lane z0 + 2*layers.
  for (let layers = 1; layers <= 8; layers++) await oracle.executeSetupCommand(`fill ${x0 + 2} ${y} ${z0 + 2 * layers} ${x0 + 13} ${y} ${z0 + 2 * layers} snow[layers=${layers}]`);
  await oracle.executeSetupCommand(`tp MinebotTrial ${x0 - 1.5} ${y} ${z0 + 0.5}`);
  await sleep(2500);
  for (let layers = 1; layers <= 8; layers++) {
    const z = z0 + 2 * layers;
    await oracle.executeSetupCommand(`tp MinebotTrial ${x0 - 1.5} ${y} ${z + 0.5}`);
    await sleep(1200);
    const block: any = actor.blockAt(new Vec3(x0 + 5, y, z));
    const top = Math.max(0, ...((block?.shapes ?? []) as number[][]).map(shape => shape[4]));
    const before = forcedMoves(actor).count;
    await actor.lookAt(new Vec3(x0 + 20, y + 1.62, z + 0.5), true);
    actor.setControlState('forward', true);
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && actor.entity.position.x < x0 + 16) await sleep(50);
    actor.clearControlStates();
    await sleep(400);
    report.strips.push({ layers, clientBlock: block?.name, clientCollisionTop: +top.toFixed(3), serverCollisionTop: +((layers - 1) / 8).toFixed(3),
      pushedBack: forcedMoves(actor).count - before, reachedX: +(actor.entity.position.x - x0).toFixed(1) });
  }
  report.passed = report.strips.every((strip: any) => strip.pushedBack === 0 && strip.reachedX >= 15);
} catch (error) {
  report.error = String((error as Error)?.stack ?? error).slice(0, 600);
} finally {
  console.log(`SNOW_WALK ${JSON.stringify(report)}`);
  closeProbeBot(operator); closeProbeBot(actor);
  setTimeout(() => process.exit(0), 500);
}
