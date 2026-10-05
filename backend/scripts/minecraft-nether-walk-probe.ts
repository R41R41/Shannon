#!/usr/bin/env node
// Model-free post-mortem of a move in the Nether: put the body where a finished run stood (the run's own world,
// its own terrain), give it what it carried and resistance to fire so that the walk can be watched to its end, ask
// for the same move, and report tick by tick how it came to the lava. Never an acceptance: the body is placed and
// protected by command.
//   MINECRAFT_NETHER_WALK_FROM="x,y,z"  MINECRAFT_NETHER_WALK_GOAL="x,y,z,range,goalType"
//   MINECRAFT_NETHER_WALK_ITEMS="diamond_pickaxe:1,cobblestone:61"
import fs from 'node:fs';
import path from 'node:path';
import { Vec3 } from 'vec3';
import { createProbeBot, closeProbeBot } from '../src/services/minebot/testing/MinecraftProbeBot.js';
import { MinecraftCommandOracle } from '../src/services/minebot/testing/MinecraftCommandOracle.js';

const port = Number(process.env.MINECRAFT_OUTAGE_PORT);
const worldDirectory = process.env.MINECRAFT_OUTAGE_WORLD_DIRECTORY ?? '';
if (process.env.MINECRAFT_OUTAGE_NO_LLM !== 'true' || !Number.isInteger(port) || port < 25577 || port > 25651
  || !/^\/home\/azureuser\/minecraft\/progressive-lab-[A-Za-z0-9]+$/.test(worldDirectory)) throw new Error('ISOLATED_PROBE_WORLD_REQUIRED');
