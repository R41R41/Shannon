#!/usr/bin/env node
// Model-free: run 22's hang (2026-10-21 12:16 and 12:20). With a pack full of rock, dig-block-at's tidy threw through drop-item,
// drop-item dug its pit through dig-block-at, and that dig's tidy did not see the first one's hold: round and round on microtasks
// only, 100% CPU, no timer could fire. Cases (MINECRAFT_TIDY_CASE):
//   dig    a 1x2 tunnel in stone, the pack full of cobblestone and tuff over their limits: dig-block-at on a dirt block in the wall
//   mine   the same, mine-block coal_ore 2 from the tunnel's wall
//   lava   the same tunnel with a lava pool beside it: use-item-on-block water_bucket count 2 (obsidian), the tidy beside the lava
// Each case says how long it took, how many drop-items ran and how many at once (never more than one), the longest the event loop
// stood still, and the pack before and after. Setup commands are lab-only. Port 25680-25689 only.
import fs from 'node:fs';
import path from 'node:path';
import { createProbeBot, closeProbeBot } from '../src/services/minebot/testing/MinecraftProbeBot.js';
import { MinecraftCommandOracle } from '../src/services/minebot/testing/MinecraftCommandOracle.js';

const port = Number(process.env.MINECRAFT_OUTAGE_PORT);
const worldDirectory = process.env.MINECRAFT_OUTAGE_WORLD_DIRECTORY ?? '';
if (process.env.MINECRAFT_OUTAGE_NO_LLM !== 'true' || !Number.isInteger(port) || port < 25680 || port > 25689
  || !/^\/home\/azureuser\/minecraft\/progressive-lab-[A-Za-z0-9]+$/.test(worldDirectory)) throw new Error('ISOLATED_PROBE_WORLD_REQUIRED');
const properties = fs.readFileSync(path.join(worldDirectory, 'server.properties'), 'utf8').split('\n');
if (!properties.includes('server-ip=127.0.0.1') || !properties.includes(`server-port=${port}`)) throw new Error('ISOLATED_PROBE_WORLD_CONFIGURATION_INVALID');
const CASE = process.env.MINECRAFT_TIDY_CASE ?? 'dig';
const actor = await createProbeBot(port, 'MinebotTrial');
const operator = await createProbeBot(port);
const oracle = new MinecraftCommandOracle(operator);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const report: any = { case: CASE, steps: [] };

// The longest the event loop stood still (a 50 ms tick that came late).
let lastTick = Date.now(), maxLagMs = 0;
setInterval(() => { const now = Date.now(); maxLagMs = Math.max(maxLagMs, now - lastTick - 50); lastTick = now; }, 50).unref();

// Every drop-item run, and how many ran at once.
const drops = { calls: 0, atOnce: 0, most: 0, args: [] as string[] };
const dropSkill: any = actor.instantSkills.getSkill('drop-item');
const dropRun = dropSkill.runImpl.bind(dropSkill);
dropSkill.runImpl = async (...args: any[]) => {
  drops.calls++; drops.atOnce++; drops.most = Math.max(drops.most, drops.atOnce); drops.args.push(`${args[0]}×${args[1]}`);
  if (drops.calls % 25 === 0) console.log(`TIDY_DROPS ${drops.calls} calls, ${drops.atOnce} at once`);
  try { return await dropRun(...args); } finally { drops.atOnce--; }
};

const FILLERS = ['apple', 'bread', 'carrot', 'potato', 'beetroot', 'cookie', 'melon_slice', 'pumpkin_seeds', 'emerald', 'gold_ingot', 'copper_ingot', 'lapis_lazuli',
  'redstone', 'quartz', 'amethyst_shard', 'book', 'paper', 'string', 'feather', 'bone'];
const held = (name: string) => actor.inventory.items().filter(item => item.name === name).reduce((sum, item) => sum + item.count, 0);
const pack = () => Object.fromEntries(actor.inventory.items().reduce((map, item) => map.set(item.name, (map.get(item.name) ?? 0) + item.count), new Map<string, number>()));

async function run(name: string, args: unknown[], maxMs = 170_000) {
  const skill = actor.instantSkills.getSkill(name)!;
  const emptyBefore = actor.inventory.emptySlotCount();
  const dropsBefore = drops.calls;
  maxLagMs = 0;
  const started = Date.now();
  const result: any = await Promise.race([skill.run(...args), sleep(maxMs).then(() => ({ success: false, result: 'probe time limit' }))]);
  const step = { name, args, seconds: +((Date.now() - started) / 1000).toFixed(1), success: result?.success ?? null, failureType: result?.failureType ?? null,
    emptyBefore, emptyAfter: actor.inventory.emptySlotCount(), dropItemCalls: drops.calls - dropsBefore, dropItemMostAtOnce: drops.most,
    maxLoopLagMs: maxLagMs, result: String(result?.result).slice(0, 500) };
  report.steps.push(step);
  console.log(`TIDY_STEP ${JSON.stringify(step)}`);
  return step;
}

