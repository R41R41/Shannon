#!/usr/bin/env node
// Physical, model-free diagnosis in a disposable clone of a stopped campaign.
// It never changes the source campaign or grants the actor items.
import fs from 'node:fs';
import path from 'node:path';
import minecraftData from 'minecraft-data';
import { Vec3 } from 'vec3';
import { createProbeBot, closeProbeBot } from '../src/services/minebot/testing/MinecraftProbeBot.js';
import { MinecraftCommandOracle } from '../src/services/minebot/testing/MinecraftCommandOracle.js';

const port = Number(process.env.MINECRAFT_WORKBENCH_PORT);
const directory = process.env.MINECRAFT_WORKBENCH_WORLD_DIRECTORY ?? '';
if (process.env.MINECRAFT_WORKBENCH_PROBE !== 'true'
  || !Number.isInteger(port) || port < 25577 || port > 25650
  || !/^\/home\/azureuser\/minecraft\/progressive-lab-[A-Za-z0-9]+$/.test(directory)) {
  throw new Error('WORKBENCH_PROBE_ISOLATED_CLONE_REQUIRED');
}
const properties = fs.readFileSync(path.join(directory, 'server.properties'), 'utf8');
for (const line of [`server-port=${port}`, 'server-ip=127.0.0.1', 'gamemode=survival']) {
  if (!properties.split('\n').includes(line)) throw new Error(`WORKBENCH_WORLD_CONFIGURATION_INVALID:${line}`);
}

const operator = await createProbeBot(port);
const actor = await createProbeBot(port, 'MinebotTrial');
const control = new MinecraftCommandOracle(operator);
const actorOracle = new MinecraftCommandOracle({ version: actor.version,
  chat: command => operator.chat(`/execute as @a[name=MinebotTrial,limit=1] at @s run ${command.replace(/^\//, '')}`),
  on: (_event, listener) => actor.on('message', listener as any),
  removeListener: (_event, listener) => actor.removeListener('message', listener as any),
});
const inventory = () => actor.inventory.items().map(item => ({ name: item.name, count: item.count }));
const compactSkillResult = (result: any) => ({
  success: result.success, result: result.result, failureType: result.failureType,
});
try {
  await control.verifyReady();
  await control.executeSetupCommand('gamemode spectator ShannonProbe');
  await control.executeSetupCommand('tp ShannonProbe -500 150 -500');
  if (process.env.MINECRAFT_WORKBENCH_INSPECT_ONLY === 'true') {
    const symbols: Record<string, string> = {
      air: '.', cave_air: '.', stone: '#', dirt: 'd', grass_block: 'g',
      furnace: 'F', crafting_table: 'T', cobblestone: 'c',
      spruce_log: 'L', spruce_leaves: 'l', large_fern: 'f',
    };
    const layers = [];
    for (let y = 59; y <= 66; y++) {
      const rows = [];
      for (let z = -117; z <= -111; z++) {
        let row = '';
        for (let x = -346; x <= -340; x++) {
          const name = actor.blockAt(new Vec3(x, y, z))?.name ?? 'unloaded';
          row += symbols[name] ?? '?';
        }
        rows.push(row);
      }
      layers.push({ y, rows });
    }
    console.log(`WORKBENCH_BLOCK_SNAPSHOT ${JSON.stringify({ position: actor.entity.position,
      xColumns: [-346, -345, -344, -343, -342, -341, -340],
      zRows: [-117, -116, -115, -114, -113, -112, -111], layers, symbols })}`);
  } else {
  const before = inventory();
  const count = (name: string) => before.filter(item => item.name === name)
    .reduce((total, item) => total + item.count, 0);
  if (count('iron_ingot') < 3 || count('stick') < 2 || count('iron_pickaxe') > 0) {
    throw new Error(`WORKBENCH_START_INVENTORY_INVALID:${JSON.stringify(before)}`);
  }
  const tableId = minecraftData(actor.version).blocksByName.crafting_table.id;
  const table = actor.findBlock({ matching: tableId, maxDistance: 32 });
  if (process.env.MINECRAFT_WORKBENCH_MOVE_ONLY === 'true') {
    const digSkill = actor.instantSkills.getSkill('dig-block-at');
    const moveSkill = actor.instantSkills.getSkill('move-to');
    if (!digSkill || !moveSkill) throw new Error('WORKBENCH_MOVEMENT_SKILLS_MISSING');
    const serverStoneBefore = await actorOracle.evaluate({ type: 'block_at',
      x: -343, y: 60, z: -114, block: 'stone' });
    const dug = await digSkill.run(-343, 60, -114, false);
    const serverAir = await actorOracle.evaluate({ type: 'block_at', x: -343, y: 60, z: -114, block: 'air' });
    const serverStoneAfter = await actorOracle.evaluate({ type: 'block_at',
      x: -343, y: 60, z: -114, block: 'stone' });
    const serverCaveAir = await actorOracle.evaluate({ type: 'block_at',
      x: -343, y: 60, z: -114, block: 'cave_air' });
    const moved = await moveSkill.run(-342.5, 60, -113.5, 0.5, 'near');
    await new Promise(resolve => setTimeout(resolve, 600));
    const serverPosition = await actorOracle.evaluate({ type: 'position_within',
      x: -342.5, y: 60, z: -113.5, radius: 0.5 });
    const serverOriginalPosition = await actorOracle.evaluate({ type: 'position_within',
      x: -342.5, y: 60, z: -114.5, radius: 0.5 });
    console.log(`WORKBENCH_MOVEMENT_PROBE_RESULT ${JSON.stringify({
      dug: compactSkillResult(dug), moved: compactSkillResult(moved), serverStoneBefore,
      serverAir, serverStoneAfter, serverCaveAir, serverPosition, serverOriginalPosition,
      localPosition: actor.entity.position, localVelocity: actor.entity.velocity,
    })}`);
    if (!dug.success || !moved.success || !serverAir.passed || !serverPosition.passed) process.exitCode = 1;
  } else {
  const skill = actor.instantSkills.getSkill('craft-one');
  if (!skill) throw new Error('CRAFT_SKILL_MISSING');
  const started = Date.now();
  const result = await skill.run('iron_pickaxe', 1);
  const proof = await actorOracle.evaluate({ type: 'inventory_count', item: 'iron_pickaxe', minCount: 1 });
  const compactResult = {
    success: result.success,
    result: result.result,
    failureType: result.failureType,
    error: result.error,
  };
  const finalFeet = actor.entity.position.floored();
  const finalColumn = [-1, 0, 1, 2, 3].map(dy => ({
    y: finalFeet.y + dy,
    block: actor.blockAt(finalFeet.offset(0, dy, 0))?.name ?? 'unloaded',
  }));
  console.log(`WORKBENCH_PROBE_RESULT ${JSON.stringify({ durationMs: Date.now() - started,
    before, table: table?.position ?? null, result: compactResult, after: inventory(),
    finalPosition: actor.entity.position, finalVelocity: actor.entity.velocity,
    finalColumn, nativeProof: proof.passed })}`);
  if (!result.success || !proof.passed) process.exitCode = 1;
  }
  }
} finally {
  closeProbeBot(actor);
  closeProbeBot(operator);
}
