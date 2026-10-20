#!/usr/bin/env node
// Model-free: how fast move-to goes through solid rock (run 20: 4 moves underground at y -58, 1 m in 2-8 s, none arrived).
// A slab of rock (MINECRAFT_TUNNEL_ROCK, default deepslate) is built in a flat lab world, the body is put in a pocket at one end with a pickaxe
// (MINECRAFT_TUNNEL_PICKAXE, default diamond_pickaxe) and told to walk to a pocket MINECRAFT_TUNNEL_LENGTH (default 30) blocks away through the
// rock, MINECRAFT_TUNNEL_RISE (default 0) blocks higher. Reports the seconds, how many blocks were dug, how many times the route was
// planned again (path_reset reasons) and how long the route searches took.
// Lab ports 25660-25669 only. Setup commands are lab-only.
import fs from 'node:fs';
import path from 'node:path';
import { createProbeBot, closeProbeBot } from '../src/services/minebot/testing/MinecraftProbeBot.js';
import { MinecraftCommandOracle } from '../src/services/minebot/testing/MinecraftCommandOracle.js';

const port = Number(process.env.MINECRAFT_OUTAGE_PORT);
const worldDirectory = process.env.MINECRAFT_OUTAGE_WORLD_DIRECTORY ?? '';
if (process.env.MINECRAFT_OUTAGE_NO_LLM !== 'true' || !Number.isInteger(port) || port < 25660 || port > 25669
  || !/^\/home\/azureuser\/minecraft\/progressive-lab-[A-Za-z0-9]+$/.test(worldDirectory)) throw new Error('ISOLATED_PROBE_WORLD_REQUIRED');
const properties = fs.readFileSync(path.join(worldDirectory, 'server.properties'), 'utf8').split('\n');
if (!properties.includes('server-ip=127.0.0.1') || !properties.includes(`server-port=${port}`)) throw new Error('ISOLATED_PROBE_WORLD_CONFIGURATION_INVALID');

const length = Number(process.env.MINECRAFT_TUNNEL_LENGTH ?? 30);
const rise = Number(process.env.MINECRAFT_TUNNEL_RISE ?? 0);
const rock = process.env.MINECRAFT_TUNNEL_ROCK ?? 'deepslate';
const pickaxe = process.env.MINECRAFT_TUNNEL_PICKAXE ?? 'diamond_pickaxe';
const skill = process.env.MINECRAFT_TUNNEL_SKILL ?? 'move-to';
const actor: any = await createProbeBot(port, 'MinebotTrial');
const operator = await createProbeBot(port);
const oracle = new MinecraftCommandOracle(operator);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const report: any = { length, rise, rock, pickaxe, skill };
try {
  await oracle.verifyReady();
  for (const command of ['gamerule spawn_mobs false', 'time set day', 'effect clear MinebotTrial', 'clear MinebotTrial', 'gamemode survival MinebotTrial',
    'effect give MinebotTrial minecraft:instant_health 1 5']) await oracle.executeSetupCommand(command);
  const x0 = 10, z0 = 10, y0 = 40;
  await oracle.executeSetupCommand(`forceload add ${x0 - 8} ${z0 - 8} ${x0 + length + 8} ${z0 + 8}`);
  await oracle.executeSetupCommand('effect give MinebotTrial minecraft:slow_falling 20 0 true');
  await oracle.executeSetupCommand(`tp MinebotTrial ${x0 + 0.5} ${y0 + 6} ${z0 + 0.5}`);
  await sleep(2500);
  // The slab: rock from 3 below the start to 4 above the target, 7 wide; two pockets of air (the start and the target).
  const top = y0 + Math.max(0, rise) + 4;
  await oracle.executeSetupCommand(`fill ${x0 - 3} ${y0 - 3} ${z0 - 3} ${x0 + length + 3} ${top} ${z0 + 3} minecraft:${rock}`);
  await oracle.executeSetupCommand(`fill ${x0} ${y0} ${z0} ${x0} ${y0 + 1} ${z0} minecraft:air`);
  await oracle.executeSetupCommand(`fill ${x0 + length} ${y0 + rise} ${z0} ${x0 + length} ${y0 + rise + 1} ${z0} minecraft:air`);
  await oracle.executeSetupCommand(`tp MinebotTrial ${x0 + 0.5} ${y0} ${z0 + 0.5}`);
  await oracle.executeSetupCommand('effect clear MinebotTrial');
  await oracle.executeSetupCommand(`give MinebotTrial minecraft:${pickaxe} 1`);
  await oracle.executeSetupCommand('give MinebotTrial minecraft:cobblestone 32');
  await sleep(2500);
  const resets: Record<string, number> = {}; let updates = 0; let searchMs = 0; let worstSearchMs = 0; let digs = 0;
  actor.on('path_reset', (reason: string) => { resets[reason] = (resets[reason] ?? 0) + 1; });
  actor.on('path_update', (result: any) => { updates++; searchMs += Number(result?.time ?? 0); worstSearchMs = Math.max(worstSearchMs, Number(result?.time ?? 0)); });
  actor.on('diggingCompleted', () => { digs++; });
  const started = Date.now();
  const target = { x: x0 + length, y: y0 + rise, z: z0 };
  const args = skill === 'move-to' ? [target.x, target.y, target.z, 1, 'near'] : [target.y];
  const moved: any = await Promise.race([actor.instantSkills.getSkill(skill)!.run(...args), sleep(Number(process.env.MINECRAFT_TUNNEL_LIMIT_MS ?? 150_000)).then(() => ({ result: 'probe time limit' }))]);
  const ms = Date.now() - started;
  const here = actor.entity.position;
  const gone = Math.hypot(here.x - (x0 + 0.5), here.z - (z0 + 0.5));
  report.walk = { ms, success: moved?.success ?? null, failureType: moved?.failureType ?? null, result: String(moved?.result).slice(0, 300),
    metresGone: +gone.toFixed(1), secondsPerMetre: gone > 0 ? +(ms / 1000 / gone).toFixed(2) : null, blocksDug: digs, pathUpdates: updates, pathResets: resets,
    searchSeconds: +(searchMs / 1000).toFixed(1), worstSearchMs: Math.round(worstSearchMs) };
  report.passed = moved?.success === true;
  await oracle.executeSetupCommand(`forceload remove ${x0 - 8} ${z0 - 8} ${x0 + length + 8} ${z0 + 8}`);
} catch (error) { report.error = String(error); process.exitCode = 1; }
finally {
  closeProbeBot(operator);
  closeProbeBot(actor);
  console.log(`TUNNEL_WALK_REPORT ${JSON.stringify(report)}`);
}
