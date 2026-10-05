#!/usr/bin/env node
/** Diagnostic native-state comparison only, inside a disposable loopback lab.
 * No planner, external provider, shared config, database or production runtime.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Vec3 } from 'vec3';
import { createProbeBot, closeProbeBot } from '../src/services/minebot/testing/MinecraftProbeBot.js';
import { MinecraftCommandOracle } from '../src/services/minebot/testing/MinecraftCommandOracle.js';
import { captureWorldObservation } from '../src/services/minebot/cognition/worldFrame.js';
const port = Number(process.env.MINECRAFT_PROBE_PORT ?? 25577);
const campaignId = new Date().toISOString().replace(/[:.]/g, '-');
const reports: any[] = []; const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const directory = path.resolve('saves/minecraft/progressive_reports'); fs.mkdirSync(directory, { recursive: true });
const sourceHashes = Object.fromEntries(['scripts/minecraft-architecture-live-probe.ts',
  'src/services/minebot/cognition/worldFrame.ts', 'src/services/minebot/testing/MinecraftProbeBot.ts'].map(file =>
  [file, createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
function snapshot(bot: any) {
  const window = bot.currentWindow;
  return { native: { isInWater: bot.entity.isInWater, effects: Object.values(bot.entity.effects),
    timeOfDay: bot.time.timeOfDay, isRaining: bot.isRaining,
    closedInventory: bot.inventory.items().map((i: any) => ({ name: i.name, count: i.count })),
    openWindowPlayerItems: window ? window.slots.slice(window.inventoryStart, window.inventoryEnd)
      .filter(Boolean).map((i: any) => ({ name: i.name, count: i.count })) : null },
    cognition: captureWorldObservation(bot) };
}
let bot: Awaited<ReturnType<typeof createProbeBot>> | undefined;
try {
  bot = await createProbeBot(port); const oracle = new MinecraftCommandOracle(bot); await oracle.verifyReady();
  for (let repeat = 1; repeat <= 3; repeat++) {
    const commands = ['/gamemode creative @s', '/difficulty peaceful', '/gamerule minecraft:spawn_mobs false',
      '/gamerule minecraft:advance_time false', '/gamerule minecraft:advance_weather false', '/time set midnight', '/weather rain',
      '/clear @s', '/fill -4 99 -4 4 99 4 stone', '/fill -4 100 -4 4 103 4 air',
      '/fill 1 100 -1 3 102 1 water', '/effect clear @s', '/effect give @s poison 30 1 true', '/tp @s 2 100 0'];
    for (const command of commands) await oracle.executeSetupCommand(command);
    await wait(600);
    const immersed = snapshot(bot);
    if (!immersed.native.isInWater || immersed.native.effects.length === 0 || !immersed.native.isRaining)
      throw new Error('Native water/effect/weather fixture was not observed');
    if (!immersed.cognition.isInWater || !immersed.cognition.activeEffects.length || immersed.cognition.weather !== 'rain'
      || immersed.cognition.time !== String(immersed.native.timeOfDay)) throw new Error('Cognition lost native water/effect/time/weather');
    reports.push({ repeat, phase: 'native-water-effects-night-rain', immersed });
    for (const command of ['/tp @s 0 100 0', '/effect clear @s', '/fill 1 100 -1 3 102 1 air',
      '/setblock 1 100 1 furnace', '/give @s raw_iron 3', '/give @s coal 1']) await oracle.executeSetupCommand(command);
    const block = bot.blockAt(new Vec3(1, 100, 1)); if (!block) throw new Error('Furnace not observed');
    const furnace = await bot.openFurnace(block);
    try {
      const registry = bot.registry.itemsByName;
      await furnace.putInput(registry.raw_iron.id, null, 3);
      await furnace.putFuel(registry.coal.id, null, 1); await wait(200);
      const pending = snapshot(bot);
      const server = await oracle.evaluate({ type: 'inventory_count', item: 'raw_iron', minCount: 0, maxCount: 0 });
      if (!server.passed) throw new Error('Server input transfer not confirmed');
      if (pending.cognition.inventory.some(item => item.name === 'raw_iron' || item.name === 'coal')) throw new Error('Transferred furnace resources still counted as player inventory');
      await wait(10500);
      reports.push({ repeat, phase: 'open-furnace', pending, server,
        progressing: snapshot(bot), furnace: { input: furnace.inputItem()?.count ?? 0,
          output: furnace.outputItem()?.count ?? 0, fuel: furnace.fuel, progress: furnace.progress } });
      if (!furnace.outputItem()?.count) throw new Error('Real furnace produced no output');
    } finally { furnace.close(); }
    await wait(200); const closed = snapshot(bot);
    if (closed.cognition.inventory.some(item => item.name === 'raw_iron' || item.name === 'coal')) throw new Error('Closed-window inventory double-counted resources');
    reports.push({ repeat, phase: 'closed-furnace', observed: closed });
  }
} finally {
  if (bot) closeProbeBot(bot);
  fs.writeFileSync(path.join(directory, `${campaignId}-architecture-native.json`), JSON.stringify({ campaignId, sourceHashes,
    diagnosticOnly: true, reports }, null, 2));
}
process.stdout.write(`ARCHITECTURE_NATIVE_REPORT ${JSON.stringify({ campaignId, repeats: 3,
  reports: reports.length, file: `${campaignId}-architecture-native.json` })}\n`);