const properties = fs.readFileSync(path.join(worldDirectory, 'server.properties'), 'utf8').split('\n');
if (!properties.includes('server-ip=127.0.0.1') || !properties.includes(`server-port=${port}`)) throw new Error('ISOLATED_PROBE_WORLD_CONFIGURATION_INVALID');
const from = (process.env.MINECRAFT_NETHER_WALK_FROM ?? '').split(',').map(Number);
const goal = (process.env.MINECRAFT_NETHER_WALK_GOAL ?? '').split(',');
if (from.length !== 3 || !from.every(Number.isFinite) || (goal.length < 3 && !process.env.MINECRAFT_NETHER_WALK_SKILL)) throw new Error('NETHER_WALK_FROM_AND_GOAL_REQUIRED');
const dimension = process.env.MINECRAFT_NETHER_WALK_DIMENSION ?? 'the_nether';
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const operator = await createProbeBot(port);
const actor: any = await createProbeBot(port, 'MinebotTrial');
const control = new MinecraftCommandOracle(operator);
const report: any = { from, goal, dimension };
try {
  await control.verifyReady();
  for (const command of ['gamemode spectator ShannonProbe', 'gamemode survival MinebotTrial', 'clear MinebotTrial', 'effect clear MinebotTrial',
    'effect give MinebotTrial minecraft:fire_resistance 900 0 true', 'effect give MinebotTrial minecraft:instant_health 1 5',
    `execute in minecraft:${dimension} run tp MinebotTrial ${from[0]} ${from[1]} ${from[2]}`]) await control.executeSetupCommand(command);
  for (const item of (process.env.MINECRAFT_NETHER_WALK_ITEMS ?? 'diamond_pickaxe:1,cobblestone:61').split(',').filter(Boolean)) {
    const [name, count] = item.split(':');
    await control.executeSetupCommand(`give MinebotTrial ${name} ${Number(count) || 1}`);
  }
  await sleep(Number(process.env.MINECRAFT_NETHER_WALK_SETTLE_MS ?? 12_000));
  report.start = { position: actor.entity.position, dimension: actor.game?.dimension, onGround: actor.entity.onGround };
  // MINECRAFT_NETHER_WALK_DUMP="x1,y1,z1,x2,y2,z2": the blocks of a box, one layer a row (top first), for reading the place.
  const dump = (process.env.MINECRAFT_NETHER_WALK_DUMP ?? '').split(',').map(Number);
  if (dump.length === 6 && dump.every(Number.isFinite)) {
    const [x1, y1, z1, x2, y2, z2] = dump;
    const layers: Record<string, string[]> = {};
    for (let y = Math.max(y1, y2); y >= Math.min(y1, y2); y--) {
      layers[`y${y}`] = [];
      for (let z = Math.min(z1, z2); z <= Math.max(z1, z2); z++) {
        let row = '';
        for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) {
          const block: any = actor.blockAt(new Vec3(x, y, z));
          const name = String(block?.name ?? '?');
          if (name !== 'air' && name !== 'netherrack') (report.dumpNames ??= {})[`${x},${y},${z}`] = name;
          row += name === 'lava' ? (block.metadata === 0 ? 'L' : 'l') : name === 'air' ? '.' : name === '?' ? '?' : block.boundingBox === 'block' ? '#' : '+';
        }
        layers[`y${y}`].push(`z${z} ${row}`);
      }
    }
    report.dump = { legend: `columns x${Math.min(x1, x2)}..x${Math.max(x1, x2)}; #=solid L=lava source l=flowing lava .=air +=other`, layers };
  }
  const trace: any[] = [];
  let enteredLavaAt = -1;
  const startedAt = Date.now();
  const stopsAtStart = actor.edgeGuard?.stops ?? 0;
  const onTick = () => {
    const p = actor.entity.position, v = actor.entity.velocity;
    const inLava = actor.entity.isInLava === true;
    trace.push({ ms: Date.now() - startedAt, x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2), vx: +v.x.toFixed(2), vy: +v.y.toFixed(2), vz: +v.z.toFixed(2),
      ground: actor.entity.onGround, lava: inLava, stops: (actor.edgeGuard?.stops ?? 0) - stopsAtStart,
      keys: ['forward', 'back', 'left', 'right', 'sprint', 'jump', 'sneak'].filter(key => actor.getControlState(key)).join('+'),
      digging: !!actor.targetDigBlock, moving: actor.pathfinder?.isMoving?.() === true });
    if (inLava && enteredLavaAt < 0) enteredLavaAt = trace.length - 1;
  };
  actor.on('physicsTick', onTick);
  // MINECRAFT_NETHER_WALK_SKILL / _ARGS (a JSON array): another skill at the same place instead of the move
  // (a shelter dug on a fortress bridge, a block placed over a hollow).
  const skillName = process.env.MINECRAFT_NETHER_WALK_SKILL ?? 'move-to';
  const move = actor.instantSkills.getSkill(skillName);
  if (!move) throw new Error(`SKILL_MISSING:${skillName}`);
  const args = process.env.MINECRAFT_NETHER_WALK_ARGS ? JSON.parse(process.env.MINECRAFT_NETHER_WALK_ARGS)
    : [Number(goal[0]), Number(goal[1]), Number(goal[2]), Number(goal[3] ?? 10), goal[4] ?? 'nearxz'];
  report.skill = skillName;
  const capMs = Number(process.env.MINECRAFT_NETHER_WALK_CAP_MS ?? 60_000);
  const result: any = await Promise.race([move.run(...args), (async () => {
    while (Date.now() - startedAt < capMs && enteredLavaAt < 0) await sleep(50);
    if (enteredLavaAt >= 0) await sleep(1500);
    actor.pathfinder?.stop(); actor.clearControlStates();
    return { success: false, result: enteredLavaAt >= 0 ? 'stopped: entered lava' : 'stopped: cap' };
  })()]);
  actor.removeListener('physicsTick', onTick);
  report.result = String(result?.result ?? '').slice(0, 300);
  report.enteredLava = enteredLavaAt >= 0;
  report.edgeGuardStops = (actor.edgeGuard?.stops ?? 0) - stopsAtStart;
  report.end = { position: actor.entity.position, ticks: trace.length };
  if (enteredLavaAt >= 0) {
    report.before = trace.slice(Math.max(0, enteredLavaAt - 40), enteredLavaAt + 8);
    const at = trace[enteredLavaAt];
    const cell = new Vec3(Math.floor(at.x), Math.floor(at.y), Math.floor(at.z));
    const rows: string[] = [];
    for (const dy of [2, 1, 0, -1, -2]) {
      rows.push(`y${cell.y + dy}: ` + [-2, -1, 0, 1, 2].map(dz => [-2, -1, 0, 1, 2].map(dx => {
        const block: any = actor.blockAt(cell.offset(dx, dy, dz));
        const name = String(block?.name ?? '?');
        return name === 'netherrack' ? 'N' : name === 'lava' ? (block.metadata === 0 ? 'L' : 'l') : name === 'air' ? '.' : name.slice(0, 5);
      }).join(' ')).join(' | '));
    }
    report.around = { cell, legend: 'rows z-2..z+2 separated by |, columns x-2..x+2; N=netherrack L=lava source l=flowing lava .=air', rows };
  } else report.tail = trace.filter((_, index) => index % 10 === 0).slice(-30);
} catch (error) { report.error = String(error); process.exitCode = 1; }
finally {
  closeProbeBot(actor); closeProbeBot(operator);
  const file = path.resolve('saves/minecraft/progressive_reports', `${new Date().toISOString().replace(/[:.]/g, '-')}-nether-walk.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(`NETHER_WALK_REPORT ${JSON.stringify({ file, result: report.result, enteredLava: report.enteredLava, edgeGuardStops: report.edgeGuardStops, start: report.start, end: report.end, error: report.error })}`);
}
