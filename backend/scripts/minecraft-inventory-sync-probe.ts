#!/usr/bin/env node
// Model-free: the body stands by a crafting table with iron, flint, sticks, planks and logs and crafts five
// things one straight after another, as a planner does in one reply (three at the table, two in the pack's own
// grid). After each craft the body's copy of its pack is compared with the server's (by asking the server for
// the whole pack). Reports what each craft answered, and which slots of the copy were wrong.
// A body's copy came apart from its pack this way and seventeen crafts "failed" (paid run L64).
// MINECRAFT_INVENTORY_SYNC=off is the control: crafts without the body's own check of its pack.
// Setup commands are lab-only.
import fs from 'node:fs';
import path from 'node:path';
import { createProbeBot, closeProbeBot } from '../src/services/minebot/testing/MinecraftProbeBot.js';
import { MinecraftCommandOracle } from '../src/services/minebot/testing/MinecraftCommandOracle.js';
import { resyncInventory } from '../src/services/minebot/utils/inventorySync.js';

const port = Number(process.env.MINECRAFT_OUTAGE_PORT);
const worldDirectory = process.env.MINECRAFT_OUTAGE_WORLD_DIRECTORY ?? '';
if (process.env.MINECRAFT_OUTAGE_NO_LLM !== 'true' || !Number.isInteger(port) || port < 25577 || port > 25651
  || !/^\/home\/azureuser\/minecraft\/progressive-lab-[A-Za-z0-9]+$/.test(worldDirectory)) throw new Error('ISOLATED_PROBE_WORLD_REQUIRED');
