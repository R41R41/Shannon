#!/usr/bin/env node
// Model-free post-mortem: at a place where a run's body ran out of air, show the blocks around it and what
// the body's own estimates say there: the route to air through cells it fits, and the time to break out.
// The operator looks from spectator mode; the world is a finished run's or the lab's. No paid API is reachable.
import fs from 'node:fs';
import path from 'node:path';
import { Vec3 } from 'vec3';
import { createProbeBot, closeProbeBot } from '../src/services/minebot/testing/MinecraftProbeBot.js';
import { MinecraftCommandOracle } from '../src/services/minebot/testing/MinecraftCommandOracle.js';
import { routeToAir } from '../src/services/minebot/utils/airRoute.js';
import { nearestOpenSurface } from '../src/services/minebot/constantSkills/autoSwim.js';

const port = Number(process.env.MINECRAFT_OUTAGE_PORT);
const worldDirectory = process.env.MINECRAFT_OUTAGE_WORLD_DIRECTORY ?? '';
if (process.env.MINECRAFT_OUTAGE_NO_LLM !== 'true' || !Number.isInteger(port) || port < 25577 || port > 25651
  || !/^\/home\/azureuser\/minecraft\/progressive-lab-[A-Za-z0-9]+$/.test(worldDirectory)) throw new Error('ISOLATED_PROBE_WORLD_REQUIRED');
const properties = fs.readFileSync(path.join(worldDirectory, 'server.properties'), 'utf8').split('\n');
if (!properties.includes('server-ip=127.0.0.1') || !properties.includes(`server-port=${port}`)) throw new Error('ISOLATED_PROBE_WORLD_CONFIGURATION_INVALID');
const [x, y, z] = (process.env.MINECRAFT_AIR_ROUTE_AT ?? '').split(',').map(Number);
if (![x, y, z].every(Number.isFinite)) throw new Error('MINECRAFT_AIR_ROUTE_AT=x,y,z required');
const operator = await createProbeBot(port);
const oracle = new MinecraftCommandOracle(operator);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const report: any = { at: [x, y, z] };
try {
  await oracle.verifyReady();
  await oracle.executeSetupCommand('gamemode spectator ShannonProbe');
  await oracle.executeSetupCommand(`tp ShannonProbe ${x} ${y + 3} ${z}`);
  await sleep(4000);
  const body = new Vec3(x, y, z);
  const letter = (block: any) => !block ? '?' : block.boundingBox === 'block' ? (block.name === 'ice' ? 'I' : '#') : /water|kelp|seagrass/.test(block.name) ? '~' : block.name === 'air' ? '.' : '+';
  // One slab per level, north at the top, the body's column in the middle: # solid, ~ water, . air, + other.
  report.levels = {};
  for (let dy = 3; dy >= -2; dy--) {
    const rows: string[] = [];
    for (let dz = -4; dz <= 4; dz++) rows.push([-4, -3, -2, -1, 0, 1, 2, 3, 4].map(dx => letter(operator.blockAt(new Vec3(Math.floor(x) + dx, Math.floor(y) + dy, Math.floor(z) + dz)))).join(''));
    report.levels[`y${Math.floor(y) + dy}`] = rows;
  }
  const route = routeToAir(operator, body);
  report.routeToAir = route ? route.map(cell => `${cell.x - 0.5},${cell.y},${cell.z - 0.5}`) : null;
  const head = new Vec3(Math.floor(x), Math.floor(y + 1.62), Math.floor(z));
  const guess = nearestOpenSurface(operator, head);
  report.straightLineGuess = guess ? `${guess.x},${guess.y},${guess.z}` : null;
} catch (error) {
  report.error = String((error as Error)?.stack ?? error).slice(0, 600);
} finally {
  console.log(`AIR_ROUTE ${JSON.stringify(report)}`);
  closeProbeBot(operator);
  setTimeout(() => process.exit(0), 500);
}
