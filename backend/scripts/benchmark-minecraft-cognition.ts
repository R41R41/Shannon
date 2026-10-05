#!/usr/bin/env node
import { performance } from 'node:perf_hooks';
import {
  JevExecutionCritic,
  LocalExecutionCritic,
  OpenAIExecutionCritic,
} from '../src/services/minebot/cognition/JevExecutionCritic.js';
import {
  JevReflexPolicy,
  LocalReflexPolicy,
  OpenAIReflexPolicy,
} from '../src/services/minebot/cognition/JevReflexPolicy.js';
import { TaskWorkspace } from '../src/services/minebot/cognition/TaskWorkspace.js';
import { captureWorldObservation } from '../src/services/minebot/cognition/worldFrame.js';
import type {
  ActionReceipt,
  CriticAssessment,
  CriticInput,
  ReflexDecision,
  ReflexDecisionInput,
  WorldFrame,
  WorldObservation,
} from '../src/services/minebot/cognition/types.js';

type ProviderName = 'jev' | 'openai' | 'local';
type RouteName = 'reflex' | 'critic';

interface FetchTiming {
  headersMs: number;
  bodyAndJsonMs: number;
  requestBytes: number;
  responseBytes: number;
}

interface RemoteSample {
  provider: ProviderName;
  route: RouteName;
  scenario: string;
  repetition: number;
  totalMs: number;
  providerReportedMs: number;
  fetchHeadersMs: number;
  responseBodyAndJsonMs: number;
  clientAndValidationMs: number;
  requestBytes: number;
  responseBytes: number;
  source: string;
  fallback: boolean;
  outcome: string;
}

const jevKey = process.env.TYPESAFE_API_KEY?.trim() ?? '';
const openAIKey = process.env.OPENAI_API_KEY?.trim() ?? '';
const jevRepetitions = positiveInteger(process.env.JEV_BENCH_REPETITIONS) ?? 8;
const openAIRepetitions = positiveInteger(process.env.OPENAI_BENCH_REPETITIONS) ?? 3;
const localRepetitions = positiveInteger(process.env.LOCAL_BENCH_REPETITIONS) ?? 100;
const jevTimeoutMs = positiveInteger(process.env.SHANNON_JEV_TIMEOUT_MS) ?? 900;
const openAITimeoutMs = positiveInteger(process.env.MINECRAFT_OPENAI_TIMEOUT_MS) ?? 2_500;

if (!jevKey && !openAIKey) {
  throw new Error('TYPESAFE_API_KEY or OPENAI_API_KEY is required');
}

const reflexScenarios: Array<{ name: string; input: ReflexDecisionInput }> = [
  {
    name: 'routine-observe',
    input: reflexInput(
      { eventType: 'ambient_update', description: 'No immediate hazard detected.' },
      world({ health: 20, food: 20, oxygen: 300, isInWater: false }),
    ),
  },
  {
    name: 'hostile-combat',
    input: reflexInput(
      { eventType: 'hostile_approach', distance: 3.2, mobCount: 2, attacker: 'zombie' },
      world({ health: 8, food: 15, nearbyEntities: [nearby('zombie', 'hostile', 3.2)] }),
    ),
  },
  {
    name: 'drowning',
    input: reflexInput(
      { eventType: 'oxygen_critical', oxygen: 28, depth: 5 },
      world({ health: 14, oxygen: 28, isInWater: true }),
    ),
  },
  {
    name: 'low-health-hunger',
    input: reflexInput(
      { eventType: 'health_and_hunger_low', safeToEat: true },
      world({ health: 5, food: 4, inventory: [{ name: 'cooked_beef', count: 3 }] }),
    ),
  },
];

