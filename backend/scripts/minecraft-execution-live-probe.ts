#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import dotenv from 'dotenv';
import { Vec3 } from 'vec3';
import { createProbeBot, closeProbeBot } from '../src/services/minebot/testing/MinecraftProbeBot.js';
import { MinecraftCommandOracle, type MinecraftCommandAssertion as Assertion } from '../src/services/minebot/testing/MinecraftCommandOracle.js';
import { withActionSignal } from '../src/services/minebot/execution/ActionExecution.js';
import { waitForObservation, type ObservationSource } from '../src/services/minebot/execution/observedWait.js';
import { ExecutionSupervisor } from '../src/services/minebot/cognition/ExecutionSupervisor.js';
import { createConfiguredExecutionCritic } from '../src/services/minebot/cognition/JevExecutionCritic.js';
import { TaskWorkspace } from '../src/services/minebot/cognition/TaskWorkspace.js';
import { captureWorldObservation, diffWorldFrames } from '../src/services/minebot/cognition/worldFrame.js';
import type { CustomBot } from '../src/services/minebot/types.js';
import type { ActionProgress } from '../src/services/minebot/execution/actionTypes.js';

const port = Number(process.env.MINECRAFT_PROBE_PORT ?? 25577);
const repeats = Number(process.env.MINECRAFT_EXECUTION_REPEATS ?? 2);
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 3) throw new Error('Invalid repeats');
const useJev = process.env.MINECRAFT_EXECUTION_PROBE_JEV === 'true';
// The dedicated Minebot-only credential stays in memory. Never load shared .env,
// print the credential, change the protected file or start the Shannon service.
const protectedEnvironment = useJev
  ? dotenv.parse(fs.readFileSync('/home/azureuser/.config/shannon/minebot-jev.env')) : {};
const critic = useJev ? createConfiguredExecutionCritic({ ...protectedEnvironment,
  MINECRAFT_COGNITION_PROVIDER: 'jev', SHANNON_JEV_TIMEOUT_MS: '900' }) : undefined;
if (useJev && critic?.source !== 'jev') throw new Error('Dedicated Jev credential unavailable');
const hash = createHash('sha256');
for (const directory of ['instantSkills', 'constantSkills', 'combat', 'utils', 'testing', 'execution', 'types', 'cognition']) {
  const root = path.resolve('src/services/minebot', directory);
  for (const file of fs.readdirSync(root).filter(f => f.endsWith('.ts')).sort()) {
    hash.update(`${directory}/${file}\0`).update(fs.readFileSync(path.join(root, file)));
  }
}
hash.update(fs.readFileSync('scripts/minecraft-execution-live-probe.ts'));
const sourceFingerprint = hash.digest('hex');
const campaignId = new Date().toISOString().replace(/[:.]/g, '-');
const directory = path.resolve('saves/minecraft/progressive_reports');
fs.mkdirSync(directory, { recursive: true });
const results: any[] = [];
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const inv = (item: string, count: number): Assertion => ({ type: 'inventory_count', item, minCount: count, maxCount: count });
const alive: Assertion = { type: 'health_between', min: 1, max: 20 };

