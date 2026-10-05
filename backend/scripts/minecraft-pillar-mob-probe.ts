#!/usr/bin/env node
// Model-free: the body pillars straight up (the path library's 1x1 tower) and, as it leaves the ground a mob comes
// to stand at the foot of the pillar, in the cell the first block is to go in. The server lays no block where a living body stands, so the next
// block of the pillar cannot go down. Reports how long the body went on jumping in place after that, and the
// reasons the path library gave for dropping its path. A zombie that had caught up with a fleeing body did
// this in paid run L65: the body jumped on the spot until it was dead.
// Setup commands are lab-only; the mob has no AI and does no damage.
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
const actor = await createProbeBot(port, 'MinebotTrial');
const operator = await createProbeBot(port);
const oracle = new MinecraftCommandOracle(operator);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const report: any = {};
try {
  await oracle.verifyReady();
  for (const command of ['gamerule spawn_mobs false', 'time set midnight', 'gamemode spectator ShannonProbe', 'kill @e[type=!minecraft:player]',
    'clear MinebotTrial', 'effect clear MinebotTrial', 'gamemode survival MinebotTrial', 'effect give MinebotTrial minecraft:instant_health 1 5']) await oracle.executeSetupCommand(command);
  const cx = 60, cz = 60, y = 230;
  // The place has to be loaded before anything can be built there; the body is held aloft meanwhile.
  await oracle.executeSetupCommand(`forceload add ${cx - 8} ${cz - 8} ${cx + 8} ${cz + 8}`);
  await oracle.executeSetupCommand('effect give MinebotTrial minecraft:slow_falling 6 0 true');
  await oracle.executeSetupCommand(`tp MinebotTrial ${cx + 0.5} ${y + 3} ${cz + 0.5}`);
  await sleep(2500);
  await oracle.executeSetupCommand(`fill ${cx - 5} ${y - 1} ${cz - 5} ${cx + 5} ${y + 12} ${cz + 5} air`);
  await oracle.executeSetupCommand(`fill ${cx - 4} ${y - 1} ${cz - 4} ${cx + 4} ${y - 1} ${cz + 4} stone`);
  await oracle.executeSetupCommand(`tp MinebotTrial ${cx + 0.5} ${y} ${cz + 0.5}`);
  await oracle.executeSetupCommand('give MinebotTrial minecraft:cobblestone 16');
  await sleep(2500);
  await oracle.executeSetupCommand('effect clear MinebotTrial');
  if (Math.abs(actor.entity.position.y - y) > 0.1) throw new Error(`STAGE_NOT_REACHED y=${actor.entity.position.y}`);
  setMovements(actor, true, true, false, true, false);
  const resets: Array<{ atMs: number; reason: string }> = [];
  let summonedAt = 0, jumpTicksAfter = 0, airborneTicksAfter = 0, highest = -Infinity, summoning = false;
  // The path library runs on the same tick, ahead of this probe: it can see the mob and drop the pillar before
  // the probe has noted the mob's arrival, so the arrival is looked for here too.
  const mobSeen = () => { if (!summonedAt && Object.values(actor.entities).some((entity: any) => entity.name === 'zombie')) summonedAt = Date.now(); return summonedAt > 0; };
  actor.on('path_reset' as any, (reason: string) => { if (mobSeen()) resets.push({ atMs: Date.now() - summonedAt, reason }); });
  let ticks = 0;
  const timeline: string[] = [];
  const onTick = () => {
    const p = actor.entity.position;
    highest = Math.max(highest, p.y);
    // The route is planned with the column empty. The mob then comes to stand at the foot of the pillar, in
    // the cell the first block is to go in, as a pursuer catches up with a body that has begun to climb.
    if (!summoning && p.y > y + 0.2) {
      summoning = true;
      void oracle.executeSetupCommand(`summon minecraft:zombie ${cx + 0.5} ${y} ${cz + 0.5} {NoAI:1b,PersistenceRequired:1b,Silent:1b}`);
    }
    mobSeen();
    if (summoning && ++ticks % 5 === 0 && timeline.length < 60) {
      const mob = Object.values(actor.entities).find((entity: any) => entity.name === 'zombie') as any;
      timeline.push(`${Date.now() - started}ms body=${(p.y - y).toFixed(2)} mob=${mob ? `${(mob.position.x - cx).toFixed(2)},${(mob.position.y - y).toFixed(2)},${(mob.position.z - cz).toFixed(2)}` : '-'} column=${[0, 1, 2, 3, 4].map(dy => actor.blockAt(actor.entity.position.floored().offset(0, 0, 0).set(cx, y + dy, cz))?.boundingBox === 'block' ? '#' : '.').join('')}`);
    }
    if (summonedAt && !resets.length) {
      if (actor.getControlState('jump')) jumpTicksAfter++;
      if (!actor.entity.onGround) airborneTicksAfter++;
    }
  };
  const started = Date.now();
  actor.on('physicsTick', onTick);
  let ended = 'time limit';
  const going = actor.pathfinder.goto(new goals.GoalBlock(cx, y + 6, cz)).then(() => { ended = 'arrived'; }, error => { ended = String(error?.message ?? error).slice(0, 80); });
  // Twelve seconds from the mob's arrival: two of the library's five-second waits on a refused placement.
  const deadline = Date.now() + 30_000;
  while (ended === 'time limit' && Date.now() < deadline && !(summonedAt && Date.now() - summonedAt > 12_000)) await sleep(100);
  const endedAfterMs = summonedAt && ended !== 'time limit' ? Date.now() - summonedAt : null;
  actor.removeListener('physicsTick', onTick);
  actor.pathfinder.setGoal(null as any); actor.pathfinder.stop(); actor.clearControlStates();
  await Promise.race([going, sleep(1000)]);
  await oracle.executeSetupCommand('kill @e[type=minecraft:zombie]');
  Object.assign(report, { ended, endedAfterMs, mobArrived: summonedAt > 0, ms: Date.now() - started, highestY: +(highest - y).toFixed(2), standingY: +(actor.entity.position.y - y).toFixed(2),
    jumpSecondsBeforeGivingUp: +(jumpTicksAfter / 20).toFixed(2), airborneSecondsBeforeGivingUp: +(airborneTicksAfter / 20).toFixed(2), resets: resets.slice(0, 8), health: actor.health, timeline });
  // Counted from when the body sees the mob to when the path library drops the pillar. Seeing the mob in the
  // cell is enough: no placement needs to be sent and refused first.
  report.passed = summonedAt > 0 && resets[0]?.reason === 'place_blocked_by_entity' && resets[0].atMs <= 500;
} catch (error) {
  report.error = String((error as Error)?.stack ?? error).slice(0, 600);
} finally {
  console.log(`PILLAR_MOB ${JSON.stringify(report)}`);
  closeProbeBot(operator); closeProbeBot(actor);
  setTimeout(() => process.exit(0), 500);
}
