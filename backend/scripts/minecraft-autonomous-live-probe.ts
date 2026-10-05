#!/usr/bin/env node
/** Real-provider goal-only runner or explicitly labelled protocol fixture.
 * Never reads shared .env/DB/Discord config or sends UI Mod writes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import dotenv from 'dotenv';
import Anthropic from '@anthropic-ai/sdk';
import { createProbeBot, closeProbeBot } from '../src/services/minebot/testing/MinecraftProbeBot.js';
import { AutonomousScenarioRunner } from '../src/services/minebot/testing/AutonomousScenarioRunner.js';
import { skillToAnthropicTool } from '../src/services/llm/graph/ShannonExecutor.js';

const kind = process.env.MINECRAFT_AUTONOMOUS_PLANNER === 'real_provider' ? 'real_provider' : 'protocol_fixture';
const repeats = Number(process.env.MINECRAFT_AUTONOMOUS_REPEATS ?? 3);
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 3) throw new Error('REPEATS_MUST_BE_1_TO_3');
const port = Number(process.env.MINECRAFT_PROBE_PORT ?? 25577);
let realClient: Anthropic | undefined; let providerCalls = 0;
if (kind === 'real_provider') {
  const file = '/home/azureuser/.config/shannon/minebot-planner.env';
  if (!fs.existsSync(file)) throw new Error('DEDICATED_PLANNER_CREDENTIAL_REQUIRED: create minebot-planner.env outside Git; do not reuse shared .env');
  const credential = dotenv.parse(fs.readFileSync(file));
  if (!credential.ANTHROPIC_API_KEY?.trim()) throw new Error('DEDICATED_ANTHROPIC_KEY_REQUIRED');
  realClient = new Anthropic({ apiKey: credential.ANTHROPIC_API_KEY });
}
const campaignId = new Date().toISOString().replace(/[:.]/g, '-');
const directory = path.resolve('saves/minecraft/progressive_reports'); fs.mkdirSync(directory, { recursive: true });
const files = ['scripts/minecraft-autonomous-live-probe.ts', 'src/services/llm/graph/ShannonExecutor.ts',
  'src/services/minebot/testing/AutonomousScenarioRunner.ts', 'src/services/minebot/cognition/GoalVerifier.ts',
  'src/services/minebot/cognition/worldFrame.ts', 'src/services/minebot/types/skills.ts', 'src/services/minebot/execution/ActionExecution.ts'];
const sourceHashes = Object.fromEntries(files.map(file => [file, createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
const reports: unknown[] = [];
for (let repeat = 1; repeat <= repeats; repeat++) {
  const bot = await createProbeBot(port);
  try {
    let turn = 0;
    const client = { messages: {
      stream: (request: any) => {
        if (realClient) {
          if (++providerCalls > 12) throw new Error('PROVIDER_CALL_BUDGET_EXHAUSTED');
          return realClient.messages.stream({ ...request, model: 'claude-haiku-4-5-20251001', max_tokens: 2048 });
        }
        const content = turn++ === 0 ? [{ type: 'tool_use', id: 'early', name: 'task-complete', input: { summary: 'not actually complete' } }]
          : turn === 2 ? [{ type: 'tool_use', id: 'wood', name: 'mine-block', input: { blockName: 'oak_log', count: 3, searchRadius: 24 } }]
          : [{ type: 'tool_use', id: 'done', name: 'task-complete', input: { summary: 'collected three logs' } },
            { type: 'tool_use', id: 'after-done', name: 'place-block-at', input: { blockName: 'oak_log', x: 1, y: 100, z: 0 } }];
        return { finalMessage: async () => ({ content, usage: {} }) };
      },
      create: async () => { throw new Error('SUMMARY_NOT_ALLOWED_IN_ISOLATED_PROBE'); },
    } };
    const runner = new AutonomousScenarioRunner(bot, { modelClient: client as any }, port);
    const goal = 'オーク原木を3個集める';
    const report = await runner.run({ id: `wood-goal-${repeat}`, goal,
      constraints: 'Survive and collect the requested material. Do not issue Minecraft chat commands. Find resources using observations; no target coordinates are supplied.',
      setup: ['/gamemode survival @s', '/difficulty peaceful', '/gamerule spawn_mobs false', '/gamerule advance_time false',
        '/time set day', '/weather clear', '/clear @s', '/kill @e[type=!player]', '/effect clear @s',
        '/effect give @s instant_health 1 10 true', '/effect give @s saturation 1 10 true',
        '/fill -15 99 -15 15 99 15 stone', '/fill -15 100 -15 15 106 15 air', '/tp @s 0 100 0', '/give @s iron_axe 1',
        `/fill ${4 + repeat * 2} 100 2 ${4 + repeat * 2} 102 2 oak_log`],
      goalContract: { goal, predicates: [{ kind: 'produced', item: 'oak_log', count: 3 }] },
      assertions: [{ type: 'inventory_count', item: 'oak_log', minCount: 3, maxCount: 3 },
        { type: 'block_at', x: 1, y: 100, z: 0, block: 'air' }, { type: 'health_between', min: 20, max: 20 }],
    }, { tools: [...bot.instantSkills.getSkills().filter(skill => skill.isToolForLLM
        && !['chat', 'get-advancements', 'investigate-terrain'].includes(skill.skillName)).map(skillToAnthropicTool),
      { name: 'task-complete', description: 'Request verified completion.', input_schema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] } }],
      plannerKind: kind, timeoutMs: 120000 });
    reports.push(report);
    process.stdout.write(`AUTONOMOUS_PROBE ${JSON.stringify({ repeat, kind, passed: report.passed, durationMs: report.durationMs, iterations: report.executor.iterations, autonomyEvaluated: report.autonomousQualityEvaluated })}\n`);
    if (!report.passed) { process.exitCode = 1; break; }
  } finally { closeProbeBot(bot); }
}
fs.writeFileSync(path.join(directory, `${campaignId}-autonomous-runner.json`), JSON.stringify({ campaignId, sourceHashes, plannerKind: kind,
  autonomousQualityEvaluated: kind === 'real_provider', providerCalls, reports }, null, 2));
