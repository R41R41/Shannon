#!/usr/bin/env node
// Real terrain, non-OP planner, separate OP oracle. No main server/DB/Discord.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import dotenv from 'dotenv';
import { Vec3 } from 'vec3';
import { createProbeBot, closeProbeBot } from '../src/services/minebot/testing/MinecraftProbeBot.js';
import { MinecraftCommandOracle } from '../src/services/minebot/testing/MinecraftCommandOracle.js';
import { AutonomousScenarioRunner } from '../src/services/minebot/testing/AutonomousScenarioRunner.js';
import { AcceptanceBudget } from '../src/services/minebot/testing/AcceptanceBudget.js';
import { createOpenAIPlannerClient } from '../src/services/minebot/cognition/OpenAIPlannerClient.js';
import { skillToAnthropicTool } from '../src/services/llm/graph/ShannonExecutor.js';

const port = Number(process.env.MINECRAFT_PROBE_PORT ?? 25578);
const surveyOnly = process.env.MINECRAFT_NATURAL_SURVEY_ONLY === 'true';
const selected = (process.env.MINECRAFT_NATURAL_CASES ?? 'day-wood,day-craft,day-place').split(',');
if (!selected.length || new Set(selected).size !== selected.length || selected.some(id => !['day-wood', 'day-craft', 'day-place', 'day-uphill', 'night-combat', 'night-work'].includes(id))) throw new Error('NATURAL_CASE_SELECTION_INVALID');
const id = new Date().toISOString().replace(/[:.]/g, '-');
const directory = path.resolve('saves/minecraft/progressive_reports'); fs.mkdirSync(directory, { recursive: true });
const sourceFiles = ['scripts/minecraft-natural-acceptance-probe.ts', 'src/services/minebot/cognition/OpenAIPlannerClient.ts',
  'src/services/llm/graph/ShannonExecutor.ts', 'src/services/minebot/cognition/TaskWorkspace.ts', 'src/services/minebot/cognition/GoalVerifier.ts',
  'src/services/minebot/instantSkills/findBlocks.ts', 'src/services/minebot/instantSkills/mineBlock.ts',
  'src/services/minebot/instantSkills/digBlockAt.ts', 'src/services/minebot/instantSkills/moveTo.ts',
  'src/services/minebot/utils/blockInteractionReach.ts', 'src/services/minebot/testing/AcceptanceBudget.ts',
  'src/services/minebot/testing/AutonomousScenarioRunner.ts'];
