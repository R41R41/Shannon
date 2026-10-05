#!/usr/bin/env node
// Model-free: press the body against a wall whose face lies on a plane where the physics library's exact
// comparisons let a flush body through (x = -2), with and without the collision tolerance, and count how
// often the server puts the body back. Setup commands are lab-only.
import fs from 'node:fs';
import path from 'node:path';
import { Vec3 } from 'vec3';
import { createProbeBot, closeProbeBot } from '../src/services/minebot/testing/MinecraftProbeBot.js';
import { MinecraftCommandOracle } from '../src/services/minebot/testing/MinecraftCommandOracle.js';
import { forcedMoves } from '../src/services/minebot/utils/motionRecorder.js';
import { installCollisionTolerance, uninstallCollisionTolerance } from '../src/services/minebot/utils/collisionTolerance.js';

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
const report: any = {};
try {
  await oracle.verifyReady();
  for (const command of ['gamerule spawn_mobs false', 'time set day', 'gamemode spectator ShannonProbe', 'kill @e[type=!minecraft:player]',
    'clear MinebotTrial', 'effect clear MinebotTrial', 'gamemode survival MinebotTrial', 'effect give MinebotTrial minecraft:instant_health 1 5']) await oracle.executeSetupCommand(command);
  const y = 230;
  // A floor, and a wall three blocks high occupying x in [-2,-1]: its west face lies on the plane x = -2.
  await oracle.executeSetupCommand(`fill -9 ${y - 1} -3 3 ${y - 1} 3 stone`);
  await oracle.executeSetupCommand(`fill -9 ${y} -3 3 ${y + 4} 3 air`);
  await oracle.executeSetupCommand(`fill -2 ${y} -3 -2 ${y + 2} 3 stone`);
  for (const tolerant of [false, true]) {
    if (tolerant) installCollisionTolerance(); else uninstallCollisionTolerance();
    await oracle.executeSetupCommand(`tp MinebotTrial -5.5 ${y} 0.5`);
    await sleep(1500);
    const before = forcedMoves(actor).count;
    await actor.lookAt(new Vec3(3.5, y + 1.62, 0.5), true);
    actor.setControlState('forward', true);
    let deepest = -Infinity;
    const onTick = () => { deepest = Math.max(deepest, actor.entity.position.x); };
    actor.on('physicsTick', onTick);
    await sleep(5000);
    actor.removeListener('physicsTick', onTick);
    actor.clearControlStates();
    await sleep(500);
    report[tolerant ? 'withTolerance' : 'libraryAlone'] = { pushedBack: forcedMoves(actor).count - before, restsAtX: +actor.entity.position.x.toFixed(4),
      // The furthest east the client believed its centre was: past -2.3 means it had walked into the wall.
      deepestClaimedX: +deepest.toFixed(4) };
  }
  installCollisionTolerance();
  report.passed = report.libraryAlone.pushedBack >= 1 && report.libraryAlone.deepestClaimedX > -2.29 && report.withTolerance.pushedBack === 0 && report.withTolerance.deepestClaimedX <= -2.2999;
} catch (error) {
  report.error = String((error as Error)?.stack ?? error).slice(0, 600);
} finally {
  console.log(`WALL_PRESS ${JSON.stringify(report)}`);
  closeProbeBot(operator); closeProbeBot(actor);
  setTimeout(() => process.exit(0), 500);
}
