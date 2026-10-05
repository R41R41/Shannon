#!/usr/bin/env node
// Model-free: two floating platforms with a gap between them over a drop the body would not survive well,
// scaffolding blocks in the inventory, and a move to the far side. The only route is to bridge the gap, which
// means leaning out over the rim to place each block. Reports whether the move arrives, how long the path
// executor spent building, how often the edge guard stopped the body, and how far the body fell.
// Setup commands are lab-only.
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
const gap = Number(process.env.MINECRAFT_BRIDGE_GAP ?? 3);
const drop = Number(process.env.MINECRAFT_BRIDGE_DROP ?? 9);
const timeLimitMs = Number(process.env.MINECRAFT_BRIDGE_TIME_LIMIT_MS ?? 45_000);
if (!Number.isInteger(gap) || gap < 1 || gap > 8 || !Number.isInteger(drop) || drop < 2 || drop > 40) throw new Error('BRIDGE_PROBE_SHAPE_INVALID');
const actor = await createProbeBot(port, 'MinebotTrial');
const operator = await createProbeBot(port);
const oracle = new MinecraftCommandOracle(operator);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const report: any = { gap, drop };
try {
  await oracle.verifyReady();
  for (const command of ['gamerule spawn_mobs false', 'time set day', 'gamemode spectator ShannonProbe', 'kill @e[type=!minecraft:player]',
    'clear MinebotTrial', 'effect clear MinebotTrial', 'gamemode survival MinebotTrial', 'effect give MinebotTrial minecraft:instant_health 1 5']) await oracle.executeSetupCommand(command);
  const y = 230;
  // Near platform x in [-12, -4], the gap east of it, the far platform beyond; a floor `drop` blocks below.
  const gapWest = -3, gapEast = gapWest + gap - 1, farEast = gapEast + 9;
  await oracle.executeSetupCommand(`fill -13 ${y - drop - 1} -4 ${farEast + 1} ${y + 5} 4 air`);
  await oracle.executeSetupCommand(`fill -13 ${y - drop - 1} -4 ${farEast + 1} ${y - drop - 1} 4 stone`);
  await oracle.executeSetupCommand(`fill -12 ${y - 1} -2 -4 ${y - 1} 2 stone`);
  await oracle.executeSetupCommand(`fill ${gapEast + 1} ${y - 1} -2 ${farEast} ${y - 1} 2 stone`);
  await oracle.executeSetupCommand(`tp MinebotTrial -8.5 ${y} 0.5`);
  await oracle.executeSetupCommand('give MinebotTrial minecraft:dirt 16');
  // Rebuilding the stage can drop the body left on it by an earlier run: heal after it stands on the new one.
  await sleep(1500);
  await oracle.executeSetupCommand('effect give MinebotTrial minecraft:instant_health 1 5');
  await sleep(1000);
  const healthBefore = actor.health;
  const guard = (actor as any).edgeGuard as { stops: number } | undefined;
  const stopsBefore = guard?.stops ?? 0, pushedBefore = forcedMoves(actor).count;
  let buildingTicks = 0, sneakTicks = 0, lowestY = Infinity, furthestEast = -Infinity;
  const onTick = () => {
    if (actor.pathfinder.isBuilding()) buildingTicks++;
    if (actor.getControlState('sneak')) sneakTicks++;
    lowestY = Math.min(lowestY, actor.entity.position.y);
    furthestEast = Math.max(furthestEast, actor.entity.position.x);
  };
  actor.on('physicsTick', onTick);
  const goalX = gapEast + 5;
  const started = Date.now();
  const moved: any = await Promise.race([actor.instantSkills.getSkill('move-to')!.run(goalX, y, 0, 1, 'near'),
    sleep(timeLimitMs).then(() => ({ result: 'probe time limit' }))]);
  actor.removeListener('physicsTick', onTick);
  actor.pathfinder?.stop?.(); actor.clearControlStates();
  await sleep(500);
  const at = actor.entity.position;
  let placed = 0;
  for (let x = gapWest; x <= gapEast; x++) for (let z = -2; z <= 2; z++) if (actor.blockAt(new Vec3(x, y - 1, z))?.boundingBox === 'block') placed++;
  Object.assign(report, { result: String(moved?.result).slice(0, 140), ms: Date.now() - started, at: `${at.x.toFixed(2)},${at.y.toFixed(2)},${at.z.toFixed(2)}`,
    furthestEast: +furthestEast.toFixed(2), lowestY: +lowestY.toFixed(2), healthBefore, health: actor.health, placedInGap: placed, buildingSeconds: +(buildingTicks / 20).toFixed(1),
    sneakSeconds: +(sneakTicks / 20).toFixed(1), edgeGuardStops: (guard?.stops ?? 0) - stopsBefore, pushedBack: forcedMoves(actor).count - pushedBefore });
  // Arrived on the far platform without ever leaving the level of the platforms.
  report.passed = Math.abs(at.x - goalX) <= 2.5 && Math.abs(at.y - y) < 0.6 && report.lowestY > y - 1.2 && actor.health >= healthBefore;
  if (process.env.MINECRAFT_BRIDGE_INTERRUPT === 'true') {
    // The move is cut at the worst moment: the body crouched and leaning out over the gap to place a block
    // (a target changes, an emergency takes the turn). Stopping must leave it standing where it is. The
    // path library used to shift a stopped body to the middle of the cell under its centre, which here is
    // the empty cell it leans over (paid run L62 fell 14 blocks from the end of its own bridge).
    await oracle.executeSetupCommand(`fill ${gapWest} ${y - 1} -2 ${gapEast} ${y - 1} 2 air`);
    await oracle.executeSetupCommand(`tp MinebotTrial -8.5 ${y} 0.5`);
    await sleep(1500);
    let leanedAt: { x: number; y: number } | null = null;
    let lowestAfter = Infinity;
    const edge = gapWest; // the near platform's rim: x = gapWest
    const watch = () => {
      const p = actor.entity.position;
      if (!leanedAt && actor.getControlState('sneak') && p.x > edge + 0.05) {
        leanedAt = { x: +p.x.toFixed(2), y: +p.y.toFixed(2) };
        actor.pathfinder.setGoal(null as any); actor.pathfinder.stop(); actor.clearControlStates();
      }
      if (leanedAt) lowestAfter = Math.min(lowestAfter, p.y);
    };
    actor.on('physicsTick', watch);
    const cut = actor.instantSkills.getSkill('move-to')!.run(goalX, y, 0, 1, 'near').catch(() => undefined);
    const deadline = Date.now() + 15_000;
    while (!leanedAt && Date.now() < deadline) await sleep(50);
    await sleep(3000);
    actor.removeListener('physicsTick', watch);
    actor.pathfinder?.stop?.(); actor.clearControlStates();
    await Promise.race([cut, sleep(1000)]);
    const end = actor.entity.position;
    report.interrupted = { leanedAt, lowestYAfter: Number.isFinite(lowestAfter) ? +lowestAfter.toFixed(2) : null, endX: +end.x.toFixed(2), endY: +end.y.toFixed(2), health: actor.health };
    report.passed = report.passed && leanedAt !== null && lowestAfter > y - 0.6 && actor.health >= healthBefore;
  }
} catch (error) {
  report.error = String((error as Error)?.stack ?? error).slice(0, 600);
} finally {
  console.log(`BRIDGE_GAP ${JSON.stringify(report)}`);
  closeProbeBot(operator); closeProbeBot(actor);
  setTimeout(() => process.exit(0), 500);
}
