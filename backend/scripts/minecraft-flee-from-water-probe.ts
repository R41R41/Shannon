#!/usr/bin/env node
// Model-free: the body afloat in the middle of a pool too deep to stand in, level banks all round, a zombie
// on the bank. The escape skill is called as the planner calls it. Reports how far the body got and whether
// any key was ever pressed: an escape that plans around water must still be able to leave the water it starts in.
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
const actor = await createProbeBot(port, 'MinebotTrial');
const operator = await createProbeBot(port);
const oracle = new MinecraftCommandOracle(operator);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const report: any = {};
try {
  await oracle.verifyReady();
  for (const command of ['gamerule spawn_mobs false', 'time set day', 'gamemode spectator ShannonProbe', 'kill @e[type=!minecraft:player]',
    'clear MinebotTrial', 'effect clear MinebotTrial', 'gamemode survival MinebotTrial']) await oracle.executeSetupCommand(command);
  const y = 200;
  // A stone table 41x41, its top at y-1; in its middle a pool 9x9 and 4 deep, full to the level of the table top.
  await oracle.executeSetupCommand(`fill -20 ${y - 6} -20 20 ${y - 1} 20 stone`);
  await oracle.executeSetupCommand(`fill -20 ${y} -20 20 ${y + 6} 20 air`);
  await oracle.executeSetupCommand(`fill -4 ${y - 4} -4 4 ${y - 1} 4 water`);
  await oracle.executeSetupCommand(`tp MinebotTrial 0.5 ${y - 1} 0.5`);
  await sleep(1500);
  await oracle.executeSetupCommand('effect give MinebotTrial minecraft:instant_health 1 5');
  // The zombie stands on the east bank; the sun is kept off it so it lasts the test.
  await oracle.executeSetupCommand(`summon minecraft:zombie 8.5 ${y} 0.5 {PersistenceRequired:1b,ArmorItems:[{},{},{},{id:"minecraft:leather_helmet",count:1}]}`);
  await sleep(2500);
  const start = actor.entity.position.clone();
  const healthBefore = actor.health;
  let keyTicks = 0, ticks = 0, lowestY = start.y;
  const onTick = () => {
    ticks++;
    if (['forward', 'back', 'left', 'right', 'jump'].some(key => actor.getControlState(key as any))) keyTicks++;
    lowestY = Math.min(lowestY, actor.entity.position.y);
  };
  actor.on('physicsTick', onTick);
  const started = Date.now();
  const result: any = await Promise.race([actor.instantSkills.getSkill('flee-from')!.run('hostile', 16, 12_000), sleep(20_000).then(() => ({ result: 'probe time limit' }))]);
  actor.removeListener('physicsTick', onTick);
  actor.pathfinder?.stop?.(); actor.clearControlStates();
  const end = actor.entity.position;
  const zombie = Object.values(actor.entities).find((entity: any) => entity?.name === 'zombie') as any;
  Object.assign(report, { result: String(result?.result).slice(0, 170), ms: Date.now() - started,
    start: `${start.x.toFixed(1)},${(start.y - y).toFixed(1)},${start.z.toFixed(1)}`, end: `${end.x.toFixed(1)},${(end.y - y).toFixed(1)},${end.z.toFixed(1)}`,
    movedMetres: +Math.hypot(end.x - start.x, end.z - start.z).toFixed(1), keysPressedShare: +(keyTicks / Math.max(1, ticks)).toFixed(2),
    sank: +(start.y - lowestY).toFixed(1), inWaterAtEnd: (actor.entity as any).isInWater === true, healthBefore, health: actor.health,
    zombieDistance: zombie ? +end.distanceTo(zombie.position).toFixed(1) : null });
  // Out of the pool, on the side away from the zombie, having actually moved.
  report.passed = !report.inWaterAtEnd && report.movedMetres >= 5 && end.x < start.x;
} catch (error) {
  report.error = String((error as Error)?.stack ?? error).slice(0, 600);
} finally {
  try { await oracle.executeSetupCommand('kill @e[type=minecraft:zombie]'); } catch { /* the report stands */ }
  console.log(`FLEE_FROM_WATER ${JSON.stringify(report)}`);
  closeProbeBot(operator); closeProbeBot(actor);
  setTimeout(() => process.exit(0), 500);
}
