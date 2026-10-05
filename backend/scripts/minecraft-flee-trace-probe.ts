#!/usr/bin/env node
// Model-free trace of an escape on an isolated lab world as it stands: walk to
// a place, wait for hostiles, run the real flee-from and record how the body
// actually moved. No setup commands, no planner, no LLM.
import fs from 'node:fs';
import path from 'node:path';
import { createProbeBot, closeProbeBot } from '../src/services/minebot/testing/MinecraftProbeBot.js';
import { isLikelyHostileMobName } from '../src/services/minebot/utils/hostileMobHints.js';
import { captureWorldObservation } from '../src/services/minebot/cognition/worldFrame.js';
import { detectVillage } from '../src/services/minebot/utils/landmarks.js';
import { scanLoadedBlocks } from '../src/services/minebot/utils/loadedBlockScan.js';
import { randomUUID } from 'node:crypto';
import { createOpenAIPlannerClient } from '../src/services/minebot/cognition/OpenAIPlannerClient.js';
import { ShannonExecutor, skillToAnthropicTool } from '../src/services/llm/graph/ShannonExecutor.js';
import { MinebotTaskRuntime } from '../src/services/minebot/runtime/MinebotTaskRuntime.js';
import { BotEventHandler } from '../src/services/minebot/events/BotEventHandler.js';
import { EventReactionSystem } from '../src/services/minebot/eventReaction/EventReactionSystem.js';
import { loadEventReactionSettingsFile } from '../src/services/minebot/eventReaction/eventReactionSettingsStore.js';
import { SkillRegistrar } from '../src/services/minebot/skills/SkillRegistrar.js';
import { MinecraftCommandOracle } from '../src/services/minebot/testing/MinecraftCommandOracle.js';

const port = Number(process.env.MINECRAFT_OUTAGE_PORT);
const worldDirectory = process.env.MINECRAFT_OUTAGE_WORLD_DIRECTORY ?? '';
if (process.env.MINECRAFT_OUTAGE_NO_LLM !== 'true' || !Number.isInteger(port) || port < 25577 || port > 25651
  || !/^\/home\/azureuser\/minecraft\/progressive-lab-[A-Za-z0-9]+$/.test(worldDirectory)) throw new Error('ISOLATED_FLEE_TRACE_WORLD_REQUIRED');
const properties = fs.readFileSync(path.join(worldDirectory, 'server.properties'), 'utf8').split('\n');
if (!properties.includes('server-ip=127.0.0.1') || !properties.includes(`server-port=${port}`)) throw new Error('ISOLATED_FLEE_TRACE_WORLD_CONFIGURATION_INVALID');

const [tx, tz] = (process.env.MINECRAFT_FLEE_TRACE_SITE ?? '').split(',').map(Number);
const actor = await createProbeBot(port, 'MinebotTrial');
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
/** Scenarios build above where the previous one left the body; start low again before the build limit. */
const labLevel = (y: number) => y + 30 > 280 ? 100 : y + 30;
const hostiles = () => Object.values(actor.entities as Record<string, any>)
  .filter(entity => entity?.position && entity !== actor.entity && isLikelyHostileMobName(String(entity.name ?? '')))
  .map(entity => ({ name: String(entity.name), distance: actor.entity.position.distanceTo(entity.position) }))
  .sort((a, b) => a.distance - b.distance);
