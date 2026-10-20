#!/usr/bin/env node
// Model-free: a full pack, a tunnel, and the pickaxes' wear (run 20 of the Minebot). Cases (MINECRAFT_PACK_CASE):
//   tunnel-drop  a 1x2 tunnel in stone, the pack full of rock: drop-item must free the slots (a hole dug beside the body) and say so
//   mine-full    the same pack, obsidian (or iron ore) at the tunnel's end: mine-block must make room itself and go on
//   spare        a worn stone pickaxe, cobblestone and sticks, twelve iron ore in a line: mine-block must make a spare first (MINECRAFT_PACK_SPARE=no: nothing to make it of)
//   descent      natural terrain: stair-mine to the diamond band (MINECRAFT_PACK_TARGET_Y, default -58), then mine-block obsidian beside the foot of it
// Setup commands are lab-only. Port 25660-25669 only.
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
const CASE = process.env.MINECRAFT_PACK_CASE ?? 'tunnel-drop';
const actor = await createProbeBot(port, 'MinebotTrial');
const operator = await createProbeBot(port);
const oracle = new MinecraftCommandOracle(operator);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const report: any = { case: CASE, steps: [] };

/** Rubbish that no tidy touches: 28 kinds of one item each, so the rest of the pack is the rock under test. */
const FILLERS = ['apple', 'bread', 'carrot', 'potato', 'beetroot', 'cookie', 'melon_slice', 'pumpkin_seeds', 'emerald', 'gold_ingot', 'copper_ingot', 'lapis_lazuli',
  'redstone', 'quartz', 'amethyst_shard', 'book', 'paper', 'string', 'feather', 'bone', 'gunpowder', 'leather', 'clay_ball', 'egg', 'slime_ball', 'glowstone_dust', 'sugar', 'torch'];
const held = (name: string) => actor.inventory.items().filter(item => item.name === name).reduce((sum, item) => sum + item.count, 0);
const pack = () => Object.fromEntries(actor.inventory.items().reduce((map, item) => map.set(item.name, (map.get(item.name) ?? 0) + item.count), new Map<string, number>()));
const pickaxes = () => actor.inventory.items().filter(item => item.name.endsWith('_pickaxe')).map(item => `${item.name} ${(item as any).maxDurability - ((item as any).durabilityUsed ?? 0)}/${(item as any).maxDurability}`);

async function run(name: string, args: unknown[], maxMs = 170_000) {
  const skill = actor.instantSkills.getSkill(name)!;
  const emptyBefore = actor.inventory.emptySlotCount();
  const started = Date.now();
  const result: any = await Promise.race([skill.run(...args), sleep(maxMs).then(() => ({ success: false, result: 'probe time limit' }))]);
  const step = { name, args, seconds: +((Date.now() - started) / 1000).toFixed(1), success: result?.success ?? null, failureType: result?.failureType ?? null,
    emptyBefore, emptyAfter: actor.inventory.emptySlotCount(), result: String(result?.result).slice(0, 420), pickaxes: pickaxes() };
  report.steps.push(step);
  console.log(`PACK_STEP ${JSON.stringify(step)}`);
  return { result, step };
}

/** Dropped items near the body: where they lie (a throw that fell in reach is the usual reason for "picked up again"). */
const itemEntities = () => Object.values(actor.entities).filter((entity: any) => entity?.name === 'item' && entity.position.distanceTo(actor.entity.position) < 12)
  .map((entity: any) => `${entity.position.x.toFixed(1)},${entity.position.y.toFixed(1)},${entity.position.z.toFixed(1)}`);
const column = (x: number, y: number, z: number) => [3, 2, 1, 0, -1, -2, -3, -4].map(dy => actor.blockAt(actor.entity.position.floored().set(x, y + dy, z))?.name ?? '?').join('/');

async function give(command: string) { await oracle.executeSetupCommand(`give MinebotTrial ${command}`); }
async function fillPack(pickaxe: string) {
  await oracle.executeSetupCommand('clear MinebotTrial');
  await sleep(500);
  await give(pickaxe);
  for (const [name, count] of [['tuff', 49], ['andesite', 128], ['diorite', 64], ['deepslate', 128], ['cobblestone', 64]] as const) await give(`minecraft:${name} ${count}`);
  for (const name of FILLERS) await give(`minecraft:${name} 1`);
  await sleep(2000);
}

