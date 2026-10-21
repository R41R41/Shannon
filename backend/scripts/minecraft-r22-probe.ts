#!/usr/bin/env node
// Model-free probes of what live run 22 showed (body side): MINECRAFT_R22_CASE picks one.
//   water-exit    a body in a pond on top of a rock slab walks to a pocket ~56 m off through the rock (run 22: 74 s, the route search's legs).
//   chicken-ledge attack-continuously for a chicken on a 6 m pillar (run 22: 62 s then only "cannot attack").
//   chicken-pen   the same for a chicken in a fence pen.
//   chicken-far   the same for a chicken 45 m off on open ground (can it be walked up to at all?).
//   furnace-window a furnace window left open, then place-block-at furnace with the furnace in the main inventory and the library's next hotbar slot beyond the window (run 22: "invalid operation").
// Lab ports 25690-25699 only. Setup commands are lab-only.
import fs from 'node:fs';
import path from 'node:path';
import { createProbeBot, closeProbeBot } from '../src/services/minebot/testing/MinecraftProbeBot.js';
import { MinecraftCommandOracle } from '../src/services/minebot/testing/MinecraftCommandOracle.js';

const port = Number(process.env.MINECRAFT_OUTAGE_PORT);
const worldDirectory = process.env.MINECRAFT_OUTAGE_WORLD_DIRECTORY ?? '';
if (process.env.MINECRAFT_OUTAGE_NO_LLM !== 'true' || !Number.isInteger(port) || port < 25690 || port > 25699
  || !/^\/home\/azureuser\/minecraft\/progressive-lab-[A-Za-z0-9]+$/.test(worldDirectory)) throw new Error('ISOLATED_PROBE_WORLD_REQUIRED');
const properties = fs.readFileSync(path.join(worldDirectory, 'server.properties'), 'utf8').split('\n');
if (!properties.includes('server-ip=127.0.0.1') || !properties.includes(`server-port=${port}`)) throw new Error('ISOLATED_PROBE_WORLD_CONFIGURATION_INVALID');

