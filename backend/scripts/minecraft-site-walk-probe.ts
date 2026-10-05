#!/usr/bin/env node
// Model-free and command-free: join an isolated lab world as it stands, walk to the given places in turn,
// and report every stretch where the server put the body back, with the client's blocks around that spot.
import fs from 'node:fs';
import path from 'node:path';
import { createProbeBot, closeProbeBot } from '../src/services/minebot/testing/MinecraftProbeBot.js';
import { forcedMoves } from '../src/services/minebot/utils/motionRecorder.js';

const port = Number(process.env.MINECRAFT_OUTAGE_PORT);
const worldDirectory = process.env.MINECRAFT_OUTAGE_WORLD_DIRECTORY ?? '';
if (process.env.MINECRAFT_OUTAGE_NO_LLM !== 'true' || !Number.isInteger(port) || port < 25577 || port > 25651
  || !/^\/home\/azureuser\/minecraft\/progressive-lab-[A-Za-z0-9]+$/.test(worldDirectory)) throw new Error('ISOLATED_PROBE_WORLD_REQUIRED');
const properties = fs.readFileSync(path.join(worldDirectory, 'server.properties'), 'utf8').split('\n');
if (!properties.includes('server-ip=127.0.0.1') || !properties.includes(`server-port=${port}`)) throw new Error('ISOLATED_PROBE_WORLD_CONFIGURATION_INVALID');
const actor = await createProbeBot(port, 'MinebotTrial');
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
await sleep(4000);
const report: any = { start: actor.entity.position.floored(), health: actor.health, legs: [] };
if (process.env.MINECRAFT_SITE_FORGET === 'true') (actor as any).serverRefusals = { strikes: new Map(), closed: { get: () => undefined, set: () => {}, delete: () => {}, keys: () => [], size: 0, [Symbol.iterator]: function* () {} } };
const neighbourhood = () => {
  const at = actor.entity.position;
  const rows: string[] = [];
  for (const dy of [2, 1, 0, -1]) rows.push(`y${Math.floor(at.y) + dy}: ` + [-1, 0, 1].map(dz => [-1, 0, 1].map(dx => {
    const block: any = actor.blockAt(at.floored().offset(dx, dy, dz));
    return `${block?.name ?? '?'}${block?.name === 'pointed_dripstone' ? `[${block.getProperties?.().thickness},${block.getProperties?.().vertical_direction}]` : ''}`;
  }).join(',')).join(' | '));
  return rows;
};
for (const spec of (process.env.MINECRAFT_SITE_GOALS ?? '').split(';').filter(Boolean)) {
  const [x, y, z, range] = spec.split(',').map(Number);
  const before = forcedMoves(actor).count;
  let dump: any = null; let prior: any = null; let last = before;
  const onTick = () => {
    const p = actor.entity.position; const count = forcedMoves(actor).count;
    if (count !== last && !dump && count - before >= 2) dump = { claimed: prior, server: { x: +p.x.toFixed(3), y: +p.y.toFixed(3), z: +p.z.toFixed(3) }, around: neighbourhood() };
    last = count;
    prior = { x: +p.x.toFixed(3), y: +p.y.toFixed(3), z: +p.z.toFixed(3), ground: actor.entity.onGround, water: (actor.entity as any).isInWater === true,
      keys: ['forward', 'back', 'left', 'right', 'sprint', 'jump', 'sneak'].filter(key => actor.getControlState(key as any)).join('+') };
  };
  actor.on('physicsTick', onTick);
  const started = Date.now();
  const moved: any = await Promise.race([actor.instantSkills.getSkill('move-to')!.run(x, y, z, range || 1, 'near'), sleep(70_000).then(() => ({ result: 'probe time limit' }))]);
  actor.removeListener('physicsTick', onTick);
  actor.pathfinder?.stop?.(); actor.clearControlStates();
  const p = actor.entity.position;
  report.legs.push({ goal: spec, result: String(moved?.result).slice(0, 110), ms: Date.now() - started, pushedBack: forcedMoves(actor).count - before,
    at: `${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)}`, closed: [...((actor as any).serverRefusals?.closed?.keys?.() ?? [])], firstRefusal: dump });
}
console.log(`SITE_WALK ${JSON.stringify(report)}`);
closeProbeBot(actor);
setTimeout(() => process.exit(0), 500);
