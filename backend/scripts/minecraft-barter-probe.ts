#!/usr/bin/env node
// Model-free: the body trades gold with a piglin through the skill a planner would call, and what came back is
// listed. Development only (the gold and the piglin come from commands).
//   MINECRAFT_BARTER_GOLD=12  MINECRAFT_BARTER_ROUNDS=12  MINECRAFT_BARTER_BOOTS=1 (golden boots on, so the piglin leaves the body alone)
import fs from 'node:fs';
import path from 'node:path';
import { createProbeBot, closeProbeBot } from '../src/services/minebot/testing/MinecraftProbeBot.js';
import { MinecraftCommandOracle } from '../src/services/minebot/testing/MinecraftCommandOracle.js';
import { potionIn } from '../src/services/minebot/utils/potionContents.js';
import { captureWorldObservation } from '../src/services/minebot/cognition/worldFrame.js';

const port = Number(process.env.MINECRAFT_OUTAGE_PORT);
const worldDirectory = process.env.MINECRAFT_OUTAGE_WORLD_DIRECTORY ?? '';
if (process.env.MINECRAFT_OUTAGE_NO_LLM !== 'true' || !Number.isInteger(port) || port < 25577 || port > 25651
  || !/^\/home\/azureuser\/minecraft\/progressive-lab-[A-Za-z0-9]+$/.test(worldDirectory)) throw new Error('ISOLATED_PROBE_WORLD_REQUIRED');
const properties = fs.readFileSync(path.join(worldDirectory, 'server.properties'), 'utf8').split('\n');
if (!properties.includes('server-ip=127.0.0.1') || !properties.includes(`server-port=${port}`)) throw new Error('ISOLATED_PROBE_WORLD_CONFIGURATION_INVALID');
const gold = Number(process.env.MINECRAFT_BARTER_GOLD ?? 12);
const rounds = Number(process.env.MINECRAFT_BARTER_ROUNDS ?? gold);
const at = [3300.5, 200, 3300.5];
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const operator = await createProbeBot(port);
const actor: any = await createProbeBot(port, 'MinebotTrial');
const control = new MinecraftCommandOracle(operator);
const report: any = { gold, rounds };
try {
  await control.verifyReady();
  const [px, py, pz] = at.map(Math.floor);
  await control.executeSetupCommand(`execute in minecraft:overworld run tp ShannonProbe ${px} ${py + 14} ${pz}`);
  await sleep(4000);
  for (const command of [`forceload add ${px - 16} ${pz - 16} ${px + 16} ${pz + 16}`,
    `fill ${px - 8} ${py - 1} ${pz - 8} ${px + 8} ${py - 1} ${pz + 8} stone`, `fill ${px - 8} ${py} ${pz - 8} ${px + 8} ${py + 4} ${pz + 8} air`,
    `fill ${px - 8} ${py} ${pz - 8} ${px + 8} ${py + 1} ${pz - 8} stone`, `fill ${px - 8} ${py} ${pz + 8} ${px + 8} ${py + 1} ${pz + 8} stone`,
    `fill ${px - 8} ${py} ${pz - 8} ${px - 8} ${py + 1} ${pz + 8} stone`, `fill ${px + 8} ${py} ${pz - 8} ${px + 8} ${py + 1} ${pz + 8} stone`,
    'kill @e[type=minecraft:piglin]', 'kill @e[type=minecraft:item]', 'difficulty normal', 'time set noon', 'weather clear',
    'gamemode spectator ShannonProbe', 'gamemode survival MinebotTrial', 'clear MinebotTrial', 'effect clear MinebotTrial',
    `execute in minecraft:overworld run tp MinebotTrial ${at[0]} ${at[1]} ${at[2]}`,
    `give MinebotTrial minecraft:gold_ingot ${gold}`]) await control.executeSetupCommand(command);
  if (process.env.MINECRAFT_BARTER_BOOTS !== '0') await control.executeSetupCommand('item replace entity MinebotTrial armor.feet with minecraft:golden_boots');
  // One that stays a piglin here (in the overworld they turn within seconds otherwise).
  await control.executeSetupCommand(`execute in minecraft:overworld run summon minecraft:piglin ${at[0] + 5} ${at[1]} ${at[2]} {IsImmuneToZombification:1b,PersistenceRequired:1b}`);
  await sleep(4000);
  const startedAt = Date.now();
  let hurt = 0;
  let last = actor.health;
  actor.on('health', () => { if (actor.health < last) hurt += last - actor.health; last = actor.health; });
  const skill = actor.instantSkills.getSkill('use-item-on-entity');
  if (!skill) throw new Error('SKILL_MISSING:use-item-on-entity');
  const result: any = await skill.run('gold_ingot', 'piglin', rounds);
  await sleep(1500);
  Object.assign(report, { ms: Date.now() - startedAt, success: result?.success ?? false, result: String(result?.result ?? '').slice(0, 500), failureType: result?.failureType,
    damage: +hurt.toFixed(1), inventory: Object.fromEntries(actor.inventory.items().map((item: any) => [item.name, item.count])) });
  // What a potion in the pack is, as the client is told it, and what drinking one does (MINECRAFT_BARTER_DRINK=1
  // gives one of fire resistance to try it with, whatever the trades brought).
  if (process.env.MINECRAFT_BARTER_DRINK === '1') {
    for (const kind of ['water', 'swiftness', 'healing', 'regeneration', 'strength', 'slow_falling', 'fire_resistance'])
      await control.executeSetupCommand(`give MinebotTrial minecraft:potion[minecraft:potion_contents={potion:"minecraft:${kind}"}] 1`);
    await control.executeSetupCommand('effect clear MinebotTrial');
    await sleep(1500);
    report.named = actor.inventory.items().filter((item: any) => item.name === 'potion').map((item: any) => potionIn(item));
    report.observed = (captureWorldObservation(actor) as any).inventory.filter((item: any) => item.name === 'potion');
  }
  report.potions = actor.inventory.items().filter((item: any) => item.name.includes('potion')).map((item: any) => ({ name: item.name, display: item.displayName,
    components: JSON.stringify(item.components ?? item.nbt ?? null).slice(0, 300), custom: item.customName ?? null }));
  if (process.env.MINECRAFT_BARTER_DRINK === '1') {
    report.wrong = String((await actor.instantSkills.getSkill('use-item').run('potion', 'night_vision'))?.result ?? '').slice(0, 160);
    const drink: any = await actor.instantSkills.getSkill('use-item').run('potion', 'fire_resistance');
    await sleep(1500);
    report.drink = String(drink?.result ?? '').slice(0, 200);
    report.effects = Object.values(actor.entity.effects ?? {}).map((effect: any) => ({ id: effect.id, name: actor.registry.effects?.[effect.id]?.name ?? null, duration: effect.duration }));
    report.after = Object.fromEntries(actor.inventory.items().map((item: any) => [item.name, item.count]));
  }
  await control.executeSetupCommand('kill @e[type=minecraft:piglin]');
} catch (error) { report.error = String(error); process.exitCode = 1; }
finally { closeProbeBot(actor); closeProbeBot(operator); console.log(`BARTER_REPORT ${JSON.stringify(report)}`); }
