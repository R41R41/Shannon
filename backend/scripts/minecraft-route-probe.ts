#!/usr/bin/env node
// Model-free: ask the navigator for routes from where the lab bot stands and print what it answers.
import fs from 'node:fs';
import path from 'node:path';
import pathfinder from 'mineflayer-pathfinder';
import { createProbeBot, closeProbeBot } from '../src/services/minebot/testing/MinecraftProbeBot.js';
import { setMovements } from '../src/services/minebot/utils/setMovements.js';

const port = Number(process.env.MINECRAFT_OUTAGE_PORT);
const worldDirectory = process.env.MINECRAFT_OUTAGE_WORLD_DIRECTORY ?? '';
if (process.env.MINECRAFT_OUTAGE_NO_LLM !== 'true' || !Number.isInteger(port) || port < 25577 || port > 25651
  || !/^\/home\/azureuser\/minecraft\/progressive-lab-[A-Za-z0-9]+$/.test(worldDirectory)) throw new Error('ISOLATED_PROBE_WORLD_REQUIRED');
const properties = fs.readFileSync(path.join(worldDirectory, 'server.properties'), 'utf8').split('\n');
if (!properties.includes('server-ip=127.0.0.1') || !properties.includes(`server-port=${port}`)) throw new Error('ISOLATED_PROBE_WORLD_CONFIGURATION_INVALID');
const actor = await createProbeBot(port, 'MinebotTrial');
await new Promise(resolve => setTimeout(resolve, 4000));
const here = actor.entity.position;
const inWater = (actor.entity as any).isInWater === true;
setMovements(actor, false, true, true, true, true, true, inWater ? 8 : 10, inWater, true, 4, inWater ? 2 : 10);
const out: any = { here: { x: +here.x.toFixed(2), y: +here.y.toFixed(2), z: +here.z.toFixed(2) }, inWater, onGround: actor.entity.onGround, routes: [] };
for (const spec of (process.env.MINECRAFT_ROUTE_GOALS ?? '').split(';').filter(Boolean)) {
  const [x, y, z, range] = spec.split(',').map(Number);
  const search = (actor.pathfinder as any).getPathFromTo(actor.pathfinder.movements, actor.entity.position, new pathfinder.goals.GoalNear(x, y, z, range || 1), { timeout: 3000 });
  let result: any = search.next().value.result; let turns = 1;
  while (result.status === 'partial') { result = search.next().value.result; turns++; }
  result.time = turns * 40;
  const last = result.path?.[result.path.length - 1];
  out.routes.push({ goal: spec, status: result.status, cost: +Number(result.cost).toFixed(1), ms: Math.round(result.time), visited: result.visitedNodes, generated: result.generatedNodes,
    steps: result.path?.length, first: result.path?.slice(0, 3).map((node: any) => `${node.x},${node.y},${node.z}`), last: last ? `${last.x},${last.y},${last.z}` : null,
    digs: result.path?.reduce((n: number, node: any) => n + (node.toBreak?.length ?? 0), 0), places: result.path?.reduce((n: number, node: any) => n + (node.toPlace?.length ?? 0), 0) });
}
const cells: string[] = [];
const base = here.floored();
for (let dy = 2; dy >= -2; dy--) cells.push(`y${base.y + dy}: ` + [-1, 0, 1, 2].map(dx => actor.blockAt(base.offset(dx, dy, 0))?.name ?? '?').join(' '));
out.cells = cells;
out.named = (process.env.MINECRAFT_ROUTE_CELLS ?? '').split(';').filter(Boolean).map(spec => {
  const [x, y, z] = spec.split(',').map(Number);
  return `${spec}=${actor.blockAt(new (here.constructor as any)(x, y, z))?.name ?? '?'}`;
});
console.log(`ROUTE_PROBE ${JSON.stringify(out)}`);
closeProbeBot(actor);
setTimeout(() => process.exit(0), 500);
