#!/usr/bin/env node
// Model-free check on the probe lab that a dig the server did not carry out
// does not stay in the client's world as air. Setup commands are lab-only.
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
const report: any = {};
try {
  await oracle.verifyReady();
  for (const command of ['gamerule spawn_mobs false', 'time set day', 'gamemode spectator ShannonProbe', 'kill @e[type=!minecraft:player]',
    'clear MinebotTrial', 'effect clear MinebotTrial', 'gamemode survival MinebotTrial', 'effect give MinebotTrial minecraft:instant_health 1 5']) await oracle.executeSetupCommand(command);
  const origin = actor.entity.position.floored();
  const x0 = origin.x, y = origin.y + 30 > 280 ? 100 : origin.y + 30, z = origin.z;
  const moveTo = actor.instantSkills.getSkill('move-to')!;
  const wall = [new Vec3(x0 + 7, y, z), new Vec3(x0 + 7, y + 1, z)];
  const serverHas = async (position: Vec3, block: string) => (await oracle.evaluate({ type: 'block_at', x: position.x, y: position.y, z: position.z, block })).passed;
  const corridor = async () => {
    // A one-wide corridor with a dirt wall seven blocks ahead: out of the server's reach from the start.
    await oracle.executeSetupCommand(`fill ${x0 - 2} ${y - 1} ${z - 2} ${x0 + 14} ${y + 3} ${z + 2} stone`);
    await oracle.executeSetupCommand(`fill ${x0} ${y} ${z} ${x0 + 12} ${y + 1} ${z} air`);
    await oracle.executeSetupCommand(`fill ${x0 + 7} ${y} ${z} ${x0 + 7} ${y + 1} ${z} dirt`);
    await oracle.executeSetupCommand(`tp MinebotTrial ${x0 + 0.5} ${y} ${z + 0.5}`);
    await sleep(1500);
  };
  for (const confirmed of [false, true]) {
    await corridor();
    const dig = confirmed ? actor.dig.bind(actor) : (actor as any).unconfirmedDig as typeof actor.dig;
    const restoredBefore = (actor as any).ghostBlocksRestored ?? 0;
    const started = Date.now();
    for (const position of wall) await dig(actor.blockAt(position)!, true);
    const row: any = { digMs: Date.now() - started, clientAfterDig: wall.map(position => actor.blockAt(position)?.name),
      serverStillDirt: [await serverHas(wall[0], 'minecraft:dirt'), await serverHas(wall[1], 'minecraft:dirt')],
      restored: ((actor as any).ghostBlocksRestored ?? 0) - restoredBefore };
    const before = forcedMoves(actor).count;
    const walk: any = await Promise.race([moveTo.run(x0 + 11, y, z, 1, 'near'), sleep(25_000).then(() => ({ result: 'probe time limit' }))]);
    actor.pathfinder?.stop?.(); actor.clearControlStates();
    row.walk = String(walk?.result).slice(0, 110);
    row.pushedBack = forcedMoves(actor).count - before;
    row.reachedX = +(actor.entity.position.x - x0).toFixed(1);
    row.serverWallGone = [await serverHas(wall[0], 'minecraft:air'), await serverHas(wall[1], 'minecraft:air')];
    report[confirmed ? 'confirmedDig' : 'libraryDig'] = row;
  }
  // Finishing a dig in the air: the server counts five times slower, so its break comes after the client's timer.
  await corridor();
  await oracle.executeSetupCommand(`setblock ${x0 + 1} ${y + 1} ${z} dirt`);
  await sleep(800);
  const target = new Vec3(x0 + 1, y + 1, z);
  actor.setControlState('jump', true);
  await sleep(250);
  const airborneAtStart = !actor.entity.onGround;
  const started = Date.now();
  await actor.dig(actor.blockAt(target)!, true);
  const airborne = { airborneAtStart, digMs: Date.now() - started, client: actor.blockAt(target)?.name, serverAir: false };
  actor.setControlState('jump', false);
  airborne.serverAir = await serverHas(target, 'minecraft:air');
  report.airborne = airborne;
  // The library-dig arm leaves a wall only the server has: the body must stop pushing into it after a few refusals.
  report.passed = report.libraryDig.clientAfterDig.every((name: string) => name === 'air') && report.libraryDig.serverStillDirt.every(Boolean) && report.libraryDig.pushedBack <= 12
    && report.confirmedDig.clientAfterDig.every((name: string) => name === 'dirt') && report.confirmedDig.restored === 2
    && report.confirmedDig.reachedX >= 9 && report.confirmedDig.pushedBack <= 1 && report.confirmedDig.serverWallGone.every(Boolean)
    && airborne.client === 'air' && airborne.serverAir;
} catch (error) {
  report.error = String((error as Error)?.stack ?? error).slice(0, 600);
} finally {
  console.log(`DIG_CONFIRMATION ${JSON.stringify(report)}`);
  closeProbeBot(operator); closeProbeBot(actor);
  setTimeout(() => process.exit(0), 500);
}
