#!/usr/bin/env node
// Model-free check of refilling a bucket from a water source the bot just
// poured next to itself: standing in the resulting flow vs. on dry ground.
import fs from 'node:fs';
import path from 'node:path';
import { Vec3 } from 'vec3';
import { createProbeBot, closeProbeBot } from '../src/services/minebot/testing/MinecraftProbeBot.js';
import { MinecraftCommandOracle } from '../src/services/minebot/testing/MinecraftCommandOracle.js';

const port = Number(process.env.MINECRAFT_BUCKET_PORT);
const worldDirectory = process.env.MINECRAFT_BUCKET_WORLD_DIRECTORY ?? '';
if (process.env.MINECRAFT_BUCKET_NO_LLM !== 'true' || !/^\/home\/azureuser\/minecraft\/progressive-lab-[A-Za-z0-9]+$/.test(worldDirectory)
  || !fs.readFileSync(path.join(worldDirectory, 'server.properties'), 'utf8').split('\n').includes(`server-port=${port}`))
  throw new Error('ISOLATED_BUCKET_WORLD_REQUIRED');
const operator = await createProbeBot(port);
const actor = await createProbeBot(port, 'MinebotTrial');
const control = new MinecraftCommandOracle(operator);
const results: any[] = [];
try {
  await control.verifyReady();
  const { activateItemFacing } = await import('../src/services/minebot/utils/activateItemFacing.js');
  const reset = async () => {
    for (const command of ['gamemode spectator ShannonProbe', 'fill -6 99 -6 12 99 12 stone', 'fill -6 100 -6 12 104 12 air',
      'tp MinebotTrial 4.5 100 5.5', 'clear MinebotTrial', 'give MinebotTrial bucket 1']) await control.executeSetupCommand(command);
    await new Promise(resolve => setTimeout(resolve, 1500));
    const bucket = actor.inventory.items().find(item => item.name === 'bucket')!;
    await actor.equip(bucket, 'hand');
  };
  const record = async (label: string, extra: object = {}) => {
    await new Promise(resolve => setTimeout(resolve, 700));
    results.push({ label, held: actor.heldItem?.name ?? null, source: actor.blockAt(new Vec3(5, 100, 5))?.name,
      feet: actor.blockAt(actor.entity.position.floored())?.name, position: actor.entity.position, ...extra });
    console.log(`BUCKET_CASE ${JSON.stringify(results.at(-1))}`);
  };
  // A: source already spread, aim at the fluid surface instead of the cell centre.
  await reset(); await control.executeSetupCommand('setblock 5 100 5 water'); await new Promise(r => setTimeout(r, 2500));
  await activateItemFacing(actor, new Vec3(5.5, 100.85, 5.5)); await record('spread-aim-surface');
  // B: sneaking so the flow does not push, aim at centre.
  await reset(); actor.setControlState('sneak', true); await control.executeSetupCommand('setblock 5 100 5 water');
  await new Promise(r => setTimeout(r, 2500));
  await activateItemFacing(actor, new Vec3(5.5, 100.5, 5.5)); await record('spread-sneak-centre'); actor.setControlState('sneak', false);
  // C: pour and scoop back within 300ms, as a player does.
  await reset(); await control.executeSetupCommand('give MinebotTrial water_bucket 1');
  const water = actor.inventory.items().find(item => item.name === 'water_bucket'); if (water) await actor.equip(water, 'hand');
  await activateItemFacing(actor, new Vec3(5.5, 100.0, 5.5));
  await new Promise(r => setTimeout(r, 300)); const placed = actor.blockAt(new Vec3(5, 100, 5))?.name;
  await activateItemFacing(actor, new Vec3(5.5, 100.5, 5.5)); await record('pour-then-scoop-300ms', { placed });
  // D: same as C but scoop after 3s (flow fully spread under the bot).
  await reset(); await control.executeSetupCommand('give MinebotTrial water_bucket 1');
  const water2 = actor.inventory.items().find(item => item.name === 'water_bucket'); if (water2) await actor.equip(water2, 'hand');
  await activateItemFacing(actor, new Vec3(5.5, 100.0, 5.5));
  await new Promise(r => setTimeout(r, 3000));
  await activateItemFacing(actor, new Vec3(5.5, 100.5, 5.5)); await record('pour-then-scoop-3s');
} finally {
  closeProbeBot(actor); closeProbeBot(operator);
  const file = path.resolve('saves/minecraft/progressive_reports', `${new Date().toISOString().replace(/[:.]/g, '-')}-bucket-pickup.json`);
  fs.writeFileSync(file, JSON.stringify({ diagnosisOnly: true, results }, null, 2), { mode: 0o600 });
  console.log(`BUCKET_REPORT ${file}`);
}
