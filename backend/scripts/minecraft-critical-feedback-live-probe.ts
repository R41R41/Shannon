#!/usr/bin/env node
/** Real mining + native health event + Jev + owned cancellation. Controlled
 * NoAI threat is a timing fixture, not evidence of natural combat survival.
 */
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { createHash } from 'node:crypto';
import { createProbeBot, closeProbeBot } from '../src/services/minebot/testing/MinecraftProbeBot.js';
import { MinecraftCommandOracle } from '../src/services/minebot/testing/MinecraftCommandOracle.js';
import { TaskWorkspace } from '../src/services/minebot/cognition/TaskWorkspace.js';
import { ExecutionSupervisor } from '../src/services/minebot/cognition/ExecutionSupervisor.js';
import { JevExecutionCritic } from '../src/services/minebot/cognition/JevExecutionCritic.js';
import { cancelActiveActions, waitForActionQuiescence } from '../src/services/minebot/execution/ActionExecution.js';
const port = Number(process.env.MINECRAFT_PROBE_PORT ?? 25577);
const campaignId = new Date().toISOString().replace(/[:.]/g, '-');
const directory = path.resolve('saves/minecraft/progressive_reports'); fs.mkdirSync(directory, { recursive: true });
const credential = dotenv.parse(fs.readFileSync('/home/azureuser/.config/shannon/minebot-jev.env'));
if (!credential.TYPESAFE_API_KEY?.trim()) throw new Error('DEDICATED_JEV_CREDENTIAL_REQUIRED');
const endpoint = credential.SHANNON_JEV_ENDPOINT ?? 'https://api.typesafe.ai/v1/systemone';
if (new URL(endpoint).origin !== 'https://api.typesafe.ai') throw new Error('JEV_ENDPOINT_NOT_ALLOWED');
let providerCalls = 0; const reports: unknown[] = [];
const sourceFiles = ['scripts/minecraft-critical-feedback-live-probe.ts', 'src/services/minebot/cognition/ExecutionSupervisor.ts',
  'src/services/minebot/cognition/JevExecutionCritic.ts', 'src/services/minebot/cognition/worldFrame.ts',
  'src/services/minebot/execution/ActionExecution.ts', 'src/services/minebot/types/skills.ts'];
