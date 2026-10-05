#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Vec3 } from 'vec3';
import { createProbeBot, closeProbeBot } from '../src/services/minebot/testing/MinecraftProbeBot.js';
import { MinecraftCommandOracle, type MinecraftCommandAssertion as Assertion } from '../src/services/minebot/testing/MinecraftCommandOracle.js';
import type { CustomBot } from '../src/services/minebot/types.js';

type Job = 'production' | 'farming' | 'combat';
const jobs = (process.env.MINECRAFT_PROGRESSIVE_JOBS ?? 'production,farming,combat').split(',') as Job[];
const tiers = (process.env.MINECRAFT_PROGRESSIVE_TIERS ?? '1,2,3').split(',').map(Number);
const repeats = Number(process.env.MINECRAFT_PROGRESSIVE_REPEATS ?? 2);
const port = Number(process.env.MINECRAFT_PROBE_PORT ?? 25577);
if (!jobs.every(j => ['production', 'farming', 'combat'].includes(j)) || jobs.length === 0
  || !tiers.every(t => [1, 2, 3].includes(t)) || tiers.length === 0
  || !Number.isInteger(repeats) || repeats < 1 || repeats > 5) throw new Error('Invalid campaign selection');
const campaignId = new Date().toISOString().replace(/[:.]/g, '-');
const fingerprint = createHash('sha256');
for (const directory of ['instantSkills', 'constantSkills', 'combat', 'utils', 'testing', 'execution', 'types', 'cognition']) {
  const root = path.resolve('src/services/minebot', directory);
  for (const file of fs.readdirSync(root).filter(f => f.endsWith('.ts')).sort()) {
    fingerprint.update(`${directory}/${file}\0`).update(fs.readFileSync(path.join(root, file)));
  }
}
fingerprint.update(fs.readFileSync(path.resolve('scripts/minecraft-progressive-live-probe.ts')));
for (const file of ['src/services/llm/graph/ShannonExecutor.ts', 'src/services/llm/graph/shannonGraph.ts', 'src/config/env.ts']) {
  fingerprint.update(`${file}\0`).update(fs.readFileSync(path.resolve(file)));
}
const sourceFingerprint = fingerprint.digest('hex');
const reportDirectory = path.resolve('saves/minecraft/progressive_reports');
fs.mkdirSync(reportDirectory, { recursive: true });
const trials: any[] = [];
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