const trace: any[] = [];
let phase = 'approach';
const sampler = setInterval(() => {
  if (!actor.entity) return;
  const p = actor.entity.position;
  const near = hostiles()[0];
  trace.push({ t: Date.now(), phase, x: +p.x.toFixed(1), y: +p.y.toFixed(1), z: +p.z.toFixed(1), hp: actor.health,
    ground: actor.entity.onGround, water: (actor.entity as any).isInWater === true,
    keys: ['forward', 'back', 'left', 'right', 'sprint', 'jump'].filter(key => actor.getControlState(key as any)).join('+'),
    moving: actor.pathfinder?.isMoving?.() ?? null, mining: actor.pathfinder?.isMining?.() ?? null, building: actor.pathfinder?.isBuilding?.() ?? null,
    goal: actor.pathfinder?.goal?.constructor?.name ?? null, edgeStops: (actor as any).edgeGuard?.stops ?? null,
    hostile: near ? `${near.name}@${near.distance.toFixed(1)}` : null });
}, 250);
const report: any = { site: [tx, tz] };
const reflexes = process.env.MINECRAFT_FLEE_TRACE_REFLEX === 'true';
const timers: Array<ReturnType<typeof setInterval>> = [];
async function attachReflexes(): Promise<void> {
  // The real reflex layer with the planner down, as in the outage probe.
  const runtime = new MinebotTaskRuntime(actor);
  const settings = loadEventReactionSettingsFile();
  const reactions = new EventReactionSystem(actor, runtime, { ...settings, reactions: settings.reactions.map(row =>
    row.eventType === 'hostile_approach' ? { ...row, enabled: true, probability: 100 } : row) });
  const handler = new BotEventHandler(actor, runtime, []);
  const registrar = new SkillRegistrar();
  const client = createOpenAIPlannerClient({ apiKey: 'offline-outage-fixture', model: 'gpt-5.6-luna',
    fetcher: async () => { throw new Error('ACCEPTANCE_SHARED_BUDGET_EXHAUSTED'); } });
  const tools: any[] = actor.instantSkills.getSkills().map(skillToAnthropicTool);
  runtime.setExecutor(async (envelope, _messages, options) => new ShannonExecutor({ modelClient: client,
    modelIdentity: { provider: 'openai', model: 'gpt-5.6-luna' }, bot: actor, instantSkills: actor.instantSkills, criticMode: 'off',
    publishTaskTree: () => {} }).run({ runId: randomUUID(), goal: envelope.text || 'エンドラを倒す', context: null,
    systemPrompt: 'You are Minebot in a real survival world.', tools, abortSignal: options?.abortSignal, tags: envelope.tags,
    goalContract: envelope.tags.includes('emergency') ? (envelope.metadata as any)?.goalContract : undefined,
    onToolStarting: options?.onToolStarting, onToolFinished: options?.onToolFinished }));
  registrar.registerConstantSkills(actor, actor.constantSkills);
  handler.registerAll();
  handler.setEventReactionSystem(reactions);
  await reactions.initialize();
  for (const ms of [100, 1000, 5000]) timers.push(setInterval(() => actor.emit(`taskPer${ms}ms` as any), ms));
}
/**
 * Lab-only scenario (setup commands on the probe lab): a zombie that arrives
 * before a shelter can be sealed must make dig-shelter refuse with both times;
 * one far enough away must leave time to dig in and seal.
 */