const which = process.env.MINECRAFT_R22_CASE ?? 'water-exit';
const limitMs = Number(process.env.MINECRAFT_R22_LIMIT_MS ?? 150_000);
const actor: any = await createProbeBot(port, 'MinebotTrial');
const operator = await createProbeBot(port);
const oracle = new MinecraftCommandOracle(operator);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const report: any = { case: which };
const setup = async (...commands: string[]) => { for (const command of commands) await oracle.executeSetupCommand(command); };
const run = async (skill: string, ...args: unknown[]) => {
  const started = Date.now();
  const outcome: any = await Promise.race([actor.instantSkills.getSkill(skill)!.run(...args), sleep(limitMs).then(() => ({ success: false, result: 'probe time limit' }))]);
  return { seconds: +((Date.now() - started) / 1000).toFixed(1), success: outcome?.success ?? null, failureType: outcome?.failureType ?? null, result: String(outcome?.result).slice(0, 420) };
};
try {
  await oracle.verifyReady();
  await setup('gamerule spawn_mobs false', 'gamerule mob_griefing false', 'time set day', 'effect clear MinebotTrial', 'clear MinebotTrial', 'gamemode survival MinebotTrial',
    'effect give MinebotTrial minecraft:instant_health 1 5', 'effect give MinebotTrial minecraft:saturation 1 10', 'kill @e[type=chicken]');
  const x0 = 10, z0 = 10, y0 = 40;
  if (which === 'water-exit') {
    const length = Number(process.env.MINECRAFT_R22_LENGTH ?? 40), drop = Number(process.env.MINECRAFT_R22_DROP ?? 40);
    await setup(`forceload add ${x0 - 8} ${z0 - 8} ${x0 + length + 8} ${z0 + 8}`, 'effect give MinebotTrial minecraft:slow_falling 20 0 true',
      `tp MinebotTrial ${x0 + 0.5} ${y0 + 12} ${z0 + 0.5}`);
    await sleep(2500);
    // A rock slab with a pond in its top at the start and a pocket of air `drop` lower at the far end.
    await setup(`fill ${x0 - 3} ${y0 - drop - 4} ${z0 - 3} ${x0 + length + 3} ${y0 + 4} ${z0 + 3} minecraft:stone`,
      `fill ${x0 - 2} ${y0 + 1} ${z0 - 2} ${x0 + 2} ${y0 + 4} ${z0 + 2} minecraft:water`,
      `fill ${x0 + length} ${y0 - drop} ${z0} ${x0 + length} ${y0 - drop + 1} ${z0} minecraft:air`,
      'effect clear MinebotTrial', 'give MinebotTrial minecraft:iron_pickaxe 1', 'give MinebotTrial minecraft:cobblestone 32', `tp MinebotTrial ${x0 + 0.5} ${y0 + 4} ${z0 + 0.5}`);
    await sleep(2500);
    report.start = { inWater: actor.entity.isInWater === true, y: +actor.entity.position.y.toFixed(1) };
    const there = await run('move-to', x0 + length, y0 - drop, z0, 1, 'near');
    const here = actor.entity.position;
    report.walk = { ...there, endDistance: +Math.hypot(here.x - (x0 + length), here.y - (y0 - drop), here.z - z0).toFixed(1), straightM: +Math.hypot(length, drop).toFixed(1) };
    report.passed = there.success === true;
    await setup(`forceload remove ${x0 - 8} ${z0 - 8} ${x0 + length + 8} ${z0 + 8}`);
  } else if (which.startsWith('chicken')) {
    const far = which === 'chicken-far';
    const reach = far ? 70 : 24;
    await setup(`forceload add ${x0 - 8} ${z0 - 12} ${x0 + reach} ${z0 + 12}`, `tp MinebotTrial ${x0 + 0.5} ${y0 + 3} ${z0 + 0.5}`);
    await sleep(2500);
    await setup(`fill ${x0 - 4} ${y0 - 1} ${z0 - 10} ${x0 + reach} ${y0 - 1} ${z0 + 10} minecraft:stone`, `fill ${x0 - 4} ${y0} ${z0 - 10} ${x0 + reach} ${y0 + 9} ${z0 + 10} minecraft:air`,
      `tp MinebotTrial ${x0 + 0.5} ${y0} ${z0 + 0.5}`, 'give MinebotTrial minecraft:stone_sword 1');
    if (which === 'chicken-ledge') {
      await setup(`fill ${x0 + 10} ${y0} ${z0} ${x0 + 10} ${y0 + 5} ${z0} minecraft:stone`, `summon minecraft:chicken ${x0 + 10.5} ${y0 + 6} ${z0 + 0.5} {NoAI:1b,Silent:1b}`);
    } else if (which === 'chicken-pen') {
      await setup(`fill ${x0 + 8} ${y0} ${z0 - 1} ${x0 + 10} ${y0} ${z0 + 1} minecraft:oak_fence`, `fill ${x0 + 9} ${y0} ${z0} ${x0 + 9} ${y0} ${z0} minecraft:air`,
        `summon minecraft:chicken ${x0 + 9.5} ${y0} ${z0 + 0.5} {NoAI:1b,Silent:1b}`);
    } else {
      await setup(`summon minecraft:chicken ${x0 + 45.5} ${y0} ${z0 + 0.5} {NoAI:1b,Silent:1b}`);
    }
    await sleep(3000);
    report.chicken = Object.values(actor.entities as Record<string, any>).filter(entity => entity?.name === 'chicken').map(entity => entity.position.toArray().map((value: number) => +value.toFixed(1)));
    const attack = await run('attack-continuously', 'chicken', 5, far ? 60 : 24, 1);
    report.attack = attack;
    report.passed = which === 'chicken-far' ? attack.success === true : attack.success === false && attack.seconds < 30;
    await setup(`forceload remove ${x0 - 8} ${z0 - 12} ${x0 + reach} ${z0 + 12}`, 'kill @e[type=chicken]');
  } else if (which === 'furnace-window') {
    await setup(`forceload add ${x0 - 8} ${z0 - 8} ${x0 + 12} ${z0 + 8}`, `tp MinebotTrial ${x0 + 0.5} ${y0 + 3} ${z0 + 0.5}`);
    await sleep(2500);
    await setup(`fill ${x0 - 5} ${y0 - 1} ${z0 - 5} ${x0 + 8} ${y0 - 1} ${z0 + 5} minecraft:stone`, `fill ${x0 - 5} ${y0} ${z0 - 5} ${x0 + 8} ${y0 + 5} ${z0 + 5} minecraft:air`,
      `tp MinebotTrial ${x0 + 0.5} ${y0} ${z0 + 0.5}`, 'clear MinebotTrial',
      // The hotbar full first, so that the furnace lands in the main inventory (a hotbar item is taken by selecting its slot, no click):
      // equip then clicks, in the numbering of whatever window is open.
      ...['dirt', 'cobblestone', 'stick', 'coal', 'oak_planks', 'sand', 'gravel', 'andesite', 'diorite', 'granite', 'glass', 'torch', 'furnace'].map(name => `give MinebotTrial minecraft:${name} 1`),
      `setblock ${x0 + 2} ${y0} ${z0 + 3} minecraft:furnace`);
    await sleep(1500);
    // Three equips from the main inventory, so that the next hotbar slot the library takes for a click is 39 (out of a furnace window).
    for (const name of ['granite', 'glass', 'torch']) await actor.equip(actor.inventory.items().find((entry: any) => entry.name === name), 'hand');
    const furnaceItem = actor.inventory.items().find((entry: any) => entry.name === 'furnace');
    report.furnaceSlot = furnaceItem?.slot ?? null;
    const block = actor.blockAt(new (actor.entity.position.constructor)(x0 + 2, y0, z0 + 3));
    const window = await actor.openFurnace(block);
    report.windowOpen = actor.currentWindow?.type ?? null;
    report.windowEnd = actor.currentWindow?.inventoryEnd ?? null;
    void window;
    const placed = await run('place-block-at', 'furnace');
    report.place = placed;
    report.windowAfter = actor.currentWindow?.type ?? null;
    report.passed = placed.success === true;
    await setup(`forceload remove ${x0 - 8} ${z0 - 8} ${x0 + 12} ${z0 + 8}`);
  } else throw new Error(`unknown case ${which}`);
} catch (error) { report.error = String(error); process.exitCode = 1; }
finally {
  closeProbeBot(operator);
  closeProbeBot(actor);
  console.log(`R22_REPORT ${JSON.stringify(report)}`);
}
