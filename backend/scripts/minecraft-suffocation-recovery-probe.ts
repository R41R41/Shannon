#!/usr/bin/env node
// Isolated, non-billable real-game regression for the native breathing gate.
// The fixture deliberately claims emergency completion while the bot is still
// underwater. Only real Minecraft air/block observations may resume the goal.
import fs from 'node:fs';
import path from 'node:path';
import { createProbeBot, closeProbeBot } from '../src/services/minebot/testing/MinecraftProbeBot.js';
import { MinecraftCommandOracle } from '../src/services/minebot/testing/MinecraftCommandOracle.js';
import { GoalVerifier, verifyNativeBreathingSafety, type GoalContract } from '../src/services/minebot/cognition/GoalVerifier.js';
import { MinebotTaskRuntime } from '../src/services/minebot/runtime/MinebotTaskRuntime.js';
import { BotEventHandler } from '../src/services/minebot/events/BotEventHandler.js';
import { EventReactionSystem } from '../src/services/minebot/eventReaction/EventReactionSystem.js';
import { loadEventReactionSettingsFile } from '../src/services/minebot/eventReaction/eventReactionSettingsStore.js';
import { SkillRegistrar } from '../src/services/minebot/skills/SkillRegistrar.js';

const port = Number(process.env.MINECRAFT_SUFFOCATION_PORT ?? 0);
const worldDirectory = process.env.MINECRAFT_SUFFOCATION_WORLD_DIRECTORY ?? '';
if (process.env.SHANNON_ISOLATED_MINEBOT_PROBE !== 'true'
  || process.env.MINECRAFT_COGNITION_MODE !== 'off'
  || !Number.isInteger(port) || port < 25577 || port > 25650
  || !/^\/home\/azureuser\/minecraft\/progressive-lab-[A-Za-z0-9]+$/.test(worldDirectory)
  || path.basename(worldDirectory) === 'progressive-lab-c72uUG') {
  throw new Error('ISOLATED_NON_BILLABLE_SUFFOCATION_LAB_REQUIRED');
}
const properties = fs.readFileSync(path.join(worldDirectory, 'server.properties'), 'utf8');
if (!properties.split(/\r?\n/).includes('server-ip=127.0.0.1')
  || !properties.split(/\r?\n/).includes(`server-port=${port}`)
  || JSON.parse(fs.readFileSync(path.join(worldDirectory, 'ops.json'), 'utf8'))
    .some((entry: { name?: string }) => entry.name === 'MinebotTrial')) {
  throw new Error('ISOLATED_LAB_CONFIGURATION_OR_NON_OP_ACTOR_INVALID');
}

const rootGoal = 'エンドラを倒す';
const startedAt = Date.now();
const operator = await createProbeBot(port);
const actor = await createProbeBot(port, 'MinebotTrial');
const oracle = new MinecraftCommandOracle(operator);
const runtime = new MinebotTaskRuntime(actor);
const originalSettings = loadEventReactionSettingsFile();
const isolatedSettings = { ...originalSettings, reactions: originalSettings.reactions.map(row => ({
  ...row, enabled: row.eventType === 'suffocation', probability: 100,
})) };
const reactions = new EventReactionSystem(actor, runtime, isolatedSettings);
const events = new BotEventHandler(actor, runtime, []);
const registrar = new SkillRegistrar();
const timers: Array<ReturnType<typeof setInterval>> = [];
const transitions: Array<Record<string, unknown>> = [];
let mainRuns = 0;
let emergencyRuns = 0;
let deaths = 0;
let emergencyContract: GoalContract | null = null;
let emergencyProof: unknown = null;
let resumedText: string | null = null;
let resumedCheckpoint: unknown = null;
let report: Record<string, unknown> = {};
actor.on('death', () => { deaths++; });

function record(stage: string): void {
  transitions.push({ stage, atMs: Date.now() - startedAt, oxygen: actor.oxygenLevel ?? null,
    health: actor.health ?? null, inWater: actor.entity?.isInWater ?? null,
    nativeBreathing: verifyNativeBreathingSafety(actor), emergencyMode: runtime.isInEmergencyMode(),
    tasks: runtime.getTaskListState() });
}
async function until(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  if (!predicate()) throw new Error(`SUFFOCATION_TIMEOUT:${label}`);
}
runtime.setExecutor(async (envelope, _messages, options) => {
  if (envelope.tags.includes('emergency')) {
    emergencyRuns++;
    emergencyContract = (envelope.metadata as any)?.goalContract ?? null;
    emergencyProof = new GoalVerifier(actor).verify(emergencyContract ?? undefined);
    record('emergency_fixture_claims_completed_underwater');
    // Deliberately false: model/task-tree completion is not native safety proof.
    return { taskTree: { goal: envelope.text, status: 'completed' } };
  }
  mainRuns++;
  if (mainRuns > 1) {
    resumedText = envelope.text ?? null;
    resumedCheckpoint = (envelope.metadata as any)?.previousCognitiveWorkspace ?? null;
    record('main_goal_resumed');
    return { taskTree: { goal: rootGoal, status: 'in_progress' }, recoveryStatus: 'awaiting_user' };
  }
  options?.onCheckpoint?.({ messages: [], taskNodes: [],
    cognitiveWorkspace: { fixture: 'native-breathing-preemption', generation: 1 } as any });
  record('main_goal_started');
  await new Promise<void>((_resolve, reject) => {
    const signal = options?.abortSignal;
    if (!signal) return reject(new Error('MAIN_ABORT_SIGNAL_MISSING'));
    if (signal.aborted) return reject(new Error('main preempted'));
    signal.addEventListener('abort', () => reject(new Error('main preempted')), { once: true });
  });
  return { taskTree: { goal: rootGoal, status: 'in_progress' } };
});

