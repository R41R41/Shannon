#!/usr/bin/env node
// Lab tool, model-free: puts the body of a finished run back as that run's own report recorded it (place,
// dimension, what it carried), so that the stretch after that point can be gone over again without the forty
// minutes before it. A run continued from a restored body is development, never an acceptance: its items come
// from commands. Durability and enchantments are not restored (the report holds names and counts).
//   MINECRAFT_CHECKPOINT_REPORT=<…-dragon-campaign.json>  [MINECRAFT_CHECKPOINT_DIMENSION=the_nether]  [MINECRAFT_CHECKPOINT_AT="x,y,z"]
//   [MINECRAFT_CHECKPOINT_EXTRA="name:count,…"]
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
const reportFile = process.env.MINECRAFT_CHECKPOINT_REPORT ?? '';
const saved = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
const actorState = saved.actor;
if (!actorState?.position || !Array.isArray(actorState.inventory)) throw new Error('CHECKPOINT_REPORT_HAS_NO_ACTOR');
const dimension = process.env.MINECRAFT_CHECKPOINT_DIMENSION ?? 'the_nether';
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const operator = await createProbeBot(port);
const actor: any = await createProbeBot(port, 'MinebotTrial');
const control = new MinecraftCommandOracle(operator);
const result: any = { report: path.basename(reportFile), dimension };
try {
  await control.verifyReady();
  // MINECRAFT_CHECKPOINT_AT="x,y,z": a spot beside the recorded one. A body recorded on arrival stands inside
  // the portal, and put back there it is carried straight through again.
  const at = (process.env.MINECRAFT_CHECKPOINT_AT ?? '').split(',').map(Number);
  const { x, y, z } = at.length === 3 && at.every(Number.isFinite) ? { x: at[0], y: at[1], z: at[2] } : actorState.position;
  // Moved first, and only then emptied: emptied where the last run left it, the pack took up what lay round it in
  // the tick before the move. A run that had stopped in its cage beside a spawner came back carrying a blaze rod
  // from the corridor floor, and its continuation (L77ab) was over as "milestone reached" in thirteen seconds.
  for (const command of ['gamemode spectator ShannonProbe', 'gamemode survival MinebotTrial',
    `execute in minecraft:${dimension} run tp MinebotTrial ${x.toFixed(2)} ${y} ${z.toFixed(2)}`, 'clear MinebotTrial', 'effect clear MinebotTrial',
    'effect give MinebotTrial minecraft:instant_health 1 5', 'effect give MinebotTrial minecraft:saturation 1 10']) await control.executeSetupCommand(command);
  for (const item of actorState.inventory) await control.executeSetupCommand(`give MinebotTrial ${item.name} ${item.count}`);
  // MINECRAFT_CHECKPOINT_EXTRA="iron_sword:1,shield:1,cooked_beef:16": things the run did not have, given on top
  // (carried, not worn). For trying the stretch ahead with a kit the run would have had to make first; such a
  // run says nothing about getting that kit.
  const extra = (process.env.MINECRAFT_CHECKPOINT_EXTRA ?? '').split(',').map(entry => entry.trim()).filter(Boolean)
    .map(entry => { const [name, count] = entry.split(':'); return { name, count: Math.max(1, Number(count ?? 1) || 1) }; })
    .filter(item => /^[a-z_]+$/.test(item.name));
  for (const item of extra) await control.executeSetupCommand(`give MinebotTrial ${item.name} ${item.count}`);
  if (extra.length) result.extra = extra;
  await sleep(6000);
  result.position = actor.entity.position.floored();
  result.actorDimension = actor.game?.dimension;
  result.health = actor.health; result.food = actor.food;
  result.items = actor.inventory.items().length;
  // Anything carried that neither the report nor the extra gave was picked up where it stands: not a restore.
  const given = new Map<string, number>();
  for (const item of [...actorState.inventory, ...extra]) given.set(item.name, (given.get(item.name) ?? 0) + item.count);
  const carried = new Map<string, number>();
  for (const item of actor.inventory.items()) carried.set(item.name, (carried.get(item.name) ?? 0) + item.count);
  const unexpected = [...carried].filter(([name, count]) => count > (given.get(name) ?? 0)).map(([name, count]) => `${name}+${count - (given.get(name) ?? 0)}`);
  if (unexpected.length) result.unexpected = unexpected;
  result.restored = String(actor.game?.dimension ?? '').includes(dimension.replace('the_', '')) && result.items >= actorState.inventory.length - 2
    && !unexpected.length;
  if (!result.restored) process.exitCode = 1;
} catch (error) { result.error = String(error); process.exitCode = 1; }
finally { closeProbeBot(actor); closeProbeBot(operator); console.log(`CHECKPOINT_RESTORE ${JSON.stringify(result)}`); }
