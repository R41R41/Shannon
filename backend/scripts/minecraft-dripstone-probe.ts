#!/usr/bin/env node
// Model-free: swim a channel studded with pointed dripstone (whose real shape the server shifts per block)
// and report how often the server put the body back and which cells the body learned to keep out of.
import fs from 'node:fs';
import path from 'node:path';
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
  for (const command of ['gamerule spawn_mobs false', 'gamerule random_tick_speed 0', 'time set day', 'gamemode spectator ShannonProbe', 'kill @e[type=!minecraft:player]',
    'clear MinebotTrial', 'effect clear MinebotTrial', 'gamemode survival MinebotTrial', 'effect give MinebotTrial minecraft:instant_health 1 5']) await oracle.executeSetupCommand(command);
  const origin = actor.entity.position.floored();
  const x0 = origin.x, y = origin.y + 30 > 280 ? 100 : origin.y + 30, z = origin.z;
  await oracle.executeSetupCommand(`fill ${x0 - 2} ${y - 4} ${z - 3} ${x0 + 18} ${y + 3} ${z + 3} stone`);
  await oracle.executeSetupCommand(`fill ${x0} ${y} ${z - 1} ${x0 + 16} ${y + 2} ${z + 1} air`);
  await oracle.executeSetupCommand(`fill ${x0} ${y - 2} ${z - 1} ${x0 + 16} ${y - 1} ${z + 1} water`);
  // Stalagmite tips just under the surface, on both sides and down the middle.
  const tips: Array<[number, number]> = [[4, -1], [4, 1], [6, 0], [8, -1], [8, 1], [10, 0], [12, -1], [12, 1]];
  for (const [dx, dz] of tips) {
    await oracle.executeSetupCommand(`setblock ${x0 + dx} ${y - 2} ${z + dz} stone`);
    await oracle.executeSetupCommand(`setblock ${x0 + dx} ${y - 1} ${z + dz} pointed_dripstone[vertical_direction=up,thickness=tip,waterlogged=true]`);
  }
  await oracle.executeSetupCommand(`tp MinebotTrial ${x0 + 0.5} ${y - 1} ${z + 0.5}`);
  await sleep(2500);
  report.tipSeenAs = actor.blockAt(actor.entity.position.floored().offset(4, 0, -1))?.name;
  const before = forcedMoves(actor).count;
  const started = Date.now();
  const moved: any = await Promise.race([actor.instantSkills.getSkill('move-to')!.run(x0 + 15.5, y - 1, z + 0.5, 1.5, 'nearxz'), sleep(60_000).then(() => ({ result: 'probe time limit' }))]);
  actor.pathfinder?.stop?.(); actor.clearControlStates();
  report.walk = String(moved?.result).slice(0, 120);
  report.ms = Date.now() - started;
  report.pushedBack = forcedMoves(actor).count - before;
  report.reachedX = +(actor.entity.position.x - x0).toFixed(1);
  report.health = actor.health;
  report.closed = [...((actor as any).serverRefusals?.closed.keys() ?? [])].map((cell: string) => { const [cx, cy, cz] = cell.split(',').map(Number); return `${cx - x0},${cy - y},${cz - z}`; });
  report.passed = report.reachedX >= 13.5 && report.pushedBack <= 30;
  await oracle.executeSetupCommand('gamerule random_tick_speed 3');
} catch (error) {
  report.error = String((error as Error)?.stack ?? error).slice(0, 600);
} finally {
  console.log(`DRIPSTONE ${JSON.stringify(report)}`);
  closeProbeBot(operator); closeProbeBot(actor);
  setTimeout(() => process.exit(0), 500);
}
