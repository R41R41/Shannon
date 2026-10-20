#!/usr/bin/env node
// Model-free run of the way from iron to the Nether in natural terrain, with the real skills run as common FCA runs them (each inside
// an action of its own name, waitForQuiescence): stair-mine to the diamond band, mine diamonds, craft the diamond pickaxe, find lava,
// make ten obsidian with a water bucket and mine it, gravel to flint, flint and steel, build the portal, light it, go in. What is
// timed is each stage, against the owner's marks (2026-10-20: diamond pickaxe by 1,200 s, obsidian 1,500 s, gate 1,650 s, Nether
// 1,800 s of a whole run; these are the tools' own share of it, with no planner between them). The kit of a body that has its iron
// (pickaxes, ingots, a bucket of water, sticks, a table, food) is a fixture grant: never a zero-start acceptance.
import fs from 'node:fs';
import path from 'node:path';
import { Vec3 } from 'vec3';
import { createProbeBot, closeProbeBot } from '../src/services/minebot/testing/MinecraftProbeBot.js';
import { MinecraftCommandOracle } from '../src/services/minebot/testing/MinecraftCommandOracle.js';
import { executeAction } from '../src/services/minebot/execution/ActionExecution.js';
import { dropBurnsIn } from '../src/services/minebot/utils/dropFate.js';

const port = Number(process.env.MINECRAFT_LADDER_PORT);
const worldDirectory = process.env.MINECRAFT_LADDER_WORLD_DIRECTORY ?? '';
const targetY = Number(process.env.MINECRAFT_LADDER_TARGET_Y ?? -58);
const peaceful = process.env.MINECRAFT_LADDER_PEACEFUL !== 'false';
const asFca = process.env.MINECRAFT_LADDER_FCA !== 'false';
if (process.env.MINECRAFT_LADDER_NO_LLM !== 'true' || !/^\/home\/azureuser\/minecraft\/progressive-lab-[A-Za-z0-9]+$/.test(worldDirectory))
  throw new Error('ISOLATED_LADDER_WORLD_REQUIRED');
const properties = fs.readFileSync(path.join(worldDirectory, 'server.properties'), 'utf8').split('\n');
if (!properties.includes('server-ip=127.0.0.1') || !properties.includes(`server-port=${port}`)
  || !properties.includes('level-type=minecraft\\:normal')) throw new Error('ISOLATED_LADDER_WORLD_CONFIGURATION_INVALID');

const operator = await createProbeBot(port);
const actor = await createProbeBot(port, 'MinebotTrial');
const control = new MinecraftCommandOracle(operator);
const startedAt = Date.now();
const seconds = () => Math.round((Date.now() - startedAt) / 1000);
const steps: any[] = [];
const stages: Record<string, { atSeconds: number | null; ok: boolean; note?: string }> = {};
let deaths = 0;
actor.on('death', () => { deaths++; console.log(`LADDER_DEATH ${JSON.stringify({ at: seconds(), position: actor.entity?.position })}`); });
const count = (name: string | RegExp) => actor.inventory.items().filter(item => typeof name === 'string' ? item.name === name : name.test(item.name))
  .reduce((sum, item) => sum + item.count, 0);
const mark = (stage: string, ok: boolean, note?: string) => {
  stages[stage] = { atSeconds: ok ? seconds() : null, ok, ...(note ? { note } : {}) };
  console.log(`LADDER_STAGE ${JSON.stringify({ stage, ok, at: seconds(), note })}`);
};

async function step(name: string, args: unknown[], maxMs: number) {
  const skill = actor.instantSkills.getSkill(name);
  if (!skill) throw new Error(`SKILL_MISSING:${name}`);
  const start = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<any>(resolve => { timer = setTimeout(() => {
    actor.interruptExecution = true; actor.pathfinder?.stop();
    resolve({ success: false, result: `diagnostic timeout ${maxMs}ms`, failureType: 'timeout' });
  }, maxMs); });
  let result: any;
  const run = () => skill.run(...args);
  try { result = await Promise.race([asFca ? executeAction(actor, name, maxMs, run, { waitForQuiescence: true }) : run(), timeout]); }
  catch (error) { result = { success: false, result: String(error), failureType: 'exception' }; }
  clearTimeout(timer);
  actor.interruptExecution = false;
  await new Promise(resolve => setTimeout(resolve, 400));
  const entry = { at: seconds(), name, args, durationMs: Date.now() - start, success: result?.success ?? false,
    result: String(result?.result ?? '').slice(0, 900), failureType: result?.failureType,
    position: actor.entity?.position && { x: Math.round(actor.entity.position.x * 10) / 10, y: Math.round(actor.entity.position.y * 10) / 10, z: Math.round(actor.entity.position.z * 10) / 10 },
    dimension: String(actor.game?.dimension ?? ''), health: actor.health,
    inventory: Object.fromEntries(actor.inventory.items().map(item => [item.name, item.count])) };
  steps.push(entry);
  console.log(`LADDER_STEP ${JSON.stringify({ at: entry.at, name, args, durationMs: entry.durationMs, success: entry.success, failureType: entry.failureType,
    y: entry.position?.y, health: entry.health, result: entry.result.slice(0, 260) })}`);
  return entry;
}
const nearest = (test: (block: any) => boolean, maxDistance: number, n = 64) => actor.findBlocks({ matching: test, maxDistance, count: n })
  .sort((a: Vec3, b: Vec3) => a.distanceTo(actor.entity.position) - b.distanceTo(actor.entity.position));

