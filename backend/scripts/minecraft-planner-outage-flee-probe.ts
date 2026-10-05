#!/usr/bin/env node
// Model-free live check of campaign segment 7: HP 8, the planner unavailable
// because its reservation is exhausted, and one pursuing zombie that leaves
// the 16m clearance radius and comes back. Uses SkillAgent's runtime, event
// and constant-skill wiring; the planner fetcher throws before any network I/O.
import { currentAction } from '../src/services/minebot/execution/ActionExecution.js';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createProbeBot, closeProbeBot } from '../src/services/minebot/testing/MinecraftProbeBot.js';
import { MinecraftCommandOracle } from '../src/services/minebot/testing/MinecraftCommandOracle.js';
import { createOpenAIPlannerClient } from '../src/services/minebot/cognition/OpenAIPlannerClient.js';
import { ShannonExecutor, skillToAnthropicTool } from '../src/services/llm/graph/ShannonExecutor.js';
import { MinebotTaskRuntime } from '../src/services/minebot/runtime/MinebotTaskRuntime.js';
import { BotEventHandler } from '../src/services/minebot/events/BotEventHandler.js';
import { EventReactionSystem } from '../src/services/minebot/eventReaction/EventReactionSystem.js';
import { loadEventReactionSettingsFile } from '../src/services/minebot/eventReaction/eventReactionSettingsStore.js';
import { SkillRegistrar } from '../src/services/minebot/skills/SkillRegistrar.js';
import { assertActionActive, executeAction } from '../src/services/minebot/execution/ActionExecution.js';
import { verifyNativeBreathingSafety } from '../src/services/minebot/cognition/GoalVerifier.js';

const port = Number(process.env.MINECRAFT_OUTAGE_PORT);
const worldDirectory = process.env.MINECRAFT_OUTAGE_WORLD_DIRECTORY ?? '';
if (process.env.MINECRAFT_OUTAGE_NO_LLM !== 'true' || process.env.MINECRAFT_COGNITION_MODE !== 'off'
  || !Number.isInteger(port) || port < 25577 || port > 25650
  || !/^\/home\/azureuser\/minecraft\/progressive-lab-[A-Za-z0-9]+$/.test(worldDirectory)) {
  throw new Error('ISOLATED_OUTAGE_WORLD_REQUIRED');
}
const properties = fs.readFileSync(path.join(worldDirectory, 'server.properties'), 'utf8');
if (!properties.split('\n').includes('server-ip=127.0.0.1') || !properties.split('\n').includes(`server-port=${port}`))
  throw new Error('ISOLATED_OUTAGE_WORLD_CONFIGURATION_INVALID');
// 'reapproach': HP 8 and a zombie that leaves and re-enters the clearance radius.
// 'witch': full HP near a potion-throwing witch; poison ticks must not restart
// the running escape each tick.
const scenario = process.env.MINECRAFT_OUTAGE_SCENARIO ?? 'reapproach';
// 'poison': HP 8 with poison II ticking while a zombie chases.
// 'water-trap': the bot is already stuck in a walled pool (no setup); only native
// recovery may get it out while the planner is unavailable.
// 'buried': sand dropped into the bot's head cell; native containment must dig it out.
// 'skeletons': three skeletons at night; the bot must seal into a shaft instead of running under fire.
// 'cornered': a zombie walks down a dead-end 1x2 tunnel; flight cannot open distance, so the
// bot must counterattack with its stone sword. Fixed before the run: no death, the zombie dead
// within 40s, and at least one native counterattack.
// 'flooded-shaft': the bot starts at the bottom of a 1x1 shaft with five water blocks whose rim
// is one block above the surface (a natural pool lip), carrying 16 cobblestone. Fixed before the
// run: out of water with breathing verified continuously for 3s within 120s, standing at or above
// the rim, no death, and at least 3 blocks placed.
// 'capped-water': the bot starts submerged in a 3-deep pool under a single block at the waterline
// (open water one block to the side). Fixed before the run: oxygen back to 20 within 60s, no death.
// 'ravine-rim': the bot (HP 8) stands near the east edge of a platform 30 blocks above the
// ground; a zombie on a separate platform across a 2-wide gap keeps the native escape pushing
// it east for 20s. Then a careless mover holds forward+sprint at the edge for 3s, and again with
// jump. Fixed before the run: no death, and in both blind phases no descent below the platform
// with the edge guard having stopped. MINECRAFT_OUTAGE_EDGE_GUARD=off is the control run.
// 'seagrass-pool': the bot starts on the floor of a 21x21 pool 10 deep, with tall seagrass on the
// floor near it and no dry land within 8 blocks of the centre (paid run L12 drowned after the native
// breathing escape swam it down to a seagrass-covered seabed taken for dry footing). Fixed before
// the run: no death within 120s.
// 'reflex-only': the same pool without seagrass, with auto-swim switched off to stand for a regular
// surfacing path that stays silent. Fixed before the run: no death within 90s and at least one
// engagement of the last-resort breathing reflex.
// 'drowned-pool': the bot (full air, stone sword) in a 9x9 pool 5 deep with a drowned. Fixed before
// the run (paid run L14 was killed by a drowned while every escape and fight was cancelled as a
// breathing emergency): no death within 60s, and the drowned dead or a counterattack made.
// 'surrounded': the bot (HP 8) on open ground with a zombie nine blocks off to each of the four sides (paid run
// L65 ran three blocks one way and three back among its pursuers until it died: away from the nearest is towards
// the one opposite). Fixed before the run: no death, no hit, at least 12 blocks from the start after five
// seconds, no doubling back.
// 'shelter-water': a stone pad with a water pocket beside the shaft the bot would dig under its
// feet (paid run L17 retried dig-shelter six times on such a spot). Fixed before the run:
// dig-shelter succeeds within 60s, the bot ends sealed in a shaft away from the water, no death.
if (!['reapproach', 'witch', 'poison', 'water-trap', 'buried', 'skeletons', 'cornered', 'flooded-shaft', 'capped-water', 'ravine-rim', 'seagrass-pool', 'reflex-only', 'drowned-pool', 'shelter-water', 'under-ice', 'ice-closes', 'bank-overhang', 'waterfall-shaft', 'lava-overhead', 'lava-contact', 'flooded-tunnel', 'cliff-lake', 'walled-off', 'water-pocket', 'surrounded'].includes(scenario)) throw new Error('OUTAGE_SCENARIO_INVALID');
const mobName = scenario === 'witch' ? 'witch' : 'zombie';
// Fixed before the run: every re-approach must restart escape, and the actor must survive.
const cycles = 3;
// Witch: 40s survival, beyond the 10m potion reach in >=70% of samples after
// 5s, and at most 5 native escape starts (first start plus 15s lease renewals).
const witchObserveMs = 40000;
const witchReach = 10;
const witchMinBeyondRatio = 0.7;
const witchMaxFleeStarts = 5;
// Poison: 30s survival, zombie beyond melee reach (4m) in >=90% of samples
// after 3s, and at most 4 native escape starts despite a damage tick ~0.6s.
const poisonObserveMs = 30000;
const poisonMinGap = 4;
const poisonMinBeyondRatio = 0.9;
const poisonMaxFleeStarts = 4;
const reapproachDistance = 9;
const clearDistance = 24;
const clearHoldMs = 2000;
const escapeGainMeters = 4;
const escapeWindowMs = 8000;

const operator = await createProbeBot(port);
const actor = await createProbeBot(port, 'MinebotTrial');
const oracle = new MinecraftCommandOracle(operator);
const runtime = new MinebotTaskRuntime(actor);
const settings = loadEventReactionSettingsFile();
const reactions = new EventReactionSystem(actor, runtime, { ...settings, reactions: settings.reactions.map(row =>
  row.eventType === 'hostile_approach' ? { ...row, enabled: true, probability: 100 } : row) });
const handler = new BotEventHandler(actor, runtime, []);
const registrar = new SkillRegistrar();
const timers: Array<ReturnType<typeof setInterval>> = [];
let plannerCalls = 0;
let deaths = 0;
const runs: Array<{ mode: string; stopReason?: string; recoveryStatus?: string; atMs: number }> = [];
const trace: any[] = [];
const startedAt = Date.now();
const elapsed = () => Date.now() - startedAt;
let report: any;
actor.on('death', () => { deaths++; });

const client = createOpenAIPlannerClient({ apiKey: 'offline-outage-fixture', model: 'gpt-5.6-luna', fetcher: async () => {
  plannerCalls++;
  throw new Error('ACCEPTANCE_SHARED_BUDGET_EXHAUSTED');
} });
const tools: any[] = actor.instantSkills.getSkills()
  .filter(skill => !['chat', 'get-advancements', 'investigate-terrain'].includes(skill.skillName))
  .map(skillToAnthropicTool);
runtime.setExecutor(async (envelope, _messages, options) => {
  const emergency = envelope.tags.includes('emergency');
  const result = await new ShannonExecutor({ modelClient: client, modelIdentity: { provider: 'openai', model: 'gpt-5.6-luna' },
    bot: actor, instantSkills: actor.instantSkills, criticMode: 'off', publishTaskTree: () => {} }).run({
    runId: randomUUID(), goal: emergency ? envelope.text || '敵から生き延びる' : 'エンドラを倒す', context: null,
    systemPrompt: 'You are Minebot in a real survival world.', tools, abortSignal: options?.abortSignal, tags: envelope.tags,
    goalContract: emergency ? (envelope.metadata as any)?.goalContract : undefined,
    onToolStarting: options?.onToolStarting, onToolFinished: options?.onToolFinished });
  runs.push({ mode: emergency ? 'emergency' : 'main', stopReason: (result as any).stopReason,
    recoveryStatus: (result as any).recoveryStatus, atMs: elapsed() });
  return result;
});

const zombie = () => Object.values(actor.entities).find(entity => entity.name === mobName);
// (mobName is only used by the zombie/witch scenarios.)
let fleeStarts = 0;
const originalStartFlee = (reactions as any).startContinuousFlee.bind(reactions);
(reactions as any).startContinuousFlee = () => { fleeStarts++; originalStartFlee(); };
let counterattacks = 0;
const originalCounterattack = (reactions as any).runCorneredCounterattack.bind(reactions);
(reactions as any).runCorneredCounterattack = (...args: any[]) => { counterattacks++; return originalCounterattack(...args); };
const zombieDistance = () => {
  const target = zombie();
  return target && actor.entity ? actor.entity.position.distanceTo(target.position) : null;
};
async function until(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  return predicate();
}

