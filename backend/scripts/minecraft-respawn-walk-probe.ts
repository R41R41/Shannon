#!/usr/bin/env node
// Model-free: run 20's drop. The body dies far from its spawn point, comes back at the spawn point, and is told to walk back to where it died
// (400 m, MINECRAFT_WALK_DISTANCE) a moment after the respawn. Reports how long the walk took, what move-to said, and what the event
// loop did meanwhile (the longest lateness of a 50 ms timer, the longest gap between two physics ticks, the watch's own stall lines).
// MINEBOT_FAR_LEG_M=0 plans the walk as one goal (before run 20); MINEBOT_RESPAWN_SETTLE=off does not wait for the chunks after the respawn.
// Lab ports 25660-25669 only. Setup commands are lab-only.
import fs from 'node:fs';
import path from 'node:path';
import { createProbeBot, closeProbeBot } from '../src/services/minebot/testing/MinecraftProbeBot.js';
import { MinecraftCommandOracle } from '../src/services/minebot/testing/MinecraftCommandOracle.js';
import { installBotLoopWatch } from '../src/services/minebot/utils/eventLoopWatch.js';
import { installRespawnTracker } from '../src/services/minebot/utils/respawnSettle.js';

const port = Number(process.env.MINECRAFT_OUTAGE_PORT);
const worldDirectory = process.env.MINECRAFT_OUTAGE_WORLD_DIRECTORY ?? '';
if (process.env.MINECRAFT_OUTAGE_NO_LLM !== 'true' || !Number.isInteger(port) || port < 25660 || port > 25669
  || !/^\/home\/azureuser\/minecraft\/progressive-lab-[A-Za-z0-9]+$/.test(worldDirectory)) throw new Error('ISOLATED_PROBE_WORLD_REQUIRED');
const properties = fs.readFileSync(path.join(worldDirectory, 'server.properties'), 'utf8').split('\n');
if (!properties.includes('server-ip=127.0.0.1') || !properties.includes(`server-port=${port}`)) throw new Error('ISOLATED_PROBE_WORLD_CONFIGURATION_INVALID');

const distance = Number(process.env.MINECRAFT_WALK_DISTANCE ?? 400);
const delayAfterRespawnMs = Number(process.env.MINECRAFT_WALK_DELAY_MS ?? 1000);
const actor: any = await createProbeBot(port, 'MinebotTrial');
const operator = await createProbeBot(port);
const oracle = new MinecraftCommandOracle(operator);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
installRespawnTracker(actor);
installBotLoopWatch(actor, { warnMs: 300, stallSampleMs: 1000, stallFile: null });

// The probe's own meter: how late a 50 ms timer runs, and the gap between physics ticks, over the walk.
let worstLagMs = 0; let lateTimers = 0; let lastTimer = performance.now();
const meter = setInterval(() => { const now = performance.now(); const lag = now - lastTimer - 50; lastTimer = now; worstLagMs = Math.max(worstLagMs, lag); if (lag > 1000) lateTimers++; }, 50);
let worstTickGapMs = 0; let lastTick = performance.now();
actor.on('physicsTick', () => { const now = performance.now(); worstTickGapMs = Math.max(worstTickGapMs, now - lastTick); lastTick = now; });
let kicked: string | null = null; actor.on('kicked', (reason: unknown) => { kicked = String(reason).slice(0, 120); });
let ended: string | null = null; actor.on('end', (reason: unknown) => { ended = String(reason); });

const report: any = { distance, farLegM: process.env.MINEBOT_FAR_LEG_M ?? 'default', settle: process.env.MINEBOT_RESPAWN_SETTLE ?? 'default' };
try {
  await oracle.verifyReady();
  for (const command of ['gamerule spawn_mobs false', 'time set day', 'effect clear MinebotTrial', 'clear MinebotTrial', 'gamemode survival MinebotTrial',
    'effect give MinebotTrial minecraft:instant_health 1 5']) await oracle.executeSetupCommand(command);
  const landOn = async (x: number, z: number) => {
    await oracle.executeSetupCommand('effect give MinebotTrial minecraft:slow_falling 90 0 true');
    await oracle.executeSetupCommand(`tp MinebotTrial ${x} 220 ${z}`);
    for (let waited = 0; waited < 60_000 && !(actor.entity?.onGround && actor.entity.position.y < 200); waited += 250) await sleep(250);
    await oracle.executeSetupCommand('effect clear MinebotTrial');
    return actor.entity.position.clone();
  };
  const spawn = await landOn(0.5, 0.5);
  await oracle.executeSetupCommand(`spawnpoint MinebotTrial ${Math.floor(spawn.x)} ${Math.floor(spawn.y)} ${Math.floor(spawn.z)}`);
  const farAway = await landOn(0.5 + distance, 0.5);
  await sleep(5000); // the chunks around the death place are read
  report.spawn = spawn.floored(); report.deathPlace = farAway.floored();
  const respawned = new Promise<void>(resolve => actor.once('respawn', () => resolve()));
  await oracle.executeSetupCommand('kill MinebotTrial');
  await Promise.race([respawned, sleep(15_000)]);
  const respawnedAt = Date.now();
  await sleep(delayAfterRespawnMs);
  report.afterRespawn = actor.entity.position.floored();
  worstLagMs = 0; lateTimers = 0; worstTickGapMs = 0;
  const started = Date.now();
  const move: any = await Promise.race([
    actor.instantSkills.getSkill('move-to')!.run(Math.floor(farAway.x), Math.floor(farAway.y), Math.floor(farAway.z), 2, 'nearxz'),
    sleep(Number(process.env.MINECRAFT_WALK_LIMIT_MS ?? 200_000)).then(() => ({ result: 'probe time limit' })),
  ]);
  report.walk = { ms: Date.now() - started, sinceRespawnMs: Date.now() - respawnedAt, success: move?.success ?? null, failureType: move?.failureType ?? null,
    result: String(move?.result).slice(0, 260), endDistance: +Math.hypot(actor.entity.position.x - farAway.x, actor.entity.position.z - farAway.z).toFixed(1),
    worstTimerLagMs: Math.round(worstLagMs), timersLateOverASecond: lateTimers, worstTickGapMs: Math.round(worstTickGapMs), kicked, ended };
  report.passed = move?.success === true && kicked === null && ended === null;
} catch (error) { report.error = String(error); process.exitCode = 1; }
finally {
  clearInterval(meter);
  closeProbeBot(operator);
  closeProbeBot(actor);
  console.log(`RESPAWN_WALK_REPORT ${JSON.stringify(report)}`);
}
