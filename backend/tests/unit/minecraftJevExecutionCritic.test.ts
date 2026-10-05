import { describe, expect, it, vi } from 'vitest';
import {
  createConfiguredExecutionCritic,
  formatCriticFeedback,
  JevExecutionCritic,
  LocalExecutionCritic,
  OpenAIExecutionCritic,
} from '../../src/services/minebot/cognition/JevExecutionCritic.js';
import type { CriticInput } from '../../src/services/minebot/cognition/types.js';

const input = (): CriticInput => ({
  runId: 'run-a',
  goal: 'collect ten cobblestone',
  evaluatedRevision: 3,
  currentWorld: null,
  previousWorld: null,
  plan: [],
  recentReceipts: [],
  previousAssessment: null,
});

describe('JevExecutionCritic', () => {
  it('sends typed questions and parses a typed control assessment', async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => ({
        answers: {
          progress_state: { choice: 'STALLED' },
          continue_now: { noul: 0.1 },
          needs_observation: { noul: 0.8 },
          needs_replan: { noul: 0.9 },
          failure_cause: { choice: 'REPEATED_FAILURE' },
          next_control: { choice: 'REPLAN', confidence: 0.9, probabilities: { CONTINUE: 0, OBSERVE: 0, RETRY_ONCE: 0, SWITCH_SUBTASK: 0, REPLAN: 1, ABORT_UNSAFE: 0 } },
          confidence: { choice: 'HIGH' },
        },
      }),
    } as Response));
    const critic = new JevExecutionCritic({
      apiKey: 'test-key',
      fetcher,
      nowMilliseconds: () => 100,
      idFactory: () => 'assessment-1',
    });

    const state = input();
    state.activeAction = { actionId: 'active-1', generation: 1, sequence: 2, capability: 'mine-block',
      physical: true, phase: 'recovery', status: 'blocked', startedAt: 0, updatedAt: 100,
      lastProgressAt: 0, elapsedMs: 100, evidence: { reason: 'no_path' } };
    const result = await critic.assess(state);
    expect(result).toMatchObject({
      id: 'assessment-1',
      source: 'jev',
      progressState: 'STALLED',
      failureCause: 'REPEATED_FAILURE',
      nextControl: 'REPLAN',
      confidence: 0.9,
    });
    const request = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
    expect(request.model).toBe('jev-latest');
    expect(request.state.evaluated_world_revision).toBe(3);
    expect(request.state.active_action).toMatchObject({ phase: 'recovery', evidence: { reason: 'no_path' } });
    expect(request.questions.next_control.criteria).toHaveProperty('SWITCH_SUBTASK');
  });

  it('falls back without emitting active feedback when Jev fails', async () => {
    const critic = new JevExecutionCritic({
      apiKey: 'test-key',
      fetcher: vi.fn(async () => { throw new Error('network'); }),
      idFactory: () => 'fallback-1',
    });
    const result = await critic.assess(input());
    expect(result.source).toBe('fallback');
    expect(formatCriticFeedback(result)).toBeNull();
  });

  it('only feeds back fresh, confident, non-CONTINUE Jev decisions', () => {
    const base = {
      id: 'assessment-1', runId: 'run-a', evaluatedRevision: 1,
      receivedAt: '2026-09-27T00:00:00.000Z', elapsedMilliseconds: 90,
      source: 'jev' as const, stale: false, progressState: 'STALLED' as const,
      continueProbability: 0.1, needsObservationProbability: 0.8,
      needsReplanProbability: 0.9, failureCause: 'REPEATED_FAILURE' as const,
      nextControl: 'REPLAN' as const, confidence: 0.9,
    };
    expect(formatCriticFeedback(base)).toContain('推奨制御=REPLAN');
    expect(formatCriticFeedback({ ...base, stale: true })).toBeNull();
    expect(formatCriticFeedback({ ...base, confidence: 0.2 })).toBeNull();
    expect(formatCriticFeedback({ ...base, nextControl: 'CONTINUE' })).toBeNull();
  });

  it('uses GPT-5.6 Luna structured output when Jev credentials are unavailable', async () => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({
          progress_state: 'STALLED',
          continue_probability: 0.1,
          needs_observation_probability: 0.8,
          needs_replan_probability: 0.9,
          failure_cause: 'REPEATED_FAILURE',
          next_control: 'REPLAN',
          confidence: 'HIGH',
        }) }] }],
      }),
    } as Response));
    const critic = new OpenAIExecutionCritic({
      apiKey: 'openai-test-key', fetcher, nowMilliseconds: () => 100, idFactory: () => 'openai-1',
    });

    const result = await critic.assess(input());
    expect(result).toMatchObject({
      id: 'openai-1', source: 'openai', progressState: 'STALLED', nextControl: 'REPLAN', confidence: 0.9,
    });
    expect(formatCriticFeedback(result)).toContain('Fast Execution Critic (openai)');
    const request = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
    expect(request).toMatchObject({
      model: 'gpt-5.6-luna',
      store: false,
      reasoning: { effort: 'none' },
      text: { verbosity: 'low', format: { type: 'json_schema', strict: true } },
    });
  });

  it('selects Jev first in auto mode, then OpenAI, and allows an explicit local fallback', () => {
    expect(createConfiguredExecutionCritic({
      TYPESAFE_API_KEY: 'jev-key', OPENAI_API_KEY: 'openai-key',
    }).source).toBe('jev');
    expect(createConfiguredExecutionCritic({ OPENAI_API_KEY: 'openai-key' }).source).toBe('openai');
    expect(createConfiguredExecutionCritic({
      MINECRAFT_COGNITION_PROVIDER: 'local', OPENAI_API_KEY: 'openai-key',
    }).source).toBe('fallback');
  });

  it('generates default assessment ids under Node 22 without losing the Crypto receiver', async () => {
    const result = await new LocalExecutionCritic().assess(input());
    expect(result.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});
