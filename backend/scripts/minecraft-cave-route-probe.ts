#!/usr/bin/env node
// Focused physical route reproduction; the only operator mutation is a
// transparent teleport inside a copy of the saved isolated world.
import fs from 'node:fs';
import path from 'node:path';
import { Vec3 } from 'vec3';
import { createProbeBot, closeProbeBot } from '../src/services/minebot/testing/MinecraftProbeBot.js';
import { MinecraftCommandOracle } from '../src/services/minebot/testing/MinecraftCommandOracle.js';

const port = Number(process.env.MINECRAFT_CAVE_PORT ?? 25580);
const directory = process.env.MINECRAFT_CAVE_WORLD_DIRECTORY ?? '';
const phase = process.env.MINECRAFT_CAVE_PHASE ?? 'baseline';
const targetRange = Number(process.env.MINECRAFT_CAVE_RANGE ?? 2);
const testCraft = process.env.MINECRAFT_CAVE_CRAFT === 'stone_sword';
if (!/^\/home\/azureuser\/minecraft\/progressive-lab-[A-Za-z0-9]+$/.test(directory)
  || !['baseline', 'revised'].includes(phase)
  || !Number.isFinite(targetRange) || targetRange < 0.5 || targetRange > 2)
  throw new Error('CAVE_PROBE_ISOLATED_INPUT_REQUIRED');
const properties = fs.readFileSync(path.join(directory, 'server.properties'), 'utf8');
for (const line of ['server-ip=127.0.0.1', `server-port=${port}`, 'level-type=minecraft\\:normal',
  'difficulty=normal', 'gamemode=survival']) {
  if (!properties.split('\n').includes(line)) throw new Error(`CAVE_WORLD_CONFIGURATION_INVALID:${line}`);
}
const operator = await createProbeBot(port);
const actor = await createProbeBot(port, 'MinebotTrial');
const oracle = new MinecraftCommandOracle(operator);
const report: any = { phase, port, targetRange, testCraft, startedAt: new Date().toISOString(), worldDirectory: directory };
const dug = new Set<string>();
let deaths = 0;
actor.on('diggingCompleted', (block: any) => { if (block?.position) dug.add(block.position.toString()); });
actor.on('death', () => { deaths++; });
try {
  await oracle.verifyReady();
  await oracle.executeSetupCommand('tp MinebotTrial -136.5 53 227.3');
  const initial = actor.entity.position.clone();
  const initialProof = await new MinecraftCommandOracle({ version: actor.version,
    chat: command => operator.chat(`/execute as @a[name=MinebotTrial,limit=1] at @s run ${command.replace(/^\//, '')}`),
    on: (_event, listener) => actor.on('message', listener as any),
    removeListener: (_event, listener) => actor.removeListener('message', listener as any),
  }).evaluate({ type: 'position_within', x: -136.5, y: 53, z: 227.3, radius: 2 });
  if (!initialProof.passed) throw new Error('CAVE_START_POSITION_NOT_PROVEN');
  const skill = actor.instantSkills.getSkill('move-to');
  if (!skill) throw new Error('CAVE_MOVE_SKILL_MISSING');
  const started = Date.now();
  const result = await skill.run(-138, 64, 225, targetRange, 'near');
  const durationMs = Date.now() - started;
  await new Promise(resolve => setTimeout(resolve, 750));
  const final = actor.entity.position.clone();
  const finalProof = await new MinecraftCommandOracle({ version: actor.version,
    chat: command => operator.chat(`/execute as @a[name=MinebotTrial,limit=1] at @s run ${command.replace(/^\//, '')}`),
    on: (_event, listener) => actor.on('message', listener as any),
    removeListener: (_event, listener) => actor.removeListener('message', listener as any),
  }).evaluate({ type: 'position_within', x: -138, y: 64, z: 225, radius: targetRange + 0.25 });
  const table = actor.blockAt(final.offset(0, 2, 0));
  const craftingTable = actor.blockAt(new Vec3(-138, 64, 225));
  const tableVisible = craftingTable ? actor.canSeeBlock(craftingTable) : false;
  Object.assign(report, { initial, final, durationMs, result, finalProof, incidentalDigs: dug.size, deaths,
    goalDistance: final.distanceTo({ x: -138, y: 64, z: 225 } as any),
    craftingTable: { name: craftingTable?.name ?? null, visible: tableVisible },
    overheadBlock: table?.name ?? null });
  if (testCraft && result.success) {
    const craftSkill = actor.instantSkills.getSkill('craft-one');
    if (!craftSkill) throw new Error('CAVE_CRAFT_SKILL_MISSING');
    const craftStarted = Date.now();
    report.craftResult = await craftSkill.run('stone_sword', 1);
    report.craftDurationMs = Date.now() - craftStarted;
    report.craftProof = await new MinecraftCommandOracle({ version: actor.version,
      chat: command => operator.chat(`/execute as @a[name=MinebotTrial,limit=1] at @s run ${command.replace(/^\//, '')}`),
      on: (_event, listener) => actor.on('message', listener as any),
      removeListener: (_event, listener) => actor.removeListener('message', listener as any),
    }).evaluate({ type: 'inventory_count', item: 'stone_sword', minCount: 1 });
  }
  console.log(`CAVE_ROUTE_RESULT ${JSON.stringify({ phase, targetRange, durationMs,
    success: result.success, failureType: result.failureType ?? null, finalProof: finalProof.passed,
    incidentalDigs: dug.size, deaths, initial, final, goalDistance: report.goalDistance,
    craftingTable: report.craftingTable, phaseMs: result.execution?.phaseMs ?? null,
    craft: testCraft ? { success: report.craftResult?.success, result: report.craftResult?.result,
      proof: report.craftProof?.passed, durationMs: report.craftDurationMs } : null })}`);
} catch (error) {
  report.error = String(error);
  process.exitCode = 1;
  console.error(`CAVE_ROUTE_ERROR ${String(error)}`);
} finally {
  const output = path.resolve('saves/minecraft/progressive_reports', `${new Date().toISOString().replace(/[:.]/g, '-')}-cave-route-${phase}.json`);
  fs.writeFileSync(output, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(`CAVE_ROUTE_REPORT ${output}`);
  closeProbeBot(actor);
  closeProbeBot(operator);
}
