import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicStructuredDecisionGateway, configuredAnthropicCognition } from '../../src/services/minebot/cognition/AnthropicStructuredDecisionGateway.js';
import { AnthropicReflexPolicy, createConfiguredReflexPolicy, formatReflexRecommendation } from '../../src/services/minebot/cognition/JevReflexPolicy.js';
import { AnthropicExecutionCritic, createConfiguredExecutionCritic, formatCriticFeedback } from '../../src/services/minebot/cognition/JevExecutionCritic.js';
import { MINECRAFT_HAIKU_MODEL, MINECRAFT_HAIKU_PROTOCOL_PREFIX } from '../../src/services/minebot/cognition/AnthropicPlannerClient.js';
import type { CriticInput, ReflexDecisionInput } from '../../src/services/minebot/cognition/types.js';

const directories: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const usage = { input_tokens: 40, output_tokens: 20, cache_creation_input_tokens: 700, cache_read_input_tokens: 0,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 700 } };
const native = (value: unknown, extras: any = {}) => ({ type: 'message', model: MINECRAFT_HAIKU_MODEL, stop_reason: 'end_turn',
  content: [{ type: 'thinking', thinking: 'fixture', signature: 'sig' }, { type: 'text', text: JSON.stringify(value) }], usage, ...extras });
const response = (payload: unknown) => new Response(JSON.stringify(payload), { status: 200 });
const schema = { type: 'object', additionalProperties: false, properties: { probability: { type: 'number', minimum: 0, maximum: 1 }, action: { type: 'string', enum: ['OBSERVE', 'CONTINUE'] } }, required: ['probability', 'action'] };
const request = { instructions: 'Classify only this observed state, without changing the goal.', state: { revision: 1 }, schemaName: 'fixture', schema, maxOutputTokens: 140 };
const options = { apiKey: 'offline-native-key', model: MINECRAFT_HAIKU_MODEL };
const reflex = (): ReflexDecisionInput => ({ event: { eventType: 'fixture' }, currentTaskActive: true, availableCapabilities: [],
  world: { observedAt: new Date(0).toISOString(), dimension: null, position: null, health: 5, food: 5, oxygen: 100,
    isInWater: false, weather: null, time: null, biome: null, heldItem: null, inventory: [], activeEffects: [], nearbyEntities: [] } });
const critic = (): CriticInput => ({ runId: 'fixture-run', goal: 'エンドラを倒す', evaluatedRevision: 3, currentWorld: null,
  previousWorld: null, plan: [], recentReceipts: [], previousAssessment: null });

