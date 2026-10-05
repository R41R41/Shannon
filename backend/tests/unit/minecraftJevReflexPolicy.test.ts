import { describe, expect, it, vi } from 'vitest';
import {
  createConfiguredReflexPolicy,
  formatReflexRecommendation,
  JevReflexPolicy,
  LocalReflexPolicy,
  OpenAIReflexPolicy,
} from '../../src/services/minebot/cognition/JevReflexPolicy.js';

const input = (availableCapabilities: string[] = ['flee-from']) => ({
  event: { eventType: 'hostile_approach', distance: 4, mobCount: 2 },
  world: {
    observedAt: '2026-09-27T00:00:00.000Z',
    dimension: 'minecraft:overworld', position: { x: 0, y: 64, z: 0 },
    health: 8, food: 15, oxygen: 300, isInWater: false,
    weather: 'clear', time: 'night', biome: 'plains', heldItem: null,
    inventory: [], activeEffects: [], nearbyEntities: [],
  },
  currentTaskActive: true,
  availableCapabilities,
});

describe('JevReflexPolicy', () => {
  it('returns a typed low-latency action from the available capability set', async () => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ answers: {
        should_preempt: { noul: 0.98 },
        immediate_action: { choice: 'FLEE', confidence: 0.9, probabilities: { FLEE: 1, EAT: 0, SURFACE: 0, STOP_MOVEMENT: 0, SEEK_SHELTER: 0, OBSERVE: 0, DELEGATE_SYSTEM2: 0 } },
        urgency: { choice: 'CRITICAL' },
        confidence: { choice: 'HIGH' },
      } }),
    } as Response));
    const policy = new JevReflexPolicy({
      apiKey: 'test-key', fetcher, nowMilliseconds: () => 100, idFactory: () => 'reflex-1',
    });
    const decision = await policy.decide(input());
    expect(decision).toMatchObject({
      id: 'reflex-1', source: 'jev', immediateAction: 'FLEE', urgency: 'CRITICAL',
      shouldPreemptProbability: 0.98, capabilityAvailable: true, confidence: 0.9,
    });
    expect(formatReflexRecommendation(decision)).toContain('immediate_action=FLEE');
  });

  it('verifies capability availability before a Jev choice reaches System 2', async () => {
    const policy = new JevReflexPolicy({
      apiKey: 'test-key',
      fetcher: vi.fn(async () => ({
        ok: true, status: 200, json: async () => ({ answers: {
          should_preempt: { noul: 0.9 }, immediate_action: { choice: 'EAT', confidence: 0.9, probabilities: { FLEE: 0, EAT: 1, SURFACE: 0, STOP_MOVEMENT: 0, SEEK_SHELTER: 0, OBSERVE: 0, DELEGATE_SYSTEM2: 0 } },
          urgency: { choice: 'CRITICAL' }, confidence: { choice: 'HIGH' },
        } }),
      } as Response)),
      idFactory: () => 'reflex-2',
    });
    const decision = await policy.decide(input([]));
    expect(decision.immediateAction).toBe('DELEGATE_SYSTEM2');
    expect(decision.capabilityAvailable).toBe(false);
  });

  it('uses a non-controlling fallback if Jev is unavailable', async () => {
    const policy = new JevReflexPolicy({
      apiKey: 'test-key',
      fetcher: vi.fn(async () => { throw new Error('offline'); }),
      idFactory: () => 'fallback-1',
    });
    const decision = await policy.decide(input());
    expect(decision).toMatchObject({
      source: 'fallback', immediateAction: 'DELEGATE_SYSTEM2', confidence: 0,
    });
    expect(formatReflexRecommendation(decision)).toBeNull();
  });

  it('uses GPT-5.6 Luna structured output without bypassing capability verification', async () => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ output_text: JSON.stringify({
        should_preempt_probability: 0.96,
        immediate_action: 'EAT',
        urgency: 'CRITICAL',
        confidence: 'HIGH',
      }) }),
    } as Response));
    const policy = new OpenAIReflexPolicy({
      apiKey: 'openai-test-key', fetcher, nowMilliseconds: () => 100, idFactory: () => 'openai-reflex',
    });

    const decision = await policy.decide(input([]));
    expect(decision).toMatchObject({
      id: 'openai-reflex', source: 'openai', immediateAction: 'DELEGATE_SYSTEM2',
      capabilityAvailable: false, confidence: 0.9,
    });
    expect(formatReflexRecommendation(decision)).toContain('高速反射判断(openai)');
    const request = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
    expect(request).toMatchObject({
      model: 'gpt-5.6-luna', reasoning: { effort: 'none' },
      text: { format: { name: 'minecraft_reflex_policy', strict: true } },
    });
  });

  it('supports the same Jev → OpenAI → local provider selection as the critic', () => {
    expect(createConfiguredReflexPolicy({ TYPESAFE_API_KEY: 'jev-key', OPENAI_API_KEY: 'openai-key' }).source).toBe('jev');
    expect(createConfiguredReflexPolicy({ OPENAI_API_KEY: 'openai-key' }).source).toBe('openai');
    expect(createConfiguredReflexPolicy({ MINECRAFT_COGNITION_PROVIDER: 'local', OPENAI_API_KEY: 'openai-key' }).source).toBe('fallback');
  });

  it('generates default decision ids under Node 22 without losing the Crypto receiver', async () => {
    const decision = await new LocalReflexPolicy().decide(input());
    expect(decision.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});