class Scenario {
  readonly steps: any[] = [];
  readonly progress: ActionProgress[] = [];
  readonly workspace: TaskWorkspace;
  readonly supervisor: ExecutionSupervisor;
  deaths = 0;
  constructor(readonly bot: CustomBot, readonly oracle: MinecraftCommandOracle, name: string, repeat: number) {
    this.workspace = new TaskWorkspace({ runId: `${campaignId}:${name}:${repeat}`, goal: name === 'smelt_overlap'
      ? 'Smelt 3 raw iron into 3 ingots, prepare and place a chest using harvested logs while the furnace works, and craft an iron pickaxe. Normal smelting takes approximately 30 seconds; do not claim completion until items are in inventory.'
      : name });
    bot.on('death', () => this.deaths++);
    bot.on('minebotActionProgress', progress => this.progress.push(structuredClone(progress)));
    this.supervisor = new ExecutionSupervisor({ bot, workspace: this.workspace, critic,
      mode: 'shadow', minimumRequestMs: 6000 });
  }
  async setup(commands: string[]) {
    for (const command of commands) await this.oracle.executeSetupCommand(command);
    await sleep(400);
  }
  async assert(label: string, assertions: Assertion[]) {
    const results = await this.oracle.evaluateAll(assertions);
    this.steps.push({ label, assertions: results });
    if (results.some(result => !result.passed)) throw new Error(`Server assertion failed: ${label}`);
  }
  async skill(name: string, args: unknown[], assertions: Assertion[] = [], expected = true) {
    const skill = this.bot.instantSkills.getSkill(name);
    if (!skill) throw new Error(`Missing skill ${name}`);
    const before = this.workspace.observeWorld(captureWorldObservation(this.bot));
    const startedAt = Date.now();
    const result = await skill.run(...args);
    const after = this.workspace.observeWorld(captureWorldObservation(this.bot));
    this.workspace.recordReceipt({ id: `${name}:${this.steps.length}`, runId: this.workspace.runId,
      iteration: this.steps.length, actionKind: 'instant_skill', capability: name, args: { positional: args },
      intendedEffect: name, startedAt: new Date(startedAt).toISOString(), finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt, beforeRevision: before.revision, afterRevision: after.revision,
      success: result.success, failureType: result.failureType ?? null, recoverable: result.recoverable ?? null,
      resultSummary: result.result, observedDelta: diffWorldFrames(before, after),
      meaningfulWorldAction: name !== 'get-background-jobs', execution: result.execution });
    this.steps.push({ name, args, startedAt, durationMs: Date.now() - startedAt, result });
    process.stdout.write(`EXECUTION_STEP ${JSON.stringify({ name, args, durationMs: Date.now() - startedAt, success: result.success, failureType: result.failureType })}\n`);
    if (this.deaths > 0) throw new Error('Player death is not successful respawn');
    if (result.success !== expected) throw new Error(`Unexpected skill outcome ${name}: ${result.result}`);
    if (assertions.length) await this.assert(name, assertions);
    return result;
  }
  async reset() {
    await this.setup([
      '/gamemode creative @s', '/execute in minecraft:overworld run tp @s 0 100 0',
      '/difficulty peaceful', '/gamerule doMobSpawning false', '/gamerule doDaylightCycle false', '/gamerule doWeatherCycle false',
      '/time set day', '/weather clear', '/effect clear @s', '/effect give @s saturation 1 10 true', '/clear @s',
      '/fill -20 98 -20 20 98 20 bedrock', '/fill -20 99 -20 20 99 20 cobblestone',
      '/fill -20 100 -20 20 106 20 air', '/kill @e[type=!player]', '/tp @s 0 100 0', '/gamemode survival @s',
    ]);
    await this.assert('fixture', [alive, { type: 'gamerule', rule: 'spawn_mobs', value: false },
      { type: 'gamemode', gamemode: 'survival' }, { type: 'position_within', x: 0, y: 100, z: 0, radius: 2 }]);
  }
}

async function targetLoot(t: Scenario, all = false) {
  await t.setup(['/give @s iron_axe 1', '/fill 4 100 0 4 102 0 oak_log',
    '/summon item -4 100 0 {Tags:["execution_distractor"],PickupDelay:0s,Item:{id:"minecraft:wheat_seeds",count:6}}']);
  await t.assert('distractor-present', [{ type: 'entity_count', entity: 'item', tag: 'execution_distractor',
    x: 0, y: 100, z: 0, radius: 16, minCount: 1, maxCount: 1 }]);
  await t.skill('mine-block', ['oak_log', 3, 16, all ? 'all' : 'target'], [inv('oak_log', 3),
    inv('wheat_seeds', all ? 6 : 0), alive,
    { type: 'entity_count', entity: 'item', tag: 'execution_distractor', x: 0, y: 100, z: 0, radius: 16,
      minCount: all ? 0 : 1, maxCount: all ? 0 : 1 }]);
}

