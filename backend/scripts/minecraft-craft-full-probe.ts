#!/usr/bin/env node
// Model-free: every inventory slot is taken (35 of stone, one of six logs) and the body is asked to make planks
// from the logs, which have nowhere to go. Reports what craft-one answers, where the logs and planks are
// afterwards (inventory, the 2x2 crafting grid, the cursor), and whether drop-item then frees a slot for good.
// A body in this state was told "craft failed" six times with no reason, and each drop came back into its
// pack two seconds later (paid run L64). Setup commands are lab-only.
import fs from 'node:fs';
import path from 'node:path';
import { createProbeBot, closeProbeBot } from '../src/services/minebot/testing/MinecraftProbeBot.js';
import { MinecraftCommandOracle } from '../src/services/minebot/testing/MinecraftCommandOracle.js';

const port = Number(process.env.MINECRAFT_OUTAGE_PORT);
const worldDirectory = process.env.MINECRAFT_OUTAGE_WORLD_DIRECTORY ?? '';
if (process.env.MINECRAFT_OUTAGE_NO_LLM !== 'true' || !Number.isInteger(port) || port < 25577 || port > 25651
  || !/^\/home\/azureuser\/minecraft\/progressive-lab-[A-Za-z0-9]+$/.test(worldDirectory)) throw new Error('ISOLATED_PROBE_WORLD_REQUIRED');