class Trial {
  readonly steps: any[] = [];
  readonly samples: any[] = [];
  readonly deaths: { id: number; name: string | undefined }[] = [];
  playerDeaths = 0;
  private sampling: ReturnType<typeof setInterval> | undefined;
  private startedAt = Date.now();
  constructor(readonly bot: CustomBot, readonly oracle: MinecraftCommandOracle) {
    bot.on('entityDead', entity => { this.deaths.push({ id: entity.id, name: entity.name }); });
    bot.on('death', () => { this.playerDeaths++; });
    this.sampling = setInterval(() => this.samples.push(this.snapshot()), 250);
  }
  snapshot() {
    return { t: Date.now() - this.startedAt, health: this.bot.health, food: this.bot.food,
      world: { timeOfDay: this.bot.time.timeOfDay, raining: this.bot.isRaining },
      pos: this.bot.entity.position.toArray(), held: this.bot.heldItem?.name,
      inventory: this.bot.inventory.items().map(i => ({ name: i.name, count: i.count })),
      entities: Object.values(this.bot.entities).filter(e => e.type === 'hostile' && e.isValid)
        .map(e => ({ id: e.id, name: e.name, pos: e.position.toArray() })) };
  }
  count(name: string) { return this.bot.inventory.items().filter(i => i.name === name).reduce((n, i) => n + i.count, 0); }
  async setup(commands: string[]) {
    for (const c of commands) await this.oracle.executeSetupCommand(c);
    await delay(400);
  }
  async assert(label: string, assertions: Assertion[]) {
    const results = await this.oracle.evaluateAll(assertions);
    this.steps.push({ label, assertions: results, observed: this.snapshot() });
    if (results.some(r => !r.passed)) throw new Error(`Assertion failed: ${label}`);
  }
  async skill(name: string, args: unknown[], assertions: Assertion[] = [], expected = true) {
    const skill = this.bot.instantSkills.getSkill(name);
    if (!skill) throw new Error(`Missing skill: ${name}`);
    const start = Date.now();
    const result = await skill.run(...args);
    const step: any = { name, args, expected, result, durationMs: Date.now() - start, observed: this.snapshot() };
    this.steps.push(step);
    process.stdout.write(`PROGRESSIVE_STEP ${JSON.stringify({ name, args, success: result.success, durationMs: step.durationMs, result: result.result })}\n`);
    if (this.playerDeaths > 0) throw new Error(`Player died during ${name}; respawn is not success`);
    if (result.success !== expected) throw new Error(`Unexpected skill outcome: ${name}: ${result.result}`);
    await delay(350);
    if (assertions.length) await this.assert(name, assertions);
    return result;
  }
  async constant(name: string, assertions: Assertion[]) {
    const skill = this.bot.constantSkills.getSkill(name);
    if (!skill) throw new Error(`Missing constant skill: ${name}`);
    const start = Date.now();
    await skill.run();
    this.steps.push({ name, durationMs: Date.now() - start, observed: this.snapshot() });
    await delay(350);
    await this.assert(name, assertions);
  }
  stop() { clearInterval(this.sampling); }
  beginMeasurement() { this.samples.length = 0; this.playerDeaths = 0; this.startedAt = Date.now(); }
}
const inv = (item: string, minCount: number, maxCount?: number): Assertion => ({ type: 'inventory_count', item, minCount, maxCount });
const block = (x: number, y: number, z: number, name: string): Assertion => ({ type: 'block_at', x, y, z, block: name });
const alive: Assertion = { type: 'health_between', min: 1, max: 20 };

async function reset(t: Trial, tier: number) {
  await t.setup([
    '/gamemode creative @s', '/execute in minecraft:overworld run tp @s 0 100 0',
    '/difficulty peaceful', '/gamerule doMobSpawning false', '/gamerule doDaylightCycle false',
    '/gamerule doWeatherCycle false',
    '/time set day', '/weather clear', '/effect clear @s',
    '/effect give @s instant_health 1 10 true', '/effect give @s saturation 1 10 true', '/clear @s',
    '/kill @e[type=!player]', '/fill -30 98 -30 30 98 30 bedrock',
    '/fill -30 99 -30 30 99 30 cobblestone',
    '/fill -30 100 -30 30 106 30 air', '/tp @s 0 100 0', '/gamemode survival @s',
  ]);
  if (tier >= 2) await t.setup(['/difficulty normal']);
  if (tier === 3) await t.setup(['/time set midnight', '/weather rain']);
  await t.assert('fixture-ready', [alive, { type: 'position_within', x: 0, y: 100, z: 0, radius: 2 },
    { type: 'gamemode', gamemode: 'survival' },
    { type: 'gamerule', rule: 'spawn_mobs', value: false },
    { type: 'gamerule', rule: 'advance_time', value: false },
    { type: 'gamerule', rule: 'advance_weather', value: false },
    { type: 'difficulty', difficulty: tier === 1 ? 'peaceful' : 'normal' }]);
  t.beginMeasurement();
}