async function interruptResume(t: Scenario) {
  await t.setup(['/give @s wooden_pickaxe 1', '/fill 1 100 2 4 100 3 stone']);
  const targets = new Set(Array.from({ length: 4 }, (_, x) => [2, 3].map(z => `${x + 1},100,${z}`)).flat());
  const completed = new Set<string>();
  const controller = new AbortController();
  const observe = (block: any) => {
    const key = block.position && `${block.position.x},${block.position.y},${block.position.z}`;
    if (!targets.has(key)) return;
    completed.add(key);
    if (completed.size >= 2) controller.abort('isolated-interruption-test');
  };
  t.bot.on('diggingCompleted', observe);
  let result;
  try {
    result = await withActionSignal(t.bot, controller.signal,
      () => t.bot.instantSkills.getSkill('mine-block')!.run('stone', 8, 8));
  } catch (error) { t.bot.removeListener('diggingCompleted', observe); throw error; }
  t.steps.push({ name: 'interrupt-mine', result, completedTargets: [...completed] });
  if (result.failureType !== 'interrupted' || completed.size < 2 || completed.size >= 8) throw new Error('Interruption did not preserve partial work');
  const actionId = result.execution?.actionId;
  await waitForObservation({}, () => t.progress.some(p => p.actionId === actionId && p.status === 'cancelled'), 3000,
    [{ source: t.bot as unknown as ObservationSource, event: 'minebotActionProgress' }]);
  if (t.bot.executingSkill) throw new Error('Cancelled action did not become quiescent');
  const actualDigs = [...completed];
  await sleep(600);
  t.bot.removeListener('diggingCompleted', observe);
  if (completed.size !== actualDigs.length) throw new Error('Cancelled action continued digging after quiescence');
  const remaining = 8 - completed.size;
  t.steps.push({ label: 'quiescent-before-resume', actualDigs, remaining });
  await t.skill('mine-block', ['stone', remaining, 8], [inv('cobblestone', 8), alive]);
  await t.assert('all-targets-excavated', [...targets].map(key => {
    const [x, y, z] = key.split(',').map(Number);
    return { type: 'block_at' as const, x, y, z, block: 'air' };
  }));
}

