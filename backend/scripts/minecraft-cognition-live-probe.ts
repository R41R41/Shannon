#!/usr/bin/env node
/**
 * Isolated live probe for the Minecraft fast-cognition path.
 *
 * Connects an offline test identity to an explicitly supplied test server,
 * observes the real world, performs one harmless jump, and asks the configured
 * remote classifier for a reflex decision and an execution assessment.
 */
import mineflayer from 'mineflayer';
import { performance } from 'node:perf_hooks';
import {
  createConfiguredExecutionCritic,
} from '../src/services/minebot/cognition/JevExecutionCritic.js';
import {
  createConfiguredReflexPolicy,
} from '../src/services/minebot/cognition/JevReflexPolicy.js';
import { TaskWorkspace } from '../src/services/minebot/cognition/TaskWorkspace.js';
import { captureWorldObservation, diffWorldFrames } from '../src/services/minebot/cognition/worldFrame.js';
import type { ActionReceipt } from '../src/services/minebot/cognition/types.js';
import { MinecraftCommandOracle } from '../src/services/minebot/testing/MinecraftCommandOracle.js';

const host = process.env.MINECRAFT_PROBE_HOST?.trim() || '127.0.0.1';
const port = positiveInteger(process.env.MINECRAFT_PROBE_PORT) ?? 25577;
const version = process.env.MINECRAFT_PROBE_VERSION?.trim() || '1.21.11';
const username = process.env.MINECRAFT_PROBE_USERNAME?.trim() || 'ShannonProbe';
const timeoutMilliseconds = positiveInteger(process.env.MINECRAFT_PROBE_TIMEOUT_MS) ?? 45_000;
const sharedServerAllowed = process.env.MINECRAFT_PROBE_ALLOW_SHARED_SERVER === 'true';
const commandOnly = process.env.MINECRAFT_PROBE_COMMAND_ONLY === 'true';
const probeStartedAt = performance.now();

if (username.length < 1 || username.length > 16) {
  throw new Error('MINECRAFT_PROBE_USERNAME must be 1-16 characters');
}
if (!sharedServerAllowed && !['127.0.0.1', 'localhost', '::1'].includes(host)) {
  throw new Error('Live cognition probe only permits a loopback server by default');
}
if (!sharedServerAllowed && port >= 25_565 && port <= 25_569) {
  throw new Error('Live cognition probe refuses known shared Minecraft ports by default');
}

if (!commandOnly && !process.env.OPENAI_API_KEY?.trim() && !process.env.TYPESAFE_API_KEY?.trim()) {
  throw new Error('OPENAI_API_KEY or TYPESAFE_API_KEY is required for the live cognition probe');
}

const providerEnvironment = {
  ...process.env,
  MINECRAFT_COGNITION_PROVIDER: process.env.MINECRAFT_COGNITION_PROVIDER || 'openai',
};
const reflexPolicy = commandOnly ? null : createConfiguredReflexPolicy(providerEnvironment);
const executionCritic = commandOnly ? null : createConfiguredExecutionCritic(providerEnvironment);
const workspace = new TaskWorkspace({
  runId: `live-probe-${Date.now()}`,
  goal: 'Perform one harmless jump in a real Minecraft world and verify the observed outcome.',
});

const bot = mineflayer.createBot({
  host,
  port,
  username,
  auth: 'offline',
  version,
  checkTimeoutInterval: timeoutMilliseconds,
});

const timeout = setTimeout(() => {
  bot.end('live probe timeout');
  process.stderr.write('MINECRAFT_COGNITION_PROBE_TIMEOUT\n');
  process.exitCode = 1;
}, timeoutMilliseconds);

bot.once('error', error => {
  clearTimeout(timeout);
  process.stderr.write(`MINECRAFT_COGNITION_PROBE_ERROR ${error.message}\n`);
  process.exitCode = 1;
});

bot.once('kicked', reason => {
  clearTimeout(timeout);
  process.stderr.write(`MINECRAFT_COGNITION_PROBE_KICKED ${stringifyReason(reason)}\n`);
  process.exitCode = 1;
});