async function production(t: Trial, tier: number) {
  const distance = tier === 1 ? 6 : tier === 2 ? 18 : 24;
  const logs = tier === 1 ? 3 : 4;
  const commands = [
    `/fill ${distance} 100 0 ${distance} ${99 + logs} 0 oak_log`,
    `/fill ${-distance} 100 -1 ${-distance} 100 1 iron_ore`,
  ];
  if (tier < 3) commands.push(`/give @s ${tier === 1 ? 'iron' : 'wooden'}_axe 1`, '/give @s stone_pickaxe 1', '/give @s coal 1');
  else commands.push(`/setblock ${-distance} 100 4 coal_ore`, '/give @s bread 2');
  if (tier === 1) commands.push('/setblock 2 100 3 furnace');
  if (tier >= 2) commands.push('/fill 8 100 -6 8 103 6 bedrock');
  if (tier >= 2) commands.push('/fill 2 100 -5 5 100 -3 stone');
  if (tier === 3) commands.push('/fill -8 100 -4 -8 103 18 bedrock');
  await t.setup(commands);
  if (tier === 3) {
    const refusal = await t.skill('mine-block', ['iron_ore', 3, 64], [inv('raw_iron', 0, 0)], false);
    if (refusal.failureType !== 'missing_tool') throw new Error('Missing-tool recovery prerequisite was not correctly identified');
  }
  await t.skill('mine-block', ['oak_log', logs, 64], [inv('oak_log', logs)]);
  await t.skill('craft-one', ['oak_planks', logs * 4], [inv('oak_planks', logs * 4)]);
  await t.skill('craft-one', ['stick', tier === 3 ? 8 : 4], [inv('stick', tier === 3 ? 8 : 4)]);
  await t.skill('craft-one', ['crafting_table', 1], [inv('crafting_table', 1)]);
  await t.skill('move-to', [0, 100, 0, 1, 'near']);
  await t.skill('place-block-at', ['crafting_table', 1, 100, 2], [block(1, 100, 2, 'crafting_table')]);
  if (tier === 3) await t.skill('craft-one', ['wooden_pickaxe', 1], [inv('wooden_pickaxe', 1)]);
  if (tier >= 2) {
    await t.skill('mine-block', ['stone', tier === 3 ? 11 : 8, 8], [inv('cobblestone', tier === 3 ? 11 : 8)]);
    if (tier === 3) await t.skill('craft-one', ['stone_pickaxe', 1], [inv('stone_pickaxe', 1)]);
    await t.skill('craft-one', ['furnace', 1], [inv('furnace', 1)]);
    await t.skill('move-to', [2, 100, 3, 2, 'near']);
    await t.skill('place-block-at', ['furnace', 2, 100, 3], [block(2, 100, 3, 'furnace')]);
  }
  await t.skill('mine-block', ['iron_ore', 3, 64], [inv('raw_iron', 3)]);
  if (tier === 3) await t.skill('mine-block', ['coal_ore', 1, 16], [inv('coal', 1)]);
  await t.skill('move-to', [2, 100, 3, 2, 'near']);
  await t.skill('start-smelting', [2, 100, 3, 'raw_iron', 'coal', 3], [inv('raw_iron', 0, 0)]);
  await t.skill('withdraw-from-furnace', [2, 100, 3, 'output'], [inv('iron_ingot', 3)]);
  await t.skill('craft-one', ['iron_pickaxe', 1], [inv('iron_pickaxe', 1), alive]);
}

