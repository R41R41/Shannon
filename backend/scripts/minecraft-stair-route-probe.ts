#!/usr/bin/env node
// Physical regression for stair-mine against a stopped campaign-world clone.
// The operator only observes. This is diagnostic and never campaign proof.
import fs from 'node:fs';
import path from 'node:path';
import { createProbeBot, closeProbeBot } from '../src/services/minebot/testing/MinecraftProbeBot.js';
import { MinecraftCommandOracle } from '../src/services/minebot/testing/MinecraftCommandOracle.js';

const port = Number(process.env.MINECRAFT_STAIR_PORT ?? 25583);
const directory = process.env.MINECRAFT_STAIR_WORLD_DIRECTORY ?? '';
const direction = process.env.MINECRAFT_STAIR_DIRECTION ?? 'north';
if (!/^\/home\/azureuser\/minecraft\/progressive-lab-[A-Za-z0-9]+$/.test(directory)
  || !Number.isInteger(port) || port < 25577 || port > 25650
  || !['north', 'south', 'east', 'west'].includes(direction)) throw new Error('STAIR_ISOLATED_INPUT_REQUIRED');
const properties = fs.readFileSync(path.join(directory, 'server.properties'), 'utf8').replace(/\\([:=])/g, '$1');
for (const line of ['server-ip=127.0.0.1', `server-port=${port}`, 'level-type=minecraft:normal',
  'difficulty=normal', 'gamemode=survival']) {
  if (!properties.split('\n').includes(line)) throw new Error(`STAIR_WORLD_CONFIGURATION_INVALID:${line}`);
}
const operator = await createProbeBot(port);
const actor = await createProbeBot(port, 'MinebotTrial');
const control = new MinecraftCommandOracle(operator);
const oracle = new MinecraftCommandOracle({ version: actor.version,
  chat: command => operator.chat(`/execute as @a[name=MinebotTrial,limit=1] at @s run ${command.replace(/^\//, '')}`),
  on: (_event, listener) => actor.on('message', listener as any),
  removeListener: (_event, listener) => actor.removeListener('message', listener as any),
});
const report: any = { startedAt: new Date().toISOString(), worldDirectory: directory, port, direction,
  initial: actor.entity.position.clone(), initialInventory: actor.inventory.items().map(item => ({ name: item.name, count: item.count })),
  steps: [] };
let deaths = 0;
actor.on('death', () => { deaths++; });
try {
  await control.verifyReady();
  const skill = actor.instantSkills.getSkill('stair-mine');
  if (!skill) throw new Error('STAIR_SKILL_MISSING');
  const initialY = Math.floor(actor.entity.position.y);
  for (const targetY of [initialY + 1, 63]) {
    if (targetY <= Math.floor(actor.entity.position.y)) continue;
    const started = Date.now();
    const result = await skill.run(targetY, direction, 'cobblestone');
    // The server can publish the new player position a little after Mineflayer
    // observes it. Wait for that independent snapshot before judging a step.
    await new Promise(resolve => setTimeout(resolve, 2500));
    const final = actor.entity.position.clone();
    const nativePosition = await oracle.evaluate({ type: 'position_within', x: final.x, y: targetY,
      z: final.z, radius: 1.25 });
    const nativeHeight = await oracle.evaluate({ type: 'position_y_between', min: targetY - 0.1,
      max: targetY + 0.1 });
    const afterOracle = actor.entity.position.clone();
    const nativeY: Array<{ y: number; passed: boolean }> = [];
    for (const y of [targetY - 2, targetY - 1, targetY, targetY + 1]) nativeY.push({
      y, passed: (await oracle.evaluate({ type: 'position_y_between', min: y - 0.1,
        max: y + 0.1 })).passed,
    });
    report.steps.push({ targetY, durationMs: Date.now() - started, result, final, afterOracle,
      nativePosition, nativeHeight, nativeY });
    console.log(`STAIR_ROUTE_STEP ${JSON.stringify({ targetY, success: result.success,
      failureType: result.failureType ?? null, result: result.result, final, afterOracle,
      nativePosition: nativePosition.passed, nativeHeight: nativeHeight.passed,
      nativeY: nativeY.filter(check => check.passed).map(check => check.y), deaths })}`);
    if (!result.success || !nativeHeight.passed || deaths) break;
  }
  report.deaths = deaths;
} catch (error) {
  report.error = String(error);
  process.exitCode = 1;
  console.error(`STAIR_ROUTE_ERROR ${String(error)}`);
} finally {
  const output = path.resolve('saves/minecraft/progressive_reports',
    `${new Date().toISOString().replace(/[:.]/g, '-')}-stair-route-diagnostic.json`);
  fs.writeFileSync(output, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(`STAIR_ROUTE_REPORT ${output}`);
  closeProbeBot(actor);
  closeProbeBot(operator);
}
