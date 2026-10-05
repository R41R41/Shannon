#!/usr/bin/env node
// Model-free: armour and a shield given into the pack are on the body a few seconds later, also while it walks.
import fs from 'node:fs';
import path from 'node:path';
import { createProbeBot, closeProbeBot } from '../src/services/minebot/testing/MinecraftProbeBot.js';
import { MinecraftCommandOracle } from '../src/services/minebot/testing/MinecraftCommandOracle.js';
import { activeActionCapabilities } from '../src/services/minebot/execution/ActionExecution.js';

const port = Number(process.env.MINECRAFT_OUTAGE_PORT);
const worldDirectory = process.env.MINECRAFT_OUTAGE_WORLD_DIRECTORY ?? '';
if (process.env.MINECRAFT_OUTAGE_NO_LLM !== 'true' || !Number.isInteger(port) || port < 25577 || port > 25651
  || !/^\/home\/azureuser\/minecraft\/progressive-lab-[A-Za-z0-9]+$/.test(worldDirectory)) throw new Error('ISOLATED_PROBE_WORLD_REQUIRED');
const properties = fs.readFileSync(path.join(worldDirectory, 'server.properties'), 'utf8').split('\n');
if (!properties.includes('server-ip=127.0.0.1') || !properties.includes(`server-port=${port}`)) throw new Error('ISOLATED_PROBE_WORLD_CONFIGURATION_INVALID');
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const operator = await createProbeBot(port);
const actor: any = await createProbeBot(port, 'MinebotTrial');
const control = new MinecraftCommandOracle(operator);
const report: any = {};
try {
  await control.verifyReady();
  for (const command of ['gamemode spectator ShannonProbe', 'gamemode survival MinebotTrial', 'clear MinebotTrial',
    'give MinebotTrial minecraft:iron_helmet', 'give MinebotTrial minecraft:iron_chestplate', 'give MinebotTrial minecraft:shield', 'give MinebotTrial minecraft:cobblestone 8']) await control.executeSetupCommand(command);
  await sleep(1500);
  const skill = actor.constantSkills.getSkill('auto-wear-armor');
  report.skill = skill ? { status: skill.status, interval: skill.interval } : null;
  const position = actor.entity.position;
  const walk = actor.instantSkills.getSkill('move-to').run(Math.floor(position.x) + 14, Math.floor(position.y), Math.floor(position.z), 'near', 1);
  await sleep(700);
  report.capabilitiesWhileWalking = activeActionCapabilities(actor);
  try { await skill.runImpl(); report.direct = 'ok'; } catch (error) { report.direct = String((error as Error)?.stack ?? error).slice(0, 600); }
  await Promise.race([walk, sleep(12_000)]);
  await sleep(1500);
  const slot = (name: string) => actor.inventory.slots[actor.getEquipmentDestSlot(name)]?.name ?? null;
  report.worn = { head: slot('head'), torso: slot('torso'), offHand: slot('off-hand') };
  report.passed = report.worn.head === 'iron_helmet' && report.worn.torso === 'iron_chestplate' && report.worn.offHand === 'shield';
  if (!report.passed) process.exitCode = 1;
} catch (error) { report.error = String(error); process.exitCode = 1; }
finally { closeProbeBot(actor); closeProbeBot(operator); console.log(`WEAR_REPORT ${JSON.stringify(report)}`); }