try {
  await oracle.verifyReady();
  for (const command of ['gamerule spawn_mobs false', 'time set day', 'gamemode spectator ShannonProbe', 'kill @e[type=!minecraft:player]',
    'clear MinebotTrial', 'effect clear MinebotTrial', 'gamemode survival MinebotTrial', 'effect give MinebotTrial minecraft:instant_health 1 5']) await oracle.executeSetupCommand(command);
  const cx = 60, cz = 90, y = 230;
  if (CASE !== 'descent') {
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
    report.autoPickUp = (actor.constantSkills.getSkill('auto-pick-up-item') as any)?.status ?? null;
  }

  if (CASE === 'tunnel-drop') {
    await fillPack('minecraft:iron_pickaxe 1');
    report.emptyAtStart = actor.inventory.emptySlotCount();
    const here = actor.entity.position.floored();
    const first = await run('drop-item', ['tuff', 49]);
    await sleep(4000);
    report.afterFirst = { tuff: held('tuff'), empty: actor.inventory.emptySlotCount(),
      floorEast: actor.blockAt(here.offset(1, -1, 0))?.name, floorWest: actor.blockAt(here.offset(-1, -1, 0))?.name };
    report.afterFirst.items = itemEntities();
    report.afterFirst.east = column(here.x + 1, here.y, here.z);
    report.afterFirst.pos = actor.entity.position.toString();
    // A second throw in the same tunnel (the first hole is covered; another is dug).
    const second = await run('drop-item', ['andesite', 128]);
    await sleep(4000);
    report.afterSecond = { andesite: held('andesite'), empty: actor.inventory.emptySlotCount(), items: itemEntities(), east: column(here.x + 1, here.y, here.z),
      west: column(here.x - 1, here.y, here.z), pos: actor.entity.position.toString() };
    report.passed = first.step.success === true && report.afterFirst.tuff === 0 && report.afterFirst.empty === report.emptyAtStart + 1
      && second.step.success === true && report.afterSecond.andesite === 0 && report.afterSecond.empty >= report.emptyAtStart + 3;
  } else if (CASE === 'mine-full') {
    const ore = process.env.MINECRAFT_PACK_ORE ?? 'obsidian';
    await oracle.executeSetupCommand(`fill ${cx + 3} ${y} ${cz} ${cx + 4} ${y + 1} ${cz} ${ore}`);
    await fillPack(ore === 'obsidian' ? 'minecraft:diamond_pickaxe 1' : 'minecraft:iron_pickaxe 1');
    report.emptyAtStart = actor.inventory.emptySlotCount();
    const mined = await run('mine-block', [ore, 4, 16]);
    report.afterMine = { ore: held(ore) + held(ore === 'iron_ore' ? 'raw_iron' : ''), empty: actor.inventory.emptySlotCount(), pack: pack() };
    report.passed = mined.step.success === true && report.afterMine.ore >= 4;
  } else if (CASE === 'spare') {
    const spare = process.env.MINECRAFT_PACK_SPARE !== 'no';
    await oracle.executeSetupCommand(`fill ${cx + 2} ${y} ${cz} ${cx + 7} ${y + 1} ${cz} iron_ore`);
    await oracle.executeSetupCommand('clear MinebotTrial');
    await sleep(500);
    await give(`minecraft:stone_pickaxe[minecraft:damage=${Number(process.env.MINECRAFT_PACK_DAMAGE ?? 118)}] 1`);
    if (spare) { await give('minecraft:cobblestone 75'); await give('minecraft:stick 4'); await give('minecraft:crafting_table 1'); }
    else await give('minecraft:dirt 10');
    await sleep(1500);
    report.before = { pickaxes: pickaxes(), pack: pack() };
    const mined = await run('mine-block', ['iron_ore', 12, 16]);
    report.after = { pickaxes: pickaxes(), raw_iron: held('raw_iron'), pack: pack() };
    report.passed = Number(process.env.MINECRAFT_PACK_DAMAGE ?? 118) < 100 ? mined.step.success === true && held('raw_iron') >= 12
      : spare ? mined.step.success === true && held('raw_iron') >= 12 && report.after.pickaxes.length >= 2
      : (mined.step.failureType === 'tool_durability_low' && report.after.pickaxes.length === 1 && Number(/ (\d+)\//.exec(report.after.pickaxes[0])?.[1]) >= 2);
  } else if (CASE === 'descent') {
    const targetY = Number(process.env.MINECRAFT_PACK_TARGET_Y ?? -58);
    for (const command of ['difficulty peaceful', 'clear MinebotTrial', 'give MinebotTrial iron_pickaxe 2', 'give MinebotTrial minecraft:diamond_pickaxe 1',
      'give MinebotTrial cobblestone 64', 'give MinebotTrial cooked_beef 16']) await oracle.executeSetupCommand(command);
    await sleep(1500);
    const start = actor.entity.position.floored();
    let ground = start.y - 1;
    while (ground > -60 && ['air', 'oak_leaves', 'birch_leaves', 'spruce_leaves', 'oak_log', 'birch_log', 'spruce_log', 'short_grass', 'tall_grass']
      .includes(actor.blockAt(start.offset(0, ground - start.y, 0))?.name ?? 'air')) ground--;
    await oracle.executeSetupCommand(`fill ${start.x} ${ground + 1} ${start.z} ${start.x} ${start.y + 2} ${start.z} air`);
    await oracle.executeSetupCommand(`tp MinebotTrial ${start.x + 0.5} ${ground + 1} ${start.z + 0.5}`);
    await sleep(1500);
    report.surfaceY = ground + 1;
    const directions = ['east', 'south', 'west', 'north'];
    for (let attempt = 0; attempt < 6 && actor.entity.position.y > targetY + 4; attempt++) await run('stair-mine', [targetY, directions[attempt % 4], 'cobblestone'], 300_000);
    report.atBottom = { y: +actor.entity.position.y.toFixed(1), empty: actor.inventory.emptySlotCount(), used: actor.inventory.items().length, pack: pack() };
    // Obsidian in the rock a few blocks off (a fixture grant of the ore only), then mined as run 20's planner did.
    const foot = actor.entity.position.floored();
    for (const [dx, dz] of [[4, 0], [5, 0], [4, 1], [5, 1]]) await oracle.executeSetupCommand(`setblock ${foot.x + dx} ${foot.y} ${foot.z + dz} obsidian`);
    const mined = await run('mine-block', ['obsidian', 2, 16], 175_000);
    report.afterMine = { obsidian: held('obsidian'), empty: actor.inventory.emptySlotCount(), pack: pack() };
    report.passed = report.atBottom.y <= targetY + 4 && mined.step.failureType !== 'inventory_full' && held('obsidian') >= 1;
  }
} catch (error) {
  report.error = String((error as Error)?.stack ?? error).slice(0, 700);
} finally {
  console.log(`PACK_ROOM ${JSON.stringify(report)}`);
  await oracle.executeSetupCommand('clear MinebotTrial').catch(() => undefined);
  closeProbeBot(operator); closeProbeBot(actor);
  setTimeout(() => process.exit(0), 500);
}