async function shelterUnderThreat(): Promise<void> {
  const operator = await createProbeBot(port);
  const oracle = new MinecraftCommandOracle(operator);
  try {
    await oracle.verifyReady();
    for (const command of ['difficulty normal', 'gamerule spawn_mobs false', 'time set midnight', 'gamemode spectator ShannonProbe',
      'kill @e[type=!minecraft:player]', 'clear MinebotTrial', 'effect clear MinebotTrial', 'gamemode survival MinebotTrial',
      'effect give MinebotTrial minecraft:instant_health 1 5']) await oracle.executeSetupCommand(command);
    const origin = actor.entity.position.floored();
    const x0 = origin.x, y = labLevel(origin.y), z = origin.z;
    await oracle.executeSetupCommand(`fill ${x0 - 4} ${y - 6} ${z - 4} ${x0 + 40} ${y - 1} ${z + 4} dirt`);
    await oracle.executeSetupCommand(`fill ${x0 - 4} ${y} ${z - 4} ${x0 + 40} ${y + 4} ${z + 4} air`);
    await oracle.executeSetupCommand('give MinebotTrial cobblestone 16');
    const shelter = actor.instantSkills.getSkill('dig-shelter')!;
    const zombie = () => Object.values(actor.entities as Record<string, any>).find(entity => entity?.name === 'zombie');
    report.cases = [];
    for (const [label, gap, site] of [['near', 13, 0], ['far', 30, 2]] as const) {
      await oracle.executeSetupCommand(`tp MinebotTrial ${x0 + site + 0.5} ${y} ${z + 0.5}`);
      await sleep(1500);
      await oracle.executeSetupCommand(`summon minecraft:zombie ${x0 + site + gap + 0.5} ${y} ${z + 0.5} {PersistenceRequired:1b}`);
      await sleep(3000);
      phase = `shelter-${label}`;
      const before = { distance: zombie() ? +actor.entity.position.distanceTo(zombie()!.position).toFixed(1) : null,
        observed: captureWorldObservation(actor).nearbyThreats?.[0] ?? null, health: actor.health };
      const startedAt = Date.now();
      const result: any = await shelter.run();
      const seconds = (Date.now() - startedAt) / 1000;
      await sleep(label === 'far' ? 20_000 : 1000);
      const feet = actor.entity.position.floored();
      const solid = (dx: number, dy: number, dz: number) => actor.blockAt(feet.offset(dx, dy, dz))?.boundingBox === 'block';
      report.cases.push({ label, before, success: result?.success, failureType: result?.failureType ?? null,
        result: String(result?.result ?? '').slice(0, 220), seconds, feetY: feet.y - y, health: actor.health,
        sealed: solid(0, 2, 0) && [0, 1].every(dy => solid(1, dy, 0) && solid(-1, dy, 0) && solid(0, dy, 1) && solid(0, dy, -1)) });
      await oracle.executeSetupCommand('kill @e[type=minecraft:zombie]');
      await sleep(500);
    }
    const [near, far] = report.cases;
    report.passed = near.failureType === 'threat_too_close' && near.feetY === 0 && far.success === true && far.sealed && far.health === 20;
  } finally { await closeProbeBot(operator); }
}
/** Lab-only scenario: a pickaxe with three uses left must stop the mining action when it breaks, not pass the job to the spare. */
async function toolBreaksMidAction(): Promise<void> {
  const operator = await createProbeBot(port);
  const oracle = new MinecraftCommandOracle(operator);
  try {
    await oracle.verifyReady();
    for (const command of ['difficulty peaceful', 'gamerule spawn_mobs false', 'time set noon', 'gamemode spectator ShannonProbe',
      'kill @e[type=!minecraft:player]', 'clear MinebotTrial', 'effect clear MinebotTrial', 'gamemode survival MinebotTrial']) await oracle.executeSetupCommand(command);
    const origin = actor.entity.position.floored();
    const x0 = origin.x, y = labLevel(origin.y), z = origin.z;
    // A cell inside solid stone and a goal eight blocks away: the way there is dug, two blocks a step.
    await oracle.executeSetupCommand(`fill ${x0 - 3} ${y - 1} ${z - 3} ${x0 + 12} ${y + 4} ${z + 3} stone`);
    await oracle.executeSetupCommand(`fill ${x0} ${y} ${z} ${x0} ${y + 1} ${z} air`);
    await oracle.executeSetupCommand(`tp MinebotTrial ${x0 + 0.5} ${y} ${z + 0.5}`);
    await oracle.executeSetupCommand('give MinebotTrial stone_pickaxe[damage=125] 1');
    await oracle.executeSetupCommand('give MinebotTrial wooden_pickaxe 1');
    await sleep(2000);
    const heard: string[] = [];
    actor.on('minebotToolBroke' as any, ((entry: { name: string }) => heard.push(entry.name)) as any);
    const count = (name: string) => actor.inventory.items().filter(item => item.name === name).reduce((sum, item) => sum + item.count, 0);
    const startedAt = Date.now();
    const result: any = await actor.instantSkills.getSkill('move-to')!.run(x0 + 8.5, y, z + 0.5, 0, 'near');
    const seconds = (Date.now() - startedAt) / 1000;
    const stoppedAt = +(actor.entity.position.x - x0).toFixed(1);
    await sleep(4000);
    const wooden = actor.inventory.items().find(item => item.name === 'wooden_pickaxe') as any;
    report.toolBreak = { heard, success: result?.success, failureType: result?.failureType ?? null, result: String(result?.result ?? '').slice(0, 220), seconds,
      stoppedAt, movedAfterStop: +(actor.entity.position.x - x0 - stoppedAt).toFixed(1),
      stonePickaxes: count('stone_pickaxe'), woodenUsed: wooden?.durabilityUsed ?? null };
    report.passed = heard.includes('stone_pickaxe') && result?.failureType === 'tool_broke' && count('stone_pickaxe') === 0
      && (wooden?.durabilityUsed ?? 0) <= 1 && Math.abs(report.toolBreak.movedAfterStop) < 1;
    await oracle.executeSetupCommand('difficulty normal');
  } finally { await closeProbeBot(operator); }
}
/** Lab-only scenario: afloat in a one-block hole in an ice sheet, the body must climb out and walk away over the ice. */
async function outOfTheIceHole(): Promise<void> {
  const operator = await createProbeBot(port);
  const oracle = new MinecraftCommandOracle(operator);
  try {
    await oracle.verifyReady();
    for (const command of ['difficulty peaceful', 'gamerule spawn_mobs false', 'time set noon', 'gamemode spectator ShannonProbe',
      'kill @e[type=!minecraft:player]', 'clear MinebotTrial', 'effect clear MinebotTrial', 'gamemode survival MinebotTrial']) await oracle.executeSetupCommand(command);
    const origin = actor.entity.position.floored();
    const x0 = origin.x, y = labLevel(origin.y), z = origin.z;
    await oracle.executeSetupCommand(`fill ${x0 - 6} ${y - 4} ${z - 6} ${x0 + 14} ${y} ${z + 6} stone`);
    await oracle.executeSetupCommand(`fill ${x0 - 5} ${y - 3} ${z - 5} ${x0 + 13} ${y - 1} ${z + 5} water`);
    await oracle.executeSetupCommand(`fill ${x0 - 5} ${y} ${z - 5} ${x0 + 13} ${y} ${z + 5} ice`);
    await oracle.executeSetupCommand(`fill ${x0 - 6} ${y + 1} ${z - 6} ${x0 + 14} ${y + 5} ${z + 6} air`);
    await oracle.executeSetupCommand(`setblock ${x0} ${y} ${z} water`);
    await oracle.executeSetupCommand(`tp MinebotTrial ${x0 + 0.5} ${y} ${z + 0.5}`);
    await sleep(3000);
    phase = 'ice-hole';
    const before = { y: +(actor.entity.position.y - y).toFixed(2), inWater: (actor.entity as any).isInWater === true };
    const startedAt = Date.now();
    const result: any = await actor.instantSkills.getSkill('move-to')!.run(x0 + 10.5, y + 1, z + 0.5, 2, 'nearxz');
    await sleep(1000);
    report.iceHole = { before, success: result?.success, result: String(result?.result ?? '').slice(0, 200), seconds: (Date.now() - startedAt) / 1000,
      final: { x: +(actor.entity.position.x - x0).toFixed(1), y: +(actor.entity.position.y - y).toFixed(2) },
      inWater: (actor.entity as any).isInWater === true, health: actor.health };
    report.passed = before.inWater && result?.success === true && report.iceHole.inWater === false && report.iceHole.final.y >= 1;
    await oracle.executeSetupCommand('difficulty normal');
  } finally { await closeProbeBot(operator); }
}
/**
 * Lab-only scenario: the chain behind "make a bed while it is day, sleep
 * through the night" with the real skills. Wool from sheep, a bed at the
 * crafting table, sleep at night until the server turns it to morning, then
 * the bed taken back into the pack.
 */