describe('native Haiku bounded Minecraft classifiers', () => {
  it('sends native schema with stable 1h prefix, unchanged data, same 2.5s deadline and no hosted tools', async () => {
    const fetcher = vi.fn(async (_url: any, _init: any) => response(native({ probability: .5, action: 'OBSERVE' })));
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const result = await new AnthropicStructuredDecisionGateway({ ...options, fetcher }).decide(request);
    expect(result).toEqual({ probability: .5, action: 'OBSERVE' }); expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]; const body = JSON.parse(init.body);
    expect(url).toBe('https://api.anthropic.com/v1/messages'); expect(init.headers['x-api-key']).toBe('offline-native-key');
    expect(timeout).toHaveBeenCalledWith(2500); expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(body).toMatchObject({ model: MINECRAFT_HAIKU_MODEL, max_tokens: 1024, thinking: { type: 'adaptive' },
      output_config: { effort: 'low', format: { type: 'json_schema', schema: { additionalProperties: false } } } });
    expect(body.system[0]).toEqual({ type: 'text', text: MINECRAFT_HAIKU_PROTOCOL_PREFIX, cache_control: { type: 'ephemeral', ttl: '1h' } });
    expect(body.system[1]).toMatchObject({ text: request.instructions, cache_control: { type: 'ephemeral', ttl: '1h' } });
    expect(body.messages).toEqual([{ role: 'user', content: JSON.stringify(request.state) }]);
    expect(body.output_config.format.schema.properties.probability).toEqual({ type: 'number', description: 'Allowed numeric range: 0 to 1.' });
    expect(body).not.toHaveProperty('tools'); expect(body).not.toHaveProperty('temperature'); expect(body).not.toHaveProperty('store');
  });

  it('keeps original numeric, enum, exact-key and required-property checks after the native schema transform', async () => {
    for (const value of [{ probability: -1, action: 'CONTINUE' }, { probability: 1.1, action: 'CONTINUE' },
      { probability: .5, action: 'COMMAND' }, { probability: .5, action: 'CONTINUE', extra: true },
      { probability: .5 }, { probability: '0.5', action: 'CONTINUE' }, { probability: null, action: 'CONTINUE' }, [], null]) {
      const fetcher = vi.fn(async () => response(native(value)));
      await expect(new AnthropicStructuredDecisionGateway({ ...options, fetcher }).decide(request)).rejects.toThrow('JSON_INVALID');
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it('refuses unsupported classifier schemas before any transmission', async () => {
    const fetcher = vi.fn(async () => response(native({})));
    for (const bad of [{ ...schema, required: ['action'] }, { ...schema, additionalProperties: true },
      { ...schema, properties: { nested: { type: 'object' } }, required: ['nested'] },
      { ...schema, properties: { probability: { type: 'number', minimum: 0, maximum: 1, multipleOf: .5 }, action: schema.properties.action } }]) {
      await expect(new AnthropicStructuredDecisionGateway({ ...options, fetcher }).decide({ ...request, schema: bad })).rejects.toThrow('SCHEMA_UNSUPPORTED');
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('preserves raw metered usage before cache, truncation, refusal or malformed JSON failure with no replay', async () => {
    for (const payload of [native({ probability: .5, action: 'CONTINUE' }, { usage: { ...usage, cache_creation_input_tokens: 0,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } } }),
      native({}, { stop_reason: 'max_tokens' }), native({}, { stop_reason: 'refusal' }),
      native({}, { content: [{ type: 'text', text: 'broken json' }] }), native({}, { content: [{ type: 'tool_use', id: 'no', name: 'no', input: {} }] })]) {
      const recorded: unknown[] = []; const fetcher = vi.fn(async () => { recorded.push(payload.usage); return response(payload); });
      await expect(new AnthropicStructuredDecisionGateway({ ...options, fetcher }).decide(request)).rejects.toThrow();
      expect(recorded).toEqual([payload.usage]); expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it('propagates original caller stop before and during dispatch, with no second provider request', async () => {
    const controller = new AbortController(); controller.abort(new Error('fixture-stop'));
    const fetcher = vi.fn(async () => response(native({ probability: .5, action: 'OBSERVE' })));
    await expect(new AnthropicStructuredDecisionGateway({ ...options, fetcher, signal: controller.signal }).decide(request)).rejects.toThrow('fixture-stop');
    expect(fetcher).not.toHaveBeenCalled();
    const running = new AbortController();
    const waiting = vi.fn((_url: any, init: any) => new Promise<Response>((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    }));
    const promise = new AnthropicStructuredDecisionGateway({ ...options, fetcher: waiting, signal: running.signal }).decide(request);
    running.abort(new Error('fixture-stop-running')); await expect(promise).rejects.toThrow('fixture-stop-running');
    expect(waiting).toHaveBeenCalledTimes(1);
  });

  it('reserves the actual native ceiling and serialized prefix against the existing daily ledger before dispatch', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minebot-cognition-budget-')); directories.push(dir);
    const file = path.join(dir, 'budget.json'); vi.stubEnv('MINECRAFT_MODEL_BUDGET_FILE', file);
    vi.stubEnv('MINECRAFT_MODEL_DAILY_REQUEST_LIMIT', '1'); vi.stubEnv('MINECRAFT_MODEL_DAILY_TOKEN_RESERVATION', '100000');
    const fetcher = vi.fn(async (_url: any, _init: any) => response(native({ probability: .5, action: 'OBSERVE' })));
    vi.stubGlobal('fetch', fetcher); const gateway = new AnthropicStructuredDecisionGateway(options);
    await gateway.decide(request);
    const body = fetcher.mock.calls[0][1].body;
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ requests: 1, reservedTokens: Buffer.byteLength(body, 'utf8') + 1024 + 4096 });
    await expect(gateway.decide(request)).rejects.toThrow('BUDGET_EXHAUSTED'); expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(file + '.lock')).toBe(false); expect(fs.readFileSync(file, 'utf8')).not.toContain(request.instructions);
  });

  it('uses truthful native provider labels and keeps capability and non-controlling local failure semantics', async () => {
    const value = { should_preempt_probability: .9, immediate_action: 'EAT', urgency: 'CRITICAL', confidence: 'HIGH' };
    const fetcher = vi.fn(async () => response(native(value)));
    const policy = new AnthropicReflexPolicy({ ...options, fetcher, idFactory: () => 'fixture-reflex' });
    expect(await policy.decide(reflex())).toMatchObject({ source: 'anthropic', immediateAction: 'DELEGATE_SYSTEM2', capabilityAvailable: false, confidenceKind: 'self_reported' });
    const invalid = new AnthropicReflexPolicy({ ...options, fetcher: (async () => response(native({ ...value, should_preempt_probability: 2 }))) });
    const failure = await invalid.decide(reflex()); expect(failure.source).toBe('fallback'); expect(formatReflexRecommendation(failure)).toBeNull();
    const assessment = await new AnthropicExecutionCritic({ ...options, fetcher: (async () => response(native({ progress_state: 'STALLED',
      continue_probability: .1, needs_observation_probability: .8, needs_replan_probability: .9,
      failure_cause: 'REPEATED_FAILURE', next_control: 'REPLAN', confidence: 'HIGH' }))) }).assess(critic());
    expect(assessment).toMatchObject({ source: 'anthropic', evaluatedRevision: 3, nextControl: 'REPLAN', confidenceKind: 'self_reported' });
    expect(formatCriticFeedback(assessment)).toContain('Fast Execution Critic (anthropic)');
  });

  it('uses explicit Haiku only in auto fallback; retains Jev priority, explicit OpenAI comparisons and local', () => {
    for (const make of [createConfiguredReflexPolicy, createConfiguredExecutionCritic]) {
      expect(make({ TYPESAFE_API_KEY: 'fixture-jev', OPENAI_API_KEY: 'fixture-openai' }, options).source).toBe('jev');
      expect(make({ OPENAI_API_KEY: 'fixture-openai' }, options).source).toBe('anthropic');
      expect(make({ OPENAI_API_KEY: 'fixture-openai' }, { ...options, apiKey: '' }).source).toBe('fallback');
      expect(make({ MINECRAFT_COGNITION_PROVIDER: 'openai', OPENAI_API_KEY: 'fixture-openai' }, options).source).toBe('openai');
      expect(make({ MINECRAFT_COGNITION_PROVIDER: 'local', OPENAI_API_KEY: 'fixture-openai' }, options).source).toBe('fallback');
      expect(make({ MINECRAFT_COGNITION_PROVIDER: 'jev' }, options).source).toBe('fallback');
      expect(make({ OPENAI_API_KEY: 'fixture-openai' }).source).toBe('openai');
    }
  });

  it('selects from injected config only and leaves absent or other planner choices untouched', () => {
    expect(configuredAnthropicCognition({ anthropic: { apiKey: 'fixture' }, minecraftPlanner: { anthropicModel: MINECRAFT_HAIKU_MODEL } })).toEqual({ apiKey: 'fixture', model: MINECRAFT_HAIKU_MODEL });
    expect(configuredAnthropicCognition({ minecraftPlanner: { provider: 'anthropic', anthropicModel: MINECRAFT_HAIKU_MODEL } })).toEqual({ apiKey: '', model: MINECRAFT_HAIKU_MODEL });
    expect(configuredAnthropicCognition({ anthropic: { apiKey: 'fixture' }, minecraftPlanner: { provider: 'anthropic', anthropicModel: ` ${MINECRAFT_HAIKU_MODEL} ` } })).toEqual({ apiKey: 'fixture', model: MINECRAFT_HAIKU_MODEL });
    for (const config of [{ anthropic: { apiKey: 'fixture' } }, { anthropic: { apiKey: 'fixture' }, minecraftPlanner: { provider: 'openai', anthropicModel: MINECRAFT_HAIKU_MODEL } },
      { anthropic: { apiKey: 'fixture' }, minecraftPlanner: { anthropicModel: 'claude-sonnet-5-5' } }]) expect(configuredAnthropicCognition(config)).toBeUndefined();
  });
});
