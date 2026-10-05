#!/usr/bin/env node
// Model-free measurement of what movement costs in hunger on the isolated lab
// server: the same distance walked, sprinted and sprint-jumped along a flat
// strip, reading food and saturation before and after. No planner, no LLM.
import fs from 'node:fs';
import path from 'node:path';
import { createProbeBot, closeProbeBot } from '../src/services/minebot/testing/MinecraftProbeBot.js';
import { MinecraftCommandOracle } from '../src/services/minebot/testing/MinecraftCommandOracle.js';

const port = Number(process.env.MINECRAFT_OUTAGE_PORT);
const worldDirectory = process.env.MINECRAFT_OUTAGE_WORLD_DIRECTORY ?? '';
if (process.env.MINECRAFT_OUTAGE_NO_LLM !== 'true' || !Number.isInteger(port) || port < 25577 || port > 25650
  || !/^\/home\/azureuser\/minecraft\/progressive-lab-[A-Za-z0-9]+$/.test(worldDirectory)) throw new Error('ISOLATED_EXERTION_WORLD_REQUIRED');
const properties = fs.readFileSync(path.join(worldDirectory, 'server.properties'), 'utf8').split('\n');
if (!properties.includes('server-ip=127.0.0.1') || !properties.includes(`server-port=${port}`)) throw new Error('ISOLATED_EXERTION_WORLD_CONFIGURATION_INVALID');

const LENGTH = 60;
const LAPS = Number(process.env.MINECRAFT_EXERTION_LAPS ?? 6);
const MODES = (process.env.MINECRAFT_EXERTION_MODES ?? 'walk,sprint,sprint-jump').split(',').filter(Boolean);
const operator = await createProbeBot(port);
const actor = await createProbeBot(port, 'MinebotTrial');
const oracle = new MinecraftCommandOracle(operator);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const results: any[] = [];
try {
  await oracle.verifyReady();
  for (const command of ['difficulty peaceful', 'gamerule spawn_mobs false', 'time set noon', 'gamemode spectator ShannonProbe',
    'kill @e[type=!minecraft:player]', 'clear MinebotTrial', 'effect clear MinebotTrial', 'gamemode survival MinebotTrial', 'difficulty normal'])
    await oracle.executeSetupCommand(command);
  const origin = actor.entity.position.floored();
  const y = origin.y + 40, x0 = origin.x, z = origin.z;
  await oracle.executeSetupCommand(`fill ${x0 - 2} ${y - 1} ${z - 1} ${x0 + LENGTH + 2} ${y - 1} ${z + 1} stone`);
  await oracle.executeSetupCommand(`fill ${x0 - 2} ${y} ${z - 1} ${x0 + LENGTH + 2} ${y + 2} ${z + 1} air`);
  for (const mode of MODES) {
    await oracle.executeSetupCommand(`tp MinebotTrial ${x0 + 0.5} ${y} ${z + 0.5}`);
    // Full hunger bar with no saturation, so every exhaustion point shows in the food level.
    await oracle.executeSetupCommand('effect give MinebotTrial minecraft:saturation 1 20 true');
    await sleep(1500);
    await oracle.executeSetupCommand('effect give MinebotTrial minecraft:hunger 4 255 true');
    await sleep(5000);
    await oracle.executeSetupCommand('effect clear MinebotTrial');
    await sleep(1000);
    const before = { food: actor.food, saturation: actor.foodSaturation };
    let travelled = 0;
    let last = actor.entity.position.clone();
    const meter = setInterval(() => { const p = actor.entity.position; travelled += Math.hypot(p.x - last.x, p.z - last.z); last = p.clone(); }, 50);
    const startedAt = Date.now();
    for (let lap = 0; lap < LAPS; lap++) {
      const target = lap % 2 === 0 ? x0 + LENGTH - 0.5 : x0 + 0.5;
      await actor.lookAt(actor.entity.position.offset(target > actor.entity.position.x ? 20 : -20, 1.62, 0), true);
      actor.setControlState('forward', true);
      actor.setControlState('sprint', mode !== 'walk');
      actor.setControlState('jump', mode === 'sprint-jump');
      const deadline = Date.now() + 40_000;
      while (Date.now() < deadline && Math.abs(actor.entity.position.x - target) > 1) await sleep(50);
      actor.clearControlStates();
      await sleep(300);
    }
    clearInterval(meter);
    const after = { food: actor.food, saturation: actor.foodSaturation };
    results.push({ mode, metres: Math.round(travelled), seconds: Math.round((Date.now() - startedAt) / 100) / 10, before, after,
      foodSpent: before.food - after.food, saturationSpent: Math.round((before.saturation - after.saturation) * 10) / 10 });
  }
  // The real move-to under each pace: the planner's set-movement-pace must reach the pathfinder.
  const moveTo = actor.instantSkills.getSkill('move-to')!;
  const pace = actor.instantSkills.getSkill('set-movement-pace')!;
  for (const chosen of ['walk', 'sprint'] as const) {
    await oracle.executeSetupCommand(`tp MinebotTrial ${x0 + 0.5} ${y} ${z + 0.5}`);
    await oracle.executeSetupCommand('effect give MinebotTrial minecraft:saturation 1 20 true');
    await sleep(1500);
    await oracle.executeSetupCommand('effect give MinebotTrial minecraft:hunger 4 255 true');
    await sleep(5000);
    await oracle.executeSetupCommand('effect clear MinebotTrial');
    await sleep(1000);
    await pace.run(chosen);
    const before = { food: actor.food, exertion: { ...(actor as any).exertion } };
    const startedAt = Date.now();
    const there: any = await moveTo.run(x0 + LENGTH - 0.5, y, z + 0.5, 1, 'near');
    const back: any = await moveTo.run(x0 + 0.5, y, z + 0.5, 1, 'near');
    const after = (actor as any).exertion;
    results.push({ mode: `move-to pace=${chosen}`, ok: there?.success === true && back?.success === true,
      seconds: Math.round((Date.now() - startedAt) / 100) / 10, foodSpent: before.food - actor.food,
      walked: Math.round(after.walkedMetres - before.exertion.walkedMetres), sprinted: Math.round(after.sprintedMetres - before.exertion.sprintedMetres),
      jumps: after.jumps - before.exertion.jumps });
  }
} finally {
  closeProbeBot(actor); closeProbeBot(operator);
  console.log(`EXERTION_RESULT ${JSON.stringify(results)}`);
}