async function farming(t: Trial, tier: number) {
  const count = tier * 3;
  const x0 = tier === 1 ? 4 : tier === 2 ? 12 : 18;
  const cells = Array.from({ length: count }, (_, i) => new Vec3(x0 + Math.floor(i / 3), 99, i % 3 - 1));
  const setup = [
    `/fill ${x0} 99 -1 ${x0 + tier - 1} 99 1 dirt`, `/setblock ${x0 - 1} 99 0 water`,
    `/give @s wheat_seeds ${count}`, `/give @s bone_meal ${count * 4}`,
  ];
  if (tier < 3) setup.push('/give @s wooden_hoe 1', '/setblock 1 100 2 crafting_table');
  else setup.push('/fill 4 100 4 4 101 4 oak_log');
  if (tier >= 2) setup.push('/fill 6 100 -4 6 102 4 bedrock');
  // Farm lighting is a real resource constraint at night, not forced crop age.
  if (tier === 3) setup.push(`/setblock ${x0 - 1} 100 -2 torch`);
  await t.setup(setup);
  if (tier === 3) {
    await t.skill('mine-block', ['oak_log', 2, 16], [inv('oak_log', 2)]);
    await t.skill('craft-one', ['oak_planks', 8]);
    await t.skill('craft-one', ['stick', 4]);
    await t.skill('craft-one', ['crafting_table', 1]);
    await t.skill('move-to', [0, 100, 0, 1, 'near']);
    await t.skill('place-block-at', ['crafting_table', 1, 100, 2]);
    await t.skill('craft-one', ['wooden_hoe', 1], [inv('wooden_hoe', 1)]);
  }
  for (let i = 0; i < cells.length; i++) {
    const p = cells[i];
    await t.skill('move-to', [p.x - 1, 100, p.z, 1, 'near']);
    await t.skill('equip-item', ['wooden_hoe', 'main']);
    await t.skill('use-item-on-block', p.toArray(), [block(p.x, 99, p.z, 'farmland')]);
    await t.skill('plant-crop', [...p.toArray(), 'wheat_seeds'], [block(p.x, 100, p.z, 'wheat')]);
    if (i === 0) {
      // An immature crop must be refused and left in place.
      await t.setup([`/setblock ${p.x} 100 ${p.z} wheat[age=3]`]);
      const refusal = await t.skill('harvest-crop', [p.x, 100, p.z], [
        { type: 'block_at', x: p.x, y: 100, z: p.z, block: 'wheat', state: { age: 3 } },
      ], false);
      if (refusal.failureType !== 'crop_immature') throw new Error('Immature crop refusal must verify age, not fail for another reason');
    }
    for (let uses = 0; uses < 4 && Number(t.bot.blockAt(p.offset(0, 1, 0))?.getProperties().age) < 7; uses++) {
      await t.skill('use-bone-meal', [p.x, 100, p.z]);
    }
    const age = Number(t.bot.blockAt(p.offset(0, 1, 0))?.getProperties().age);
    if (age !== 7) throw new Error(`Crop did not mature with bounded fertilizer: ${age}`);
    await t.assert('mature-crop', [{ type: 'block_at', x: p.x, y: 100, z: p.z, block: 'wheat', state: { age: 7 } }]);
    await t.skill('harvest-crop', [p.x, 100, p.z], [block(p.x, 100, p.z, 'air')]);
    await delay(400);
    if (t.count('wheat') < i + 1) await t.skill('pickup-nearest-item', ['wheat', 8]);
    await t.assert('harvest-material', [inv('wheat', i + 1)]);
  }
  // Reserve harvested seeds by replanting the original field.
  if (tier >= 2) for (const p of cells) {
    await t.skill('move-to', [p.x - 1, 100, p.z, 1, 'near']);
    await t.skill('plant-crop', [...p.toArray(), 'wheat_seeds'], [block(p.x, 100, p.z, 'wheat')]);
  }
  await t.skill('move-to', [1, 100, 2, 2, 'near']);
  await t.skill('craft-one', ['bread', tier], [inv('bread', tier)]);
  if (tier === 3) {
    await t.setup(['/effect give @s hunger 15 255 true']);
    await delay(8000);
    await t.setup(['/effect clear @s hunger']);
    await t.assert('actually-hungry', [{ type: 'food_between', min: 0, max: 10 }]);
    await t.constant('auto-eat', [inv('bread', tier - 1, tier - 1), { type: 'food_between', min: 5, max: 20 }, alive]);
  }
}