async function smeltOverlap(t: Scenario) {
  await t.setup(['/give @s raw_iron 3', '/give @s coal 1', '/give @s iron_axe 1',
    '/setblock 1 100 2 crafting_table', '/setblock 2 100 3 furnace', '/fill 8 100 0 8 102 0 oak_log']);
  t.workspace.observeWorld(captureWorldObservation(t.bot));
  t.supervisor.start();
  await t.skill('start-smelting', [2, 100, 3, 'raw_iron', 'coal', 3], [inv('raw_iron', 0)]);
  const waiting = await t.skill('withdraw-from-furnace', [2, 100, 3, 'output', false], [], false);
  if (waiting.failureType !== 'waiting_external' || t.bot.activeFurnaces.length !== 1) throw new Error('Nonblocking furnace wait lost the pending job');
  const jobs = await t.skill('get-background-jobs', []);
  const pending = JSON.parse(jobs.result).jobs;
  if (pending.length !== 1 || pending[0].completionVerified !== false) throw new Error('Predicted completion was falsely verified');
  const independentStart = Date.now();
  await t.skill('mine-block', ['oak_log', 3, 16], [inv('oak_log', 3)]);
  await t.skill('craft-one', ['oak_planks', 12], [inv('oak_planks', 12)]);
  await t.skill('craft-one', ['stick', 4], [inv('stick', 4)]);
  await t.skill('craft-one', ['chest', 1], [inv('chest', 1)]);
  await t.skill('move-to', [2, 100, 3, 2, 'near']);
  await t.skill('place-block-at', ['chest', 0, 100, 4], [{ type: 'block_at', x: 0, y: 100, z: 4, block: 'chest' }]);
  const independentWorkMs = Date.now() - independentStart;
  const withdrawn = await t.skill('withdraw-from-furnace', [2, 100, 3, 'output'], [inv('iron_ingot', 3)]);
  const furnaceProgress = t.progress.filter(p => p.actionId === withdrawn.execution?.actionId
    && p.phase === 'wait_external' && p.evidence.kind === 'smelting');
  const outputCounts = furnaceProgress.map(p => (p.evidence.output as { count: number } | null)?.count ?? 0);
  if (!outputCounts.includes(3) || new Set(outputCounts).size < 2
    || !furnaceProgress.some(p => p.lastProgressAt > furnaceProgress[0].lastProgressAt)) {
    throw new Error('Native furnace updates did not reach live action progress');
  }
  t.steps.push({ label: 'live-furnace-progress', outputCounts,
    remainingInputCounts: furnaceProgress.map(p => (p.evidence.input as { count: number } | null)?.count ?? 0) });
  await t.skill('craft-one', ['iron_pickaxe', 1], [inv('iron_pickaxe', 1), alive]);
  t.steps.push({ label: 'overlap-timing', independentWorkMs,
    remainingFurnaceWaitMs: withdrawn.execution?.phaseMs.wait_external ?? 0,
    classifierRequests: t.supervisor.assessments.length,
    assessments: t.supervisor.assessments });
  t.supervisor.stop(); await t.supervisor.drain();
  if (useJev && !t.supervisor.assessments.some(a => a.assessment.source === 'jev')) throw new Error('No real in-action Jev assessment');
  if (t.supervisor.assessments.some(a => a.applied)) throw new Error('Shadow assessment changed bot control');
}

for (let repeat = 1; repeat <= repeats; repeat++) for (const name of ['target_loot', 'collect_all', 'interrupt_resume', 'smelt_overlap']) {
  const startedAt = Date.now(); let bot: CustomBot | undefined; let trial: Scenario | undefined; let error: string | null = null;
  try {
    bot = await createProbeBot(port);
    trial = new Scenario(bot, new MinecraftCommandOracle(bot), name, repeat);
    await trial.oracle.verifyReady(); await trial.reset();
    if (name === 'target_loot' || name === 'collect_all') await targetLoot(trial, name === 'collect_all');
    else if (name === 'interrupt_resume') await interruptResume(trial);
    else await smeltOverlap(trial);
  } catch (caught) { error = caught instanceof Error ? caught.message : String(caught); }
  finally {
    trial?.supervisor.stop(); await trial?.supervisor.drain();
    if (bot) closeProbeBot(bot); await sleep(500);
  }
  const result = { name, repeat, passed: error === null, error, durationMs: Date.now() - startedAt,
    deaths: trial?.deaths ?? 0, steps: trial?.steps ?? [], progress: trial?.progress ?? [],
    workspace: trial?.workspace.snapshot(), assessments: trial?.supervisor.assessments ?? [] };
  results.push(result);
  fs.writeFileSync(path.join(directory, `${campaignId}-execution-${name}-${repeat}.json`), JSON.stringify(result, null, 2));
  process.stdout.write(`EXECUTION_TRIAL_END ${JSON.stringify({ name, repeat, passed: result.passed, error, durationMs: result.durationMs })}\n`);
}
const report = { campaignId, sourceFingerprint, port, repeats, jev: useJev,
  total: results.length, passed: results.filter(r => r.passed).length, ok: results.every(r => r.passed) };
fs.writeFileSync(path.join(directory, `${campaignId}-execution-summary.json`), JSON.stringify(report, null, 2));
process.stdout.write(`MINECRAFT_EXECUTION_REPORT ${JSON.stringify(report)}\n`);
process.exitCode = report.ok ? 0 : 1;
