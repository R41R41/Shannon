#!/usr/bin/env node
/**
 * Model-free, physical regression for furnace withdrawal in a fresh clone.
 * Operator commands create a diagnostic fixture only; this result must never
 * be counted as the zero-inventory dragon-campaign acceptance milestone.
 * The source campaign world is read for safety checks and never changed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Vec3 } from 'vec3';
import { waitForObservation } from '../src/services/minebot/execution/observedWait.js';
import { createProbeBot, closeProbeBot } from '../src/services/minebot/testing/MinecraftProbeBot.js';
import { MinecraftCommandOracle } from '../src/services/minebot/testing/MinecraftCommandOracle.js';

const cloneDirectory = process.env.MINECRAFT_SMELT_CLONE_DIRECTORY ?? '';
const sourceDirectory = process.env.MINECRAFT_SMELT_SOURCE_DIRECTORY ?? '';
const port = Number(process.env.MINECRAFT_SMELT_PORT);
const sourcePort = Number(process.env.MINECRAFT_SMELT_SOURCE_PORT);
const labPath = /^\/home\/azureuser\/minecraft\/progressive-lab-[A-Za-z0-9]+$/;
if (process.env.MINECRAFT_SMELT_PROBE !== 'true'
  || process.env.MINECRAFT_SMELT_ALLOW_OP_FIXTURE !== 'true'
  || !labPath.test(cloneDirectory) || !labPath.test(sourceDirectory)
  || !Number.isInteger(port) || port < 25577 || port > 25650
  || !Number.isInteger(sourcePort) || sourcePort < 25577 || sourcePort > 25650
  || port === sourcePort) {
  throw new Error('SMELT_PROBE_FRESH_ISOLATED_CLONE_AND_DIAGNOSTIC_FIXTURE_REQUIRED');
}
const cloneReal = fs.realpathSync(cloneDirectory);
const sourceReal = fs.realpathSync(sourceDirectory);
if (cloneReal === sourceReal
  || fs.realpathSync(path.join(cloneReal, 'progressive_world'))
    === fs.realpathSync(path.join(sourceReal, 'progressive_world'))) {
  throw new Error('SMELT_PROBE_SOURCE_WORLD_MUST_NOT_BE_MUTATED');
}
const lines = (directory: string) => new Set(fs.readFileSync(path.join(directory, 'server.properties'), 'utf8').split('\n'));
const cloneConfig = lines(cloneReal);
const sourceConfig = lines(sourceReal);
for (const [config, expected] of [
  [cloneConfig, [`server-port=${port}`, 'server-ip=127.0.0.1', 'level-name=progressive_world',
    'level-type=minecraft\\:normal', 'gamemode=survival', 'difficulty=normal']],
  [sourceConfig, [`server-port=${sourcePort}`, 'server-ip=127.0.0.1', 'level-name=progressive_world',
    'level-type=minecraft\\:normal']],
] as const) {
  for (const value of expected) if (!config.has(value)) throw new Error(`SMELT_PROBE_WORLD_CONFIGURATION_INVALID:${value}`);
}
const operators = JSON.parse(fs.readFileSync(path.join(cloneReal, 'ops.json'), 'utf8')) as Array<{ name?: string }>;
if (!operators.some(operator => operator.name === 'ShannonProbe')
  || operators.some(operator => operator.name === 'MinebotTrial')) {
  throw new Error('SMELT_PROBE_OPERATOR_ROLE_INVALID');
}

const fixture = { x: -330, y: 120, z: -100 } as const;
const blockPos = new Vec3(fixture.x, fixture.y, fixture.z);
const startedAt = new Date().toISOString();
const report: Record<string, unknown> = {
  startedAt, sourceDirectory: sourceReal, cloneDirectory: cloneReal, port,
  diagnosticOnly: true, operatorFixtureSupplied: true,
  excludedFromAutonomousDragonCampaignAcceptance: true,
  fixture: { ...fixture, rawIron: 3, sprucePlanks: 2 },
};
const operator = await createProbeBot(port);
const actor = await createProbeBot(port, 'MinebotTrial');
const control = new MinecraftCommandOracle(operator);
const actorOracle = new MinecraftCommandOracle({
  version: actor.version,
  chat: command => operator.chat(`/execute as @a[name=MinebotTrial,limit=1] at @s run ${command.replace(/^\//, '')}`),
  on: (_event, listener) => actor.on('message', listener as any),
  removeListener: (_event, listener) => actor.removeListener('message', listener as any),
});
const itemCount = (name: string) => actor.inventory.items()
  .filter(item => item.name === name).reduce((sum, item) => sum + item.count, 0);
const inventory = () => actor.inventory.items().map(item => ({ name: item.name, count: item.count }));
const compact = (result: any) => ({ success: result.success, result: result.result,
  failureType: result.failureType ?? null, durationMs: result.duration ?? null,
  phaseMs: result.execution?.phaseMs ?? null });

try {
  await control.verifyReady();
  // All setup mutations are confined to the disposable clone. The actor does
  // not receive operator permissions, and no fixture item is acceptance proof.
  for (const command of [
    'gamemode spectator ShannonProbe',
    'tp ShannonProbe -500 150 -500',
    'deop MinebotTrial',
    'gamemode survival MinebotTrial',
    'gamerule spawn_mobs false',
    'time set day',
    `fill ${fixture.x - 3} ${fixture.y - 1} ${fixture.z - 3} ${fixture.x + 3} ${fixture.y - 1} ${fixture.z + 3} stone`,
    `fill ${fixture.x - 3} ${fixture.y} ${fixture.z - 3} ${fixture.x + 3} ${fixture.y + 4} ${fixture.z + 3} air`,
    `setblock ${fixture.x} ${fixture.y} ${fixture.z} furnace`,
    `tp MinebotTrial ${fixture.x + 1.5} ${fixture.y} ${fixture.z + 0.5}`,
    'clear MinebotTrial',
    'give MinebotTrial raw_iron 3',
    'give MinebotTrial spruce_planks 2',
  ]) await control.executeSetupCommand(command);

  const setupProof = await actorOracle.evaluateAll([
    { type: 'gamemode', gamemode: 'survival' },
    { type: 'block_at', ...fixture, block: 'furnace' },
    { type: 'inventory_count', item: 'raw_iron', minCount: 3, maxCount: 3 },
    { type: 'inventory_count', item: 'spruce_planks', minCount: 2, maxCount: 2 },
    { type: 'inventory_count', item: 'iron_ingot', minCount: 0, maxCount: 0 },
  ]);
  report.setupProof = setupProof;
  if (setupProof.some(proof => !proof.passed)) throw new Error('SMELT_PROBE_SETUP_NOT_PROVEN');
  const inventoryDeadline = Date.now() + 5000;
  while ((itemCount('raw_iron') !== 3 || itemCount('spruce_planks') !== 2) && Date.now() < inventoryDeadline) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (itemCount('raw_iron') !== 3 || itemCount('spruce_planks') !== 2) {
    throw new Error('SMELT_PROBE_ACTOR_INVENTORY_NOT_SYNCED');
  }
  report.before = inventory();

  const startSkill = actor.instantSkills.getSkill('start-smelting');
  const withdrawSkill = actor.instantSkills.getSkill('withdraw-from-furnace');
  if (!startSkill || !withdrawSkill) throw new Error('SMELT_PROBE_SKILLS_MISSING');
  const startTime = Date.now();
  const start = await startSkill.run(fixture.x, fixture.y, fixture.z, 'raw_iron', 'spruce_planks', 3);
  report.start = { ...compact(start), elapsedMs: Date.now() - startTime };
  if (!start.success) throw new Error(`SMELT_PROBE_START_FAILED:${start.result}`);

  // Reproduce the paid trial's critical state: one ingot is ready while raw
  // material remains. Inspect without taking any item from the furnace.
  const furnaceBlock = actor.blockAt(blockPos);
  if (!furnaceBlock || furnaceBlock.name !== 'furnace') throw new Error('SMELT_PROBE_FURNACE_MISSING');
  const furnace = await actor.openFurnace(furnaceBlock);
  let partialReady = false;
  try {
    partialReady = await waitForObservation(actor, () =>
      (furnace.outputItem()?.count ?? 0) >= 1 && (furnace.inputItem()?.count ?? 0) >= 1,
    18000, [{ source: furnace, event: 'update' }]);
    report.partial = {
      ready: partialReady,
      input: furnace.inputItem() && { name: furnace.inputItem()!.name, count: furnace.inputItem()!.count },
      fuel: furnace.fuelItem() && { name: furnace.fuelItem()!.name, count: furnace.fuelItem()!.count },
      output: furnace.outputItem() && { name: furnace.outputItem()!.name, count: furnace.outputItem()!.count },
    };
  } finally {
    furnace.close();
  }
  if (!partialReady) throw new Error('SMELT_PROBE_PARTIAL_OUTPUT_NOT_OBSERVED');
  await new Promise(resolve => setTimeout(resolve, 250));

  const withdrawTime = Date.now();
  const withdrawn = await withdrawSkill.run(fixture.x, fixture.y, fixture.z, 'all', true);
  report.withdraw = { ...compact(withdrawn), elapsedMs: Date.now() - withdrawTime };
  const finalProof = await actorOracle.evaluateAll([
    { type: 'inventory_count', item: 'iron_ingot', minCount: 3, maxCount: 3 },
    { type: 'inventory_count', item: 'raw_iron', minCount: 0, maxCount: 0 },
  ]);
  report.finalProof = finalProof;
  report.after = inventory();
  report.passed = withdrawn.success && finalProof.every(proof => proof.passed);
  console.log(`SMELT_WITHDRAWAL_PROBE_RESULT ${JSON.stringify({
    diagnosticOnly: true, passed: report.passed, partial: report.partial,
    start: report.start, withdraw: report.withdraw, finalProof, after: report.after,
  })}`);
  if (!report.passed) process.exitCode = 1;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
  console.error(`SMELT_WITHDRAWAL_PROBE_ERROR ${report.error}`);
} finally {
  const output = path.resolve('saves/minecraft/progressive_reports',
    `${new Date().toISOString().replace(/[:.]/g, '-')}-smelting-withdrawal.json`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(`SMELT_WITHDRAWAL_PROBE_REPORT ${output}`);
  closeProbeBot(actor);
  closeProbeBot(operator);
}