const sourceHashes = Object.fromEntries(sourceFiles.map(file => [file, createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
for (let repeat = 1; repeat <= 3; repeat++) {
  const bot = await createProbeBot(port); let supervisor: ExecutionSupervisor | undefined;
  try {
    const oracle = new MinecraftCommandOracle(bot); await oracle.verifyReady();
    for (const command of ['/gamemode survival @s', '/difficulty normal', '/gamerule spawn_mobs false', '/gamerule advance_time false',
      '/gamerule minecraft:natural_health_regeneration false', '/time set midnight', '/weather clear', '/kill @e[type=!player]', '/clear @s', '/effect clear @s', '/effect give @s instant_health 1 10',
      '/fill -5 99 -5 5 99 5 stone', '/fill -5 100 -5 5 108 5 air', '/fill 0 100 2 0 107 2 oak_log', '/tp @s 0 100 0']) await oracle.executeSetupCommand(command);
    const fixtureProof = await oracle.evaluate({ type: 'gamerule', rule: 'natural_health_regeneration', value: false });
    if (!fixtureProof.passed) throw new Error('FIXED_HEALTH_GAMERULE_NOT_PROVEN');
    const workspace = new TaskWorkspace({ runId: `critical-${repeat}`, goal: 'Collect logs while staying alive. Stop immediately if continuing becomes unsafe.' });
    const requests: unknown[] = []; const timings: any[] = []; let healthObservedAt: number | null = null;
    let actionSettledAt: number | null = null; let deaths = 0;
    bot.on('death', () => deaths++); bot.on('health', () => { if (bot.health <= 2) healthObservedAt ??= Date.now(); });
    bot.on('minebotSupervisorTiming', timing => timings.push(timing));
    bot.on('minebotActionProgress', progress => {
      if (progress.capability === 'mine-block' && ['completed', 'cancelled', 'failed'].includes(progress.status)) actionSettledAt ??= Date.now();
    });
    const critic = new JevExecutionCritic({ apiKey: credential.TYPESAFE_API_KEY, endpoint, timeoutMilliseconds: 1200,
      fetcher: async (url, options) => {
        if (++providerCalls > 12) throw new Error('PROVIDER_CALL_BUDGET_EXHAUSTED');
        const requestedAt = Date.now(); const input = JSON.parse(String(options?.body));
        const response = await fetch(url, options); const body = await response.clone().json();
        requests.push({ requestedAt, receivedAt: Date.now(), input, response: body }); return response;
      } });
    supervisor = new ExecutionSupervisor({ bot, workspace, critic, mode: 'feedback', sampleMs: 100 }); supervisor.start();
    const mining = bot.instantSkills.getSkill('mine-block')!.run('oak_log', 8, 8);
    await new Promise(resolve => setTimeout(resolve, 400));
    const damageCommandAt = Date.now(); await oracle.executeSetupCommand('/damage @s 18 minecraft:generic');
    await oracle.executeSetupCommand('/summon zombie 1 100 0 {NoAI:1b,PersistenceRequired:1b}');
    const watchdog = setTimeout(() => cancelActiveActions(bot, 'probe_watchdog'), 6000);
    const result = await mining; clearTimeout(watchdog); supervisor.stop(); await supervisor.drain(); await waitForActionQuiescence(bot);
    const quiescentVerifiedAt = Date.now();
    const assertions = await oracle.evaluateAll([{ type: 'health_between', min: 1, max: 2 },
      { type: 'inventory_count', item: 'oak_log', minCount: 0, maxCount: 7 }]);
    const applied = supervisor.assessments.find(entry => entry.applied && entry.assessment.nextControl === 'ABORT_UNSAFE');
    const timing = timings.find(entry => entry.appliedAt !== null);
    const measuredFromHealth = healthObservedAt !== null && timing?.appliedAt !== null && timing?.appliedAt >= healthObservedAt;
    const assessedLowHealth = (requests as any[]).some(request => request.input.state.current_world?.health <= 2);
    const passed = deaths === 0 && Boolean(applied) && measuredFromHealth && assessedLowHealth
      && result.failureType === 'interrupted' && assertions.every(assertion => assertion.passed);
    const report = { repeat, passed, controlledTimingFixture: true, naturalRegeneration: false, fixtureProof, damageCommandAt, healthObservedAt,
      healthToAppliedMs: healthObservedAt && timing?.appliedAt ? timing.appliedAt - healthObservedAt : null,
      actionSettledAt, quiescentVerifiedAt, healthToQuiescentMs: healthObservedAt && actionSettledAt ? actionSettledAt - healthObservedAt : null,
      deaths, result, timings, assessments: supervisor.assessments, requests, assertions };
    reports.push(report); process.stdout.write(`CRITICAL_FEEDBACK_PROBE ${JSON.stringify({ repeat, passed, healthToAppliedMs: report.healthToAppliedMs, providerCalls, controls: supervisor.assessments.map(entry => ({ control: entry.assessment.nextControl, confidence: entry.assessment.confidence, applied: entry.applied, rejected: entry.rejected })) })}\n`);
    if (!passed) { process.exitCode = 1; break; }
  } finally { supervisor?.stop(); cancelActiveActions(bot, 'probe_finished');
    await new MinecraftCommandOracle(bot).executeSetupCommand('/gamerule minecraft:natural_health_regeneration true').catch(() => {});
    closeProbeBot(bot);
    fs.writeFileSync(path.join(directory, `${campaignId}-critical-feedback.json`), JSON.stringify({ campaignId, sourceHashes, providerCalls, reports }, null, 2)); }
}