const criticScenarios: Array<{ name: string; input: CriticInput }> = [
  {
    name: 'on-track',
    input: criticInput('collect ten cobblestone', true, 'mine-block', 1, 4),
  },
  {
    name: 'repeated-failure',
    input: criticInput('reach the village', false, 'pathfind-to', 3, 4),
  },
  {
    name: 'regressing-unsafe',
    input: criticInput('escape hostile mobs safely', false, 'flee-from', 2, 4, -8),
  },
  {
    name: 'completed-unverified',
    input: criticInput('craft one iron pickaxe', true, 'craft-item', 1, 4, 0, 'claimed complete without inventory verification'),
  },
];

const remoteSamples: RemoteSample[] = [];

if (jevKey) {
  await benchmarkProvider('jev', jevRepetitions);
}
if (openAIKey) {
  await benchmarkProvider('openai', openAIRepetitions);
}
await benchmarkProvider('local', localRepetitions);

const infrastructure = benchmarkInfrastructure();
const report = {
  schemaVersion: 1,
  measuredAt: new Date().toISOString(),
  runtime: {
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    jevModel: process.env.SHANNON_JEV_MODEL?.trim() || 'jev-latest',
    jevTimeoutMs,
    openAIModel: process.env.MINECRAFT_OPENAI_MODEL?.trim() || 'gpt-5.6-luna',
    openAIReasoningEffort: process.env.MINECRAFT_OPENAI_REASONING_EFFORT?.trim() || 'none',
    openAITimeoutMs,
    repetitions: { jev: jevKey ? jevRepetitions : 0, openai: openAIKey ? openAIRepetitions : 0, local: localRepetitions },
  },
  summaries: summarizeRemoteSamples(remoteSamples),
  scenarioSummaries: summarizeRemoteSamples(remoteSamples, true),
  infrastructure,
  samples: remoteSamples,
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

async function benchmarkProvider(provider: ProviderName, repetitions: number): Promise<void> {
  for (let repetition = 1; repetition <= repetitions; repetition += 1) {
    for (const scenario of reflexScenarios) {
      const timing = emptyTiming();
      const policy = provider === 'jev'
        ? new JevReflexPolicy({
            apiKey: jevKey,
            model: process.env.SHANNON_JEV_MODEL?.trim() || 'jev-latest',
            endpoint: process.env.SHANNON_JEV_ENDPOINT?.trim() || undefined,
            timeoutMilliseconds: jevTimeoutMs,
            fetcher: timedFetch(timing),
          })
        : provider === 'openai'
          ? new OpenAIReflexPolicy({
              apiKey: openAIKey,
              model: process.env.MINECRAFT_OPENAI_MODEL?.trim() || 'gpt-5.6-luna',
              endpoint: process.env.MINECRAFT_OPENAI_ENDPOINT?.trim() || undefined,
              reasoningEffort: reasoningEffort(process.env.MINECRAFT_OPENAI_REASONING_EFFORT),
              timeoutMilliseconds: openAITimeoutMs,
              fetcher: timedFetch(timing),
            })
          : new LocalReflexPolicy();
      const started = performance.now();
      const decision = await policy.decide(scenario.input);
      remoteSamples.push(reflexSample(provider, scenario.name, repetition, performance.now() - started, timing, decision));
    }

    for (const scenario of criticScenarios) {
      const timing = emptyTiming();
      const critic = provider === 'jev'
        ? new JevExecutionCritic({
            apiKey: jevKey,
            model: process.env.SHANNON_JEV_MODEL?.trim() || 'jev-latest',
            endpoint: process.env.SHANNON_JEV_ENDPOINT?.trim() || undefined,
            timeoutMilliseconds: jevTimeoutMs,
            fetcher: timedFetch(timing),
          })
        : provider === 'openai'
          ? new OpenAIExecutionCritic({
              apiKey: openAIKey,
              model: process.env.MINECRAFT_OPENAI_MODEL?.trim() || 'gpt-5.6-luna',
              endpoint: process.env.MINECRAFT_OPENAI_ENDPOINT?.trim() || undefined,
              reasoningEffort: reasoningEffort(process.env.MINECRAFT_OPENAI_REASONING_EFFORT),
              timeoutMilliseconds: openAITimeoutMs,
              fetcher: timedFetch(timing),
            })
          : new LocalExecutionCritic();
      const started = performance.now();
      const assessment = await critic.assess(scenario.input);
      remoteSamples.push(criticSample(provider, scenario.name, repetition, performance.now() - started, timing, assessment));
    }
  }
}

function timedFetch(timing: FetchTiming): typeof fetch {
  return async (input, init) => {
    timing.requestBytes = typeof init?.body === 'string' ? Buffer.byteLength(init.body) : 0;
    const started = performance.now();
    const response = await fetch(input, init);
    timing.headersMs = performance.now() - started;
    return new Proxy(response, {
      get(target, property) {
        if (property === 'json') {
          return async () => {
            const bodyStarted = performance.now();
            const text = await target.text();
            timing.bodyAndJsonMs = performance.now() - bodyStarted;
            timing.responseBytes = Buffer.byteLength(text);
            return JSON.parse(text) as unknown;
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as Response;
  };
}

function reflexSample(
  provider: ProviderName,
  scenario: string,
  repetition: number,
  totalMs: number,
  timing: FetchTiming,
  decision: ReflexDecision,
): RemoteSample {
  return baseSample(provider, 'reflex', scenario, repetition, totalMs, timing, decision.elapsedMilliseconds, decision.source, `${decision.urgency}/${decision.immediateAction}`);
}

function criticSample(
  provider: ProviderName,
  scenario: string,
  repetition: number,
  totalMs: number,
  timing: FetchTiming,
  assessment: CriticAssessment,
): RemoteSample {
  return baseSample(provider, 'critic', scenario, repetition, totalMs, timing, assessment.elapsedMilliseconds, assessment.source, `${assessment.progressState}/${assessment.nextControl}`);
}

function baseSample(
  provider: ProviderName,
  route: RouteName,
  scenario: string,
  repetition: number,
  totalMs: number,
  timing: FetchTiming,
  providerReportedMs: number,
  source: string,
  outcome: string,
): RemoteSample {
  const networkAndBody = timing.headersMs + timing.bodyAndJsonMs;
  return {
    provider,
    route,
    scenario,
    repetition,
    totalMs: round(totalMs),
    providerReportedMs,
    fetchHeadersMs: round(timing.headersMs),
    responseBodyAndJsonMs: round(timing.bodyAndJsonMs),
    clientAndValidationMs: round(Math.max(0, totalMs - networkAndBody)),
    requestBytes: timing.requestBytes,
    responseBytes: timing.responseBytes,
    source,
    fallback: source === 'fallback',
    outcome,
  };
}

function summarizeRemoteSamples(samples: RemoteSample[], byScenario = false): unknown[] {
  const groups = new Map<string, RemoteSample[]>();
  for (const sample of samples) {
    const key = [sample.provider, sample.route, byScenario ? sample.scenario : 'all'].join('|');
    groups.set(key, [...(groups.get(key) ?? []), sample]);
  }
  return [...groups.values()].map(group => ({
    provider: group[0].provider,
    route: group[0].route,
    ...(byScenario ? { scenario: group[0].scenario } : {}),
    sampleCount: group.length,
    remoteSuccessRate: round(group.filter(sample => !sample.fallback).length / group.length, 4),
    fallbackCount: group.filter(sample => sample.fallback).length,
    totalMs: stats(group.map(sample => sample.totalMs)),
    fetchHeadersMs: stats(group.map(sample => sample.fetchHeadersMs)),
    responseBodyAndJsonMs: stats(group.map(sample => sample.responseBodyAndJsonMs)),
    clientAndValidationMs: stats(group.map(sample => sample.clientAndValidationMs)),
    requestBytes: stats(group.map(sample => sample.requestBytes)),
    outcomes: Object.fromEntries([...new Set(group.map(sample => sample.outcome))].sort().map(outcome => [outcome, group.filter(sample => sample.outcome === outcome).length])),
  }));
}

function benchmarkInfrastructure(): Record<string, unknown> {
  const fakeBot = createFakeBot();
  const observationTimes: number[] = [];
  const workspaceFreshTimes: number[] = [];
  const workspaceStaleTimes: number[] = [];
  const serializationTimes: number[] = [];
  let payloadBytes = 0;

  for (let index = 0; index < 10_000; index += 1) {
    let started = performance.now();
    const observation = captureWorldObservation(fakeBot);
    observationTimes.push(performance.now() - started);

    const workspace = new TaskWorkspace({ runId: `infra-${index}`, goal: 'measure local cognition plumbing' });
    const frame = workspace.observeWorld(observation);
    const assessment = assessmentFor(frame);
    started = performance.now();
    workspace.recordAssessment(assessment);
    workspaceFreshTimes.push(performance.now() - started);

    const staleWorkspace = new TaskWorkspace({ runId: `stale-${index}`, goal: 'measure stale rejection' });
    const evaluated = staleWorkspace.observeWorld(observation);
    staleWorkspace.observeWorld({ ...observation, observedAt: new Date().toISOString() });
    started = performance.now();
    staleWorkspace.recordAssessment(assessmentFor(evaluated, staleWorkspace.runId));
    workspaceStaleTimes.push(performance.now() - started);

    started = performance.now();
    const payload = JSON.stringify(criticScenarios[index % criticScenarios.length].input);
    serializationTimes.push(performance.now() - started);
    payloadBytes = Buffer.byteLength(payload);
  }

  return {
    iterations: 10_000,
    observationCaptureMs: stats(observationTimes),
    workspaceRecordFreshMs: stats(workspaceFreshTimes),
    workspaceRecordStaleMs: stats(workspaceStaleTimes),
    criticInputSerializationMs: stats(serializationTimes),
    representativeCriticPayloadBytes: payloadBytes,
  };
}

function reflexInput(event: Record<string, unknown>, observation: WorldObservation): ReflexDecisionInput {
  return {
    event,
    world: observation,
    currentTaskActive: true,
    availableCapabilities: ['flee-from', 'auto-eat', 'stop-movement'],
  };
}

function world(overrides: Partial<WorldObservation> = {}): WorldObservation {
  return {
    observedAt: '2026-09-28T00:00:00.000Z',
    dimension: 'minecraft:overworld',
    position: { x: 0, y: 64, z: 0 },
    health: 20,
    food: 20,
    oxygen: 300,
    isInWater: false,
    weather: 'clear',
    time: 'night',
    biome: 'plains',
    heldItem: null,
    inventory: [],
    activeEffects: [],
    nearbyEntities: [],
    ...overrides,
  };
}

function nearby(name: string, kind: string, distance: number) {
  return { name, kind, distance, position: { x: distance, y: 64, z: 0 } };
}

function criticInput(
  goal: string,
  success: boolean,
  capability: string,
  receiptCount: number,
  revision: number,
  healthDelta = 0,
  resultSummary = success ? 'action produced the intended world delta' : 'action did not advance the goal',
): CriticInput {
  const previousWorld = frame(revision - 1, 12 - healthDelta, []);
  const currentWorld = frame(revision, 12, success && capability === 'mine-block' ? [{ name: 'cobblestone', count: 4 }] : []);
  return {
    runId: `bench-${capability}`,
    goal,
    evaluatedRevision: revision,
    previousWorld,
    currentWorld,
    plan: [{ id: 'root', goal, status: success ? 'in_progress' : 'error', progress: resultSummary }],
    recentReceipts: Array.from({ length: receiptCount }, (_, index) => receipt({
      runId: `bench-${capability}`,
      iteration: index + 1,
      capability,
      success,
      resultSummary,
      beforeRevision: Math.max(0, revision - 1),
      afterRevision: revision,
      healthDelta: index === receiptCount - 1 ? healthDelta : 0,
    })),
    previousAssessment: null,
  };
}

function frame(revision: number, health: number, inventory: WorldObservation['inventory']): WorldFrame {
  return { ...world({ health, inventory }), runId: 'bench-frame', revision };
}

function receipt(input: {
  runId: string;
  iteration: number;
  capability: string;
  success: boolean;
  resultSummary: string;
  beforeRevision: number;
  afterRevision: number;
  healthDelta: number;
}): ActionReceipt {
  return {
    id: `${input.runId}-${input.iteration}`,
    runId: input.runId,
    iteration: input.iteration,
    actionKind: 'instant_skill',
    capability: input.capability,
    args: {},
    intendedEffect: input.resultSummary,
    startedAt: '2026-09-28T00:00:00.000Z',
    finishedAt: '2026-09-28T00:00:00.100Z',
    durationMs: 100,
    beforeRevision: input.beforeRevision,
    afterRevision: input.afterRevision,
    success: input.success,
    failureType: input.success ? null : 'NO_PROGRESS',
    recoverable: !input.success,
    resultSummary: input.resultSummary,
    observedDelta: {
      positionDelta: { x: 0, y: 0, z: 0 },
      healthDelta: input.healthDelta,
      foodDelta: 0,
      dimensionChanged: false,
      inventoryDelta: [],
    },
    meaningfulWorldAction: true,
  };
}

function assessmentFor(frameValue: WorldFrame, runId = frameValue.runId): CriticAssessment {
  return {
    id: `assessment-${frameValue.revision}`,
    runId,
    evaluatedRevision: frameValue.revision,
    receivedAt: '2026-09-28T00:00:00.000Z',
    elapsedMilliseconds: 80,
    source: 'jev',
    stale: false,
    progressState: 'ON_TRACK',
    continueProbability: 0.9,
    needsObservationProbability: 0.1,
    needsReplanProbability: 0.1,
    failureCause: 'NONE',
    nextControl: 'CONTINUE',
    confidence: 0.9,
  };
}

function createFakeBot(): Record<string, unknown> {
  const entities = Object.fromEntries(Array.from({ length: 64 }, (_, index) => [
    String(index + 2),
    {
      name: index % 4 === 0 ? 'zombie' : 'cow',
      type: index % 4 === 0 ? 'hostile' : 'mob',
      position: { x: index + 1, y: 64, z: index % 8 },
    },
  ]));
  const self = { name: 'player', type: 'player', position: { x: 0, y: 64, z: 0 } };
  return {
    entity: self,
    entities: { self, ...entities },
    inventory: { items: () => Array.from({ length: 36 }, (_, index) => ({ name: `item_${index}`, count: index + 1 })) },
    game: { dimension: 'minecraft:overworld' },
    heldItem: { name: 'iron_pickaxe' },
    health: 20,
    food: 20,
    oxygenLevel: 300,
    isInWater: false,
    environmentState: { weather: 'clear', time: 'day', biome: 'plains' },
    activeEffects: [{ name: 'speed', amplifier: 1 }],
  };
}

function emptyTiming(): FetchTiming {
  return { headersMs: 0, bodyAndJsonMs: 0, requestBytes: 0, responseBytes: 0 };
}

function stats(values: number[]): Record<string, number> {
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    min: round(sorted[0] ?? 0),
    p50: round(percentile(sorted, 0.5)),
    p95: round(percentile(sorted, 0.95)),
    max: round(sorted.at(-1) ?? 0),
    mean: round(sorted.length ? sum / sorted.length : 0),
  };
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function round(value: number, digits = 2): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function positiveInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function reasoningEffort(value: string | undefined): 'none' | 'low' | 'medium' {
  const normalized = value?.trim().toLowerCase();
  return normalized === 'low' || normalized === 'medium' ? normalized : 'none';
}