bot.once('spawn', async () => {
  try {
    const spawnedAt = performance.now();
    const commandOracle = new MinecraftCommandOracle(bot);
    let stageStartedAt = performance.now();
    await commandOracle.verifyReady();
    const oracleReadyMs = performance.now() - stageStartedAt;
    stageStartedAt = performance.now();
    for (const command of [
      '/fill -5 99 -5 5 99 5 stone',
      '/tp @s 0 100 0',
      '/gamemode survival @s',
      '/clear @s',
      '/give @s iron_ingot 3',
      '/time set day',
      '/weather clear',
    ]) {
      await commandOracle.executeSetupCommand(command);
    }
    const setupCommandsMs = performance.now() - stageStartedAt;
    stageStartedAt = performance.now();
    await delay(500);
    const settleBeforeObservationMs = performance.now() - stageStartedAt;
    stageStartedAt = performance.now();
    const before = workspace.observeWorld(captureWorldObservation(bot));
    const initialObservationAndWorkspaceMs = performance.now() - stageStartedAt;
    stageStartedAt = performance.now();
    const reflex = reflexPolicy
      ? await reflexPolicy.decide({
          event: { eventType: 'spawn_safety_check', description: 'Newly spawned in an isolated test world.' },
          world: before,
          currentTaskActive: true,
          availableCapabilities: ['stop-movement'],
        })
      : null;
    if (reflex) workspace.recordReflexDecision(reflex);
    const reflexAndRecordMs = performance.now() - stageStartedAt;

    stageStartedAt = performance.now();
    const actionStartedAt = new Date();
    bot.setControlState('jump', true);
    await delay(500);
    bot.setControlState('jump', false);
    await delay(1_000);
    const jumpControlAndWaitMs = performance.now() - stageStartedAt;
    stageStartedAt = performance.now();
    const after = workspace.observeWorld(captureWorldObservation(bot));
    const actionFinishedAt = new Date();
    const receipt: ActionReceipt = {
      id: crypto.randomUUID(),
      runId: workspace.runId,
      iteration: 1,
      actionKind: 'instant_skill',
      capability: 'probe-jump',
      args: {},
      intendedEffect: 'Perform one harmless jump without losing health.',
      startedAt: actionStartedAt.toISOString(),
      finishedAt: actionFinishedAt.toISOString(),
      durationMs: actionFinishedAt.getTime() - actionStartedAt.getTime(),
      beforeRevision: before.revision,
      afterRevision: after.revision,
      success: after.health !== null && before.health !== null ? after.health >= before.health : null,
      failureType: null,
      recoverable: null,
      resultSummary: 'Offline test bot completed the jump control sequence in a real server tick loop.',
      observedDelta: diffWorldFrames(before, after),
      meaningfulWorldAction: true,
    };
    workspace.recordReceipt(receipt);
    const finalObservationAndReceiptMs = performance.now() - stageStartedAt;
    stageStartedAt = performance.now();
    const assessment = executionCritic
      ? workspace.recordAssessment(await executionCritic.assess(workspace.criticInput()))
      : null;
    const criticAndRecordMs = performance.now() - stageStartedAt;
    stageStartedAt = performance.now();
    const commandAssertions = await commandOracle.evaluateAll([
      { type: 'position_within', x: 0, y: 100, z: 0, radius: 2 },
      { type: 'block_at', x: 0, y: 99, z: 0, block: 'stone' },
      { type: 'dimension', dimension: 'overworld' },
      { type: 'gamemode', gamemode: 'survival' },
      { type: 'health_between', min: 20, max: 20 },
      { type: 'food_between', min: 20, max: 20 },
      { type: 'inventory_count', item: 'iron_ingot', minCount: 3, maxCount: 3 },
      { type: 'entity_nearby', entity: 'zombie', maxDistance: 8, present: false },
    ]);
    const commandOracleMs = performance.now() - stageStartedAt;
    const commandOraclePassed = commandAssertions.every(result => result.passed);
    const cognitionPassed = commandOnly
      || Boolean(
        reflex
        && reflex.source !== 'fallback'
        && assessment
        && assessment.source !== 'fallback'
        && !assessment.stale,
      );
    const ok = commandOraclePassed && cognitionPassed;

    process.stdout.write(`${JSON.stringify({
      ok,
      mode: commandOnly ? 'command-only' : 'command-and-cognition',
      server: { host, port, version },
      bot: { username: bot.username, entityId: bot.entity?.id ?? null },
      world: {
        dimension: after.dimension,
        beforePosition: before.position,
        afterPosition: after.position,
        health: after.health,
        food: after.food,
        nearbyEntityCount: after.nearbyEntities.length,
      },
      reflex: reflex ? {
        source: reflex.source,
        latencyMs: reflex.elapsedMilliseconds,
        urgency: reflex.urgency,
        immediateAction: reflex.immediateAction,
        confidence: reflex.confidence,
      } : null,
      critic: assessment ? {
        source: assessment.source,
        latencyMs: assessment.elapsedMilliseconds,
        progressState: assessment.progressState,
        nextControl: assessment.nextControl,
        confidence: assessment.confidence,
        stale: assessment.stale,
      } : null,
      workspace: {
        worldRevision: workspace.worldRevision,
        receiptCount: workspace.snapshot().receipts.length,
        eventCount: workspace.snapshot().events.length,
      },
      timings: {
        connectToSpawnMs: spawnedAt - probeStartedAt,
        oracleReadyMs,
        setupCommandsMs,
        settleBeforeObservationMs,
        initialObservationAndWorkspaceMs,
        reflexAndRecordMs,
        jumpControlAndWaitMs,
        finalObservationAndReceiptMs,
        criticAndRecordMs,
        commandOracleMs,
        totalToReportMs: performance.now() - probeStartedAt,
      },
      commandOracle: {
        passed: commandOraclePassed,
        assertions: commandAssertions.map(result => ({
          assertion: result.assertion,
          passed: result.passed,
          durationMs: result.durationMs,
          error: result.error,
        })),
      },
    }, null, 2)}\n`);
    if (!ok) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`MINECRAFT_COGNITION_PROBE_FAILED ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  } finally {
    clearTimeout(timeout);
    bot.end('live probe complete');
  }
});

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function positiveInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function stringifyReason(value: unknown): string {
  if (typeof value === 'string') return value.slice(0, 500);
  try {
    return JSON.stringify(value).slice(0, 500);
  } catch {
    return String(value).slice(0, 500);
  }
}
