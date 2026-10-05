#!/usr/bin/env node
// Isolated game acceptance: OP setup actor, non-OP planner, no DB/Discord/UI.
// Real requests require either dedicated credentials or explicit production-key
// acceptance authorization. Never export the credential to child processes.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import dotenv from 'dotenv';
import { createProbeBot, closeProbeBot } from '../src/services/minebot/testing/MinecraftProbeBot.js';
import { MinecraftCommandOracle } from '../src/services/minebot/testing/MinecraftCommandOracle.js';
import { AutonomousScenarioRunner } from '../src/services/minebot/testing/AutonomousScenarioRunner.js';
import { createOpenAIPlannerClient } from '../src/services/minebot/cognition/OpenAIPlannerClient.js';
import { skillToAnthropicTool } from '../src/services/llm/graph/ShannonExecutor.js';
import { flatAcceptanceSetup } from '../src/services/minebot/testing/acceptanceFixture.js';
import { AcceptanceBudget } from '../src/services/minebot/testing/AcceptanceBudget.js';

const real = process.env.MINECRAFT_ACCEPTANCE_REAL_MODEL === 'true';
const dedicated = '/home/azureuser/.config/shannon/minebot-planner.env';
let apiKey = '';
if (real) {
  const file = fs.existsSync(dedicated) ? dedicated : process.env.MINECRAFT_PRODUCTION_KEY_ACCEPTANCE_AUTHORIZED === 'true'
    ? '/home/azureuser/Shannon-current/backend/.env' : null;
  if (!file) throw new Error('DEDICATED_KEY_OR_EXPLICIT_ACCEPTANCE_AUTHORIZATION_REQUIRED');
  apiKey = dotenv.parse(fs.readFileSync(file)).OPENAI_API_KEY ?? '';
  if (!apiKey.trim()) throw new Error('OPENAI_ACCEPTANCE_KEY_REQUIRED');
}
const port = Number(process.env.MINECRAFT_PROBE_PORT ?? 25577);
const id = new Date().toISOString().replace(/[:.]/g, '-');
const directory = path.resolve('saves/minecraft/progressive_reports'); fs.mkdirSync(directory, { recursive: true });
const sourceFiles = ['scripts/minecraft-openai-acceptance-probe.ts', 'src/services/minebot/cognition/OpenAIPlannerClient.ts',
  'src/services/llm/graph/ShannonExecutor.ts', 'src/services/minebot/cognition/GoalVerifier.ts', 'src/services/minebot/instantSkills/findBlocks.ts',
  'src/services/minebot/testing/AutonomousScenarioRunner.ts', 'src/services/minebot/testing/AcceptanceBudget.ts', 'src/services/minebot/testing/acceptanceFixture.ts', 'src/services/minebot/testing/MinecraftProbeBot.ts'];
