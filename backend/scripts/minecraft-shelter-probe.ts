#!/usr/bin/env node
// Model-free live check of dig-shelter on natural terrain at night: three
// zombies 10m away, the bot seals itself into a shaft and must stay unharmed.
// Fixed before the run: sealed roof/walls by server block checks and no
// health loss for 30s after sealing.
import fs from 'node:fs';
import path from 'node:path';
import { createProbeBot, closeProbeBot } from '../src/services/minebot/testing/MinecraftProbeBot.js';
import { MinecraftCommandOracle } from '../src/services/minebot/testing/MinecraftCommandOracle.js';

const port = Number(process.env.MINECRAFT_SHELTER_PORT);
const worldDirectory = process.env.MINECRAFT_SHELTER_WORLD_DIRECTORY ?? '';
if (process.env.MINECRAFT_SHELTER_NO_LLM !== 'true' || !/^\/home\/azureuser\/minecraft\/progressive-lab-[A-Za-z0-9]+$/.test(worldDirectory)
  || !fs.readFileSync(path.join(worldDirectory, 'server.properties'), 'utf8').split('\n').includes(`server-port=${port}`))
  throw new Error('ISOLATED_SHELTER_WORLD_REQUIRED');
const operator = await createProbeBot(port);
const actor = await createProbeBot(port, 'MinebotTrial');
const control = new MinecraftCommandOracle(operator);
let report: any;
const startedAt = Date.now();
let deaths = 0;
actor.on('death', () => { deaths++; });
try {
  await control.verifyReady();
  for (const command of ['difficulty normal', 'time set midnight', 'gamerule spawn_mobs false', 'gamemode spectator ShannonProbe',
    'kill @e[type=minecraft:zombie]', 'clear MinebotTrial', 'effect clear MinebotTrial', 'effect give MinebotTrial minecraft:instant_health 1 5',
    'gamemode survival MinebotTrial', 'give MinebotTrial stone_pickaxe 1', 'give MinebotTrial cobblestone 16'])
    await control.executeSetupCommand(command);
  await new Promise(resolve => setTimeout(resolve, 2000));
  const start = actor.entity.position.floored();
  for (const dx of [10, -10, 0]) await control.executeSetupCommand(`summon minecraft:zombie ${start.x + dx} ${start.y + 2} ${start.z + (dx === 0 ? 10 : 0)} {PersistenceRequired:1b}`);
  const skill = actor.instantSkills.getSkill('dig-shelter')!;
  const began = Date.now();
  const result: any = await skill.run();
  const sealedAt = Date.now();
  const bottom = actor.entity.position.floored();
  // The roof is placed from the carried cobblestone; walls are whatever solid terrain surrounds the shaft.
  const roofProof = await control.evaluate({ type: 'block_at', x: bottom.x, y: bottom.y + 2, z: bottom.z, block: 'cobblestone' });
  const walls = [[1, 0], [-1, 0], [0, 1], [0, -1]].flatMap(([dx, dz]) => [0, 1].map(dy => {
    const block = actor.blockAt(bottom.offset(dx, dy, dz));
    return { x: bottom.x + dx, y: bottom.y + dy, z: bottom.z + dz, name: block?.name, passed: block?.boundingBox === 'block' };
  }));
  const checks = [roofProof, ...walls];
  const healthAtSeal = actor.health;
  let minHealth = actor.health;
  const trace: any[] = [];
  while (Date.now() - sealedAt < 30_000) {
    await new Promise(resolve => setTimeout(resolve, 500));
    minHealth = Math.min(minHealth, actor.health);
    const zombies = Object.values(actor.entities).filter(entity => entity.name === 'zombie')
      .map(entity => Math.round(entity.position.distanceTo(actor.entity.position) * 10) / 10);
    trace.push({ atMs: Date.now() - sealedAt, health: actor.health, zombies });
  }
  await control.executeSetupCommand('kill @e[type=minecraft:zombie]');
  const passed = result.success && deaths === 0 && minHealth >= healthAtSeal && Array.isArray(checks) && checks.every((c: any) => c.passed);
  report = { passed, durationMs: Date.now() - startedAt, digMs: sealedAt - began, result: result.result, start, bottom,
    checks, healthAtSeal, minHealth, deaths, trace, diagnosisOnly: true };
} catch (error) {
  report = { passed: false, error: String(error), durationMs: Date.now() - startedAt, deaths };
  process.exitCode = 1;
} finally {
  closeProbeBot(actor); closeProbeBot(operator);
  const file = path.resolve('saves/minecraft/progressive_reports', `${new Date().toISOString().replace(/[:.]/g, '-')}-shelter.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(`SHELTER_RESULT ${JSON.stringify({ passed: report.passed, digMs: report.digMs, result: String(report.result ?? report.error).slice(0, 240),
    checks: report.checks?.map((c: any) => c.passed), healthAtSeal: report.healthAtSeal, minHealth: report.minHealth, deaths,
    nearestZombie: report.trace?.at(-1)?.zombies })}`);
  console.log(`SHELTER_REPORT ${file}`);
}