async function bedBeforeNight(): Promise<void> {
  const operator = await createProbeBot(port);
  const oracle = new MinecraftCommandOracle(operator);
  try {
    await oracle.verifyReady();
    for (const command of ['difficulty normal', 'gamerule spawn_mobs false', 'time set 1000', 'weather clear', 'gamemode spectator ShannonProbe',
      'kill @e[type=!minecraft:player]', 'clear MinebotTrial', 'effect clear MinebotTrial', 'gamemode survival MinebotTrial']) await oracle.executeSetupCommand(command);
    const origin = actor.entity.position.floored();
    const x0 = origin.x, y = labLevel(origin.y), z = origin.z;
    await oracle.executeSetupCommand(`fill ${x0 - 8} ${y - 1} ${z - 8} ${x0 + 8} ${y - 1} ${z + 8} grass_block`);
    // Walled, so that neither a fleeing sheep nor its drops leave the pasture.
    await oracle.executeSetupCommand(`fill ${x0 - 9} ${y} ${z - 9} ${x0 + 9} ${y + 2} ${z + 9} stone`);
    await oracle.executeSetupCommand(`fill ${x0 - 8} ${y} ${z - 8} ${x0 + 8} ${y + 4} ${z + 8} air`);
    await oracle.executeSetupCommand(`tp MinebotTrial ${x0 + 0.5} ${y} ${z + 0.5}`);
    await oracle.executeSetupCommand('give MinebotTrial oak_log 2');
    await oracle.executeSetupCommand('give MinebotTrial crafting_table 1');
    for (const dx of [4, 5, 6]) await oracle.executeSetupCommand(`summon minecraft:sheep ${x0 + dx} ${y} ${z + 2} {Color:0b}`);
    await sleep(2500);
    const count = (name: string) => actor.inventory.items().filter(item => item.name === name).reduce((sum, item) => sum + item.count, 0);
    const skill = (name: string) => actor.instantSkills.getSkill(name)!;
    const steps: any[] = [];
    const step = async (name: string, run: () => Promise<any>) => {
      const startedAt = Date.now();
      const result: any = await run();
      steps.push({ name, success: result?.success, seconds: +((Date.now() - startedAt) / 1000).toFixed(1), result: String(result?.result ?? '').slice(0, 120) });
      return result;
    };
    const seen = captureWorldObservation(actor).nearbyEntities.filter(entity => entity.name === 'sheep').length;
    await step('attack-continuously sheep', () => skill('attack-continuously').run('sheep', 60, 24, 3));
    await sleep(1500);
    const wool = count('white_wool');
    await step('craft-one oak_planks', () => skill('craft-one').run('oak_planks', 1));
    await step('place crafting table / craft-one white_bed', () => skill('craft-one').run('white_bed', 1));
    const bedCrafted = count('white_bed');
    await oracle.executeSetupCommand('time set 13000');
    await sleep(1500);
    const before = actor.time.timeOfDay;
    await step('sleep-in-bed', () => skill('sleep-in-bed').run());
    await sleep(2000);
    const after = actor.time.timeOfDay;
    const bedBlock = actor.findBlock({ matching: (block: any) => String(block.name).endsWith('_bed'), maxDistance: 8 });
    if (bedBlock) {
      await step('dig-block-at bed (refused without the flag)', () => skill('dig-block-at').run(bedBlock.position.x, bedBlock.position.y, bedBlock.position.z));
      await step('dig-block-at bed, takeEquipment', () => skill('dig-block-at').run(bedBlock.position.x, bedBlock.position.y, bedBlock.position.z, true, 'target', true));
    }
    await sleep(2500);
    report.bed = { sheepSeen: seen, wool, bedCrafted, timeBefore: before, timeAfter: after, sleeping: actor.isSleeping, bedBack: count('white_bed'), steps };
    report.passed = seen === 3 && wool >= 3 && bedCrafted === 1 && before >= 12542 && after < 2000 && count('white_bed') >= 1;
  } finally { await closeProbeBot(operator); }
}
/** Lab-only scenario: village markers 60 blocks away must show up as a landmark, and the searches must not stall the body. */
async function villageInView(): Promise<void> {
  const operator = await createProbeBot(port);
  const oracle = new MinecraftCommandOracle(operator);
  try {
    await oracle.verifyReady();
    for (const command of ['difficulty peaceful', 'gamerule spawn_mobs false', 'time set noon', 'gamemode spectator ShannonProbe',
      'kill @e[type=!minecraft:player]', 'clear MinebotTrial', 'gamemode survival MinebotTrial']) await oracle.executeSetupCommand(command);
    const origin = actor.entity.position.floored();
    const before = { landmark: detectVillage(actor as any), structure: String((await actor.instantSkills.getSkill('find-structure')!.run('village') as any)?.result).slice(0, 120) };
    const vx = origin.x + 60, vy = origin.y, vz = origin.z - 20;
    await oracle.executeSetupCommand(`fill ${vx - 4} ${vy - 1} ${vz - 4} ${vx + 4} ${vy - 1} ${vz + 4} dirt_path`);
    await oracle.executeSetupCommand(`setblock ${vx} ${vy} ${vz} bell`);
    await oracle.executeSetupCommand(`setblock ${vx + 2} ${vy} ${vz} hay_block`);
    await oracle.executeSetupCommand(`setblock ${vx - 2} ${vy} ${vz + 1} composter`);
    await oracle.executeSetupCommand(`setblock ${vx} ${vy} ${vz + 3} white_bed[part=foot,facing=east]`);
    await oracle.executeSetupCommand(`summon minecraft:villager ${vx + 1} ${vy} ${vz + 1}`);
    await sleep(7000); // the watcher looks every five seconds
    const timed = async (label: string, run: () => Promise<any> | any) => { const startedAt = process.hrtime.bigint(); const value = await run();
      return { label, ms: +(Number(process.hrtime.bigint() - startedAt) / 1e6).toFixed(1), value }; };
    const scan = scanLoadedBlocks(actor as any, ['bell']);
    report.village = { reachMetres: scan.reachMetres, columns: scan.columns, before,
      watcher: (actor as any).landmarks, observation: captureWorldObservation(actor).landmarks ?? null,
      timings: [
        await timed('detectVillage', () => detectVillage(actor as any)?.evidence),
        await timed('find-structure village', async () => String((await actor.instantSkills.getSkill('find-structure')!.run('village') as any)?.result).slice(0, 140)),
        await timed('find-blocks furnace (absent), 128', async () => String((await actor.instantSkills.getSkill('find-blocks')!.run('furnace', 128, 8) as any)?.result).slice(0, 60)),
        await timed('find-blocks hay_block, 128', async () => String((await actor.instantSkills.getSkill('find-blocks')!.run('hay_block', 128, 8) as any)?.result).slice(0, 90)),
      ] };
    const landmark = (actor as any).landmarks?.[0];
    report.passed = before.landmark === null && landmark?.kind === 'village' && Math.abs(landmark.distance - 63) <= 6
      && report.village.timings.every((entry: any) => entry.ms < 250);
    await oracle.executeSetupCommand(`fill ${vx - 4} ${vy} ${vz - 4} ${vx + 4} ${vy + 2} ${vz + 4} air`);
    await oracle.executeSetupCommand('kill @e[type=minecraft:villager]');
    await oracle.executeSetupCommand('difficulty normal');
  } finally { await closeProbeBot(operator); }
}
try {
  if (process.env.MINECRAFT_FLEE_TRACE_VILLAGE === 'true') { await villageInView(); throw new Error('SCENARIO_DONE'); }
  if (process.env.MINECRAFT_FLEE_TRACE_BED === 'true') { await bedBeforeNight(); throw new Error('SCENARIO_DONE'); }
  if (process.env.MINECRAFT_FLEE_TRACE_ICEHOLE === 'true') { await outOfTheIceHole(); throw new Error('SCENARIO_DONE'); }
  if (process.env.MINECRAFT_FLEE_TRACE_TOOLBREAK === 'true') { await toolBreaksMidAction(); throw new Error('SCENARIO_DONE'); }
  if (process.env.MINECRAFT_FLEE_TRACE_SHELTER === 'true') { await shelterUnderThreat(); throw new Error('SCENARIO_DONE'); }
  const moveTo = actor.instantSkills.getSkill('move-to')!;
  const flee = actor.instantSkills.getSkill('flee-from')!;
  if (Number.isFinite(tx) && Number.isFinite(tz)) {
    for (let attempt = 0; attempt < 4 && Math.hypot(actor.entity.position.x - tx, actor.entity.position.z - tz) > 6; attempt++) {
      const result: any = await moveTo.run(tx, actor.entity.position.y, tz, 4, 'nearxz');
      console.log(`approach ${attempt}: ${String(result?.result).slice(0, 160)}`);
    }
  }
  report.arrived = actor.entity.position.floored();
  phase = 'wait';
  const deadline = Date.now() + Number(process.env.MINECRAFT_FLEE_TRACE_WAIT_MS ?? 90_000);
  while (Date.now() < deadline && !(hostiles()[0]?.distance <= 16)) await sleep(250);
  report.hostilesAtStart = hostiles().slice(0, 4);
  report.flees = [];
  if (reflexes) {
    phase = 'reflex';
    const from = actor.entity.position.clone();
    const before = hostiles()[0]?.distance ?? null;
    await attachReflexes();
    await sleep(Number(process.env.MINECRAFT_FLEE_TRACE_REFLEX_MS ?? 30_000));
    report.reflex = { hostileBefore: before, hostileAfter: hostiles()[0]?.distance ?? null,
      displacement: +from.distanceTo(actor.entity.position).toFixed(1), health: actor.health };
  } else for (let round = 0; round < 2 && hostiles()[0]?.distance <= 40; round++) {
    phase = `flee${round}`;
    const from = actor.entity.position.clone();
    const startedAt = Date.now();
    const result: any = await flee.run('hostile', 32, 10000);
    report.flees.push({ success: result?.success, result: result?.result, seconds: (Date.now() - startedAt) / 1000,
      displacement: +from.distanceTo(actor.entity.position).toFixed(1), health: actor.health });
    console.log(`flee ${round}: ${result?.result}`);
  }
} catch (error) { if (String(error) !== 'Error: SCENARIO_DONE') report.error = String(error); }
clearInterval(sampler);
for (const timer of timers) clearInterval(timer);
report.health = actor.health;
const out = path.join(process.cwd(), 'saves/minecraft/progressive_reports', `flee-trace-${Date.now()}.json`);
fs.writeFileSync(out, JSON.stringify({ report, trace }, null, 1));
console.log(`FLEE_TRACE_REPORT ${out}`);
console.log(JSON.stringify(report));
await closeProbeBot(actor);
process.exit(0);