const hashSources = () => Object.fromEntries(sourceFiles.map(file => [file, createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
const sourceHashes = hashSources();
const worldDirectory = process.env.MINECRAFT_NATURAL_WORLD_DIRECTORY;
if (!worldDirectory || !/^\/home\/azureuser\/minecraft\/progressive-lab-[A-Za-z0-9]+$/.test(worldDirectory)) throw new Error('EXPLICIT_ISOLATED_WORLD_REQUIRED');
// Java Properties rewrites resource locations with escaped colons after boot.
const properties = fs.readFileSync(path.join(worldDirectory, 'server.properties'), 'utf8').replace(/\\([:=])/g, '$1');
if (!properties.includes('level-type=minecraft:normal\n') || !properties.includes(`server-port=${port}\n`) || !properties.includes('server-ip=127.0.0.1\n')) throw new Error('NATURAL_WORLD_CONFIGURATION_UNVERIFIED');
const ops = JSON.parse(fs.readFileSync(path.join(worldDirectory, 'ops.json'), 'utf8'));
if (ops.some((op: any) => op.name === 'MinebotTrial')) throw new Error('PLANNER_MUST_BE_NON_OP');
const siteFile = path.join(worldDirectory, 'acceptance-site.json');
const rememberedSite = fs.existsSync(siteFile) ? JSON.parse(fs.readFileSync(siteFile, 'utf8')) : null;
const operator = await createProbeBot(port);
const actor = await createProbeBot(port, 'MinebotTrial');
let died = 0, minHealth = 20;
actor.on('death', () => { died++; }); actor.on('health', () => { minHealth = Math.min(minHealth, actor.health); });
const control = new MinecraftCommandOracle(operator);
const oracle = new MinecraftCommandOracle({ version: actor.version,
  chat: message => operator.chat(`/execute as @a[name=MinebotTrial,limit=1] at @s run ${message.replace(/^\//, '')}`),
  on: (_event, listener) => actor.on('message', listener as any),
  removeListener: (_event, listener) => actor.removeListener('message', listener as any),
});
const reports: any[] = [], requests: any[] = [];
let site: any = null;
try {
  await control.verifyReady();
  await control.executeSetupCommand('/gamemode spectator @s');
  // executeSetupCommand intentionally allowlists only gameplay setup; OP control
  // remains with the explicit operator, never a planner tool.
  await control.executeSetupCommand('/deop MinebotTrial');
  await actor.waitForChunksToLoad();
  const origin = rememberedSite ? new Vec3(rememberedSite.origin.x, rememberedSite.origin.y, rememberedSite.origin.z) : actor.entity.position.floored();
  const groundNames = new Set(['grass_block', 'dirt', 'stone', 'sand', 'gravel']);
  const surfaces: Vec3[] = [];
  // Sample TOP surfaces across X/Z, rather than taking the nearest 8,000
  // underground blocks (which biased the former non-flat assertion).
  for (let dx = -32; dx <= 32; dx += 2) {
    await new Promise<void>(resolve => setImmediate(resolve));
    for (let dz = -32; dz <= 32; dz += 2) {
      for (let yy = origin.y + 24; yy >= origin.y - 32; yy--) {
        const p = new Vec3(origin.x + dx, yy, origin.z + dz);
        const block = actor.blockAt(p, false);
        if (groundNames.has(block?.name ?? '') && actor.blockAt(p.offset(0, 1, 0), false)?.name === 'air'
          && actor.blockAt(p.offset(0, 2, 0), false)?.name === 'air') { surfaces.push(p); break; }
        // Do not count a cave floor below water or a canopy as surface relief.
        if (block?.boundingBox === 'block' || ['water', 'lava'].includes(block?.name ?? '')) break;
      }
    }
  }
  const distinctHeights = [...new Set(surfaces.map(p => p.y))].sort((a, b) => a - b);
  if (distinctHeights.length < 3) throw new Error(`NON_FLAT_TERRAIN_NOT_VERIFIED: surfaces=${surfaces.length} heights=${JSON.stringify(distinctHeights)}`);
  const ground = surfaces.filter(p => p.distanceTo(origin) >= 9 && p.distanceTo(origin) <= 24 && Math.abs(p.y - origin.y) <= 8)
    .sort((a, b) => a.distanceTo(origin) - b.distanceTo(origin))[0];
  if (!ground) throw new Error('NATURAL_CAMP_SITE_NOT_FOUND');
  const camp = rememberedSite ? new Vec3(rememberedSite.camp.x, rememberedSite.camp.y, rememberedSite.camp.z) : ground.offset(0, 1, 0);
  const uphill = surfaces.filter(p => p.y >= origin.y + 3 && p.distanceTo(origin) <= 32).sort((a, b) => a.distanceTo(origin) - b.distanceTo(origin))[0]?.offset(0, 1, 0);
  const enemyGround = surfaces.filter(p => {
    const horizontal = Math.hypot(p.x - origin.x, p.z - origin.z);
    return horizontal >= 6 && horizontal <= 10 && Math.abs(p.y - origin.y) <= 2;
  }).sort((a, b) => Math.hypot(a.x - origin.x - 7, a.z - origin.z)
    - Math.hypot(b.x - origin.x - 7, b.z - origin.z))[0];
  // Local 5x5 shelter only. No terrain-wide clearing, resource placement, or OP
  // shortcut is available to the planner. The original surrounding hills remain.
  const x = camp.x, y = camp.y, z = camp.z;
  const structure = [
    `/fill ${x} ${y - 1} ${z} ${x + 4} ${y - 1} ${z + 4} cobblestone`,
    `/fill ${x} ${y} ${z} ${x + 4} ${y + 3} ${z + 4} oak_planks`,
    `/fill ${x + 1} ${y} ${z + 1} ${x + 3} ${y + 2} ${z + 3} air`,
    `/fill ${x + 2} ${y} ${z} ${x + 2} ${y + 1} ${z} air`,
    `/setblock ${x + 1} ${y} ${z + 1} crafting_table`,
    `/setblock ${x + 3} ${y + 2} ${z + 3} torch`,
  ];
  for (const command of structure) await control.executeSetupCommand(command);
  const logs = actor.findBlocks({ matching: actor.registry.blocksByName.oak_log.id, maxDistance: 48, count: 64 });
  site = { origin: { x: origin.x, y: origin.y, z: origin.z }, camp: { x, y, z },
    terrain: { distinctHeights, surfaceSamples: surfaces.slice(0, 128), logSamples: logs.slice(0, 16), seed: 9272026 },
    structure, uphill, enemyGround, structureKind: 'prepared-5x5-shelter-on-generated-terrain' };
  if (!rememberedSite) fs.writeFileSync(siteFile, JSON.stringify(site, null, 2));
  console.log(`NATURAL_SITE ${JSON.stringify(site)}`);
  if (!logs.length) throw new Error('NATURAL_OAK_RESOURCE_NOT_FOUND');
  if (!surveyOnly) {
    if (process.env.MINECRAFT_PRODUCTION_KEY_ACCEPTANCE_AUTHORIZED !== 'true') throw new Error('EXPLICIT_ACCEPTANCE_AUTHORIZATION_REQUIRED');
    const keyFile = '/home/azureuser/Shannon-current/backend/.env';
    const apiKey = dotenv.parse(fs.readFileSync(keyFile)).OPENAI_API_KEY ?? '';
    const ledger = process.env.MINECRAFT_ACCEPTANCE_BUDGET_FILE;
    if (!ledger) throw new Error('SHARED_ACCEPTANCE_LEDGER_REQUIRED');
    const budget = new AcceptanceBudget(path.resolve(ledger));
    const client = createOpenAIPlannerClient({ apiKey, fetcher: async (url, options) => {
      if (url !== 'https://api.openai.com/v1/responses' || typeof options?.body !== 'string') throw new Error('OFFICIAL_ENDPOINT_REQUIRED');
      const reservation = budget.reserve(options.body); const start = Date.now();
      try {
        const response = await fetch(url, options); const payload: any = await response.clone().json();
        requests.push({ ...reservation, durationMs: Date.now() - start, httpStatus: response.status, model: payload.model, usage: payload.usage,
          toolCalls: (payload.output ?? []).filter((item: any) => item.type === 'function_call').map((item: any) => item.name) });
        return response;
      } catch (error) { requests.push({ ...reservation, durationMs: Date.now() - start, error: String(error) }); throw error; }
    } });
    const allow = new Set(['list-inventory-items', 'get-bot-status', 'get-position', 'get-blocks-in-area', 'find-blocks', 'get-block-at', 'get-entities',
      'mine-block', 'dig-block-at', 'craft-one', 'check-recipe', 'place-block-at', 'pickup-nearest-item', 'move-to', 'equip-item', 'combat-engage', 'use-item']);
    const tools: any[] = actor.instantSkills.getSkills().filter(skill => allow.has(skill.skillName)).map(skillToAnthropicTool);
    tools.push({ name: 'task-complete', description: 'Request native-verified completion.', input_schema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] } });
    for (const caseId of selected) {
      const caseStartedAt = Date.now(); minHealth = 20;
      const night = caseId.startsWith('night');
      const setup = ['/gamemode survival @s', `/difficulty ${night ? 'normal' : 'peaceful'}`, `/gamerule spawn_mobs ${night}`,
        '/gamerule advance_time false', `/time set ${night ? 'midnight' : 'day'}`, '/weather clear', '/kill @e[type=!player]',
        '/clear @s', '/effect clear @s', '/effect give @s instant_health 1 10 true', '/effect give @s saturation 1 10 true',
        `/tp @s ${origin.x + 0.5} ${origin.y} ${origin.z + 0.5}`, '/give @s bread 3'];
      const pre: any[] = [{ type: 'gamemode', gamemode: 'survival' }, { type: 'difficulty', difficulty: night ? 'normal' : 'peaceful' },
        { type: 'gamerule', rule: 'spawn_mobs', value: night }, { type: 'block_at', x: x + 1, y, z: z + 1, block: 'crafting_table' }];
      let goal: string; let predicates: any[]; let assertions: any[];
      if (caseId === 'day-uphill' && !uphill) throw new Error('UPHILL_DESTINATION_NOT_FOUND');
      const destination = caseId === 'day-uphill' ? { x: uphill!.x + 0.5, y: uphill!.y, z: uphill!.z + 0.5 } : { x: x + 2.5, y, z: z + 2.5 };
      const home = { kind: 'position', dimension: 'overworld', position: destination, radius: 2 };
      const arrival = { type: 'position_within', ...destination, radius: 2 };
      if (caseId === 'day-craft') {
        setup.push('/give @s wheat 3'); goal = 'パンを追加で1個クラフトする'; predicates = [{ kind: 'produced', item: 'bread', count: 1 }];
        assertions = [{ type: 'inventory_count', item: 'bread', minCount: 4 }, { type: 'inventory_count', item: 'wheat', minCount: 0, maxCount: 0 }];
      } else if (caseId === 'day-place') {
        setup.push('/give @s stone 1', `/setblock ${x + 1} ${y} ${z + 3} air`);
        goal = `小屋内の座標(${x + 1},${y},${z + 3})に石を1個置く`;
        predicates = [{ kind: 'block', dimension: 'overworld', position: { x: x + 1, y, z: z + 3 }, block: 'stone' }];
        assertions = [{ type: 'block_at', x: x + 1, y, z: z + 3, block: 'stone' }];
      } else if (caseId === 'night-combat') {
        if (!enemyGround) throw new Error('DRY_NEARBY_ENEMY_SPAWN_NOT_FOUND');
        const enemySpawn = { x: enemyGround.x + 0.5, y: enemyGround.y + 1, z: enemyGround.z + 0.5 };
        site.enemySpawn = enemySpawn;
        setup.push('/give @s iron_sword 1', '/give @s shield 1', '/item replace entity @s armor.chest with iron_chestplate', '/item replace entity @s armor.legs with iron_leggings',
          `/summon zombie ${enemySpawn.x} ${enemySpawn.y} ${enemySpawn.z} {Tags:["natural_acceptance_enemy"],PersistenceRequired:1b}`);
        pre.push({ type: 'block_at', x: enemyGround.x, y: enemyGround.y, z: enemyGround.z, block: actor.blockAt(enemyGround)?.name });
        // Entity IDs are resolved from actual loaded observations after setup.
        goal = `近くの試験ゾンビを倒して、小屋内(${x + 2.5},${y},${z + 2.5})へ戻る`;
        predicates = [home]; assertions = [arrival, { type: 'entity_count', entity: 'zombie', tag: 'natural_acceptance_enemy', x: origin.x, y: origin.y, z: origin.z, radius: 64, minCount: 0, maxCount: 0 }];
      } else {
        setup.push('/give @s iron_axe 1');
        goal = `自然のオーク原木を3個集めて、${caseId === 'day-uphill' ? '丘の上' : '小屋内'}(${destination.x},${destination.y},${destination.z})へ運ぶ`;
        predicates = [{ kind: 'produced', item: 'oak_log', count: 3 }, home]; assertions = [{ type: 'inventory_count', item: 'oak_log', minCount: 3 }, arrival];
        if (night) setup.push('/give @s iron_sword 1', '/give @s shield 1', '/item replace entity @s armor.chest with iron_chestplate', '/item replace entity @s armor.legs with iron_leggings');
      }
      // Prepare before resolving the actual enemy ID; never grant planner OP.
      for (const command of setup) await oracle.executeSetupCommand(command);
      if (caseId === 'night-combat') {
        const enemy = Object.values(actor.entities).filter(entity => entity?.name === 'zombie' && entity.position.distanceTo(actor.entity.position) < 16)
          .sort((a, b) => a.position.distanceTo(actor.entity.position) - b.position.distanceTo(actor.entity.position))[0];
        if (!enemy) throw new Error('LIVE_AI_ZOMBIE_NOT_OBSERVED');
        predicates.unshift({ kind: 'defeated', entityId: enemy.id, dimension: 'overworld' });
        pre.push({ type: 'entity_nearby', entity: 'zombie', maxDistance: 16, present: true });
        site.enemyId = enemy.id;
      }
      const runner = new AutonomousScenarioRunner(actor, { modelClient: client, modelIdentity: { provider: 'openai', model: 'gpt-5.6-luna' } }, port);
      const report = await runner.run({ id: caseId, goal, goalContract: { goal, predicates }, setup: [], preAssertions: pre,
        constraints: 'Never issue chat commands. Use native observations, not guessed coordinates. Preserve the shelter and workstations. Natural terrain has height changes; use nearxz for ground navigation. Choose your own plan. If the goal proof is verified call task-complete. Food in the initial inventory is not newly crafted food.',
        assertions: [...assertions, { type: 'health_between', min: 1, max: 20 }, { type: 'gamemode', gamemode: 'survival' },
          { type: 'block_at', x, y, z, block: 'oak_planks' }, { type: 'block_at', x: x + 1, y, z: z + 1, block: 'crafting_table' }],
      }, { tools, timeoutMs: 180000, plannerKind: 'real_provider', oracle });
      reports.push({ ...report, runnerDurationMs: report.durationMs, durationMs: Date.now() - caseStartedAt, setup, minHealth, died });
      console.log(`NATURAL_RESULT ${JSON.stringify({ scenario: caseId, passed: report.passed, durationMs: Date.now() - caseStartedAt, executorMs: report.executor.durationMs, iterations: report.executor.iterations, minHealth, died })}`);
      if (!report.passed || died) { process.exitCode = 1; break; }
    }
  }
} catch (error) { console.error(String(error)); reports.push({ infrastructureError: String(error) }); process.exitCode = 1; }
finally {
  closeProbeBot(actor); closeProbeBot(operator);
  const sourceUnchanged = JSON.stringify(sourceHashes) === JSON.stringify(hashSources());
  fs.writeFileSync(path.join(directory, `${id}-natural-acceptance.json`), JSON.stringify({ id, port, surveyOnly, selected, site, died, minHealth, sourceHashes, sourceUnchanged, requests, reports }, null, 2));
}
