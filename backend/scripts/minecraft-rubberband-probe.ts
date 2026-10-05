#!/usr/bin/env node
// Model-free look at a place where the server kept putting the body back:
// which blocks are there, what collision shape the client believes they have,
// and whether walking through reproduces the corrections.
import fs from 'node:fs';
import path from 'node:path';
import { Vec3 } from 'vec3';
import { createProbeBot, closeProbeBot } from '../src/services/minebot/testing/MinecraftProbeBot.js';
import { forcedMoves } from '../src/services/minebot/utils/motionRecorder.js';

const port = Number(process.env.MINECRAFT_OUTAGE_PORT);
const worldDirectory = process.env.MINECRAFT_OUTAGE_WORLD_DIRECTORY ?? '';
if (process.env.MINECRAFT_OUTAGE_NO_LLM !== 'true' || !Number.isInteger(port) || port < 25577 || port > 25651
  || !/^\/home\/azureuser\/minecraft\/progressive-lab-[A-Za-z0-9]+$/.test(worldDirectory)) throw new Error('ISOLATED_PROBE_WORLD_REQUIRED');
const properties = fs.readFileSync(path.join(worldDirectory, 'server.properties'), 'utf8').split('\n');
if (!properties.includes('server-ip=127.0.0.1') || !properties.includes(`server-port=${port}`)) throw new Error('ISOLATED_PROBE_WORLD_CONFIGURATION_INVALID');
const [sx, sy, sz] = (process.env.MINECRAFT_RUBBERBAND_SITE ?? '').split(',').map(Number);
const actor = await createProbeBot(port, 'MinebotTrial');
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
await sleep(4000);
const moveTo = actor.instantSkills.getSkill('move-to')!;
const report: any = { start: actor.entity.position.floored() };
for (let attempt = 0; attempt < 3 && actor.entity.position.distanceTo(new Vec3(sx, sy, sz)) > 3; attempt++) {
  const result: any = await moveTo.run(sx, sy, sz, 1, 'near');
  report[`approach${attempt}`] = String(result?.result).slice(0, 140);
}
const here = actor.entity.position.floored();
const kinds = new Map<string, any>();
for (let dx = -4; dx <= 4; dx++) for (let dy = -2; dy <= 3; dy++) for (let dz = -4; dz <= 4; dz++) {
  const block = actor.blockAt(here.offset(dx, dy, dz));
  if (!block || block.name === 'air') continue;
  const entry = kinds.get(block.name) ?? { count: 0, boundingBox: block.boundingBox, shapes: JSON.stringify(block.shapes), sample: `${block.position.x},${block.position.y},${block.position.z}` };
  entry.count++; kinds.set(block.name, entry);
}
report.at = here; report.blocks = Object.fromEntries(kinds);
// Approach the spot from the east twice, once with the edge guard off, and trace every tick around each correction.
const cells: string[] = [];
for (let dy = -1; dy <= 2; dy++) for (let dx = -2; dx <= 1; dx++) for (let dz = -2; dz <= 1; dz++) {
  const block = actor.blockAt(new Vec3(Math.floor(sx) + dx, sy + dy, Math.floor(sz) + dz));
  if (block && block.name !== 'air') cells.push(`${block.position.x},${block.position.y},${block.position.z}=${block.name}`);
}
report.cells = cells;
for (const guard of [true, false]) {
  await moveTo.run(sx + 5, sy, sz + 1, 1, 'nearxz');
  await sleep(500);
  (actor as any).edgeGuard.enabled = guard;
  const before = forcedMoves(actor).count;
  const ticks: any[] = [];
  let last = before;
  const onTick = () => {
    const p = actor.entity.position; const count = forcedMoves(actor).count;
    if (count !== last || ticks.length < 3) ticks.push({ x: +p.x.toFixed(3), y: +p.y.toFixed(3), z: +p.z.toFixed(3), ground: actor.entity.onGround, vy: +actor.entity.velocity.y.toFixed(3),
      keys: ['forward', 'back', 'left', 'right', 'sprint', 'jump', 'sneak'].filter(key => actor.getControlState(key as any)).join('+'), corrections: count - before,
      guardStops: (actor as any).edgeGuard.stops });
    last = count;
  };
  actor.on('physicsTick', onTick);
  const result: any = await moveTo.run(-2.3, sy, 398.2, 0.3, 'near');
  await sleep(1500);
  actor.removeListener('physicsTick', onTick);
  report[guard ? 'guardOn' : 'guardOff'] = { result: String(result?.result).slice(0, 90), corrections: forcedMoves(actor).count - before,
    final: actor.entity.position, firstTicks: ticks.slice(0, 3), aroundCorrections: ticks.slice(3, 12) };
}
(actor as any).edgeGuard.enabled = true;
console.log(`RUBBERBAND ${JSON.stringify(report)}`);
await closeProbeBot(actor);
process.exit(0);