const properties = fs.readFileSync(path.join(worldDirectory, 'server.properties'), 'utf8').split('\n');
if (!properties.includes('server-ip=127.0.0.1') || !properties.includes(`server-port=${port}`)) throw new Error('ISOLATED_PROBE_WORLD_CONFIGURATION_INVALID');
const actor = await createProbeBot(port, 'MinebotTrial');
const operator = await createProbeBot(port);
const oracle = new MinecraftCommandOracle(operator);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const report: any = {};
try {
  await oracle.verifyReady();
  for (const command of ['gamerule spawn_mobs false', 'time set day', 'gamemode spectator ShannonProbe', 'kill @e[type=!minecraft:player]',
    'clear MinebotTrial', 'effect clear MinebotTrial', 'gamemode survival MinebotTrial', 'effect give MinebotTrial minecraft:instant_health 1 5']) await oracle.executeSetupCommand(command);
  const cx = 60, cz = 90, y = 230;
  await oracle.executeSetupCommand(`forceload add ${cx - 12} ${cz - 12} ${cx + 12} ${cz + 12}`);
  await oracle.executeSetupCommand('effect give MinebotTrial minecraft:slow_falling 6 0 true');
  await oracle.executeSetupCommand(`tp MinebotTrial ${cx + 0.5} ${y + 3} ${cz + 0.5}`);
  await sleep(2500);
  await oracle.executeSetupCommand(`fill ${cx - 10} ${y - 1} ${cz - 10} ${cx + 10} ${y + 5} ${cz + 10} air`);
  await oracle.executeSetupCommand(`fill ${cx - 10} ${y - 1} ${cz - 10} ${cx + 10} ${y - 1} ${cz + 10} stone`);
  await oracle.executeSetupCommand(`tp MinebotTrial ${cx + 0.5} ${y} ${cz + 0.5}`);
  await sleep(2000);
  await oracle.executeSetupCommand('effect clear MinebotTrial');
  if (process.env.MINECRAFT_SHELTER_CASE) {
    // The body shuts itself in a shaft on open ground at night; a zombie that cannot move is then put three
    // blocks from the shaft, on the ground above. Asked to climb out (tower-up) and to shelter again
    // (dig-shelter), the body stays shut in and says why; with the zombie gone it climbs out.
    await oracle.executeSetupCommand('time set midnight');
    await oracle.executeSetupCommand(`fill ${cx - 14} ${y - 6} ${cz - 14} ${cx + 14} ${y - 1} ${cz + 14} stone`);
    await oracle.executeSetupCommand('give MinebotTrial minecraft:cobblestone 32');
    await oracle.executeSetupCommand('give MinebotTrial minecraft:iron_pickaxe 1');
    await sleep(1500);
    const sealedNow = () => { const f = actor.entity.position.floored(); const solid = (dx: number, dy: number, dz: number) => actor.blockAt(f.offset(dx, dy, dz))?.boundingBox === 'block';
      return !solid(0, 0, 0) && !solid(0, 1, 0) && solid(0, 2, 0) && solid(0, -1, 0) && [0, 1].every(dy => solid(1, dy, 0) && solid(-1, dy, 0) && solid(0, dy, 1) && solid(0, dy, -1)); };
    const run = async (name: string, ...args: any[]) => { const r: any = await Promise.race([actor.instantSkills.getSkill(name)!.run(...args), sleep(40_000).then(() => ({ result: 'probe time limit' }))]);
      return { success: r?.success ?? null, failureType: r?.failureType ?? null, result: String(r?.result).slice(0, 150), sealed: sealedNow(), y: +(actor.entity.position.y - y).toFixed(1) }; };
    const steps: any = {};
    steps.shelter = await run('dig-shelter');
    const at = actor.entity.position.floored();
    await oracle.executeSetupCommand(`summon minecraft:zombie ${at.x + 3.5} ${y} ${at.z + 0.5} {NoAI:1b,PersistenceRequired:1b,Silent:1b}`);
    await sleep(2500);
    steps.climbWithZombie = await run('tower-up', 4, 'cobblestone');
    steps.shelterAgain = await run('dig-shelter');
    steps.tunnelAway = await run('dig-block-at', at.x - 1, at.y, at.z, false);
    await oracle.executeSetupCommand('kill @e[type=minecraft:zombie]');
    await sleep(2500);
    // The side tunnel just dug is closed again by standing still: only the roof matters for the last step.
    steps.climbAfter = await run('tower-up', 4, 'cobblestone');
    report.steps = steps;
    report.guard = (actor as any).exposureDigGuard;
    report.passed = steps.shelter.success === true && steps.shelter.sealed
      && steps.climbWithZombie.success === false && steps.climbWithZombie.failureType === 'threat_exposed' && steps.climbWithZombie.sealed
      && steps.shelterAgain.success === true && steps.shelterAgain.sealed && steps.shelterAgain.result.includes('既に')
      && steps.tunnelAway.success === true
      && steps.climbAfter.success === true && steps.climbAfter.y >= 0;
    await oracle.executeSetupCommand('time set day');
    throw Object.assign(new Error('done'), { done: true });
  }
  if (process.env.MINECRAFT_DOUSE_CASE) {
    // On fire on open ground with a bucket of water and no lava anywhere near: the body pours the water at its
    // feet and takes it up again.
    await oracle.executeSetupCommand(`fill ${cx - 14} ${y - 1} ${cz - 14} ${cx + 14} ${y - 1} ${cz + 14} stone`);
    await oracle.executeSetupCommand('give MinebotTrial minecraft:water_bucket 1');
    await sleep(1000);
    const healthBefore = actor.health;
    const burning = () => (Number((actor.entity as any).metadata?.[0] ?? 0) & 1) !== 0;
    await oracle.executeSetupCommand(`setblock ${cx} ${y} ${cz} minecraft:fire`);
    const lit = Date.now();
    while (!burning() && Date.now() - lit < 3000) await sleep(50);
    const caughtAfterMs = burning() ? Date.now() - lit : null;
    await oracle.executeSetupCommand(`setblock ${cx} ${y} ${cz} minecraft:air`);
    const started = Date.now();
    let outAfter: number | null = null;
    while (Date.now() - started < 8000) { await sleep(100); if (!burning() && outAfter === null) outAfter = Date.now() - started; }
    report.caughtAfterMs = caughtAfterMs;
    report.douse = { state: (actor as any).fireDouse, outAfterMs: outAfter, healthBefore, health: actor.health,
      buckets: actor.inventory.items().filter(item => item.name.includes('bucket')).map(item => item.name),
      waterLeft: actor.blockAt(actor.entity.position.floored().set(cx, y, cz))?.name };
    report.passed = caughtAfterMs !== null && (actor as any).fireDouse?.doused >= 1 && outAfter !== null && outAfter < 3000 && report.douse.buckets.includes('water_bucket') && report.douse.waterLeft !== 'water';
    throw Object.assign(new Error('done'), { done: true });
  }
  if (process.env.MINECRAFT_FILL_CASE) {
    // A wall three wide and three high whose far end is out of reach from where the body stands, one layer of it
    // already there, and as much stone as the whole range would take if none of it were built (but no more).
    await oracle.executeSetupCommand(`fill ${cx - 14} ${y - 1} ${cz - 14} ${cx + 14} ${y - 1} ${cz + 14} stone`);
    await oracle.executeSetupCommand(`fill ${cx + 3} ${y} ${cz - 1} ${cx + 8} ${y} ${cz - 1} stone`);
    await oracle.executeSetupCommand('give MinebotTrial minecraft:cobblestone 10');
    await oracle.executeSetupCommand('give MinebotTrial minecraft:dirt 1');
    await sleep(800);
    await oracle.executeSetupCommand('give MinebotTrial minecraft:cobblestone 8');
    await sleep(1500);
    const stacks = actor.inventory.items().filter(item => item.name === 'cobblestone').map(item => item.count);
    const started = Date.now();
    const filled: any = await Promise.race([actor.instantSkills.getSkill('fill-area')!.run(cx + 3, y, cz - 1, cx + 8, y + 2, cz - 1, 'cobblestone'), sleep(120_000).then(() => ({ result: 'probe time limit' }))]);
    let solid = 0;
    for (let x = cx + 3; x <= cx + 8; x++) for (let dy = 0; dy <= 2; dy++) if (actor.blockAt(actor.entity.position.floored().set(x, y + dy, cz - 1))?.boundingBox === 'block') solid++;
    report.fill = { stacks, success: filled?.success ?? null, result: String(filled?.result).slice(0, 220), ms: Date.now() - started, solidCells: solid, of: 18,
      stoneLeft: actor.inventory.items().filter(item => item.name === 'cobblestone').reduce((sum, item) => sum + item.count, 0) };
    // Twelve empty cells and eighteen stone: the wall stands whole, and only the empty cells took stone.
    report.passed = filled?.success === true && solid === 18 && report.fill.stoneLeft >= 6;
    throw Object.assign(new Error('done'), { done: true });
  }
  if (process.env.MINECRAFT_DROP_CASE) {
    // 'flat': level ground with no pit in reach (the platform is widened so its rim is out of the search).
    // 'enclosed': the body walled into a single cell, where a dropped item cannot be left behind.
    const enclosed = process.env.MINECRAFT_DROP_CASE === 'enclosed';
    await oracle.executeSetupCommand(`fill ${cx - 14} ${y - 1} ${cz - 14} ${cx + 14} ${y - 1} ${cz + 14} stone`);
    if (enclosed) {
      await oracle.executeSetupCommand(`fill ${cx - 1} ${y} ${cz - 1} ${cx + 1} ${y + 2} ${cz + 1} stone`);
      await oracle.executeSetupCommand(`fill ${cx} ${y} ${cz} ${cx} ${y + 1} ${cz} air`);
    }
    await oracle.executeSetupCommand('give MinebotTrial minecraft:cobblestone 128');
    await sleep(1500);
    actor.constantSkills.getSkill('auto-pick-up-item')!.status = false;
    const held = () => actor.inventory.items().filter(item => item.name === 'cobblestone').reduce((sum, item) => sum + item.count, 0);
    const started = Date.now();
    const dropped: any = await Promise.race([actor.instantSkills.getSkill('drop-item')!.run('cobblestone', 64), sleep(40_000).then(() => ({ result: 'probe time limit' }))]);
    const saidHeld = held();
    await sleep(4000);
    report.drop = { case: process.env.MINECRAFT_DROP_CASE, success: dropped?.success ?? null, failureType: dropped?.failureType ?? null, result: String(dropped?.result).slice(0, 200),
      ms: Date.now() - started - 4000, heldWhenAnswered: saidHeld, heldFourSecondsLater: held() };
    // The answer matches what the pack holds afterwards: on open ground the stone stays gone; walled in, the skill says it came back.
    report.passed = enclosed ? dropped?.success === false && dropped?.failureType === 'picked_up_again' && held() === 128
      : dropped?.success === true && held() === 64;
    throw Object.assign(new Error('done'), { done: true });
  }
  if (process.env.MINECRAFT_CRAFT_STALE_WINDOW) {
    // A container window left open by an earlier action (a furnace or a chest whose user was cut off), six
    // logs in the pack, and planks to make from them in the pack's own 2x2 grid.
    const kind = process.env.MINECRAFT_CRAFT_STALE_WINDOW;
    await oracle.executeSetupCommand(`setblock ${cx + 1} ${y} ${cz} minecraft:${kind}`);
    await oracle.executeSetupCommand('give MinebotTrial minecraft:spruce_log 6');
    await sleep(1500);
    const block = actor.blockAt(actor.entity.position.floored().offset(1, 0, 0))!;
    const opened = new Promise(resolve => actor.once('windowOpen', resolve));
    await actor.activateBlock(block);
    await Promise.race([opened, sleep(3000)]);
    const count = (name: string) => actor.inventory.items().filter(item => item.name === name).reduce((sum, item) => sum + item.count, 0);
    report.stale = { kind, windowOpen: actor.currentWindow ? String((actor.currentWindow as any).type) : null, logs: count('spruce_log') };
    const results: any[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const crafted: any = await Promise.race([actor.instantSkills.getSkill('craft-one')!.run('spruce_planks', 4), sleep(15_000).then(() => ({ result: 'probe time limit' }))]);
      await sleep(1000);
      results.push({ success: crafted?.success ?? null, result: String(crafted?.result).slice(0, 120), logs: count('spruce_log'), planks: count('spruce_planks'),
        windowStillOpen: actor.currentWindow ? String((actor.currentWindow as any).type) : null,
        elsewhere: [0, 1, 2, 3, 4, 45].map(slot => actor.inventory.slots[slot]).filter(Boolean).map((item: any) => `${item.name}x${item.count}@${item.slot}`) });
    }
    report.crafts = results;
    // Every log that goes becomes four planks in the pack.
    report.passed = results.every(result => result.success === true) && results[1].planks === (6 - results[1].logs) * 4 && results[1].logs < 6;
    throw Object.assign(new Error('done'), { done: true });
  }
  for (const [name, count] of [['cobblestone', 640], ['andesite', 640], ['granite', 640], ['diorite', 320], ['spruce_log', 6]] as const) await oracle.executeSetupCommand(`give MinebotTrial minecraft:${name} ${count}`);
  await sleep(1500);
  const count = (name: string) => actor.inventory.items().filter(item => item.name === name).reduce((sum, item) => sum + item.count, 0);
  const outside = () => ({ grid: [0, 1, 2, 3, 4].map(slot => actor.inventory.slots[slot]).filter(Boolean).map((item: any) => `${item.name}x${item.count}@${item.slot}`),
    cursor: (actor.inventory as any).selectedItem ? `${(actor.inventory as any).selectedItem.name}x${(actor.inventory as any).selectedItem.count}` : null });
  report.before = { emptySlots: actor.inventory.emptySlotCount(), logs: count('spruce_log'), planks: count('spruce_planks') };
  const crafted: any = await Promise.race([actor.instantSkills.getSkill('craft-one')!.run('spruce_planks', 4), sleep(15_000).then(() => ({ result: 'probe time limit' }))]);
  await sleep(1000);
  report.craft = { success: crafted?.success ?? null, failureType: crafted?.failureType ?? null, result: String(crafted?.result).slice(0, 200) };
  report.afterCraft = { emptySlots: actor.inventory.emptySlotCount(), logs: count('spruce_log'), planks: count('spruce_planks'), ...outside() };
  // Then the way out the planner took: throw stone away, and make the planks.
  const stoneBefore = count('cobblestone');
  const dropped: any = await Promise.race([actor.instantSkills.getSkill('drop-item')!.run('cobblestone', 64), sleep(30_000).then(() => ({ result: 'probe time limit' }))]);
  await sleep(4000); // past the two seconds before a thrown item can be picked up again
  report.drop = { success: dropped?.success ?? null, result: String(dropped?.result).slice(0, 160), stoneBefore, stoneAfter: count('cobblestone'), emptySlots: actor.inventory.emptySlotCount() };
  const again: any = await Promise.race([actor.instantSkills.getSkill('craft-one')!.run('spruce_planks', 4), sleep(15_000).then(() => ({ result: 'probe time limit' }))]);
  await sleep(1000);
  report.craftAgain = { success: again?.success ?? null, result: String(again?.result).slice(0, 160), logs: count('spruce_log'), planks: count('spruce_planks'), ...outside() };
  // The first craft says there was no room; after the drop the stone stays gone and the planks are made.
  report.passed = crafted?.failureType === 'inventory_full' && report.afterCraft.grid.length === 0
    && report.drop.stoneAfter === stoneBefore - 64 && again?.success === true && report.craftAgain.planks >= 4;
} catch (error) {
  if (!(error as any)?.done) report.error = String((error as Error)?.stack ?? error).slice(0, 600);
} finally {
  console.log(`CRAFT_FULL ${JSON.stringify(report)}`);
  await oracle.executeSetupCommand('clear MinebotTrial').catch(() => undefined);
  closeProbeBot(operator); closeProbeBot(actor);
  setTimeout(() => process.exit(0), 500);
}
