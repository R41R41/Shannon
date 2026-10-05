#!/usr/bin/env node
// Focused live Minecraft check of the same runtime, event and constant-skill
// wiring used by SkillAgent. The LLM executor is a non-billable abort-aware
// fixture; this script never connects to the normal DB, Discord or UI Mod.
import fs from 'node:fs';
import path from 'node:path';
import { createProbeBot, closeProbeBot } from '../src/services/minebot/testing/MinecraftProbeBot.js';
import { MinecraftCommandOracle } from '../src/services/minebot/testing/MinecraftCommandOracle.js';
import { MinebotTaskRuntime } from '../src/services/minebot/runtime/MinebotTaskRuntime.js';
import { BotEventHandler } from '../src/services/minebot/events/BotEventHandler.js';
import { EventReactionSystem } from '../src/services/minebot/eventReaction/EventReactionSystem.js';
import { loadEventReactionSettingsFile } from '../src/services/minebot/eventReaction/eventReactionSettingsStore.js';
import { SkillRegistrar } from '../src/services/minebot/skills/SkillRegistrar.js';

const port = Number(process.env.MINECRAFT_PRODUCTION_REACTION_PORT ?? 25580);
const worldDirectory = process.env.MINECRAFT_PRODUCTION_REACTION_WORLD_DIRECTORY ?? '';
if (!Number.isInteger(port) || port < 25577 || port > 25650
  || !/^\/home\/azureuser\/minecraft\/progressive-lab-[A-Za-z0-9]+$/.test(worldDirectory)) {
  throw new Error('ISOLATED_REACTION_WORLD_REQUIRED');
}
const properties = fs.readFileSync(path.join(worldDirectory, 'server.properties'), 'utf8');
if (!properties.includes('server-ip=127.0.0.1') || !properties.includes(`server-port=${port}`)) {
  throw new Error('ISOLATED_REACTION_WORLD_CONFIGURATION_INVALID');
}

const operator = await createProbeBot(port);
const actor = await createProbeBot(port, 'MinebotTrial');
const oracle = new MinecraftCommandOracle(operator);
const runtime = new MinebotTaskRuntime(actor);
const settings = loadEventReactionSettingsFile();
const isolatedSettings = {
  ...settings,
  reactions: settings.reactions.map(row => row.eventType === 'hostile_approach'
    ? { ...row, enabled: true, probability: 100 }
    : row),
};
const reactions = new EventReactionSystem(actor, runtime, isolatedSettings);
const handler = new BotEventHandler(actor, runtime, []);
const registrar = new SkillRegistrar();
const timers: Array<ReturnType<typeof setInterval>> = [];
let mainRuns = 0;
let emergencyRuns = 0;
let deaths = 0;
const healthTrace: Array<{ at: number; health: number; food: number }> = [];
const controlTrace: Array<{ at: number; state: string; position: { x: number; y: number; z: number } }> = [];
const startedAt = Date.now();
let report: any;
actor.on('death', () => { deaths++; });
actor.on('health', () => healthTrace.push({ at: Date.now() - startedAt, health: actor.health, food: actor.food }));

function snapshot(): void {
  const position = actor.entity?.position;
  if (position) controlTrace.push({ at: Date.now() - startedAt, state: String(actor.minebotControlState ?? 'none'),
    position: { x: position.x, y: position.y, z: position.z } });
}
async function until(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  if (!predicate()) throw new Error(`REACTION_TIMEOUT:${label}`);
}
runtime.setExecutor(async (_envelope, _messages, options) => {
  if (_envelope.tags.includes('emergency')) {
    emergencyRuns++;
    await new Promise(resolve => setTimeout(resolve, 1800));
    return { taskTree: { goal: 'survive', status: 'completed' } };
  }
  mainRuns++;
  if (mainRuns > 1) return { taskTree: { goal: 'dragon goal', status: 'completed' } };
  await new Promise<void>((_resolve, reject) => {
    const signal = options?.abortSignal;
    if (!signal) return reject(new Error('MAIN_ABORT_SIGNAL_MISSING'));
    signal.addEventListener('abort', () => reject(new Error('main preempted')), { once: true });
  });
  return { taskTree: { goal: 'dragon goal', status: 'completed' } };
});

