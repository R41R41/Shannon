#!/usr/bin/env node
// Model-free diagnosis of the late Nether chain with real skills in an
// isolated flat world: bucket, water, lava-to-obsidian, obsidian mining,
// gravel-to-flint, flint and steel, portal build/light, and portal entry.
// Raw iron ingots and a diamond pickaxe are fixture grants: this checks the
// physical skills only and is never counted as a zero-start acceptance.
import fs from 'node:fs';
import path from 'node:path';
import { Vec3 } from 'vec3';
import { createProbeBot, closeProbeBot } from '../src/services/minebot/testing/MinecraftProbeBot.js';
import { MinecraftCommandOracle } from '../src/services/minebot/testing/MinecraftCommandOracle.js';

const port = Number(process.env.MINECRAFT_NETHER_CHAIN_PORT);
const worldDirectory = process.env.MINECRAFT_NETHER_CHAIN_WORLD_DIRECTORY ?? '';
if (process.env.MINECRAFT_NETHER_CHAIN_NO_LLM !== 'true' || !Number.isInteger(port) || port < 25577 || port > 25650
  || !/^\/home\/azureuser\/minecraft\/progressive-lab-[A-Za-z0-9]+$/.test(worldDirectory)) throw new Error('ISOLATED_CHAIN_WORLD_REQUIRED');
const properties = fs.readFileSync(path.join(worldDirectory, 'server.properties'), 'utf8').split('\n');
if (!properties.includes('server-ip=127.0.0.1') || !properties.includes(`server-port=${port}`)
  || !properties.includes('level-type=minecraft\\:flat')) throw new Error('ISOLATED_CHAIN_WORLD_CONFIGURATION_INVALID');

// MINECRAFT_NETHER_CHAIN_LAVA_DEPTH=3: the lava is a lake three deep, as natural lava usually is, not a film over
// stone. What is asked then is whether obsidian can be taken from over lava without the drops or the body going in.
const lavaDepth = Math.max(1, Math.min(4, Number(process.env.MINECRAFT_NETHER_CHAIN_LAVA_DEPTH ?? 1) || 1));
const WATER = { x: -7, y: 99, z: 5 };
const LAVA = { x0: 6, z0: 4, x1: 9, z1: 7, y: 99 };
const PORTAL = { x: -2, y: 100, z: -12 };
const PORTAL_INSIDE = { x: -1, y: 101, z: -12 };
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
const inventory = () => Object.fromEntries(actor.inventory.items().map(item => [item.name, item.count]));

async function step(name: string, args: unknown[], maxMs = 120_000, check?: () => Promise<any>) {
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
  await new Promise(resolve => setTimeout(resolve, 600));
  const proof = check ? await check() : null;
  const entry = { name, args, durationMs: Date.now() - start, success: result?.success ?? false,
    result: String(result?.result ?? '').slice(0, 600), failureType: result?.failureType, proof, inventory: inventory(),
    position: actor.entity?.position, dimension: actor.game?.dimension, health: actor.health };
  steps.push(entry);
  console.log(`CHAIN_STEP ${JSON.stringify({ name, args, durationMs: entry.durationMs, success: entry.success,
    proof: Array.isArray(proof) ? proof.map((p: any) => p.passed) : proof?.passed ?? proof, result: entry.result.slice(0, 200) })}`);
  return entry;
}
const hasItem = (item: string, minCount = 1) => () => oracle.evaluate({ type: 'inventory_count', item, minCount });