let report: any;
try {
  await control.verifyReady();
  const kit = ['iron_pickaxe 2', 'iron_ingot 3', 'bucket 1', 'water_bucket 1', 'stick 8', 'crafting_table 1', 'cobblestone 64', 'cobblestone 64',
    'cooked_beef 16', 'iron_helmet 1', 'iron_chestplate 1', 'iron_leggings 1', 'iron_boots 1', 'iron_sword 1',
    // A body this far has its bed (the milestones put it before the iron); without one the night gate keeps it above y 16 after dusk.
    'white_bed 1'];
  for (const command of [...(peaceful ? ['difficulty peaceful'] : []), 'time set day', 'gamemode spectator ShannonProbe',
    'clear MinebotTrial', 'effect clear MinebotTrial', 'gamemode survival MinebotTrial', ...kit.map(item => `give MinebotTrial ${item}`)])
    await control.executeSetupCommand(command);
  await new Promise(resolve => setTimeout(resolve, 1500));
  // World spawn can be on a tree canopy; start from the terrain surface below.
  const start = actor.entity.position.floored();
  let ground = start.y - 1;
  while (ground > -60 && /^(air|.*_leaves|.*_log|short_grass|tall_grass|snow|fern|large_fern)$/.test(actor.blockAt(start.offset(0, ground - start.y, 0))?.name ?? 'air')) ground--;
  await control.executeSetupCommand(`fill ${start.x} ${ground + 1} ${start.z} ${start.x} ${start.y + 2} ${start.z} air`);
  await control.executeSetupCommand(`tp MinebotTrial ${start.x + 0.5} ${ground + 1} ${start.z + 0.5}`);
  await new Promise(resolve => setTimeout(resolve, 1500));

  // ── 1. Down to the diamond band ──
  const directions = ['east', 'south', 'west', 'north'];
  for (let attempt = 0; attempt < 12 && actor.entity.position.y > targetY + 4; attempt++)
    await step('stair-mine', [targetY, directions[attempt % 4], 'cobblestone'], 600_000);
  mark('descent', actor.entity.position.y <= targetY + 4, `y=${Math.round(actor.entity.position.y)}`);

  // ── 2. Diamonds (three), mine-block over the loaded chunks, a branch of 24 blocks between tries ──
  for (let leg = 0; leg < 8 && count('diamond') < 3; leg++) {
    await step('mine-block', ['diamond_ore,deepslate_diamond_ore', 3 - count('diamond'), 48, 'target'], 300_000);
    if (count('diamond') >= 3) break;
    const here = actor.entity.position.floored();
    const offset = [[24, 0], [0, 24], [-24, 0], [0, -24]][leg % 4];
    await step('move-to', [here.x + offset[0], here.y, here.z + offset[1], 2, 'near'], 180_000);
  }
  mark('diamonds', count('diamond') >= 3, `diamond=${count('diamond')}`);
  if (count('diamond') >= 3) await step('craft-one', ['diamond_pickaxe', 1], 60_000);
  mark('diamond_pickaxe', count('diamond_pickaxe') >= 1);
  // Dry ground to build the gate on later, away from the pool and the water poured on it (a planner chooses such a place too).
  const dryPos = actor.entity.position.floored();

  // ── 3. Obsidian: the nearest lava, water poured on it, the obsidian mined (the owner's way) ──
  if (count('diamond_pickaxe') >= 1) {
    await step('find-blocks', ['lava', 48, 5], 60_000);
    // A pool poured on twice for nothing is left for another one, as a planner would after two refusals.
    const refused: Vec3[] = [];
    let lavaSearches = 0;
    for (let attempt = 0; attempt < 24 && count('obsidian') < 10; attempt++) {
      // Only what can be taken straight away counts (obsidian over the rest of the pool burns its drop), as the pour's result says.
      const obsidianNear = nearest(block => block?.name === 'obsidian', 16).filter((at: Vec3) => !dropBurnsIn(actor as any, at)).length;
      if (count('obsidian') + obsidianNear < 10 && count('water_bucket') > 0) {
        // A lava source with air over it (the top of a pool), nearest first.
        // (findBlocks' matcher sees a block without its place: the place is judged from the positions it returns.)
        const lava = nearest(block => block?.name === 'lava', 48, 256).find((at: Vec3) => actor.blockAt(at)?.metadata === 0
          && /air$/.test(actor.blockAt(at.offset(0, 1, 0))?.name ?? '') && refused.filter(r => r.distanceTo(at) <= 10).length < 2);
        // None: further down first (lava pools lie mostly at the bottom), then legs of 32 blocks, as a planner would; three tries at most.
        if (!lava && lavaSearches < 3) {
          lavaSearches++;
          if (actor.entity.position.y > targetY + 6) await step('stair-mine', [targetY, directions[lavaSearches % 4], 'cobblestone'], 300_000);
          else {
            const here = actor.entity.position.floored(), offset = [[32, 0], [0, 32], [-32, 0]][lavaSearches - 1] ?? [0, -32];
            await step('move-to', [here.x + offset[0], here.y, here.z + offset[1], 2, 'near'], 120_000);
          }
          continue;
        }
        if (!lava) { mark('lava', false, 'no lava source with air over it within 48 m'); break; }
        // Far below: a stair towards it first (the route planner gives up on twenty blocks of rock), then the walk.
        const here = actor.entity.position;
        if (here.y - lava.y > 5) {
          const dx = lava.x - here.x, dz = lava.z - here.z;
          await step('stair-mine', [lava.y + 1, Math.abs(dx) >= Math.abs(dz) ? (dx >= 0 ? 'east' : 'west') : (dz >= 0 ? 'south' : 'north'), 'cobblestone'], 180_000);
        }
        if (lava.distanceTo(actor.entity.position) > 4) await step('move-to', [lava.x, lava.y + 1, lava.z, 3, 'near'], 90_000);
        const poured = await step('use-item-on-block', [lava.x, lava.y, lava.z, 'water_bucket'], 30_000);
        if (!poured.success) refused.push(lava);
        // The water back into the bucket, from where it was poured (the skill says where).
        if (count('water_bucket') === 0 && count('bucket') > 0) {
          const water = nearest(block => block?.name === 'water', 6).find((at: Vec3) => actor.blockAt(at)?.metadata === 0);
          if (water) await step('use-item-on-block', [water.x, water.y, water.z, 'bucket'], 20_000);
        }
      } else {
        await step('mine-block', ['obsidian', 10 - count('obsidian'), 16, 'target'], 240_000);
      }
    }
  }
  mark('obsidian', count('obsidian') >= 10, `obsidian=${count('obsidian')}`);

  // ── 4. Flint: gravel mined (a tenth drops flint), then flint and steel ──
  for (let attempt = 0; attempt < 4 && count('flint') < 1; attempt++) await step('mine-block', ['gravel', 10, 48, 'target'], 180_000);
  mark('flint', count('flint') >= 1, `flint=${count('flint')} gravel=${count('gravel')}`);
  if (count('flint') >= 1) await step('craft-one', ['flint_and_steel', 1], 60_000);
  mark('flint_and_steel', count('flint_and_steel') >= 1);

  // ── 5. The gate: built beside the body, lit, gone through ──
  if (count('obsidian') >= 10 && count('flint_and_steel') >= 1) {
    if (actor.entity.position.distanceTo(dryPos) > 3) await step('move-to', [dryPos.x, dryPos.y, dryPos.z, 1, 'near'], 90_000);
    const here = actor.entity.position.floored();
    const built = await step('build-structure', ['nether_portal', here.x + 2, here.y, here.z, 'south'], 240_000);
    const inside = nearest(block => block?.name === 'nether_portal', 12)[0];
    mark('portal', !!inside, inside ? `at ${inside}` : String(built.result).slice(0, 160));
    if (inside) {
      await step('enter-portal', [inside.x, inside.y, inside.z], 60_000);
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  } else mark('portal', false, 'no obsidian or no flint and steel');
  mark('nether', String(actor.game?.dimension ?? '').includes('nether'));
  report = { passed: stages.nether?.ok === true && deaths === 0, diagnosisOnly: true, asFca, peaceful, targetY,
    fixtureGrants: [...(peaceful ? ['difficulty peaceful'] : []), ...kit], durationMs: Date.now() - startedAt, deaths, stages, steps };
} catch (error) {
  report = { passed: false, diagnosisOnly: true, error: String(error), durationMs: Date.now() - startedAt, deaths, stages, steps };
  process.exitCode = 1;
} finally {
  closeProbeBot(actor); closeProbeBot(operator);
  const file = path.resolve('saves/minecraft/progressive_reports', `${new Date().toISOString().replace(/[:.]/g, '-')}-nether-ladder.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(`LADDER_RESULT ${JSON.stringify({ passed: report.passed, durationMs: report.durationMs, deaths, error: report.error, stages })}`);
  console.log(`LADDER_REPORT ${file}`);
}