try {
  await oracle.verifyReady();
  // Only the controlled causal probe alters conditions. The later campaign
  // remains an unassisted natural survival run.
  await oracle.executeSetupCommand('difficulty normal');
  await oracle.executeSetupCommand('gamerule spawn_mobs false');
  await oracle.executeSetupCommand('time set day');
  await oracle.executeSetupCommand('gamemode spectator ShannonProbe');
  const origin = actor.entity.position.clone();
  const x = Math.floor(origin.x), y = Math.floor(origin.y), z = Math.floor(origin.z);
  registrar.registerConstantSkills(actor, actor.constantSkills);
  handler.registerAll();
  handler.setEventReactionSystem(reactions);
  await reactions.initialize();
  for (const ms of [100, 1000, 5000]) timers.push(setInterval(() => actor.emit(`taskPer${ms}ms` as any), ms));
  timers.push(setInterval(snapshot, 100));
  const queued = runtime.addTaskToQueue({ userMessage: 'dragon goal' });
  if (!queued.success) throw new Error(`MAIN_TASK_QUEUE_FAILED:${queued.reason}`);
  await until(() => mainRuns === 1 && runtime.isRunning(), 3000, 'main task started');
  await oracle.executeSetupCommand(`summon minecraft:zombie ${x + 12} ${y} ${z} {NoAI:1b,Silent:1b,PersistenceRequired:1b}`);
  await until(() => Object.values(actor.entities).some(entity => entity.name === 'zombie'), 3000, 'zombie visible');
  await new Promise(resolve => setTimeout(resolve, 1100));
  const warningOnly = { emergencyRuns, mainRuns, position: actor.entity.position.clone() };
  await oracle.executeSetupCommand(`tp @e[type=minecraft:zombie,sort=nearest,limit=1] ${x + 7} ${y} ${z}`);
  await until(() => emergencyRuns > 0, 5000, 'critical emergency invoked');
  await until(() => mainRuns >= 2, 8000, 'main task resumed');
  await new Promise(resolve => setTimeout(resolve, 300));
  report = { passed: warningOnly.emergencyRuns === 0 && emergencyRuns === 1 && mainRuns >= 2 && deaths === 0,
    durationMs: Date.now() - startedAt, port, settings: { persistedHostileProbability: settings.reactions.find(row => row.eventType === 'hostile_approach')?.probability,
      isolatedHostileProbability: 100 }, warningOnly, mainRuns, emergencyRuns, deaths, healthTrace, controlTrace,
    actor: { position: actor.entity.position, health: actor.health, food: actor.food }, taskList: runtime.getTaskListState() };
} catch (error) {
  report = { passed: false, durationMs: Date.now() - startedAt, error: String(error), mainRuns, emergencyRuns,
    deaths, healthTrace, controlTrace, taskList: runtime.getTaskListState() };
  process.exitCode = 1;
} finally {
  for (const timer of timers) clearInterval(timer);
  reactions.destroy();
  for (const skill of actor.constantSkills.getSkills()) registrar.detachConstantSkillInterval(actor, skill.skillName);
  runtime.forceStop();
  closeProbeBot(actor); closeProbeBot(operator);
  const file = path.resolve('saves/minecraft/progressive_reports', `${new Date().toISOString().replace(/[:.]/g, '-')}-production-reaction.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(`PRODUCTION_REACTION_RESULT ${JSON.stringify({ passed: report.passed, durationMs: report.durationMs, mainRuns, emergencyRuns, deaths, error: report.error })}`);
  console.log(`PRODUCTION_REACTION_REPORT ${file}`);
}