const properties = fs.readFileSync(path.join(worldDirectory, 'server.properties'), 'utf8').split('\n');
if (!properties.includes('server-ip=127.0.0.1') || !properties.includes(`server-port=${port}`)) throw new Error('ISOLATED_PROBE_WORLD_CONFIGURATION_INVALID');
const syncOn = process.env.MINECRAFT_INVENTORY_SYNC !== 'off';
const actor = await createProbeBot(port, 'MinebotTrial');
const operator = await createProbeBot(port);
const oracle = new MinecraftCommandOracle(operator);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const report: any = { syncOn };
try {
  await oracle.verifyReady();
  for (const command of ['gamerule spawn_mobs false', 'time set day', 'gamemode spectator ShannonProbe', 'kill @e[type=!minecraft:player]',
    'clear MinebotTrial', 'effect clear MinebotTrial', 'gamemode survival MinebotTrial', 'effect give MinebotTrial minecraft:instant_health 1 5']) await oracle.executeSetupCommand(command);
  const cx = 60, cz = 120, y = 230;
  await oracle.executeSetupCommand(`forceload add ${cx - 8} ${cz - 8} ${cx + 8} ${cz + 8}`);
  await oracle.executeSetupCommand('effect give MinebotTrial minecraft:slow_falling 6 0 true');
  await oracle.executeSetupCommand(`tp MinebotTrial ${cx + 0.5} ${y + 3} ${cz + 0.5}`);
  await sleep(2500);
  await oracle.executeSetupCommand(`fill ${cx - 6} ${y - 1} ${cz - 6} ${cx + 6} ${y + 5} ${cz + 6} air`);
  await oracle.executeSetupCommand(`fill ${cx - 6} ${y - 1} ${cz - 6} ${cx + 6} ${y - 1} ${cz + 6} stone`);
  await oracle.executeSetupCommand(`tp MinebotTrial ${cx + 0.5} ${y} ${cz + 0.5}`);
  await oracle.executeSetupCommand(`setblock ${cx + 1} ${y} ${cz} minecraft:crafting_table`);
  await sleep(2000);
  await oracle.executeSetupCommand('effect clear MinebotTrial');
  for (const [name, count] of [['iron_ingot', 24], ['flint', 2], ['stick', 8], ['spruce_planks', 8], ['spruce_log', 6], ['cobblestone', 40], ['coal', 9]] as const) await oracle.executeSetupCommand(`give MinebotTrial minecraft:${name} ${count}`);
  await sleep(1500);
  const sync = ((actor as any).inventorySync ??= { enabled: true, resyncs: 0, corrected: 0 });
  // The server's pack, by the same question the body asks; the copy as it stood is kept for comparison.
  const truth = async () => {
    const copy = actor.inventory.slots.map(item => item ? `${item.name}x${item.count}` : '');
    sync.enabled = true;
    const ok = await resyncInventory(actor as any);
    sync.enabled = syncOn;
    const server = actor.inventory.slots.map(item => item ? `${item.name}x${item.count}` : '');
    return { ok, wrong: server.map((value, slot) => value !== copy[slot] ? `${slot}: ${copy[slot] || '-'} / ${value || '-'}` : '').filter(Boolean) };
  };
  report.start = await truth();
  sync.enabled = syncOn;
  const count = (name: string) => actor.inventory.items().filter(item => item.name === name).reduce((sum, item) => sum + item.count, 0);
  const steps: any[] = [];
  const order: Array<[string, number]> = [['iron_sword', 1], ['bucket', 1], ['flint_and_steel', 1], ['stick', 4], ['spruce_planks', 4], ['iron_pickaxe', 1], ['spruce_planks', 4], ['stick', 4]];
  // All of them with nothing between, then the comparison: a look in between would itself put the copy right.
  for (const [name, wanted] of order) {
    const before = count(name);
    const crafted: any = await Promise.race([actor.instantSkills.getSkill('craft-one')!.run(name, wanted), sleep(20_000).then(() => ({ result: 'probe time limit' }))]);
    steps.push({ name, success: crafted?.success ?? null, result: String(crafted?.result).slice(0, 90), copySays: `${before}→${count(name)}` });
  }
  report.steps = steps;
  report.afterAll = await truth();
  // Something left lying in the pack's own crafting grid (a craft there that was cut off, or one whose result
  // never came): one stone put into a corner of the grid, by the same clicks a craft makes.
  const stone = actor.inventory.items().find(item => item.name === 'cobblestone')!;
  await actor.clickWindow(stone.slot, 0, 0);
  await actor.clickWindow(2, 1, 0);
  await actor.clickWindow(stone.slot, 0, 0);
  await sleep(500);
  const grid = () => [1, 2, 3, 4].map(slot => actor.inventory.slots[slot]).filter(Boolean).map((item: any) => `${item.name}x${item.count}@${item.slot}`);
  const leftover: any = { gridBefore: grid(), logsBefore: count('spruce_log'), planksBefore: count('spruce_planks'), crafts: [] as any[] };
  for (let attempt = 0; attempt < 3; attempt++) {
    const crafted: any = await Promise.race([actor.instantSkills.getSkill('craft-one')!.run('spruce_planks', 4), sleep(20_000).then(() => ({ result: 'probe time limit' }))]);
    leftover.crafts.push({ success: crafted?.success ?? null, result: String(crafted?.result).slice(0, 110), logs: count('spruce_log'), planks: count('spruce_planks'), grid: grid() });
  }
  report.leftover = leftover;
  report.afterLeftover = await truth();
  report.have = Object.fromEntries(['iron_sword', 'bucket', 'flint_and_steel', 'iron_pickaxe', 'stick', 'spruce_planks', 'spruce_log', 'iron_ingot', 'flint'].map(name => [name, count(name)]));
  report.resyncs = sync.resyncs; report.corrected = sync.corrected;
  // Every craft answers truly: success, and the pack holds what the answers say.
  report.passed = steps.every(step => step.success === true) && report.have.iron_sword === 1 && report.have.bucket === 1 && report.have.flint_and_steel === 1 && report.have.iron_pickaxe === 1
    && report.afterAll.wrong.length === 0
    // With something left in the grid: every craft still makes planks, a log each, and nothing stays in the grid.
    && leftover.crafts.every((craft: any) => craft.success === true && craft.grid.length === 0)
    && leftover.crafts[2].planks === leftover.planksBefore + 12 && leftover.crafts[2].logs === leftover.logsBefore - 3;
} catch (error) {
  report.error = String((error as Error)?.stack ?? error).slice(0, 600);
} finally {
  console.log(`INVENTORY_SYNC ${JSON.stringify(report)}`);
  await oracle.executeSetupCommand('clear MinebotTrial').catch(() => undefined);
  closeProbeBot(operator); closeProbeBot(actor);
  setTimeout(() => process.exit(0), 500);
}