try {
  await oracle.verifyReady();
  await oracle.executeSetupCommand('difficulty peaceful');
  await oracle.executeSetupCommand('gamerule spawn_mobs false');
  await oracle.executeSetupCommand('time set day');
  await oracle.executeSetupCommand('gamemode spectator ShannonProbe');
  await oracle.executeSetupCommand('gamemode survival MinebotTrial');
  await oracle.executeSetupCommand('effect give MinebotTrial minecraft:resistance 45 4 true');
  const x = Math.floor(actor.entity.position.x) + 12;
  const z = Math.floor(actor.entity.position.z) + 12;
  // A sealed, disposable water chamber keeps auto-swim from surfacing before
  // the native gate is observed. The fixture later drains only this chamber.
  await oracle.executeSetupCommand(`fill ${x - 2} 99 ${z - 2} ${x + 2} 103 ${z + 2} minecraft:stone`);
  await oracle.executeSetupCommand(`fill ${x - 1} 100 ${z - 1} ${x + 1} 102 ${z + 1} minecraft:water`);

  registrar.registerConstantSkills(actor, actor.constantSkills);
  events.registerAll();
  events.setEventReactionSystem(reactions);
  await reactions.initialize();
  for (const ms of [100, 1000, 5000]) timers.push(setInterval(() => actor.emit(`taskPer${ms}ms` as any), ms));
  const queued = runtime.addTaskToQueue({ userMessage: rootGoal });
  if (!queued.success) throw new Error(`MAIN_TASK_QUEUE_FAILED:${queued.reason}`);
  await until(() => mainRuns === 1 && runtime.isRunning(), 5_000, 'main started');
  await oracle.executeSetupCommand(`tp MinebotTrial ${x + 0.5} 100 ${z + 0.5}`);
  await until(() => actor.entity?.isInWater === true, 5_000, 'water state');
  record('underwater_fixture_entered');
  await until(() => emergencyRuns === 1, 18_000, 'real breath event and emergency');
  await until(() => runtime.isInEmergencyMode() && !runtime.isRunning(), 5_000, 'main paused after false model completion');
  record('main_still_paused_in_water');
  const underWater = verifyNativeBreathingSafety(actor);
  const mainRunsBeforeRecovery = mainRuns;
  await new Promise(resolve => setTimeout(resolve, 900));
  if (!runtime.isInEmergencyMode() || mainRuns !== mainRunsBeforeRecovery) {
    throw new Error('UNSAFE_EARLY_MAIN_RESUME');
  }
  const pausedQueue = runtime.getTaskListState();
  if (!pausedQueue.tasks.some(task => task.id === queued.taskId && task.status === 'paused')) {
    throw new Error('ORIGINAL_GOAL_NOT_PAUSED');
  }

  await oracle.executeSetupCommand(`fill ${x - 1} 100 ${z - 1} ${x + 1} 102 ${z + 1} minecraft:air`);
  record('water_removed_by_operator');
  await until(() => verifyNativeBreathingSafety(actor).status === 'verified', 6_000, 'native breathing recovery');
  await until(() => mainRuns === 2 && !runtime.isInEmergencyMode(), 6_000, 'original goal resumed');
  const afterRecovery = verifyNativeBreathingSafety(actor);
  const finalProof = new GoalVerifier(actor).verify(emergencyContract ?? undefined);
  record('native_proof_and_resume_confirmed');
  report = { passed: emergencyRuns === 1 && mainRuns === 2 && deaths === 0
      && underWater.status !== 'verified' && afterRecovery.status === 'verified'
      && (emergencyProof as any)?.status !== 'verified' && finalProof.status === 'verified'
      && emergencyContract?.predicates.length === 1 && emergencyContract.predicates[0]?.kind === 'breathing_safe'
      && resumedText === rootGoal && (resumedCheckpoint as any)?.fixture === 'native-breathing-preemption',
    durationMs: Date.now() - startedAt, port, worldDirectory, rootGoal,
    modelRequests: 0, mainRuns, emergencyRuns, deaths, emergencyContract,
    emergencyProof, finalProof, underWater, afterRecovery, resumedText, resumedCheckpoint,
    pausedQueue, transitions, finalTasks: runtime.getTaskListState() };
  if (!report.passed) process.exitCode = 1;
} catch (error) {
  report = { passed: false, durationMs: Date.now() - startedAt, port, worldDirectory,
    modelRequests: 0, error: String(error), mainRuns, emergencyRuns, deaths,
    emergencyContract, emergencyProof, resumedText, resumedCheckpoint,
    transitions, finalTasks: runtime.getTaskListState() };
  process.exitCode = 1;
} finally {
  for (const timer of timers) clearInterval(timer);
  reactions.destroy();
  for (const skill of actor.constantSkills.getSkills()) registrar.detachConstantSkillInterval(actor, skill.skillName);
  runtime.forceStop();
  closeProbeBot(actor); closeProbeBot(operator);
  const file = path.resolve('saves/minecraft/progressive_reports',
    `${new Date().toISOString().replace(/[:.]/g, '-')}-suffocation-recovery.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(`SUFFOCATION_RECOVERY_RESULT ${JSON.stringify({ passed: report.passed,
    durationMs: report.durationMs, mainRuns, emergencyRuns, deaths, error: report.error })}`);
  console.log(`SUFFOCATION_RECOVERY_REPORT ${file}`);
}
