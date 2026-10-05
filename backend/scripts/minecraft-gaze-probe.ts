#!/usr/bin/env node
// Model-free: the body walks along a flat platform towards a point short of an enderman that stands 24 blocks
// ahead on the same level. A walking body looks level along its way, and on level ground that line passes
// through the enderman's eyes for the first part of the walk. Reports whether the enderman turned on the body
// (the server's "stared at" and "screaming" flags, a teleport, damage taken) and how often the gaze guard
// changed the look. MINECRAFT_GAZE_GUARD=off is the control. An enderman killed a body this way in paid run L64.
// Setup commands are lab-only; the enderman cannot walk (movement speed 0) so that it stays where it is put.
import fs from 'node:fs';
import path from 'node:path';
import pathfinderPkg from 'mineflayer-pathfinder';
import { createProbeBot, closeProbeBot } from '../src/services/minebot/testing/MinecraftProbeBot.js';
import { MinecraftCommandOracle } from '../src/services/minebot/testing/MinecraftCommandOracle.js';
import { setMovements } from '../src/services/minebot/utils/setMovements.js';

const { goals } = pathfinderPkg;
const port = Number(process.env.MINECRAFT_OUTAGE_PORT);
const worldDirectory = process.env.MINECRAFT_OUTAGE_WORLD_DIRECTORY ?? '';
if (process.env.MINECRAFT_OUTAGE_NO_LLM !== 'true' || !Number.isInteger(port) || port < 25577 || port > 25651
  || !/^\/home\/azureuser\/minecraft\/progressive-lab-[A-Za-z0-9]+$/.test(worldDirectory)) throw new Error('ISOLATED_PROBE_WORLD_REQUIRED');
const properties = fs.readFileSync(path.join(worldDirectory, 'server.properties'), 'utf8').split('\n');
if (!properties.includes('server-ip=127.0.0.1') || !properties.includes(`server-port=${port}`)) throw new Error('ISOLATED_PROBE_WORLD_CONFIGURATION_INVALID');
const guardOn = process.env.MINECRAFT_GAZE_GUARD !== 'off';
const actor = await createProbeBot(port, 'MinebotTrial');
const operator = await createProbeBot(port);
const oracle = new MinecraftCommandOracle(operator);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const report: any = { guardOn };
try {
  await oracle.verifyReady();
  for (const command of ['gamerule spawn_mobs false', 'time set midnight', 'weather clear', 'gamemode spectator ShannonProbe', 'kill @e[type=!minecraft:player]',
    'clear MinebotTrial', 'effect clear MinebotTrial', 'gamemode survival MinebotTrial', 'effect give MinebotTrial minecraft:instant_health 1 5']) await oracle.executeSetupCommand(command);
  const x0 = 84, x1 = 108, z = 60, y = 230;
  await oracle.executeSetupCommand(`forceload add ${x0 - 8} ${z - 8} ${x1 + 12} ${z + 8}`);
  await oracle.executeSetupCommand('effect give MinebotTrial minecraft:slow_falling 6 0 true');
  await oracle.executeSetupCommand(`tp MinebotTrial ${x0 + 0.5} ${y + 3} ${z + 0.5}`);
  await sleep(2500);
  await oracle.executeSetupCommand(`fill ${x0 - 4} ${y - 1} ${z - 4} ${x1 + 8} ${y + 6} ${z + 4} air`);
  await oracle.executeSetupCommand(`fill ${x0 - 4} ${y - 1} ${z - 4} ${x1 + 8} ${y - 1} ${z + 4} stone`);
  await oracle.executeSetupCommand(`tp MinebotTrial ${x0 + 0.5} ${y} ${z + 0.5} 0 60`);
  await sleep(2500);
  await oracle.executeSetupCommand('effect clear MinebotTrial');
  if (Math.abs(actor.entity.position.y - y) > 0.1) throw new Error(`STAGE_NOT_REACHED y=${actor.entity.position.y}`);
  const guard = (actor as any).gazeGuard as { enabled: boolean; averted: number };
  guard.enabled = guardOn;
  // The body faces away and down while the enderman is put in place.
  await actor.look(Math.PI / 2, -1.2, true);
  await oracle.executeSetupCommand(`summon minecraft:enderman ${x1 + 0.5} ${y} ${z + 0.5} {PersistenceRequired:1b,attributes:[{id:"minecraft:movement_speed",base:0.0d}]}`);
  const enderman = () => Object.values(actor.entities).find((entity: any) => entity.name === 'enderman') as any;
  const deadline = Date.now() + 5000;
  while (!enderman() && Date.now() < deadline) await sleep(100);
  if (!enderman()) throw new Error('ENDERMAN_NOT_VISIBLE');
  await sleep(1000);
  const placedAt = enderman().position.clone();
  const healthBefore = actor.health, avertedBefore = guard.averted;
  let flagged = false, levelLookTicks = 0, lowestPitch = 0, minHealth = actor.health;
  const flags = () => { const meta = enderman()?.metadata ?? []; return [meta[17], meta[18]].some(value => value === true || value === 1); };
  const onTick = () => {
    if (flags()) flagged = true;
    if (Math.abs(actor.entity.pitch) < 0.01) levelLookTicks++;
    lowestPitch = Math.min(lowestPitch, actor.entity.pitch);
    minHealth = Math.min(minHealth, actor.health);
  };
  actor.on('physicsTick', onTick);
  setMovements(actor, false, true, false, true, false);
  const started = Date.now();
  let walked = 'time limit';
  await Promise.race([actor.pathfinder.goto(new goals.GoalNear(x0 + 14, y, z, 1)).then(() => { walked = 'arrived'; }, error => { walked = String(error?.message ?? error).slice(0, 80); }), sleep(12_000)]);
  const walkMs = Date.now() - started;
  // An enderman that has taken a target far off comes to it within a second and a half.
  await sleep(6000);
  actor.removeListener('physicsTick', onTick);
  actor.pathfinder.setGoal(null as any); actor.pathfinder.stop(); actor.clearControlStates();
  const now = enderman();
  const moved = now ? +now.position.distanceTo(placedAt).toFixed(1) : null;
  await oracle.executeSetupCommand('kill @e[type=minecraft:enderman]');
  Object.assign(report, { walked, walkMs, at: +(actor.entity.position.x - x0).toFixed(1), staredAtOrScreaming: flagged, endermanMoved: moved,
    healthBefore, minHealth, levelLookSeconds: +(levelLookTicks / 20).toFixed(1), lowestPitchDegrees: +(lowestPitch * 180 / Math.PI).toFixed(1), averted: guard.averted - avertedBefore });
  const provoked = flagged || (moved ?? 0) > 1 || minHealth < healthBefore;
  report.provoked = provoked;
  // With the guard the walk arrives and the enderman is left as it was; the control shows that without it the same walk provokes it.
  report.passed = guardOn ? walked === 'arrived' && !provoked && report.averted > 0 : provoked;
} catch (error) {
  report.error = String((error as Error)?.stack ?? error).slice(0, 600);
} finally {
  console.log(`GAZE ${JSON.stringify(report)}`);
  closeProbeBot(operator); closeProbeBot(actor);
  setTimeout(() => process.exit(0), 500);
}