async function combat(t: Trial, tier: number) {
  const enemies = tier === 1 ? ['zombie'] : tier === 2 ? ['zombie', 'zombie'] : ['zombie', 'husk', 'skeleton'];
  await t.setup([
    `/difficulty ${tier === 3 ? 'hard' : 'normal'}`, '/time set midnight',
    '/fill -25 100 -25 25 103 -25 bedrock', '/fill -25 100 25 25 103 25 bedrock',
    '/fill -25 100 -25 -25 103 25 bedrock', '/fill 25 100 -25 25 103 25 bedrock',
    `/give @s ${tier === 1 ? 'diamond' : 'iron'}_sword 1`,
    '/give @s shield 1', '/give @s iron_chestplate 1', '/give @s iron_leggings 1',
    '/give @s bread 2', '/item replace entity @s armor.chest with iron_chestplate',
    '/item replace entity @s armor.legs with iron_leggings',
    '/item replace entity @s weapon.offhand with shield',
  ]);
  if (tier === 3) await t.setup(['/gamerule doMobSpawning true', '/setblock 4 100 0 stone', '/setblock 4 101 0 stone']);
  await t.assert('combat-environment', [
    { type: 'difficulty', difficulty: tier === 3 ? 'hard' : 'normal' },
    { type: 'gamerule', rule: 'spawn_mobs', value: tier === 3 },
  ]);
  // All enemies have real AI. No resistance, forced low mob health, or NoAI.
  await t.setup(enemies.map((name, i) => `/summon ${name} ${8 + i * 2} 100 ${i * 3} {Tags:["stress_target"],PersistenceRequired:1b}`));
  const before = t.deaths.length;
  await t.skill('combat-engage', [undefined, 60]);
  await delay(1200);
  const dead = t.deaths.slice(before).filter(e => enemies.includes(e.name ?? ''));
  t.steps.push({ label: 'kill-events', required: enemies.length, observed: dead });
  if (dead.length < enemies.length) throw new Error(`Combat claimed success but kill evidence is ${dead.length}/${enemies.length}`);
  await t.assert('defended-arena', [alive, { type: 'position_within', x: 0, y: 100, z: 0, radius: 35 },
    ...Array.from(new Set(enemies)).map(entity => ({ type: 'entity_count' as const, entity, tag: 'stress_target',
      x: 0, y: 100, z: 0, radius: 48, minCount: 0, maxCount: 0 }))]);
}

for (const job of jobs) for (const tier of tiers) for (let repeat = 1; repeat <= repeats; repeat++) {
  const startedAt = Date.now();
  process.stdout.write(`PROGRESSIVE_TRIAL_START ${JSON.stringify({ job, tier, repeat })}\n`);
  let bot: CustomBot | undefined;
  let trial: Trial | undefined;
  let error: string | null = null;
  try {
    bot = await createProbeBot(port);
    trial = new Trial(bot, new MinecraftCommandOracle(bot));
    await trial.oracle.verifyReady();
    if (trials.length === 0) {
      const invalidQuery = await trial.oracle.evaluate({ type: 'gamerule', rule: 'shannon_missing_test_rule', value: false });
      trial.steps.push({ label: 'invalid-query-must-not-reuse-score', expectedPassed: false, observed: invalidQuery });
      if (invalidQuery.passed) throw new Error('Invalid gamerule query reused a stale scoreboard value');
    }
    await reset(trial, tier);
    await ({ production, farming, combat })[job](trial, tier);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  } finally {
    trial?.stop();
    if (bot) closeProbeBot(bot);
    await delay(500);
  }
  const result = { job, tier, repeat, passed: error === null, error,
    playerDeaths: trial?.playerDeaths ?? 0,
    durationMs: Date.now() - startedAt, steps: trial?.steps ?? [], samples: trial?.samples ?? [],
    minimumHealth: trial?.samples.length ? Math.min(...trial.samples.map(s => s.health)) : null };
  trials.push(result);
  fs.writeFileSync(path.join(reportDirectory, `${campaignId}-${job}-${tier}-${repeat}.json`), JSON.stringify(result, null, 2));
  process.stdout.write(`PROGRESSIVE_TRIAL_END ${JSON.stringify({ ...result, steps: undefined, samples: undefined })}\n`);
}
const output = { campaignId, sourceFingerprint, fingerprintVersion: 2, port, seed: 9272026, jobs, tiers, repeats, requiredPassRate: 1,
  summary: jobs.flatMap(job => tiers.map(tier => {
    const cell = trials.filter(t => t.job === job && t.tier === tier);
    return { job, tier, passed: cell.filter(t => t.passed).length, total: cell.length,
      errors: cell.filter(t => !t.passed).map(t => t.error) };
  })),
  ok: trials.every(t => t.passed) };
fs.writeFileSync(path.join(reportDirectory, `${campaignId}-summary.json`), JSON.stringify(output, null, 2));
process.stdout.write(`MINECRAFT_PROGRESSIVE_REPORT ${JSON.stringify(output)}\n`);
process.exitCode = output.ok ? 0 : 1;