let report: any;
try {
  await control.verifyReady();
  await oracle.verifyReady();
  for (const command of ['difficulty peaceful', 'gamerule spawn_mobs false', 'time set day', 'weather clear',
    'gamemode spectator ShannonProbe', 'tp ShannonProbe 0 130 0', 'kill @e[type=!minecraft:player]',
    'fill -16 99 -16 16 99 16 stone', 'fill -16 100 -16 16 110 16 air', `fill -16 ${98 - lavaDepth} -16 16 98 16 stone`,
    `fill ${WATER.x - 1} ${WATER.y} ${WATER.z - 1} ${WATER.x + 1} ${WATER.y} ${WATER.z + 1} water`,
    `fill ${LAVA.x0} ${LAVA.y - lavaDepth + 1} ${LAVA.z0} ${LAVA.x1} ${LAVA.y} ${LAVA.z1} lava`,
    // MINECRAFT_NETHER_CHAIN_CEILING=1: a cave roof two blocks over the floor around the lava (paid run L77 met its
    // lava in a two-high tunnel; a foothold there puts the head in a pocket dug into the roof).
    ...(process.env.MINECRAFT_NETHER_CHAIN_CEILING === '1' ? ['fill 3 102 1 12 103 10 stone'] : []),
    'fill -9 100 -8 -5 100 -6 gravel', 'setblock 2 100 -2 crafting_table',
    'clear MinebotTrial', 'effect clear MinebotTrial', 'gamemode survival MinebotTrial', 'tp MinebotTrial 0 100 0',
    'give MinebotTrial iron_ingot 4', 'give MinebotTrial diamond_pickaxe 1', 'give MinebotTrial iron_shovel 1',
    'give MinebotTrial cobblestone 16', 'give MinebotTrial cooked_beef 8']) await control.executeSetupCommand(command);
  await new Promise(resolve => setTimeout(resolve, 1500));

  await step('craft-one', ['bucket', 1], 45_000, hasItem('bucket'));
  await step('equip-item', ['bucket', 'main'], 10_000);
  await step('move-to', [WATER.x + 2, 100, WATER.z, 1.5, 'near'], 30_000);
  await step('use-item-on-block', [WATER.x, WATER.y, WATER.z, 'bucket'], 20_000, hasItem('water_bucket'));
  await step('move-to', [LAVA.x0 - 2, 100, LAVA.z0 + 1, 1.5, 'near'], 30_000);
  await step('equip-item', ['water_bucket', 'main'], 10_000);
  await step('use-item-on-block', [LAVA.x0, LAVA.y, LAVA.z0 + 1, 'water_bucket'], 20_000, async () => {
    await new Promise(resolve => setTimeout(resolve, 4000));
    const found = actor.findBlocks({ matching: (block: any) => block?.name === 'obsidian', maxDistance: 16, count: 64 });
    return { passed: found.length >= 10, obsidianBlocks: found.length };
  });
  // Pour on the nearest remaining lava source until ten obsidian exist, as a planner would.
  for (let attempt = 0; attempt < 20; attempt++) {
    const obsidian = actor.findBlocks({ matching: (block: any) => block?.name === 'obsidian', maxDistance: 16, count: 64 }).length;
    if (!actor.inventory.items().some(item => item.name === 'water_bucket')) break;
    const lava = actor.findBlocks({ matching: (block: any) => block?.name === 'lava' && block?.metadata === 0, maxDistance: 16, count: 64 })
      .filter((at: Vec3) => at.y === LAVA.y) // the surface of the lake: what is under it cannot be poured on
      .sort((a: Vec3, b: Vec3) => a.distanceTo(actor.entity.position) - b.distanceTo(actor.entity.position))[0];
    if (!lava) break;
    await step('move-to', [lava.x, 100, lava.z, 2.5, 'near'], 30_000);
    await step('use-item-on-block', [lava.x, lava.y, lava.z, 'water_bucket'], 20_000, async () => {
      const count = actor.findBlocks({ matching: (block: any) => block?.name === 'obsidian', maxDistance: 16, count: 64 }).length;
      return { passed: count >= 10, obsidianBlocks: count, waterBucket: actor.inventory.items().some(item => item.name === 'water_bucket') };
    });
  }
  // Asked again for what is still missing, as the skill's own partial result says to (one action has two minutes).
  const obsidianHeld = () => actor.inventory.items().filter(item => item.name === 'obsidian').reduce((sum, item) => sum + item.count, 0);
  for (let attempt = 0; attempt < 3 && obsidianHeld() < 10; attempt++) {
    await step('mine-block', ['obsidian', 10 - obsidianHeld(), 16, 'target'], 240_000, hasItem('obsidian', 10));
  }
  await step('move-to', [-7, 100, -5, 2, 'near'], 30_000);
  await step('mine-block', ['gravel', 15, 16, 'target'], 120_000, hasItem('flint'));
  // Flint drops from 10% of gravel; a player re-places and re-mines gravel.
  const spot = { x: -3, y: 100, z: -3 };
  for (let attempt = 0; attempt < 30 && !actor.inventory.items().some(item => item.name === 'flint')
    && actor.inventory.items().some(item => item.name === 'gravel'); attempt++) {
    if (actor.entity.position.distanceTo(new Vec3(spot.x, spot.y, spot.z)) > 3.5) await step('move-to', [spot.x + 2, 100, spot.z, 1.5, 'near'], 20_000);
    await step('place-block-at', ['gravel', spot.x, spot.y, spot.z], 15_000);
    await step('dig-block-at', [spot.x, spot.y, spot.z], 15_000);
  }
  await step('craft-one', ['flint_and_steel', 1], 30_000, hasItem('flint_and_steel'));
  await step('build-structure', ['nether_portal', PORTAL.x, PORTAL.y, PORTAL.z, 'south'], 180_000, () =>
    control.evaluateAll([{ type: 'block_at', x: PORTAL_INSIDE.x, y: PORTAL_INSIDE.y, z: PORTAL_INSIDE.z, block: 'nether_portal' },
      { type: 'block_at', x: PORTAL.x + 1, y: PORTAL.y, z: PORTAL.z, block: 'obsidian' }]));
  await step('enter-portal', [PORTAL_INSIDE.x, PORTAL_INSIDE.y, PORTAL_INSIDE.z], 60_000, async () => {
    await new Promise(resolve => setTimeout(resolve, 3000));
    return oracle.evaluate({ type: 'dimension', dimension: 'the_nether' });
  });
  const proofOf = (entry: any) => Array.isArray(entry?.proof) ? entry.proof.every((p: any) => p.passed) : entry?.proof?.passed;
  report = { passed: proofOf(steps.at(-1)) === true && deaths === 0, diagnosisOnly: true, fixtureGrants:
    ['iron_ingot x4', 'diamond_pickaxe', 'iron_shovel', 'cobblestone x16', 'cooked_beef x8'], durationMs: Date.now() - startedAt,
    deaths, port, worldDirectory, steps };
} catch (error) {
  report = { passed: false, diagnosisOnly: true, error: String(error), durationMs: Date.now() - startedAt, deaths, steps };
  process.exitCode = 1;
} finally {
  closeProbeBot(actor); closeProbeBot(operator);
  const file = path.resolve('saves/minecraft/progressive_reports', `${new Date().toISOString().replace(/[:.]/g, '-')}-nether-chain.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(`CHAIN_RESULT ${JSON.stringify({ passed: report.passed, durationMs: report.durationMs, deaths, error: report.error,
    failed: steps.filter(entry => !entry.success).map(entry => entry.name) })}`);
  console.log(`CHAIN_REPORT ${file}`);
}
