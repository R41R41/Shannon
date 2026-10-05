#!/usr/bin/env node
// Model-free diagnosis of the diamond stage in natural terrain: stair-mine
// from the surface to the deepslate diamond band, search, and mine three
// diamonds with an iron pickaxe. The iron pickaxe is a fixture grant, so this
// never counts as zero-start acceptance.
import fs from 'node:fs';
import path from 'node:path';
import { createProbeBot, closeProbeBot } from '../src/services/minebot/testing/MinecraftProbeBot.js';
import { MinecraftCommandOracle } from '../src/services/minebot/testing/MinecraftCommandOracle.js';

const port = Number(process.env.MINECRAFT_DIAMOND_PORT);
const worldDirectory = process.env.MINECRAFT_DIAMOND_WORLD_DIRECTORY ?? '';
const targetY = Number(process.env.MINECRAFT_DIAMOND_TARGET_Y ?? -58);
if (process.env.MINECRAFT_DIAMOND_NO_LLM !== 'true' || !/^\/home\/azureuser\/minecraft\/progressive-lab-[A-Za-z0-9]+$/.test(worldDirectory))
  throw new Error('ISOLATED_DIAMOND_WORLD_REQUIRED');
const properties = fs.readFileSync(path.join(worldDirectory, 'server.properties'), 'utf8').split('\n');
if (!properties.includes('server-ip=127.0.0.1') || !properties.includes(`server-port=${port}`)
  || !properties.includes('level-type=minecraft\\:normal')) throw new Error('ISOLATED_DIAMOND_WORLD_CONFIGURATION_INVALID');

const operator = await createProbeBot(port);
const actor = await createProbeBot(port, 'MinebotTrial');
const control = new MinecraftCommandOracle(operator);
const oracle = new MinecraftCommandOracle({ version: actor.version,
  chat: message => operator.chat(`/execute as @a[name=MinebotTrial,limit=1] at @s run ${message.replace(/^\//, '')}`),
  on: (_event, listener) => actor.on('message', listener as any),
  removeListener: (_event, listener) => actor.removeListener('message', listener as any) });
const startedAt = Date.now();
const steps: any[] = [];
let deaths = 0;
actor.on('death', () => { deaths++; });
async function step(name: string, args: unknown[], maxMs: number) {
  const skill = actor.instantSkills.getSkill(name);
  if (!skill) throw new Error(`SKILL_MISSING:${name}`);
  const start = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<any>(resolve => { timer = setTimeout(() => {
    actor.interruptExecution = true; actor.pathfinder?.stop();
    resolve({ success: false, result: `diagnostic timeout ${maxMs}ms`, failureType: 'timeout' });
  }, maxMs); });
  let result: any;
  try { result = await Promise.race([skill.run(...args), timeout]); }
  catch (error) { result = { success: false, result: String(error), failureType: 'exception' }; }
  clearTimeout(timer);
  actor.interruptExecution = false;
  const entry = { name, args, durationMs: Date.now() - start, success: result?.success ?? false,
    result: String(result?.result ?? '').slice(0, 700), failureType: result?.failureType,
    y: actor.entity?.position?.y, position: actor.entity?.position, health: actor.health,
    inventory: Object.fromEntries(actor.inventory.items().map(item => [item.name, item.count])) };
  steps.push(entry);
  console.log(`DIAMOND_STEP ${JSON.stringify({ name, args, durationMs: entry.durationMs, success: entry.success,
    y: entry.y && Math.round(entry.y * 10) / 10, health: entry.health, result: entry.result.slice(0, 220) })}`);
  return entry;
}

let report: any;
try {
  await control.verifyReady();
  for (const command of ['difficulty peaceful', 'time set day', 'gamemode spectator ShannonProbe',
    'clear MinebotTrial', 'effect clear MinebotTrial', 'gamemode survival MinebotTrial',
    'give MinebotTrial iron_pickaxe 2', 'give MinebotTrial cobblestone 64', 'give MinebotTrial cooked_beef 16'])
    await control.executeSetupCommand(command);
  await new Promise(resolve => setTimeout(resolve, 1500));
  // World spawn can be on a tree canopy; start from the terrain surface below.
  const start = actor.entity.position.floored();
  let ground = start.y - 1;
  while (ground > -60 && ['air', 'oak_leaves', 'birch_leaves', 'spruce_leaves', 'oak_log', 'birch_log', 'spruce_log', 'short_grass', 'tall_grass']
    .includes(actor.blockAt(start.offset(0, ground - start.y, 0))?.name ?? 'air')) ground--;
  await control.executeSetupCommand(`fill ${start.x} ${ground + 1} ${start.z} ${start.x} ${start.y + 2} ${start.z} air`);
  await control.executeSetupCommand(`tp MinebotTrial ${start.x + 0.5} ${ground + 1} ${start.z + 0.5}`);
  await new Promise(resolve => setTimeout(resolve, 1500));
  // A cave edge stops a descent; a player turns and continues in another direction.
  const directions = ['east', 'south', 'west', 'north'];
  for (let attempt = 0; attempt < 12 && actor.entity.position.y > targetY + 4; attempt++)
    await step('stair-mine', [targetY, directions[attempt % 4], 'cobblestone'], 600_000);
  await step('find-blocks', ['diamond_ore,deepslate_diamond_ore', 32, 10], 60_000);
  await step('find-blocks', ['lava', 32, 5], 60_000);
  // Branch-mine through the diamond band until ore is in the loaded search range.
  for (let leg = 0; leg < 6 && !actor.findBlocks({ matching: (block: any) => /diamond_ore$/.test(block?.name ?? ''), maxDistance: 24, count: 1 }).length; leg++) {
    const here = actor.entity.position.floored();
    const offset = [[24, 0], [0, 24], [-24, 0], [0, -24]][leg % 4];
    await step('move-to', [here.x + offset[0], here.y, here.z + offset[1], 2, 'near'], 180_000);
  }
  await step('find-blocks', ['diamond_ore,deepslate_diamond_ore', 32, 10], 60_000);
  await step('mine-block', ['deepslate_diamond_ore', 3, 32, 'target'], 400_000);
  if (!actor.inventory.items().some(item => item.name === 'diamond' && item.count >= 3))
    await step('mine-block', ['diamond_ore', 3, 32, 'target'], 300_000);
  const proof = await oracle.evaluate({ type: 'inventory_count', item: 'diamond', minCount: 3 });
  report = { passed: proof.passed && deaths === 0, diagnosisOnly: true, fixtureGrants: ['iron_pickaxe x2', 'cobblestone x64', 'cooked_beef x16'],
    peaceful: true, targetY, durationMs: Date.now() - startedAt, deaths, proof, steps };
} catch (error) {
  report = { passed: false, diagnosisOnly: true, error: String(error), durationMs: Date.now() - startedAt, deaths, steps };
  process.exitCode = 1;
} finally {
  closeProbeBot(actor); closeProbeBot(operator);
  const file = path.resolve('saves/minecraft/progressive_reports', `${new Date().toISOString().replace(/[:.]/g, '-')}-diamond-descent.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(`DIAMOND_RESULT ${JSON.stringify({ passed: report.passed, durationMs: report.durationMs, deaths, error: report.error })}`);
  console.log(`DIAMOND_REPORT ${file}`);
}