async function give(command: string) { await oracle.executeSetupCommand(`give MinebotTrial ${command}`); }
/** The pack of run 22: rock over the body's limits (cobblestone 320, tuff 256), more rock, the tools, filler: four slots free. */
async function fillPack(tools: string[]) {
  await oracle.executeSetupCommand('clear MinebotTrial');
  await sleep(500);
  for (const tool of tools) await give(tool);
  for (const [name, count] of [['cobblestone', 320], ['tuff', 256], ['andesite', 64], ['deepslate', 64]] as const) await give(`minecraft:${name} ${count}`);
  for (const name of FILLERS) await give(`minecraft:${name} 1`);
  await sleep(2000);
  const free = actor.inventory.emptySlotCount();
  for (let i = 0; i < free - 4; i++) await give(`minecraft:${['oak_planks', 'birch_planks', 'spruce_planks', 'stick', 'flint', 'coal', 'glass', 'sand'][i % 8]} 1`);
  await sleep(1500);
}

try {
  await oracle.verifyReady();
  for (const command of ['gamerule spawn_mobs false', 'time set day', 'gamemode spectator ShannonProbe', 'kill @e[type=!minecraft:player]',
    'clear MinebotTrial', 'effect clear MinebotTrial', 'gamemode survival MinebotTrial', 'effect give MinebotTrial minecraft:instant_health 1 5']) await oracle.executeSetupCommand(command);
  const cx = 60, cz = 90, y = 230;
  await oracle.executeSetupCommand(`forceload add ${cx - 14} ${cz - 14} ${cx + 14} ${cz + 14}`);
  await oracle.executeSetupCommand('effect give MinebotTrial minecraft:slow_falling 6 0 true');
  await oracle.executeSetupCommand(`tp MinebotTrial ${cx + 0.5} ${y + 3} ${cz + 0.5}`);
  await sleep(2500);
  // A block of stone with a tunnel along x through it (floor at y-1, ceiling at y+2).
  await oracle.executeSetupCommand(`fill ${cx - 13} ${y - 10} ${cz - 6} ${cx + 13} ${y + 6} ${cz + 6} stone`);
  await oracle.executeSetupCommand(`fill ${cx - 9} ${y} ${cz} ${cx + 9} ${y + 1} ${cz} air`);
  await oracle.executeSetupCommand(`tp MinebotTrial ${cx - 3.5} ${y} ${cz + 0.5}`);
  await sleep(2500);
  await oracle.executeSetupCommand('effect clear MinebotTrial');

  if (CASE === 'dig') {
    await oracle.executeSetupCommand(`setblock ${cx - 2} ${y} ${cz + 1} dirt`);
    await fillPack(['minecraft:iron_pickaxe 1', 'minecraft:iron_shovel 1']);
    report.before = pack();
    const step = await run('dig-block-at', [cx - 2, y, cz + 1, true]);
    report.after = pack();
    report.passed = step.result !== 'probe time limit' && step.maxLoopLagMs < 2000 && step.dropItemMostAtOnce <= 1 && step.dropItemCalls <= 2;
  } else if (CASE === 'mine') {
    for (const dx of [0, 1, 2]) await oracle.executeSetupCommand(`setblock ${cx + dx} ${y} ${cz + 1} coal_ore`);
    await fillPack(['minecraft:iron_pickaxe 1']);
    report.before = pack();
    const step = await run('mine-block', ['coal_ore', 2, 16]);
    report.after = pack();
    report.passed = step.result !== 'probe time limit' && step.maxLoopLagMs < 2000 && step.dropItemMostAtOnce <= 1 && held('coal') >= 2;
  } else if (CASE === 'lava') {
    // A lava pool of four sources beside the tunnel (open above), two blocks off the tunnel's side.
    await oracle.executeSetupCommand(`fill ${cx + 1} ${y} ${cz + 1} ${cx + 2} ${y + 1} ${cz + 2} air`);
    await oracle.executeSetupCommand(`fill ${cx + 1} ${y - 1} ${cz + 1} ${cx + 2} ${y - 1} ${cz + 2} lava`);
    await fillPack(['minecraft:diamond_pickaxe 1', 'minecraft:water_bucket 1']);
    report.before = pack();
    const water = actor.inventory.items().find(item => item.name === 'water_bucket');
    if (water) await actor.equip(water, 'hand');
    const step = await run('use-item-on-block', [cx + 1, y - 1, cz + 1, 'water_bucket', 2]);
    report.after = pack();
    report.lavaLeft = [[1, 1], [2, 1], [1, 2], [2, 2]].map(([dx, dz]) => actor.blockAt(actor.entity.position.floored().set(cx + dx, y - 1, cz + dz))?.name ?? '?');
    report.passed = step.result !== 'probe time limit' && step.maxLoopLagMs < 2000 && step.dropItemMostAtOnce <= 1 && actor.health > 0;
  }
  report.health = actor.health;
  report.dropArgs = drops.args.slice(0, 12);
} catch (error) {
  report.error = String((error as Error)?.stack ?? error).slice(0, 700);
} finally {
  console.log(`TIDY_LOOP ${JSON.stringify(report)}`);
  await oracle.executeSetupCommand('clear MinebotTrial').catch(() => undefined);
  closeProbeBot(operator); closeProbeBot(actor);
  setTimeout(() => process.exit(0), 500);
}