const hashSources = () => Object.fromEntries(sourceFiles.map(file => [file, createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
const sourceHashes = hashSources();
let calls = 0, reservedUsd = 0;
// An additional acceptance allocation is separate from the original 12-call
// authorization. The operator must only set this flag after explicit approval.
const maxCalls = process.env.MINECRAFT_ACCEPTANCE_ADDITIONAL_AUTHORIZED === 'true' ? 24 : 12;
const selectedCases = (process.env.MINECRAFT_ACCEPTANCE_CASES ?? 'wood,craft,place').split(',');
if (!selectedCases.length || selectedCases.some(value => !['wood', 'craft', 'place'].includes(value))
  || new Set(selectedCases).size !== selectedCases.length) throw new Error('ACCEPTANCE_CASE_SELECTION_INVALID');
const requests: unknown[] = [];
const sharedBudget = process.env.MINECRAFT_ACCEPTANCE_BUDGET_FILE ? new AcceptanceBudget(path.resolve(process.env.MINECRAFT_ACCEPTANCE_BUDGET_FILE)) : undefined;
const client = real ? createOpenAIPlannerClient({ apiKey, fetcher: async (url, options) => {
  if (url !== 'https://api.openai.com/v1/responses' || typeof options?.body !== 'string') throw new Error('OFFICIAL_ENDPOINT_REQUIRED');
  const body = JSON.parse(options.body);
  // Conservative pricing reservation: UTF-8 bytes upper-bound input tokens plus
  // framing allowance; 2x input price + cache-write premium, 1.5x output price.
  const cost = ((Buffer.byteLength(options.body) + 4096) * 0.50 + body.max_output_tokens * 1.80) / 1_000_000;
  if (calls >= maxCalls || reservedUsd + cost > 0.50) throw new Error('ACCEPTANCE_REQUEST_OR_COST_RESERVATION_LIMIT');
  const sharedReservation = sharedBudget?.reserve(options.body);
  const request = ++calls; reservedUsd += cost;
  const start = Date.now(); const response = await fetch(url, options);
  const payload: any = await response.clone().json();
  requests.push({ request, durationMs: Date.now() - start, httpStatus: response.status, model: payload.model,
    usage: payload.usage, reservedUsd: cost, sharedReservation, toolCalls: (payload.output ?? []).filter((i: any) => i.type === 'function_call').map((i: any) => i.name) });
  return response;
} }) : undefined;
const reports: any[] = [];
const operator = await createProbeBot(port);
const actor = await createProbeBot(port, 'MinebotTrial');
const control = new MinecraftCommandOracle(operator);
let died = 0; actor.on('death', () => { died++; });
try {
  await control.verifyReady();
  await control.executeSetupCommand('/gamemode spectator @s');
  await control.executeSetupCommand('/deop MinebotTrial');
  const oracle = new MinecraftCommandOracle({ version: actor.version,
    chat: message => operator.chat(`/execute as @a[name=MinebotTrial,limit=1] at @s run ${message.replace(/^\//, '')}`),
    on: (_event, listener) => actor.on('message', listener as any),
    removeListener: (_event, listener) => actor.removeListener('message', listener as any),
  });
  const allow = new Set(['list-inventory-items', 'get-bot-status', 'get-position', 'get-blocks-in-area', 'find-blocks', 'get-block-at',
    'mine-block', 'dig-block-at', 'craft-one', 'check-recipe', 'place-block-at', 'pickup-nearest-item', 'move-to', 'equip-item']);
  const tools: any[] = actor.instantSkills.getSkills().filter(skill => allow.has(skill.skillName)).map(skillToAnthropicTool);
  tools.push({ name: 'task-complete', description: 'Request native-verified completion.', input_schema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] } });
  const cases: any[] = [
    { id: 'wood', goal: 'オーク原木を3個集める', fixture: ['/give @s iron_axe 1', '/fill 8 100 2 8 102 2 oak_log'],
      goalContract: { goal: 'オーク原木を3個集める', predicates: [{ kind: 'produced', item: 'oak_log', count: 3 }] },
      assertions: [{ type: 'inventory_count', item: 'oak_log', minCount: 3, maxCount: 3 },
        ...[100, 101, 102].map(y => ({ type: 'block_at', x: 8, y, z: 2, block: 'air' }))], tool: 'mine-block', input: { blockName: 'oak_log', count: 3, searchRadius: 24 } },
    { id: 'craft', goal: 'パンを1個クラフトする', fixture: ['/give @s wheat 3', '/setblock 2 100 0 crafting_table'],
      goalContract: { goal: 'パンを1個クラフトする', predicates: [{ kind: 'produced', item: 'bread', count: 1 }] },
      assertions: [{ type: 'inventory_count', item: 'bread', minCount: 1, maxCount: 1 }, { type: 'inventory_count', item: 'wheat', minCount: 0, maxCount: 0 }],
      tool: 'craft-one', input: { itemName: 'bread', count: 1 } },
    { id: 'place', goal: '座標(3,100,0)に石ブロックを1個置く', fixture: ['/give @s stone 1'],
      goalContract: { goal: '座標(3,100,0)に石ブロックを1個置く', predicates: [{ kind: 'block', dimension: 'overworld', position: { x: 3, y: 100, z: 0 }, block: 'stone' }] },
      assertions: [{ type: 'block_at', x: 3, y: 100, z: 0, block: 'stone' }], tool: 'place-block-at', input: { blockName: 'stone', x: 3, y: 100, z: 0 } },
  ];
  for (const scenario of cases.filter(value => selectedCases.includes(value.id))) {
    let turn = 0;
    const fixtureClient: any = { messages: { stream: () => ({ finalMessage: async () => ({ usage: {}, content: [turn++ === 0
      ? { type: 'tool_use', id: 'act', name: scenario.tool, input: scenario.input }
      : { type: 'tool_use', id: 'done', name: 'task-complete', input: { summary: 'request proof' } }] }) }) } };
    const runner = new AutonomousScenarioRunner(actor, { modelClient: client ?? fixtureClient,
      ...(real ? { modelIdentity: { provider: 'openai', model: 'gpt-5.6-luna' } } : {}) }, port);
    const report = await runner.run({ ...scenario, constraints: 'Never issue chat commands. Discover resources from native observations. Choose skills yourself. On success call task-complete.',
      setup: ['/gamemode spectator @s', '/difficulty peaceful', '/gamerule spawn_mobs false', '/gamerule advance_time false', '/time set day', '/weather clear',
        '/clear @s', '/kill @e[type=!player]', '/effect clear @s', '/effect give @s instant_health 1 10 true', '/effect give @s saturation 1 10 true',
        ...flatAcceptanceSetup(), ...scenario.fixture, '/gamemode survival @s'],
      preAssertions: [{ type: 'block_at', x: 0, y: 107, z: 2, block: 'air' }, { type: 'difficulty', difficulty: 'peaceful' },
        { type: 'gamerule', rule: 'spawn_mobs', value: false }],
      assertions: [...scenario.assertions, { type: 'gamemode', gamemode: 'survival' }, { type: 'health_between', min: 20, max: 20 }],
    }, { tools, timeoutMs: 120000, plannerKind: real ? 'real_provider' : 'protocol_fixture', oracle });
    reports.push(report); console.log(JSON.stringify({ scenario: scenario.id, passed: report.passed, durationMs: report.durationMs, iterations: report.executor.iterations, plannerKind: report.plannerKind, died }));
    if (!report.passed || died) { process.exitCode = 1; break; }
  }
} finally {
  closeProbeBot(actor); closeProbeBot(operator);
  const sourceUnchanged = JSON.stringify(sourceHashes) === JSON.stringify(hashSources());
  fs.writeFileSync(path.join(directory, `${id}-openai-acceptance.json`), JSON.stringify({ id, real, calls, maxCalls, maxReservedUsd: 0.50, selectedCases, reservedUsd, died,
    setupActor: 'operator', plannerActor: 'non-op-survival', sourceHashes, sourceUnchanged, requests, reports }, null, 2));
}
