#!/usr/bin/env node
/** Bounded, shadow-only representation/question ablation. Not an autonomous-game eval.
 * Dedicated Minebot Jev credential only. No shared .env or runtime start.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import dotenv from 'dotenv';
import { JevExecutionCritic } from '../src/services/minebot/cognition/JevExecutionCritic.js';
import { captureWorldObservation } from '../src/services/minebot/cognition/worldFrame.js';
import type { CriticInput } from '../src/services/minebot/cognition/types.js';

const repeats = Number(process.env.MINECRAFT_CRITIC_AUDIT_REPEATS ?? 3);
const variants = (process.env.MINECRAFT_CRITIC_AUDIT_VARIANTS ?? 'production,pending_receipt_only,focused_question_only,pending_and_focused').split(',');
if (!variants.length || variants.some(variant => !['production', 'pending_receipt_only', 'focused_question_only', 'pending_and_focused'].includes(variant))) throw new Error('INVALID_AUDIT_VARIANT');
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 3) throw new Error('Repeats must be 1..3 (at most 36 requests)');
const env = dotenv.parse(fs.readFileSync('/home/azureuser/.config/shannon/minebot-jev.env'));
if (!env.TYPESAFE_API_KEY?.trim()) throw new Error('Dedicated Jev credential unavailable');
const endpoint = env.SHANNON_JEV_ENDPOINT || 'https://api.typesafe.ai/v1/systemone';
if (new URL(endpoint).origin !== 'https://api.typesafe.ai') throw new Error('Only the verified TypeSafe endpoint is permitted');
const campaignId = new Date().toISOString().replace(/[:.]/g, '-');
const directory = path.resolve('saves/minecraft/progressive_reports'); fs.mkdirSync(directory, { recursive: true });
const sourceFiles = ['scripts/minecraft-critic-audit.ts', 'src/services/minebot/cognition/JevExecutionCritic.ts',
  'src/services/minebot/cognition/worldFrame.ts'];
const sourceHashes = Object.fromEntries(sourceFiles.map(file => [file, createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
const rows: any[] = [];
const definitions = [
  { name: 'healthy_smelting', accepted: ['CONTINUE'], cause: 'NONE' },
  { name: 'blocked_path', accepted: ['REPLAN', 'SWITCH_SUBTASK'], cause: 'BLOCKED_PATH' },
  { name: 'unsafe_health', accepted: ['ABORT_UNSAFE'], cause: 'UNSAFE' },
];
function fixture(name: string): CriticInput {
  const now = Date.now(); const runId = `audit:${name}`;
  const world = { ...captureWorldObservation({ entity: { position: { x: 2, y: 100, z: 3 } },
    health: name === 'unsafe_health' ? 2 : 20, food: 20, game: { dimension: 'overworld' },
    inventory: { items: () => [{ name: 'stick', count: 4 }] }, entities: name === 'unsafe_health'
      ? { zombie: { name: 'zombie', type: 'hostile', position: { x: 3, y: 100, z: 3 } } } : {} }),
    runId, revision: 2 };
  const smelting = name === 'healthy_smelting';
  return { runId, goal: 'Smelt three raw iron, prepare a chest while the furnace works, and craft an iron pickaxe.',
    evaluatedRevision: 2, currentWorld: world, previousWorld: { ...world, revision: 1, health: 20 },
    plan: [], previousAssessment: null,
    recentReceipts: [{ id: 'previous', runId, iteration: 1, actionKind: 'instant_skill',
      capability: smelting ? 'withdraw-from-furnace' : 'mine-block', args: {}, intendedEffect: 'advance prerequisites',
      startedAt: new Date(now - 20000).toISOString(), finishedAt: new Date(now - 15000).toISOString(), durationMs: 20,
      beforeRevision: 1, afterRevision: 2, success: false, failureType: smelting ? 'waiting_external' : 'no_path',
      recoverable: true, resultSummary: smelting ? 'The furnace is still smelting. No output yet.' : 'No path to target.',
      observedDelta: { positionDelta: { x: 0, y: 0, z: 0 }, healthDelta: 0, foodDelta: 0, dimensionChanged: false, inventoryDelta: [] },
      meaningfulWorldAction: true }],
    activeAction: { actionId: 'active', executionSessionId: 'audit-session', generation: 1, sequence: 2,
      capability: smelting ? 'withdraw-from-furnace' : 'mine-block', physical: true,
      phase: smelting ? 'wait_external' : 'recovery', status: smelting ? 'waiting_external' : 'blocked',
      startedAt: now - 5000, updatedAt: now, lastProgressAt: smelting ? now - 200 : now - 5000, elapsedMs: 5000,
      evidence: smelting ? { kind: 'smelting', position: [2, 100, 3], input: { name: 'raw_iron', count: 2 },
        output: { name: 'iron_ingot', count: 1 }, fuel: null, expectedOutputCount: 3, maximumWaitMs: 22000 }
        : { reason: 'no_path', attempts: 3, targetStillPresent: true, inventoryPrerequisitePresent: true } },
  };
}
const focusedQuestion = { type: 'choice',
  instructions: 'Which immediate execution control is supported by the current facts? Judge the active action, not whether the final product is already owned. A furnace can still be burning after its fuel slot becomes empty. Recent output progress during normal smelting supports continuing. Repeated verified route failures support replanning. Current HP 2 with a hostile one metre away supports an immediate safety stop. If the facts are inadequate choose OBSERVE.',
  criteria: {
    CONTINUE: 'The current physical action is making verified progress and can continue safely.',
    OBSERVE: 'Important current facts are unknown or inconsistent; gather observation.',
    REPLAN: 'A verified blocker requires a different route or prerequisite.',
    SWITCH_SUBTASK: 'Another unblocked task should run instead of the blocked current task.',
    ABORT_UNSAFE: 'Current facts show immediate danger; stop the unsafe current action.',
  } };
function cleanState(payload: any) {
  const state = payload.state;
  // Diagnostic intervention only: no runtime receipt/schema behavior is modified.
  state.recent_action_receipts = state.recent_action_receipts.map((r: any) => r.failureType === 'waiting_external'
    ? { ...r, success: null, failureType: null, outcome: 'pending_external' } : r);
  return state;
}
for (let repeat = 1; repeat <= repeats; repeat++) for (const definition of definitions) {
  for (const variant of variants) {
    const input = fixture(definition.name); let request: any;
    // Capture the EXACT current production request without exposing headers/key or making a call.
    await new JevExecutionCritic({ apiKey: 'mock', fetcher: (async (_url, init) => {
      request = JSON.parse(String(init?.body)); throw new Error('capture-only');
    }) as typeof fetch }).assess(input);
    if (variant.includes('pending')) cleanState(request);
    if (variant.includes('focused')) request.questions = { next_control: focusedQuestion };
    const start = Date.now(); let response: any = null; let status: number | null = null; let error: string | null = null;
    try {
      const result = await fetch(endpoint, { method: 'POST', headers: { authorization: `Bearer ${env.TYPESAFE_API_KEY}`,
        'content-type': 'application/json' }, body: JSON.stringify(request), signal: AbortSignal.timeout(2500) });
      status = result.status; if (!result.ok) throw new Error(`HTTP_${result.status}`);
      response = await result.json();
    } catch (caught) { error = caught instanceof Error ? caught.name === 'TimeoutError' ? 'timeout' : caught.message.replaceAll(env.TYPESAFE_API_KEY, '[redacted]') : 'unknown'; }
    const answer = response?.answers?.next_control;
    const row = { fixture: definition.name, variant, repeat, acceptedControls: definition.accepted,
      correctControl: definition.accepted.includes(answer?.choice), durationMs: Date.now() - start,
      status, error, request, response, providerControlConfidence: answer?.confidence ?? null,
      selfReportedConfidenceLabel: response?.answers?.confidence?.choice ?? null,
      cause: response?.answers?.failure_cause?.choice ?? null };
    rows.push(row);
    fs.writeFileSync(path.join(directory, `${campaignId}-critic-audit.json`), JSON.stringify({ campaignId, sourceHashes, repeats,
      fixtureScope: 'constructed fixtures grounded in native smelting evidence; not exact historical request replay', rows }, null, 2));
    process.stdout.write(`CRITIC_AUDIT ${JSON.stringify({ fixture: row.fixture, variant, repeat,
      control: answer?.choice, correct: row.correctControl, durationMs: row.durationMs, error,
      confidence: row.providerControlConfidence, selfReported: row.selfReportedConfidenceLabel, cause: row.cause })}\n`);
    if (error) { process.exitCode = 1; throw new Error(`Audit stopped: ${error}`); } // never retry/spend unbounded
  }
}
const groups = definitions.flatMap(d => variants.map(variant => {
  const selected = rows.filter(r => r.fixture === d.name && r.variant === variant);
  return { fixture: d.name, variant, count: selected.length, correct: selected.filter(r => r.correctControl).length,
    controls: selected.map(r => r.response.answers.next_control.choice),
    meanMs: selected.reduce((n, r) => n + r.durationMs, 0) / selected.length };
}));
fs.writeFileSync(path.join(directory, `${campaignId}-critic-audit-summary.json`), JSON.stringify({ campaignId, sourceHashes, groups }, null, 2));
process.stdout.write(`CRITIC_AUDIT_SUMMARY ${JSON.stringify({ campaignId, total: rows.length, groups })}\n`);