const cycleResults: any[] = [];
try {
  await oracle.verifyReady();
  // Every scenario builds from where the body stands, and what the one before it left standing there has
  // decided results more than once (a flooded pool where a platform was meant to hang in the air, a body
  // starting inside a block). With MINECRAFT_OUTAGE_STAGE="x,y,z" the body is first put on a small pad of
  // its own at that place, which the caller picks fresh for each run.
  const stage = (process.env.MINECRAFT_OUTAGE_STAGE ?? '').split(',').map(Number);
  if (stage.length === 3 && stage.every(Number.isFinite) && scenario !== 'water-trap') {
    const [sx, sy, sz] = stage.map(Math.floor);
    // The observer goes first so the place is loaded; the pad is laid before the body arrives on it.
    await oracle.executeSetupCommand('gamemode spectator ShannonProbe');
    await oracle.executeSetupCommand(`tp ShannonProbe ${sx + 0.5} ${sy + 12} ${sz + 0.5}`);
    await new Promise(resolve => setTimeout(resolve, 4000));
    await oracle.executeSetupCommand(`forceload add ${sx - 48} ${sz - 32} ${sx + 64} ${sz + 32}`);
    await oracle.executeSetupCommand(`fill ${sx - 2} ${sy - 1} ${sz - 2} ${sx + 2} ${sy - 1} ${sz + 2} stone`);
    await oracle.executeSetupCommand(`fill ${sx - 2} ${sy} ${sz - 2} ${sx + 2} ${sy + 3} ${sz + 2} air`);
    await oracle.executeSetupCommand(`tp MinebotTrial ${sx + 0.5} ${sy} ${sz + 0.5}`);
    if (!await until(() => Math.abs(actor.entity.position.x - (sx + 0.5)) < 0.6 && Math.abs(actor.entity.position.y - sy) < 0.6 && actor.entity.onGround, 8000)) throw new Error('STAGE_NOT_REACHED');
  }
  if (scenario !== 'water-trap') for (const command of ['difficulty normal', 'gamerule spawn_mobs false', 'time set midnight',
    'gamemode spectator ShannonProbe', 'kill @e[type=!minecraft:player]', 'clear MinebotTrial',
    'effect clear MinebotTrial', 'effect give MinebotTrial minecraft:instant_health 1 5',
    // A body left burning by the run before would die during this one's setup.
    'effect give MinebotTrial minecraft:fire_resistance 20 0 true',
    'gamemode survival MinebotTrial']) await oracle.executeSetupCommand(command);
  if (scenario !== 'water-trap' && !await until(() => actor.health >= 20, 3000)) throw new Error('ACTOR_HEALTH_RESET_FAILED');
  if (scenario === 'water-trap') await oracle.executeSetupCommand('gamemode spectator ShannonProbe');
  registrar.registerConstantSkills(actor, actor.constantSkills);
  handler.registerAll();
  handler.setEventReactionSystem(reactions);
  await reactions.initialize();
  for (const ms of [100, 1000, 5000]) timers.push(setInterval(() => actor.emit(`taskPer${ms}ms` as any), ms));
  timers.push(setInterval(() => {
    const position = actor.entity?.position;
    trace.push({ atMs: elapsed(), health: actor.health, zombieDistance: zombieDistance(),
      position: position ? { x: position.x, y: position.y, z: position.z } : null,
      controlState: actor.minebotControlState ?? null, emergency: runtime.isInEmergencyMode(),
      keys: ['forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint'].filter(key => actor.getControlState(key as any)).join('+'),
      yaw: actor.entity ? +actor.entity.yaw.toFixed(2) : null, oxygen: actor.oxygenLevel, action: (currentAction(actor) as any)?.name ?? null,
      recoveryStatus: runtime.currentState?.recoveryStatus ?? null });
  }, 250));

  const queued = runtime.addTaskToQueue({ userMessage: 'エンドラを倒す' });
  if (!queued.success) throw new Error(`MAIN_TASK_QUEUE_FAILED:${queued.reason}`);
  const plannerDown = await until(() => runs.some(run => run.mode === 'main') && !runtime.isRunning(), 15000);
  if (!plannerDown) throw new Error('PLANNER_OUTAGE_NOT_REACHED');
  const origin = actor.entity.position.floored();
  if (scenario === 'flooded-tunnel') {
    // An open pool, and from it a roofed, flooded tunnel to a dead end: the
    // body swims in as a path would take it (paid run L30) and must come back
    // out the way it came when the air runs low. Stone too slow to dig through.
    const tx = origin.x + 8, ty = origin.y, tz = origin.z;
    const length = Number(process.env.MINECRAFT_OUTAGE_TUNNEL_LENGTH ?? 10);
    await oracle.executeSetupCommand(`fill ${tx - 4} ${ty} ${tz - 3} ${tx + length + 3} ${ty + 5} ${tz + 3} obsidian`);
    await oracle.executeSetupCommand(`fill ${tx - 3} ${ty + 1} ${tz - 2} ${tx} ${ty + 4} ${tz + 2} water`);
    await oracle.executeSetupCommand(`fill ${tx - 3} ${ty + 5} ${tz - 2} ${tx} ${ty + 8} ${tz + 2} air`);
    await oracle.executeSetupCommand(`fill ${tx + 1} ${ty + 1} ${tz} ${tx + length} ${ty + 2} ${tz} water`);
    await oracle.executeSetupCommand(`fill ${tx - 4} ${ty + 6} ${tz - 3} ${tx + length + 3} ${ty + 9} ${tz + 3} air`);
    await oracle.executeSetupCommand(`tp MinebotTrial ${tx - 1.5} ${ty + 4} ${tz + 0.5}`);
    await new Promise(resolve => setTimeout(resolve, 2500));
    const lowestOxygen = { value: 20 };
    const deepest = { x: actor.entity.position.x };
    timers.push(setInterval(() => { lowestOxygen.value = Math.min(lowestOxygen.value, actor.oxygenLevel ?? 20);
      deepest.x = Math.max(deepest.x, actor.entity?.position.x ?? deepest.x); }, 100));
    // Swim to the dead end by hand, as a path through water would, then let go.
    const end = tx + length - 0.5;
    // As an action, the way a skill holds the body: between actions the body floats and would not dive.
    await executeAction(actor, 'move-to', 25_000, async () => {
      const swimDeadline = Date.now() + 20_000;
      while (Date.now() < swimDeadline && actor.entity.position.x < end - 0.6 && deaths === 0) {
        // Like any skill, the swim stops the moment a reflex takes the body: it must not keep steering against it.
        assertActionActive(actor);
        const p = actor.entity.position;
        await actor.lookAt(new (p.constructor as any)(end, p.y + 1.62, tz + 0.5), true);
        actor.setControlState('forward', p.y < ty + 2.2 || p.x < tx - 0.5);
        actor.setControlState('jump', p.y < ty + 1.1);
        actor.setControlState('sneak', p.y > ty + 1.6);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      actor.clearControlStates();
      return { success: true, result: 'swam in' };
    });
    const reached = { x: +(actor.entity.position.x - tx).toFixed(1), oxygen: actor.oxygenLevel };
    const out = await until(() => deaths > 0 || (verifyNativeBreathingSafety(actor).status === 'verified' && actor.entity.position.x < tx + 1), 60_000);
    await new Promise(resolve => setTimeout(resolve, 2000));
    const proof = verifyNativeBreathingSafety(actor);
    report = { scenario, passed: out && deaths === 0 && proof.status === 'verified' && reached.x >= 4, deaths, length, reached,
      lowestOxygen: lowestOxygen.value, final: { x: +(actor.entity.position.x - tx).toFixed(1), y: +(actor.entity.position.y - ty).toFixed(1) },
      minHealth: Math.min(...trace.map(sample => sample.health)), durationMs: elapsed(), plannerCalls, runs, trace };
    if (!report.passed) process.exitCode = 1;
  } else if (scenario === 'under-ice') {
    // A pool under a closed ice sheet, the body below it: nothing to swim to,
    // the only way to air is through the ice (paid run L25 drowned here).
    const tx = origin.x + 8, ty = origin.y, tz = origin.z;
    await oracle.executeSetupCommand(`fill ${tx - 5} ${ty} ${tz - 5} ${tx + 5} ${ty + 5} ${tz + 5} stone`);
    await oracle.executeSetupCommand(`fill ${tx - 4} ${ty + 1} ${tz - 4} ${tx + 4} ${ty + 4} ${tz + 4} water`);
    await oracle.executeSetupCommand(`fill ${tx - 4} ${ty + 5} ${tz - 4} ${tx + 4} ${ty + 5} ${tz + 4} ice`);
    await oracle.executeSetupCommand(`fill ${tx - 5} ${ty + 6} ${tz - 5} ${tx + 5} ${ty + 9} ${tz + 5} air`);
    if (process.env.MINECRAFT_OUTAGE_BARE_HANDS !== 'true') await oracle.executeSetupCommand('give MinebotTrial stone_pickaxe 1');
    await oracle.executeSetupCommand(`tp MinebotTrial ${tx + 0.5} ${ty + 2} ${tz + 0.5}`);
    const lowestOxygen = { value: 20 };
    timers.push(setInterval(() => { lowestOxygen.value = Math.min(lowestOxygen.value, actor.oxygenLevel ?? 20); }, 100));
    const out = await until(() => deaths > 0 || (actor.entity.position.y >= ty + 5 && (actor.oxygenLevel ?? 0) >= 18), 60_000);
    await new Promise(resolve => setTimeout(resolve, 3000));
    const proof = verifyNativeBreathingSafety(actor);
    report = { scenario, passed: out && deaths === 0 && proof.status === 'verified', deaths, lowestOxygen: lowestOxygen.value,
      breathingProof: proof, final: actor.entity.position, iceLevel: ty + 5, bareHands: process.env.MINECRAFT_OUTAGE_BARE_HANDS === 'true',
      minHealth: Math.min(...trace.map(sample => sample.health)), durationMs: elapsed(), plannerCalls, runs, trace };
    if (!report.passed) process.exitCode = 1;
  } else if (scenario === 'ice-closes') {
    // A lake too deep to stand in, under an ice sheet with one hole. The body breathes in the hole, swims
    // off under the ice the way a chase after fish takes it, and the hole freezes over behind it: the way
    // back it remembers is gone and the only air is through the ice (paid run L50 drowned here).
    // Fixed before the run: no death, no drowning damage, and the body ends breathing above the ice level.
    const tx = origin.x + 8, ty = origin.y, tz = origin.z, ice = ty + 9;
    await oracle.executeSetupCommand(`fill ${tx - 6} ${ty} ${tz - 4} ${tx + 6} ${ice} ${tz + 4} stone`);
    await oracle.executeSetupCommand(`fill ${tx - 5} ${ty + 1} ${tz - 3} ${tx + 5} ${ice - 1} ${tz + 3} water`);
    await oracle.executeSetupCommand(`fill ${tx - 5} ${ice} ${tz - 3} ${tx + 5} ${ice} ${tz + 3} ice`);
    await oracle.executeSetupCommand(`fill ${tx - 6} ${ice + 1} ${tz - 4} ${tx + 6} ${ice + 4} ${tz + 4} air`);
    await oracle.executeSetupCommand(`setblock ${tx - 4} ${ice} ${tz} water`);
    if (process.env.MINECRAFT_OUTAGE_BARE_HANDS !== 'true') await oracle.executeSetupCommand('give MinebotTrial stone_pickaxe 1');
    await oracle.executeSetupCommand(`tp MinebotTrial ${tx - 3.5} ${ice} ${tz + 0.5}`);
    await new Promise(resolve => setTimeout(resolve, 3000));
    const lowestOxygen = { value: 20 };
    timers.push(setInterval(() => { lowestOxygen.value = Math.min(lowestOxygen.value, actor.oxygenLevel ?? 20); }, 100));
    const breathedAt = actor.entity.position.clone();
    const end = tx + 2.5;
    await executeAction(actor, 'move-to', 25_000, async () => {
      const swimDeadline = Date.now() + 15_000;
      while (Date.now() < swimDeadline && actor.entity.position.x < end - 0.4 && deaths === 0) {
        assertActionActive(actor);
        const p = actor.entity.position;
        await actor.lookAt(new (p.constructor as any)(end, p.y + 1.62, tz + 0.5), true);
        // Dive until the head is below the ice, then swim along under it.
        actor.setControlState('forward', p.y < ice - 1.9);
        actor.setControlState('jump', p.y < ice - 2.6);
        actor.setControlState('sneak', p.y > ice - 2.1);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      actor.clearControlStates();
      return { success: true, result: 'swam under the ice' };
    }).catch(() => undefined);
    const swam = { x: +(actor.entity.position.x - tx).toFixed(1), y: +(actor.entity.position.y - ice).toFixed(1), oxygen: actor.oxygenLevel };
    await oracle.executeSetupCommand(`setblock ${tx - 4} ${ice} ${tz} ice`);
    const closedAtMs = elapsed();
    const out = await until(() => deaths > 0 || (actor.entity.position.y >= ice && (actor.oxygenLevel ?? 0) >= 18), 60_000);
    const airAfterMs = elapsed() - closedAtMs;
    await new Promise(resolve => setTimeout(resolve, 3000));
    const proof = verifyNativeBreathingSafety(actor);
    const minHealth = Math.min(...trace.map(sample => sample.health));
    report = { scenario, passed: out && deaths === 0 && proof.status === 'verified' && minHealth >= 20 && swam.x >= 1.5, deaths, lowestOxygen: lowestOxygen.value,
      breathedAt: { x: +(breathedAt.x - tx).toFixed(1), y: +(breathedAt.y - ice).toFixed(1) }, swam, airAfterMs, breathingProof: proof,
      final: actor.entity.position, iceLevel: ice, bareHands: process.env.MINECRAFT_OUTAGE_BARE_HANDS === 'true',
      minHealth, durationMs: elapsed(), plannerCalls, runs, trace };
    if (!report.passed) process.exitCode = 1;
  } else if (scenario === 'bank-overhang') {
    // A pool too deep to stand in, level banks, and one block of the bank jutting out over the water. The
    // body breathes on the bank, then is in the water under the jutting block (knocked in, as in a fight):
    // open water one cell to its side, stone over its head, and "the way it came" up on the bank where no
    // swim leads (paid run L54 swam at the bank, then started digging the stone, and drowned).
    // Fixed before the run: no death, no drowning damage, breathing in open water within 20 seconds.
    const tx = origin.x + 8, ty = origin.y, tz = origin.z, top = ty + 5;
    await oracle.executeSetupCommand(`fill ${tx - 6} ${ty} ${tz - 4} ${tx + 4} ${top} ${tz + 4} stone`);
    await oracle.executeSetupCommand(`fill ${tx - 6} ${top + 1} ${tz - 4} ${tx + 4} ${top + 5} ${tz + 4} air`);
    await oracle.executeSetupCommand(`fill ${tx - 2} ${ty + 1} ${tz - 2} ${tx + 2} ${top} ${tz + 2} water`);
    await oracle.executeSetupCommand(`setblock ${tx - 2} ${top + 1} ${tz} stone`);
    await oracle.executeSetupCommand('give MinebotTrial stone_pickaxe 1');
    await oracle.executeSetupCommand(`tp MinebotTrial ${tx - 3.5} ${top + 1} ${tz + 0.5}`);
    await new Promise(resolve => setTimeout(resolve, 2500));
    const lowestOxygen = { value: 20 };
    timers.push(setInterval(() => { lowestOxygen.value = Math.min(lowestOxygen.value, actor.oxygenLevel ?? 20); }, 100));
    await oracle.executeSetupCommand(`tp MinebotTrial ${tx - 1.5} ${top - 0.8} ${tz + 0.5}`);
    const underAtMs = elapsed();
    await new Promise(resolve => setTimeout(resolve, 1500));
    const under = { x: +(actor.entity.position.x - tx).toFixed(1), y: +(actor.entity.position.y - top).toFixed(1), oxygen: actor.oxygenLevel };
    const out = await until(() => deaths > 0 || (elapsed() - underAtMs > 9000 && verifyNativeBreathingSafety(actor).status === 'verified' && (actor.oxygenLevel ?? 0) >= 18), 45_000);
    const airAfterMs = elapsed() - underAtMs;
    await new Promise(resolve => setTimeout(resolve, 2000));
    const proof = verifyNativeBreathingSafety(actor);
    const minHealth = Math.min(...trace.map(sample => sample.health));
    const stoneStillThere = actor.blockAt(new (actor.entity.position.constructor as any)(tx - 2, top + 1, tz))?.name === 'stone';
    report = { scenario, passed: out && deaths === 0 && proof.status === 'verified' && minHealth >= 20, deaths, lowestOxygen: lowestOxygen.value, under, airAfterMs,
      stoneStillThere, breathingProof: proof, final: { x: +(actor.entity.position.x - tx).toFixed(1), y: +(actor.entity.position.y - top).toFixed(1), z: +(actor.entity.position.z - tz).toFixed(1) },
      minHealth, durationMs: elapsed(), plannerCalls, runs, trace };
    if (!report.passed) process.exitCode = 1;
  } else if (scenario === 'waterfall-shaft') {
    // A dry tunnel in stone, and at its end a shaft one cell wide with water falling down it from a source
    // ten cells up, stone over the source. The body stands idle at the foot of the fall, head in the water
    // (as after digging into a spring from below). Air is one step to its side; up the fall there is none
    // (paid run L59 held jump, swam up the fall and drowned under the stone).
    // Fixed before the run: no death, no drowning damage, the body never climbs the fall and ends in the tunnel.
    const tx = origin.x + 8, ty = origin.y, tz = origin.z;
    await oracle.executeSetupCommand(`fill ${tx - 7} ${ty} ${tz - 2} ${tx + 2} ${ty + 14} ${tz + 2} stone`);
    await oracle.executeSetupCommand(`fill ${tx - 6} ${ty + 1} ${tz} ${tx - 1} ${ty + 2} ${tz} air`);
    await oracle.executeSetupCommand(`fill ${tx} ${ty + 1} ${tz} ${tx} ${ty + 11} ${tz} air`);
    await oracle.executeSetupCommand(`setblock ${tx} ${ty + 11} ${tz} water`);
    await new Promise(resolve => setTimeout(resolve, 5000));
    await oracle.executeSetupCommand('effect give MinebotTrial minecraft:instant_health 1 5');
    // MINECRAFT_OUTAGE_SHAFT_START: how many cells above the tunnel floor the body starts in the fall (the current carries nothing sideways up there).
    const startUp = Math.max(1, Math.min(9, Number(process.env.MINECRAFT_OUTAGE_SHAFT_START ?? 1)));
    await oracle.executeSetupCommand(`tp MinebotTrial ${tx + 0.5} ${ty + startUp} ${tz + 0.5}`);
    const placedAtMs = elapsed();
    const lowestOxygen = { value: 20 };
    const highest = { y: -Infinity };
    timers.push(setInterval(() => { lowestOxygen.value = Math.min(lowestOxygen.value, actor.oxygenLevel ?? 20);
      highest.y = Math.max(highest.y, (actor.entity?.position.y ?? -Infinity) - ty); }, 100));
    await new Promise(resolve => setTimeout(resolve, 1000));
    const placed = { x: +(actor.entity.position.x - tx).toFixed(1), y: +(actor.entity.position.y - ty).toFixed(1), oxygen: actor.oxygenLevel };
    await new Promise(resolve => setTimeout(resolve, 24_000));
    const proof = verifyNativeBreathingSafety(actor);
    // From the moment the body is at the foot of the fall (where the stage was built may itself have hurt it).
    const minHealth = Math.min(...trace.filter(sample => sample.atMs >= placedAtMs + 500).map(sample => sample.health));
    const final = { x: +(actor.entity.position.x - tx).toFixed(1), y: +(actor.entity.position.y - ty).toFixed(1), z: +(actor.entity.position.z - tz).toFixed(1) };
    report = { scenario, passed: deaths === 0 && proof.status === 'verified' && minHealth >= 20 && highest.y <= startUp + 2 && final.x < 0, deaths, startUp,
      lowestOxygen: lowestOxygen.value, placed, highestY: +highest.y.toFixed(1), final, breathingProof: proof, minHealth, durationMs: elapsed(), plannerCalls, runs, trace };
    if (!report.passed) process.exitCode = 1;
  } else if (scenario === 'lava-overhead') {
    // The body at the bottom of a shaft of its own, dirt over its head, and a pocket of lava beside that dirt
    // (paid run L63: stair-mine refused the block, tower-up then broke it from underneath and the lava came
    // down). The planner's call is made as the planner made it. Fixed before the run: the climb is refused
    // with the lava named as the reason, the dirt is still there, and the body is unhurt.
    const tx = origin.x + 8, ty = origin.y, tz = origin.z;
    await oracle.executeSetupCommand(`fill ${tx - 3} ${ty} ${tz - 3} ${tx + 3} ${ty + 7} ${tz + 3} stone`);
    await oracle.executeSetupCommand(`fill ${tx} ${ty + 1} ${tz} ${tx} ${ty + 2} ${tz} air`);
    await oracle.executeSetupCommand(`setblock ${tx} ${ty + 3} ${tz} dirt`);
    await oracle.executeSetupCommand(`setblock ${tx + 1} ${ty + 3} ${tz} lava`);
    await oracle.executeSetupCommand('give MinebotTrial cobblestone 16');
    await oracle.executeSetupCommand('give MinebotTrial stone_pickaxe 1');
    await oracle.executeSetupCommand(`tp MinebotTrial ${tx + 0.5} ${ty + 1} ${tz + 0.5}`);
    await until(() => actor.inventory.items().some(item => item.name === 'cobblestone'), 3000);
    await new Promise(resolve => setTimeout(resolve, 1500));
    const placedAtMs = elapsed();
    const result: any = await actor.instantSkills.getSkill('tower-up')!.run(5, 'cobblestone');
    await new Promise(resolve => setTimeout(resolve, 3000));
    const overhead = actor.blockAt(new (actor.entity.position.constructor as any)(tx, ty + 3, tz))?.name;
    const minHealth = Math.min(...trace.filter(sample => sample.atMs >= placedAtMs).map(sample => sample.health));
    report = { scenario, passed: deaths === 0 && result?.success === false && /溶岩/.test(String(result?.result)) && overhead === 'dirt' && minHealth >= 20,
      deaths, result: String(result?.result).slice(0, 200), failureType: result?.failureType, overhead, minHealth,
      refusedDigs: (actor as any).lavaDigGuard?.refused ?? null, durationMs: elapsed(), plannerCalls, runs, trace };
    if (!report.passed) process.exitCode = 1;
  } else if (scenario === 'lava-contact') {
    // A corridor in stone, the body standing in it, and lava set flowing into the cell it stands in. Nobody
    // plans (paid run L63 stood in the flow for the two seconds it took to die).
    // Fixed before the run: the body is out of the lava within three seconds.
    // (Lava takes four points every half second and leaves the body burning; in lava it can only wade. Getting
    // out is a last chance, not a safe outcome: not letting the lava in is the rule that protects the body.)
    const tx = origin.x + 8, ty = origin.y, tz = origin.z;
    await oracle.executeSetupCommand(`fill ${tx - 6} ${ty} ${tz - 2} ${tx + 6} ${ty + 5} ${tz + 2} stone`);
    await oracle.executeSetupCommand(`fill ${tx - 5} ${ty + 1} ${tz} ${tx + 5} ${ty + 2} ${tz} air`);
    await oracle.executeSetupCommand(`tp MinebotTrial ${tx + 0.5} ${ty + 1} ${tz + 0.5}`);
    await new Promise(resolve => setTimeout(resolve, 2000));
    await oracle.executeSetupCommand('effect clear MinebotTrial');
    await oracle.executeSetupCommand('effect give MinebotTrial minecraft:instant_health 1 5');
    await oracle.executeSetupCommand('effect give MinebotTrial minecraft:saturation 1 5');
    await new Promise(resolve => setTimeout(resolve, 1000));
    // MINECRAFT_OUTAGE_WATER_BUCKET=true: the body carries a bucket of water, as it does on its way to make a portal.
    const carriesWater = process.env.MINECRAFT_OUTAGE_WATER_BUCKET === 'true';
    if (carriesWater) await oracle.executeSetupCommand('give MinebotTrial minecraft:water_bucket 1');
    await new Promise(resolve => setTimeout(resolve, 500));
    const deathsBefore = deaths;
    await oracle.executeSetupCommand(`setblock ${tx} ${ty + 2} ${tz} lava`);
    const lavaAtMs = elapsed();
    let enteredAt: number | null = null, leftAt: number | null = null, inLavaMs = 0, lastSample = Date.now();
    const sampler = setInterval(() => {
      const now = Date.now(); const inLava = (actor.entity as any)?.isInLava === true;
      if (inLava) { inLavaMs += now - lastSample; enteredAt ??= elapsed(); leftAt = null; }
      else if (enteredAt !== null && leftAt === null) {
        leftAt = elapsed();
        // With water carried, what is looked at is the fire after the lava: the lava is a pocket that has run out
        // (a spring that goes on feeding a dead-end corridor needs someone to walk away from it, which is the planner's part).
        if (carriesWater) void oracle.executeSetupCommand(`setblock ${tx} ${ty + 2} ${tz} air`).catch(() => undefined);
      }
      lastSample = now;
    }, 50);
    timers.push(sampler);
    await until(() => deaths > deathsBefore || elapsed() - lavaAtMs > 20_000, 25_000);
    clearInterval(sampler);
    const died = deaths > deathsBefore;
    // Leave nothing burning for the next run.
    await oracle.executeSetupCommand(`fill ${tx - 5} ${ty + 1} ${tz} ${tx + 5} ${ty + 2} ${tz} air`);
    await oracle.executeSetupCommand('effect give MinebotTrial minecraft:fire_resistance 30 0 true');
    const minHealth = Math.min(...trace.filter(sample => sample.atMs >= lavaAtMs).map(sample => sample.health));
    const final = { x: +(actor.entity.position.x - tx).toFixed(1), y: +(actor.entity.position.y - ty).toFixed(1), inLava: (actor.entity as any)?.isInLava === true };
    // What is asked of the reflex is to get the body out. Whether it then lives depends on how long it burns
    // (the fire goes on for up to fifteen seconds after the lava); `survived` reports that, and does not decide the run.
    const douse = (actor as any).fireDouse ?? null;
    report = { scenario, passed: enteredAt !== null && inLavaMs <= 3000 && (died || !final.inLava) && (!carriesWater || !died), survived: !died, carriesWater, douse,
      bucketAfter: actor.inventory.items().filter(item => item.name.includes('bucket')).map(item => item.name), deaths: died ? 1 : 0, enteredLava: enteredAt !== null,
      inLavaMs, minHealth: +minHealth.toFixed(1), final, reflexEngagements: (actor as any).lavaReflex?.engagements ?? null, durationMs: elapsed(), plannerCalls, runs, trace };
    if (!report.passed) process.exitCode = 1;
  } else if (scenario === 'shelter-water') {
    const tx = origin.x + 6, ty = origin.y, tz = origin.z;
    await oracle.executeSetupCommand(`fill ${tx - 4} ${ty - 6} ${tz - 4} ${tx + 4} ${ty - 1} ${tz + 4} stone`);
    await oracle.executeSetupCommand(`fill ${tx - 4} ${ty} ${tz - 4} ${tx + 4} ${ty + 3} ${tz + 4} air`);
    await oracle.executeSetupCommand(`setblock ${tx + 1} ${ty - 2} ${tz} water`);
    await oracle.executeSetupCommand('give MinebotTrial cobblestone 16');
    await oracle.executeSetupCommand('give MinebotTrial stone_pickaxe 1');
    await oracle.executeSetupCommand(`tp MinebotTrial ${tx + 0.5} ${ty} ${tz + 0.5}`);
    await until(() => actor.inventory.items().some(item => item.name === 'cobblestone'), 3000);
    await new Promise(resolve => setTimeout(resolve, 1000));
    const result: any = await actor.instantSkills.getSkill('dig-shelter')!.run();
    const feet = actor.entity.position.floored();
    const solid = (dx: number, dy: number, dz: number) => actor.blockAt(feet.offset(dx, dy, dz))?.boundingBox === 'block';
    const sealed = solid(0, 2, 0) && [0, 1].every(dy => solid(1, dy, 0) && solid(-1, dy, 0) && solid(0, dy, 1) && solid(0, dy, -1));
    report = { scenario, passed: deaths === 0 && result?.success === true && sealed && !(feet.x === tx && feet.z === tz),
      result: String(result?.result ?? '').slice(0, 200), sealed, feet, start: { x: tx, y: ty, z: tz },
      minHealth: Math.min(...trace.map(sample => sample.health)), durationMs: elapsed(), plannerCalls, deaths, runs, trace };
    if (!report.passed) process.exitCode = 1;
  } else if (scenario === 'drowned-pool') {
    const tx = origin.x + 8, ty = origin.y, tz = origin.z;
    await oracle.executeSetupCommand(`fill ${tx - 5} ${ty} ${tz - 5} ${tx + 5} ${ty + 5} ${tz + 5} stone`);
    await oracle.executeSetupCommand(`fill ${tx - 4} ${ty + 1} ${tz - 4} ${tx + 4} ${ty + 5} ${tz + 4} water`);
    await oracle.executeSetupCommand(`fill ${tx - 5} ${ty + 6} ${tz - 5} ${tx + 5} ${ty + 9} ${tz + 5} air`);
    await oracle.executeSetupCommand('give MinebotTrial stone_sword 1');
    await oracle.executeSetupCommand(`tp MinebotTrial ${tx + 0.5} ${ty + 3} ${tz + 0.5}`);
    await new Promise(resolve => setTimeout(resolve, 1500));
    await oracle.executeSetupCommand(`summon minecraft:drowned ${tx + 3.5} ${ty + 3} ${tz + 0.5} {PersistenceRequired:1b}`);
    const drowned = () => Object.values(actor.entities).find(entity => entity.name === 'drowned');
    const survived = !await until(() => deaths > 0, 60_000);
    const killed = !drowned();
    // Now that the navigator knows the way out of a pool, getting out of the water and out of its reach is as good as winning the fight.
    const gap = drowned() ? actor.entity.position.distanceTo(drowned()!.position) : null;
    const escapedDry = !(actor.entity as any).isInWater && actor.entity.onGround === true && gap !== null && gap >= 6;
    await oracle.executeSetupCommand('kill @e[type=minecraft:drowned]');
    report = { scenario, passed: survived && deaths === 0 && (killed || counterattacks > 0 || escapedDry), deaths, killed, counterattacks, escaped: escapedDry, fleeStarts,
      minHealth: Math.min(...trace.map(sample => sample.health)), final: actor.entity.position, durationMs: elapsed(), plannerCalls, runs, trace };
    if (!report.passed) process.exitCode = 1;
  } else if (scenario === 'seagrass-pool' || scenario === 'reflex-only') {
    const tx = origin.x + 14, ty = origin.y, tz = origin.z;
    if (scenario === 'reflex-only') actor.constantSkills.getSkill('auto-swim')!.status = false;
    // Stone under the sand: on a stage that hangs in the air the sand floor fell away and took the water with it.
    await oracle.executeSetupCommand(`fill ${tx - 11} ${ty - 1} ${tz - 11} ${tx + 11} ${ty - 1} ${tz + 11} stone`);
    await oracle.executeSetupCommand(`fill ${tx - 11} ${ty} ${tz - 11} ${tx + 11} ${ty + 10} ${tz + 11} stone`);
    await oracle.executeSetupCommand(`fill ${tx - 10} ${ty + 1} ${tz - 10} ${tx + 10} ${ty + 10} ${tz + 10} water`);
    await oracle.executeSetupCommand(`fill ${tx - 11} ${ty + 11} ${tz - 11} ${tx + 11} ${ty + 14} ${tz + 11} air`);
    await oracle.executeSetupCommand(`fill ${tx - 10} ${ty} ${tz - 10} ${tx + 10} ${ty} ${tz + 10} sand`);
    for (const [dx, dz] of scenario === 'seagrass-pool' ? [[2, 0], [-2, 1], [0, 3], [1, -2], [-3, -3]] : []) {
      await oracle.executeSetupCommand(`setblock ${tx + dx} ${ty + 1} ${tz + dz} tall_seagrass[half=lower]`);
      await oracle.executeSetupCommand(`setblock ${tx + dx} ${ty + 2} ${tz + dz} tall_seagrass[half=upper]`);
    }
    // The body is put in once it can see the pool: arriving ahead of the block updates, it read the old air
    // under the new water as the nearest air and swam down for two seconds before it swam up.
    await until(() => actor.blockAt(actor.entity.position.floored().set(tx, ty + 5, tz))?.name === 'water', 8000);
    await oracle.executeSetupCommand(`tp MinebotTrial ${tx + 0.5} ${ty + 1} ${tz + 0.5}`);
    const lowestOxygen = { value: 20 };
    const watch = setInterval(() => { lowestOxygen.value = Math.min(lowestOxygen.value, actor.oxygenLevel ?? 20); }, 100);
    timers.push(watch);
    const survived = !await until(() => deaths > 0, scenario === 'reflex-only' ? 90_000 : 120_000);
    const reflex = (actor as any).breathingReflex?.engagements ?? 0;
    // With nobody acting, the body now treads water: the last-resort reflex
    // should no longer be needed at all, and the air should never run low.
    report = { scenario, passed: survived && deaths === 0 && (scenario !== 'reflex-only' || lowestOxygen.value >= 15), deaths, reflexEngagements: reflex,
      floating: (actor as any).breathingReflex?.floating ?? null, breathingProof: verifyNativeBreathingSafety(actor),
      lowestOxygen: lowestOxygen.value, final: actor.entity.position,
      minHealth: Math.min(...trace.map(sample => sample.health)), durationMs: elapsed(), plannerCalls, runs, trace };
    if (!report.passed) process.exitCode = 1;
  } else if (scenario === 'ravine-rim') {
    if (process.env.MINECRAFT_OUTAGE_EDGE_GUARD === 'off') (actor as any).edgeGuard.enabled = false;
    const top = origin.y + 30;
    await oracle.executeSetupCommand('damage MinebotTrial 12 minecraft:generic');
    await until(() => actor.health <= 8, 3000);
    // Bot platform x in [ox, ox+6]; zombie platform x in [ox-5, ox-3] across a 2-wide gap.
    const ox = origin.x + 3;
    // The drop has to be a drop: what earlier scenarios left standing around here is cleared first.
    await oracle.executeSetupCommand(`fill ${ox - 9} ${top - 14} ${origin.z - 7} ${ox + 11} ${top + 6} ${origin.z + 7} air`);
    await oracle.executeSetupCommand(`fill ${ox} ${top} ${origin.z - 3} ${ox + 6} ${top} ${origin.z + 3} stone`);
    await oracle.executeSetupCommand(`fill ${ox - 5} ${top} ${origin.z - 1} ${ox - 3} ${top} ${origin.z + 1} stone`);
    await oracle.executeSetupCommand(`tp MinebotTrial ${ox + 4.5} ${top + 1} ${origin.z + 0.5}`);
    await until(() => Math.abs(actor.entity.position.y - (top + 1)) < 0.1 && actor.entity.onGround, 5000);
    await oracle.executeSetupCommand(`summon minecraft:zombie ${ox - 3.5} ${top + 1} ${origin.z + 0.5} {PersistenceRequired:1b}`);
    const lowest = { y: actor.entity.position.y };
    const watch = setInterval(() => { lowest.y = Math.min(lowest.y, actor.entity?.position.y ?? lowest.y); }, 50);
    timers.push(watch);
    await new Promise(resolve => setTimeout(resolve, 20_000));
    await oracle.executeSetupCommand('kill @e[type=minecraft:zombie]');
    const guard = (actor as any).edgeGuard;
    const fleeStops = guard.stops;
    // A careless mover: keys held straight at the east edge, walking then sprint-jumping.
    const blind: Array<{ jump: boolean; stops: number; lowestY: number }> = [];
    for (const jump of [false, true]) {
      if (deaths) break;
      await oracle.executeSetupCommand(`tp MinebotTrial ${ox + 2.5} ${top + 1} ${origin.z + 0.5}`);
      await until(() => Math.abs(actor.entity.position.x - (ox + 2.5)) < 0.1 && actor.entity.onGround, 5000);
      const before = guard.stops;
      lowest.y = actor.entity.position.y;
      await actor.lookAt(actor.entity.position.offset(10, 1.62, 0), true);
      const hold = setInterval(() => {
        actor.setControlState('forward', true); actor.setControlState('sprint', true); actor.setControlState('jump', jump);
      }, 50);
      await new Promise(resolve => setTimeout(resolve, 3000));
      clearInterval(hold);
      actor.clearControlStates();
      await new Promise(resolve => setTimeout(resolve, 1500));
      blind.push({ jump, stops: guard.stops - before, lowestY: lowest.y });
    }
    report = { scenario, guardEnabled: guard.enabled,
      passed: deaths === 0 && blind.length === 2 && blind.every(phase => phase.lowestY >= top + 0.9 && phase.stops > 0),
      lowestY: lowest.y, platformTop: top + 1, edgeGuardStops: guard.stops, fleeStops, blind, fleeStarts, final: actor.entity.position,
      minHealth: Math.min(...trace.map(sample => sample.health)), durationMs: elapsed(), plannerCalls, deaths, runs, trace };
    if (!report.passed) process.exitCode = 1;
  } else if (scenario === 'capped-water') {
    const tx = origin.x + 5;
    await oracle.executeSetupCommand(`fill ${tx - 3} ${origin.y} ${origin.z - 3} ${tx + 3} ${origin.y + 4} ${origin.z + 3} stone`);
    await oracle.executeSetupCommand(`fill ${tx - 2} ${origin.y + 1} ${origin.z - 2} ${tx + 2} ${origin.y + 3} ${origin.z + 2} water`);
    await oracle.executeSetupCommand(`fill ${tx - 2} ${origin.y + 4} ${origin.z - 2} ${tx + 2} ${origin.y + 4} ${origin.z + 2} air`);
    await oracle.executeSetupCommand(`setblock ${tx} ${origin.y + 3} ${origin.z} stone`);
    await oracle.executeSetupCommand(`tp MinebotTrial ${tx + 0.5} ${origin.y + 1} ${origin.z + 0.5}`);
    // The body used to wait under the cap until its air ran low and then be rescued; an idle body now goes
    // to the air beside it at once. Either way it must end breathing with full air, unhurt.
    const { verifyNativeBreathingSafety: breathing } = await import('../src/services/minebot/cognition/GoalVerifier.js');
    let lowestOxygen = 20;
    const placedAt = elapsed();
    const recovered = await until(() => {
      lowestOxygen = Math.min(lowestOxygen, actor.oxygenLevel ?? 20);
      return elapsed() - placedAt > 8000 && breathing(actor).status === 'verified' && (actor.oxygenLevel ?? 0) >= 20;
    }, 60_000);
    const minHealth = Math.min(...trace.map(sample => sample.health));
    report = { scenario, passed: recovered && deaths === 0 && minHealth >= 20, recovered, lowestOxygen, final: actor.entity.position,
      oxygen: actor.oxygenLevel, minHealth, durationMs: elapsed(), plannerCalls, deaths, runs, trace };
    if (!report.passed) process.exitCode = 1;
  } else if (scenario === 'flooded-shaft') {
    const { verifyNativeBreathingSafety } = await import('../src/services/minebot/cognition/GoalVerifier.js');
    const tx = origin.x + 4;
    await oracle.executeSetupCommand(`fill ${tx - 1} ${origin.y} ${origin.z - 1} ${tx + 1} ${origin.y + 6} ${origin.z + 1} stone`);
    await oracle.executeSetupCommand(`fill ${tx} ${origin.y + 1} ${origin.z} ${tx} ${origin.y + 5} ${origin.z} water`);
    await oracle.executeSetupCommand(`fill ${tx} ${origin.y + 6} ${origin.z} ${tx} ${origin.y + 6} ${origin.z} air`);
    await oracle.executeSetupCommand('give MinebotTrial cobblestone 16');
    await oracle.executeSetupCommand(`tp MinebotTrial ${tx + 0.5} ${origin.y + 1} ${origin.z + 0.5}`);
    const cobble = () => actor.inventory.items().filter(item => item.name === 'cobblestone').reduce((n, item) => n + item.count, 0);
    await until(() => cobble() === 16, 3000);
    // With nobody planning, the body now floats at the top of the shaft and
    // breathes; it no longer has to be rescued by a suffocation emergency.
    // Getting out is the leave-water skill, called here as a planner would.
    const lowestOxygen = { value: 20 };
    timers.push(setInterval(() => { lowestOxygen.value = Math.min(lowestOxygen.value, actor.oxygenLevel ?? 20); }, 100));
    await new Promise(resolve => setTimeout(resolve, 25_000));
    const floated = { breathing: verifyNativeBreathingSafety(actor).status, lowestOxygen: lowestOxygen.value, y: actor.entity.position.y - origin.y };
    const left: any = await actor.instantSkills.getSkill('leave-water')!.run();
    let outSince: number | null = null;
    const escaped = floated.breathing === 'verified' && floated.lowestOxygen >= 15 && await until(() => {
      const out = verifyNativeBreathingSafety(actor).status === 'verified' && !(actor.entity as any).isInWater
        && actor.entity.position.y >= origin.y + 5.9;
      outSince = out ? outSince ?? Date.now() : null;
      return outSince !== null && Date.now() - outSince >= 3000;
    }, 20_000);
    const placedBlocks = 16 - cobble();
    // The oracle executes as the spectating operator, so @s-relative checks would test the
    // operator; count players standing near the rim instead (the operator stays at ground level).
    const surface = await oracle.evaluate({ type: 'entity_count', entity: 'minecraft:player', x: tx, y: origin.y + 6, z: origin.z,
      radius: 3, minCount: 1 });
    report = { scenario, passed: escaped && deaths === 0 && placedBlocks >= 1 && surface.passed, escaped, placedBlocks, floated,
      result: String(left?.result ?? '').slice(0, 160),
      surface, final: actor.entity.position, minHealth: Math.min(...trace.map(sample => sample.health)),
      durationMs: elapsed(), plannerCalls, deaths, runs, trace };
    if (!report.passed) process.exitCode = 1;
  } else if (scenario === 'cliff-lake') {
    // A lake walled by cliffs five blocks above the water on three sides, with the only bank 30 blocks east.
    // The nearest dry footing in a straight line is a cliff top; the body has to pick the bank (paid run L32).
    const { x: ox, y: oy, z: oz } = origin;
    // High in the lab the surface freezes within seconds, and an ice floe is footing too: keep this lake liquid.
    await oracle.executeSetupCommand('gamerule random_tick_speed 0');
    await oracle.executeSetupCommand(`fill ${ox - 6} ${oy - 8} ${oz - 6} ${ox + 40} ${oy + 4} ${oz + 6} stone`);
    await oracle.executeSetupCommand(`fill ${ox - 6} ${oy + 5} ${oz - 6} ${ox + 40} ${oy + 8} ${oz + 6} air`);
    await oracle.executeSetupCommand(`fill ${ox - 1} ${oy} ${oz - 4} ${ox + 40} ${oy + 4} ${oz + 4} air`);
    await oracle.executeSetupCommand(`fill ${ox - 1} ${oy - 6} ${oz - 4} ${ox + 30} ${oy - 1} ${oz + 4} water`);
    await oracle.executeSetupCommand('give MinebotTrial cobblestone 16');
    await oracle.executeSetupCommand('give MinebotTrial stone_pickaxe 1');
    await oracle.executeSetupCommand(`tp MinebotTrial ${ox + 0.5} ${oy - 1} ${oz + 0.5}`);
    await until(() => (actor.entity as any).isInWater === true, 4000);
    let lowest = actor.entity.position.y;
    timers.push(setInterval(() => { lowest = Math.min(lowest, actor.entity.position.y); }, 100));
    const startedAt = Date.now();
    const left: any = await actor.instantSkills.getSkill('leave-water')!.run();
    const final = actor.entity.position.clone();
    await until(() => actor.entity.onGround === true, 2000);
    const dry = !(actor.entity as any).isInWater && actor.entity.onGround === true;
    await oracle.executeSetupCommand('gamerule random_tick_speed 3');
    report = { scenario, passed: left?.success === true && dry && final.x >= ox + 30.5 && deaths === 0 && lowest >= oy - 2.6 && Date.now() - startedAt <= 100_000,
      result: String(left?.result ?? '').slice(0, 200), escaped: dry, reached: { dx: +(final.x - ox).toFixed(1), dy: +(final.y - oy).toFixed(1) },
      lowestY: +(lowest - oy).toFixed(1), leaveMs: Date.now() - startedAt, final,
      minHealth: Math.min(...trace.map(sample => sample.health)), durationMs: elapsed(), plannerCalls, deaths, runs, trace };
    if (!report.passed) process.exitCode = 1;
  } else if (scenario === 'cornered') {
    // Built beside the bot, then entered: filling over the bot would bury it first.
    const tx = origin.x + 4;
    await oracle.executeSetupCommand(`fill ${tx - 1} ${origin.y - 1} ${origin.z - 1} ${tx + 1} ${origin.y + 2} ${origin.z + 9} stone`);
    await oracle.executeSetupCommand(`fill ${tx} ${origin.y} ${origin.z} ${tx} ${origin.y + 1} ${origin.z + 8} air`);
    await oracle.executeSetupCommand(`tp MinebotTrial ${tx + 0.5} ${origin.y} ${origin.z + 0.5}`);
    await oracle.executeSetupCommand('give MinebotTrial stone_sword 1');
    await new Promise(resolve => setTimeout(resolve, 1000));
    // Wounded and peckish with food in the pack: the state in which eating
    // used to take the body from the counterattack (paid run L18).
    const wounded = process.env.MINECRAFT_OUTAGE_WOUNDED === 'true';
    if (wounded) {
      await oracle.executeSetupCommand('give MinebotTrial cooked_beef 4');
      await oracle.executeSetupCommand('effect give MinebotTrial minecraft:hunger 1 255 true');
      await new Promise(resolve => setTimeout(resolve, 1500));
      await oracle.executeSetupCommand('damage MinebotTrial 6');
      await until(() => actor.health <= 14, 3000);
    }
    const woundedState = { health: actor.health, food: actor.food };
    await oracle.executeSetupCommand(`summon minecraft:zombie ${tx + 0.5} ${origin.y} ${origin.z + 6.5} {PersistenceRequired:1b}`);
    const killed = await until(() => !zombie() && counterattacks > 0, 40_000);
    await new Promise(resolve => setTimeout(resolve, 1000));
    const zombieCount = await oracle.evaluate({ type: 'entity_count', entity: 'minecraft:zombie', x: tx, y: origin.y, z: origin.z,
      radius: 32, minCount: 0, maxCount: 0 }).catch(error => ({ error: String(error) }));
    await oracle.executeSetupCommand('kill @e[type=minecraft:zombie]');
    report = { scenario, passed: deaths === 0 && killed && counterattacks > 0, killed, counterattacks, fleeStarts, wounded: wounded ? woundedState : null,
      zombieCount, minHealth: Math.min(...trace.map(sample => sample.health)), durationMs: elapsed(), plannerCalls, deaths, runs, trace };
    if (!report.passed) process.exitCode = 1;
  } else if (scenario === 'surrounded') {
    await oracle.executeSetupCommand(`fill ${origin.x - 30} ${origin.y - 1} ${origin.z - 30} ${origin.x + 30} ${origin.y - 1} ${origin.z + 30} stone`);
    await oracle.executeSetupCommand(`fill ${origin.x - 30} ${origin.y} ${origin.z - 30} ${origin.x + 30} ${origin.y + 3} ${origin.z + 30} air`);
    await oracle.executeSetupCommand('damage MinebotTrial 12 minecraft:generic');
    await until(() => actor.health <= 8, 3000);
    const from = actor.entity.position.clone();
    for (const [dx, dz] of [[9, 0], [-9, 0], [0, 9], [0, -9]]) await oracle.executeSetupCommand(`summon minecraft:zombie ${origin.x + 0.5 + dx} ${origin.y} ${origin.z + 0.5 + dz} {PersistenceRequired:1b}`);
    const zombies = () => Object.values(actor.entities).filter(entity => entity.name === 'zombie');
    if (!await until(() => zombies().length === 4, 5000)) throw new Error('ZOMBIES_NOT_VISIBLE');
    const beganAt = Date.now(), health = actor.health;
    let walked = 0, nearest = Infinity, turns = 0, last = actor.entity.position.clone(), heading: { x: number; z: number } | null = null;
    // Five seconds: at a sprint that is short of the platform's rim, thirty blocks off.
    while (Date.now() - beganAt < 5000) {
      await new Promise(resolve => setTimeout(resolve, 250));
      const now = actor.entity.position.clone();
      const step = { x: now.x - last.x, z: now.z - last.z }, length = Math.hypot(step.x, step.z);
      walked += length;
      // A turn: this quarter second's step points more than a right angle away from the one before.
      if (length > 0.3) {
        if (heading && step.x * heading.x + step.z * heading.z < 0) turns++;
        heading = { x: step.x / length, z: step.z / length };
      }
      last = now;
      for (const zombie of zombies()) nearest = Math.min(nearest, now.distanceTo(zombie.position));
    }
    const net = Math.hypot(actor.entity.position.x - from.x, actor.entity.position.z - from.z);
    await oracle.executeSetupCommand('kill @e[type=minecraft:zombie]');
    // Fixed before the run: no death, no hit, at least 12 blocks from the start after five seconds, no doubling back.
    report = { scenario, passed: deaths === 0 && actor.health >= health && net >= 12 && turns === 0,
      escaped: net >= 12, length: +walked.toFixed(1), reached: { net: +net.toFixed(1), turns, nearest: +nearest.toFixed(1) },
      minHealth: Math.min(...trace.map(sample => sample.health)), durationMs: elapsed(), plannerCalls, deaths, runs, trace };
    if (!report.passed) process.exitCode = 1;
  } else if (scenario === 'skeletons') {
    await oracle.executeSetupCommand(`fill ${origin.x - 8} ${origin.y - 5} ${origin.z - 8} ${origin.x + 8} ${origin.y - 1} ${origin.z + 8} stone`);
    await oracle.executeSetupCommand('give MinebotTrial cobblestone 16');
    for (const [dx, dz] of [[12, 0], [-12, 2], [2, 12]]) await oracle.executeSetupCommand(`summon minecraft:skeleton ${origin.x + dx} ${origin.y} ${origin.z + dz} {PersistenceRequired:1b}`);
    // Deterministic trigger: a fleeing bot is not always hit within the window.
    if (process.env.MINECRAFT_OUTAGE_FORCE_HIT === 'true') {
      await new Promise(resolve => setTimeout(resolve, 1500));
      await oracle.executeSetupCommand('damage MinebotTrial 8 minecraft:generic');
    }
    await new Promise(resolve => setTimeout(resolve, 45_000));
    const feet = actor.entity.position.floored();
    const solid = (dx: number, dy: number, dz: number) => actor.blockAt(feet.offset(dx, dy, dz))?.boundingBox === 'block';
    const sealed = solid(0, 2, 0) && [0, 1].every(dy => solid(1, dy, 0) && solid(-1, dy, 0) && solid(0, dy, 1) && solid(0, dy, -1));
    await oracle.executeSetupCommand('kill @e[type=minecraft:skeleton]');
    report = { scenario, passed: deaths === 0 && sealed, sealed, minHealth: Math.min(...trace.map(sample => sample.health)),
      durationMs: elapsed(), plannerCalls, deaths, runs, trace };
    if (!report.passed) process.exitCode = 1;
  } else if (scenario === 'water-pocket') {
    // Water two blocks deep under a dirt ceiling, beside the one-block hole the body came down through.
    // Swum in at a sprint and let go, the body rises against the ceiling, where the server holds it crouched
    // with its head under water. The way to air is back to the hole, 1.5 m away (paid run L38 dug at the ceiling and drowned).
    const { verifyNativeBreathingSafety } = await import('../src/services/minebot/cognition/GoalVerifier.js');
    const { bodyPose } = await import('../src/services/minebot/utils/bodyPose.js');
    const tx = origin.x + 6, ty = origin.y, tz = origin.z;
    await oracle.executeSetupCommand('gamerule random_tick_speed 0');
    await oracle.executeSetupCommand(`fill ${tx - 2} ${ty - 1} ${tz - 2} ${tx + 6} ${ty + 4} ${tz + 2} stone`);
    await oracle.executeSetupCommand(`fill ${tx - 2} ${ty + 5} ${tz - 2} ${tx + 6} ${ty + 8} ${tz + 2} air`);
    await oracle.executeSetupCommand(`fill ${tx} ${ty + 1} ${tz} ${tx + 3} ${ty + 2} ${tz} water`);
    await oracle.executeSetupCommand(`fill ${tx + 1} ${ty + 3} ${tz} ${tx + 3} ${ty + 3} ${tz} dirt`);
    await oracle.executeSetupCommand(`fill ${tx} ${ty + 3} ${tz} ${tx} ${ty + 4} ${tz} air`);
    await oracle.executeSetupCommand(`tp MinebotTrial ${tx + 0.5} ${ty + 3} ${tz + 0.5}`);
    await new Promise(resolve => setTimeout(resolve, 3000));
    const { airTrailPoints: trailNow } = await import('../src/services/minebot/utils/breathingReflex.js');
    const atHole = { dx: +(actor.entity.position.x - tx).toFixed(2), dy: +(actor.entity.position.y - ty).toFixed(2), oxygen: actor.oxygenLevel,
      trail: trailNow(actor).map(point => `${(point.x - tx).toFixed(1)},${(point.y - ty).toFixed(1)}`) };
    const lowestOxygen = { value: 20 };
    timers.push(setInterval(() => { lowestOxygen.value = Math.min(lowestOxygen.value, actor.oxygenLevel ?? 20); }, 100));
    let pressed: any = null;
    await executeAction(actor, 'move-to', 8_000, async () => {
      const until = Date.now() + 4000;
      while (Date.now() < until && actor.entity.position.x < tx + 2.4 && deaths === 0) {
        assertActionActive(actor);
        const p = actor.entity.position;
        await actor.lookAt(new (p.constructor as any)(tx + 3.5, p.y + 1.2, tz + 0.5), true);
        actor.setControlState('forward', true); actor.setControlState('sprint', true); actor.setControlState('jump', p.x > tx + 1.2);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      await new Promise(resolve => setTimeout(resolve, 600));
      actor.clearControlStates();
      return { success: true, result: 'swam under the ceiling' };
    });
    const { retraceFeasible, airTrailPoints } = await import('../src/services/minebot/utils/breathingReflex.js');
    const { surfacingPossible } = await import('../src/services/minebot/constantSkills/autoSwim.js');
    pressed = { dx: +(actor.entity.position.x - tx).toFixed(2), dy: +(actor.entity.position.y - ty).toFixed(2), pose: bodyPose(actor).name, oxygen: actor.oxygenLevel,
      retraceFeasible: retraceFeasible(actor as any), surfacingPossible: surfacingPossible(actor as any),
      trail: airTrailPoints(actor).map(point => `${(point.x - tx).toFixed(1)},${(point.y - ty).toFixed(1)}`) };
    // Who moves the keys once the body is let go (to see what fights the retrace).
    const keyCalls = new Map<string, number>();
    const nativeSet = actor.setControlState.bind(actor), nativeClear = actor.clearControlStates.bind(actor);
    const caller = () => (new Error().stack ?? '').split('\n').slice(3, 6).map(line => line.replace(/^.*\/(src|scripts|node_modules)\//, '').replace(/\)$/, '').trim().split(' ').pop()).join(' < ');
    const keyLog: string[] = [];
    const t0 = Date.now();
    const ticks: string[] = [];
    actor.on('physicsTick', () => {
      if (!keyLog.length || ticks.length >= 44) return;
      const p = actor.entity.position, v = actor.entity.velocity;
      ticks.push(`${Date.now() - t0}ms (${(p.x - tx).toFixed(2)},${(p.y - ty).toFixed(2)},${(p.z - tz).toFixed(2)}) yaw=${actor.entity.yaw.toFixed(2)} v=(${v.x.toFixed(3)},${v.y.toFixed(3)},${v.z.toFixed(3)}) `
        + `${['forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint'].filter(key => actor.getControlState(key as any)).join('+')} guard=${(actor as any).edgeGuard?.stops ?? '-'} water=${(actor.entity as any).isInWater}`);
    });
    (actor as any).setControlState = (name: any, value: boolean) => { if ((actor.oxygenLevel ?? 20) < 10) { const k = `${name}=${value} @ ${caller()}`; keyCalls.set(k, (keyCalls.get(k) ?? 0) + 1);
      if (keyLog.length < 90 && actor.getControlState(name) !== value) { const p = actor.entity.position; keyLog.push(`${Date.now() - t0}ms (${(p.x - tx).toFixed(2)},${(p.y - ty).toFixed(2)}) ${name}=${value} ${caller().split(' < ').slice(0, 2).map(c => c.split('/').pop()).join('<')}`); } } return nativeSet(name, value); };
    (actor as any).clearControlStates = () => { if ((actor.oxygenLevel ?? 20) < 10) { const k = `CLEAR @ ${caller()}`; keyCalls.set(k, (keyCalls.get(k) ?? 0) + 1); } return nativeClear(); };
    const path: string[] = [];
    timers.push(setInterval(() => { const p = actor.entity.position; if (path.length < 120) path.push(`${(p.x - tx).toFixed(1)},${(p.y - ty).toFixed(1)}:${actor.oxygenLevel}:${['forward', 'back', 'jump', 'sneak', 'sprint'].filter(key => actor.getControlState(key as any)).join('+')}`); }, 500));
    let safeSince: number | null = null;
    const out = await until(() => {
      const safe = deaths === 0 && verifyNativeBreathingSafety(actor).status === 'verified' && (actor.oxygenLevel ?? 0) >= 18;
      safeSince = safe ? safeSince ?? Date.now() : null;
      return deaths > 0 || (safeSince !== null && Date.now() - safeSince >= 2000);
    }, 45_000);
    await oracle.executeSetupCommand('gamerule random_tick_speed 3');
    report = { scenario, passed: out && deaths === 0 && pressed.dx >= 1.2 && lowestOxygen.value >= 1, deaths, atHole, reached: pressed, keyLog, ticks, path, keyCalls: [...keyCalls.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14), lowestOxygen: lowestOxygen.value,
      final: { x: +(actor.entity.position.x - tx).toFixed(1), y: +(actor.entity.position.y - ty).toFixed(1) },
      minHealth: Math.min(...trace.map(sample => sample.health)), durationMs: elapsed(), plannerCalls, runs, trace };
    if (!report.passed) process.exitCode = 1;
  } else if (scenario === 'walled-off') {
    // Two zombies in the next chamber with solid stone between: near, but they can neither see nor reach the
    // body. No emergency and nothing to flee from until the wall is opened (paid run L33).
    const { captureWorldObservation } = await import('../src/services/minebot/cognition/worldFrame.js');
    const { x: ox, y: oy, z: oz } = origin;
    await oracle.executeSetupCommand(`fill ${ox - 3} ${oy - 1} ${oz - 3} ${ox + 11} ${oy + 4} ${oz + 3} stone`);
    await oracle.executeSetupCommand(`fill ${ox - 1} ${oy} ${oz - 1} ${ox + 1} ${oy + 1} ${oz + 1} air`);
    await oracle.executeSetupCommand(`fill ${ox + 6} ${oy} ${oz - 1} ${ox + 8} ${oy + 1} ${oz + 1} air`);
    await oracle.executeSetupCommand(`tp MinebotTrial ${ox + 0.5} ${oy} ${oz + 0.5}`);
    for (const dz of [-0.5, 0.5]) await oracle.executeSetupCommand(`summon minecraft:zombie ${ox + 7.5} ${oy} ${oz + 0.5 + dz} {PersistenceRequired:1b}`);
    const emergencies = () => runs.filter(run => run.mode === 'emergency').length;
    const before = emergencies();
    await new Promise(resolve => setTimeout(resolve, 12_000));
    const seenThreats = (captureWorldObservation(actor).nearbyThreats ?? []).map(entity => ({ name: entity.name, distance: Math.round(entity.distance), canReachMe: entity.canReachMe }));
    const flee: any = await actor.instantSkills.getSkill('flee-from')!.run('hostile', 24, 5000);
    const sealed = { emergencies: emergencies() - before, emergencyMode: runtime.isInEmergencyMode(), threats: seenThreats,
      flee: String(flee?.result ?? '').slice(0, 60), moved: +actor.entity.position.distanceTo(new (actor.entity.position.constructor as any)(ox + 0.5, oy, oz + 0.5)).toFixed(1) };
    // Open a way between the chambers: the same zombies are now a threat.
    await oracle.executeSetupCommand(`fill ${ox + 2} ${oy} ${oz} ${ox + 5} ${oy + 1} ${oz} air`);
    const noticed = await until(() => emergencies() > before || fleeStarts > 0 || counterattacks > 0 || runtime.isInEmergencyMode(), 15_000);
    await oracle.executeSetupCommand('kill @e[type=minecraft:zombie]');
    report = { scenario, passed: deaths === 0 && sealed.emergencies === 0 && !sealed.emergencyMode && sealed.moved < 1.5
      && sealed.threats.length === 2 && sealed.threats.every(threat => threat.canReachMe === false) && sealed.flee.includes('逃げる必要はありません') && noticed,
      sealed, noticedAfterOpening: noticed, fleeStarts, counterattacks, minHealth: Math.min(...trace.map(sample => sample.health)),
      final: actor.entity.position, durationMs: elapsed(), plannerCalls, deaths, runs, trace };
    if (!report.passed) process.exitCode = 1;
  } else if (scenario === 'buried') {
    await oracle.executeSetupCommand('difficulty peaceful');
    await oracle.executeSetupCommand(`fill ${origin.x - 1} ${origin.y} ${origin.z - 1} ${origin.x + 1} ${origin.y + 3} ${origin.z + 1} stone`);
    await oracle.executeSetupCommand(`fill ${origin.x} ${origin.y} ${origin.z} ${origin.x} ${origin.y + 1} ${origin.z} air`);
    await oracle.executeSetupCommand(`setblock ${origin.x} ${origin.y + 1} ${origin.z} sand`);
    await new Promise(resolve => setTimeout(resolve, 30_000));
    const head = actor.blockAt(actor.entity.position.offset(0, 1.62, 0).floored());
    const foot = actor.blockAt(actor.entity.position.offset(0, 0.1, 0).floored());
    report = { scenario, passed: deaths === 0 && head?.boundingBox !== 'block' && foot?.boundingBox !== 'block',
      head: head?.name, foot: foot?.name, durationMs: elapsed(), plannerCalls, deaths, runs, trace };
    if (!report.passed) process.exitCode = 1;
  } else if (scenario === 'water-trap') {
    const { verifyNativeBreathingSafety } = await import('../src/services/minebot/cognition/GoalVerifier.js');
    // A finished run's world, looked at afterwards: MINECRAFT_OUTAGE_TRAP_AT="x,y,z" puts the body where the
    // run's body ended, to see what the reflexes do from there (never during a run).
    const trapAt = (process.env.MINECRAFT_OUTAGE_TRAP_AT ?? '').split(',').map(Number);
    if (trapAt.length === 3 && trapAt.every(Number.isFinite)) {
      // MINECRAFT_OUTAGE_TRAP_RESTORE="x,y,z,block;...": blocks an earlier look at the same place broke, put back.
      for (const entry of (process.env.MINECRAFT_OUTAGE_TRAP_RESTORE ?? '').split(';').filter(Boolean)) {
        const [bx, by, bz, name] = entry.split(',');
        if (/^-?\d+$/.test(bx) && /^-?\d+$/.test(by) && /^-?\d+$/.test(bz) && /^[a-z_]+$/.test(name)) await oracle.executeSetupCommand(`setblock ${bx} ${by} ${bz} minecraft:${name}`);
      }
      await oracle.executeSetupCommand('effect give MinebotTrial minecraft:instant_health 1 5');
      await oracle.executeSetupCommand(`tp MinebotTrial ${trapAt[0]} ${trapAt[1]} ${trapAt[2]}`);
      await until(() => Math.hypot(actor.entity.position.x - trapAt[0], actor.entity.position.z - trapAt[2]) < 1 && !!(actor.entity as any).isInWater, 8000);
    }
    const startedInWater = !!(actor.entity as any).isInWater;
    const escaped = await until(() => deaths > 0 || verifyNativeBreathingSafety(actor).status === 'verified' && !(actor.entity as any).isInWater
      && actor.oxygenLevel >= 20, Number(process.env.MINECRAFT_OUTAGE_TRAP_MS ?? 180_000)) && deaths === 0;
    report = { scenario, passed: startedInWater && escaped && deaths === 0, startedInWater, escaped, durationMs: elapsed(),
      origin, final: actor.entity.position, plannerCalls, networkRequests: 0, deaths, runs, taskList: runtime.getTaskListState(), trace };
    if (!report.passed) process.exitCode = 1;
  } else if (scenario === 'witch') {
    await oracle.executeSetupCommand(`summon minecraft:witch ${origin.x + 9} ${origin.y} ${origin.z} {PersistenceRequired:1b}`);
    if (!await until(() => zombieDistance() !== null, 5000)) throw new Error('WITCH_NOT_VISIBLE');
    const observeFrom = elapsed();
    await new Promise(resolve => setTimeout(resolve, witchObserveMs));
    const samples = trace.filter(sample => sample.atMs >= observeFrom + 5000);
    const beyondRatio = samples.filter(sample => sample.zombieDistance === null || sample.zombieDistance > witchReach).length
      / Math.max(1, samples.length);
    await oracle.executeSetupCommand('kill @e[type=minecraft:witch]');
    const passed = deaths === 0 && plannerCalls > 0 && beyondRatio >= witchMinBeyondRatio && fleeStarts <= witchMaxFleeStarts;
    report = { scenario, passed, durationMs: elapsed(), port, worldDirectory, plannerCalls, networkRequests: 0, deaths,
      criteria: { witchObserveMs, witchReach, witchMinBeyondRatio, witchMaxFleeStarts },
      beyondRatio, fleeStarts, minHealth: Math.min(...trace.map(sample => sample.health)), runs,
      taskList: runtime.getTaskListState(), trace };
    if (!passed) process.exitCode = 1;
  } else if (scenario === 'poison') {
    await oracle.executeSetupCommand('damage MinebotTrial 12 minecraft:generic');
    await until(() => actor.health <= 8, 3000);
    await oracle.executeSetupCommand(`summon minecraft:zombie ${origin.x + 6} ${origin.y} ${origin.z} {PersistenceRequired:1b}`);
    if (!await until(() => zombieDistance() !== null, 5000)) throw new Error('ZOMBIE_NOT_VISIBLE');
    await oracle.executeSetupCommand('effect give MinebotTrial minecraft:poison 30 1');
    const observeFrom = elapsed();
    await new Promise(resolve => setTimeout(resolve, poisonObserveMs));
    const samples = trace.filter(sample => sample.atMs >= observeFrom + 3000);
    const beyondRatio = samples.filter(sample => sample.zombieDistance === null || sample.zombieDistance > poisonMinGap).length
      / Math.max(1, samples.length);
    await oracle.executeSetupCommand('kill @e[type=minecraft:zombie]');
    const passed = deaths === 0 && plannerCalls > 0 && beyondRatio >= poisonMinBeyondRatio && fleeStarts <= poisonMaxFleeStarts;
    report = { scenario, passed, durationMs: elapsed(), port, worldDirectory, plannerCalls, networkRequests: 0, deaths,
      criteria: { poisonObserveMs, poisonMinGap, poisonMinBeyondRatio, poisonMaxFleeStarts },
      beyondRatio, fleeStarts, minHealth: Math.min(...trace.map(sample => sample.health)), runs,
      taskList: runtime.getTaskListState(), trace };
    if (!passed) process.exitCode = 1;
  } else {
    // Open ground: left inside a sealed chamber by an earlier scenario, the body rightly ignores a zombie it is walled off from.
    await oracle.executeSetupCommand(`fill ${origin.x - 30} ${origin.y - 1} ${origin.z - 30} ${origin.x + 30} ${origin.y - 1} ${origin.z + 30} stone`);
    await oracle.executeSetupCommand(`fill ${origin.x - 30} ${origin.y} ${origin.z - 30} ${origin.x + 30} ${origin.y + 3} ${origin.z + 30} air`);
    await oracle.executeSetupCommand('damage MinebotTrial 12 minecraft:generic');
    await until(() => actor.health <= 8, 3000);
    await oracle.executeSetupCommand(`summon minecraft:zombie ${origin.x + 6} ${origin.y} ${origin.z} {PersistenceRequired:1b}`);
    if (!await until(() => zombieDistance() !== null, 5000)) throw new Error('ZOMBIE_NOT_VISIBLE');

    const placeZombie = async (distance: number) => {
      const position = actor.entity.position;
      const target = zombie();
      if (!target) throw new Error('ZOMBIE_LOST');
      const away = position.minus(target.position);
      const scale = distance / Math.max(0.001, Math.hypot(away.x, away.z));
      const x = position.x - away.x * scale, z = position.z - away.z * scale;
      await oracle.executeSetupCommand(`tp @e[type=minecraft:zombie,limit=1] ${x.toFixed(1)} ${Math.floor(position.y)} ${z.toFixed(1)}`);
    };
    await until(() => (zombieDistance() ?? 0) > 12, 15000);
    for (let cycle = 1; cycle <= cycles && !deaths; cycle++) {
      // The pursuer leaves the 16m clearance radius for longer than the 600ms
      // stability window that previously released the lease, then returns.
      await placeZombie(clearDistance);
      const cleared = await until(() => (zombieDistance() ?? 0) > 16, 3000);
      const clearedAtMs = elapsed();
      await new Promise(resolve => setTimeout(resolve, clearHoldMs));
      const clearedFor = trace.filter(sample => sample.atMs >= clearedAtMs && (sample.zombieDistance ?? 0) > 16).length * 250;
      const containmentHeld = runtime.isInEmergencyMode();
      await placeZombie(reapproachDistance);
      await until(() => (zombieDistance() ?? 99) < reapproachDistance + 2, 3000);
      const reapproachAtMs = elapsed();
      const startDistance = zombieDistance();
      const escaped = await until(() => (zombieDistance() ?? 0) >= (startDistance ?? reapproachDistance) + escapeGainMeters, escapeWindowMs);
      cycleResults.push({ cycle, cleared, clearedAtMs, clearedForMs: clearedFor, containmentHeld, reapproachAtMs, startDistance, escaped,
        escapeMs: escaped ? elapsed() - reapproachAtMs : null, endDistance: zombieDistance(), health: actor.health, deaths });
    }
    await oracle.executeSetupCommand('kill @e[type=minecraft:zombie]');
    const passed = deaths === 0 && plannerCalls > 0 && cycleResults.length === cycles
      && cycleResults.every(result => result.cleared && result.clearedForMs >= 1000 && result.containmentHeld && result.escaped);
    report = { passed, durationMs: elapsed(), port, worldDirectory, plannerCalls, networkRequests: 0, deaths,
      criteria: { cycles, clearDistance, clearHoldMs, minClearedMs: 1000, reapproachDistance, escapeGainMeters, escapeWindowMs },
      cycleResults, runs,
      taskList: runtime.getTaskListState(), trace };
  }
} catch (error) {
  report = { passed: false, durationMs: elapsed(), error: String(error), plannerCalls, deaths, cycleResults, runs,
    taskList: runtime.getTaskListState(), trace };
  process.exitCode = 1;
} finally {
  for (const timer of timers) clearInterval(timer);
  reactions.destroy();
  for (const skill of actor.constantSkills.getSkills()) registrar.detachConstantSkillInterval(actor, skill.skillName);
  runtime.forceStop();
  closeProbeBot(actor); closeProbeBot(operator);
  const file = path.resolve('saves/minecraft/progressive_reports', `${new Date().toISOString().replace(/[:.]/g, '-')}-planner-outage-flee.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(`OUTAGE_FLEE_RESULT ${JSON.stringify({ scenario, passed: report.passed, durationMs: report.durationMs, plannerCalls,
    fleeStarts, beyondRatio: report.beyondRatio, minHealth: report.minHealth,
    deaths, cycles: cycleResults.map(result => ({ clearedForMs: result.clearedForMs, containmentHeld: result.containmentHeld,
      escaped: result.escaped, escapeMs: result.escapeMs, startDistance: result.startDistance,
      endDistance: result.endDistance, health: result.health })), error: report.error })}`);
  console.log(`OUTAGE_FLEE_REPORT ${file}`);
}
