import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import Anthropic from '@anthropic-ai/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/config/env.js', () => ({ config: { anthropic: { apiKey: 'offline-anthropic', model: 'claude-opus-4-6' },
  openaiApiKey: 'offline-openai', minecraftPlanner: { provider: 'anthropic', anthropicModel: 'claude-haiku-5-5', openAIModel: 'gpt-5.6-luna' } } }));
vi.mock('../../src/services/minebot/config/MinebotConfig.js', () => ({ CONFIG: { UI_MOD_BASE_URL: 'http://example.invalid' } }));
import { createConfiguredMinecraftPlanner } from '../../src/services/minebot/cognition/configuredMinecraftPlanner.js';
import { MINECRAFT_HAIKU_MODEL } from '../../src/services/minebot/cognition/AnthropicPlannerClient.js';
import { ShannonExecutor } from '../../src/services/llm/graph/ShannonExecutor.js';

const directories: string[] = [];
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
const configuration = (provider = 'anthropic', anthropicModel = MINECRAFT_HAIKU_MODEL) => ({
  anthropic: { apiKey: 'offline-anthropic' }, openaiApiKey: 'offline-openai',
  minecraftPlanner: { provider, anthropicModel, openAIModel: 'gpt-5.6-luna' },
});
const usage = { input_tokens: 12, output_tokens: 30, cache_creation_input_tokens: 700, cache_read_input_tokens: 0,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 700 } };
const reply = (content: any[]) => new Response(JSON.stringify({ type: 'message', role: 'assistant', model: MINECRAFT_HAIKU_MODEL,
  stop_reason: content.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn', content, usage }));
const budget = (limit = '12') => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'minebot-configured-')); directories.push(directory);
  const file = path.join(directory, 'budget.json');
  vi.stubEnv('MINECRAFT_MODEL_BUDGET_FILE', file); vi.stubEnv('MINECRAFT_MODEL_DAILY_REQUEST_LIMIT', limit);
  vi.stubEnv('MINECRAFT_MODEL_DAILY_TOKEN_RESERVATION', '1000000');
  return file;
};
const botFixture = () => Object.assign(new EventEmitter(), { executingSkill: false, interruptExecution: false,
  registry: { itemsByName: {} }, health: 20, food: 20, activeFurnaces: [], entities: {}, inventory: { items: () => [] },
  entity: { position: { x: 0, y: 64, z: 0 } }, game: { dimension: 'overworld' },
  pathfinder: { stop: vi.fn(), setGoal: vi.fn() }, clearControlStates: vi.fn() });

describe('production Minecraft planner configuration', () => {
  it('loads only the explicit dedicated model setting and leaves the global Anthropic default alone', async () => {
    vi.stubEnv('SHANNON_ISOLATED_MINEBOT_PROBE', 'true'); vi.stubEnv('OPENAI_API_KEY', 'offline-openai');
    vi.stubEnv('MONGODB_URI', 'mongodb://127.0.0.1:1/offline-not-used');
    vi.stubEnv('MINECRAFT_PLANNER_ANTHROPIC_MODEL', MINECRAFT_HAIKU_MODEL);
    vi.stubEnv('SHANNON_ANTHROPIC_MODEL', 'claude-opus-4-6');
    const actual: any = await vi.importActual('../../src/config/env.js');
    expect(actual.config.minecraftPlanner.anthropicModel).toBe(MINECRAFT_HAIKU_MODEL);
    expect(actual.config.anthropic.model).toBe('claude-opus-4-6');
  });

  it.each(['anthropic', 'auto'])('fixes native %s requests to Haiku while preserving original tool IDs and dynamic data', async provider => {
    const bodies: any[] = [];
    const fetcher = vi.fn(async (url: any, init: any) => { expect(url).toBe('https://api.anthropic.com/v1/messages');
      bodies.push(JSON.parse(init.body)); return reply([{ type: 'tool_use', id: 'next', name: 'task-complete', input: { summary: 'done' } }]); });
    const configured = createConfiguredMinecraftPlanner(configuration(provider), fetcher as any);
    const request: any = { model: 'claude-opus-4-6', max_tokens: 200, system: 'Keep the original goal.', tools: [],
      messages: [{ role: 'user', content: 'original goal' }, { role: 'assistant', content: [{ type: 'tool_use', id: 'original-call', name: 'observe', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'original-call', content: 'actual result' }] }] };
    const before = JSON.stringify(request);
    await (configured.client.messages as any).stream(request).finalMessage();
    expect(configured.model).toBe(MINECRAFT_HAIKU_MODEL); expect(bodies[0].model).toBe(MINECRAFT_HAIKU_MODEL);
    expect(bodies[0].system[1].text).toBe('Keep the original goal.');
    expect(bodies[0].messages[1].content[0].id).toBe('original-call');
    expect(bodies[0].messages[2].content[0]).toEqual(request.messages[2].content[0]);
    expect(JSON.stringify(request)).toBe(before); expect(fetcher).toHaveBeenCalledOnce();
  });

  it('keeps OpenAI explicitly selected and the unconfigured legacy SDK selection available', async () => {
    const fetcher = vi.fn(async (url: any, init: any) => {
      expect(url).toBe('https://api.openai.com/v1/responses');
      expect(JSON.parse(init.body).model).toBe('gpt-5.6-luna');
      return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'legacy' }] }],
        usage: { input_tokens: 20, output_tokens: 2 } }));
    });
    const openai = createConfiguredMinecraftPlanner(configuration('openai'), fetcher as any);
    expect(openai.model).toBe('gpt-5.6-luna');
    await (openai.client.messages as any).create({ messages: [{ role: 'user', content: 'fixture' }], max_tokens: 50 });
    const legacy = createConfiguredMinecraftPlanner(configuration('anthropic', ''), fetcher as any);
    expect(legacy.client).toBeInstanceOf(Anthropic); expect(legacy.model).toBeUndefined();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('refuses a selected Haiku key that is absent instead of using the other provider', () => {
    expect(() => createConfiguredMinecraftPlanner({ ...configuration(), anthropic: { apiKey: '' } }, vi.fn() as any)).toThrow('KEY_REQUIRED');
  });
});

describe('real executor composition with the native budgeted planner', () => {
  it.each([
    { goal: 'こんにちは', tags: [], previousMessages: undefined, expectedRequests: 1 },
    { goal: '資源を集める', tags: ['emergency'], previousMessages: undefined, expectedRequests: 1 },
    { goal: 'ネザーポータルを建設する', tags: [], previousMessages: undefined, expectedRequests: 1 },
    { goal: '安全を確かめてから必要な材料を集めてネザーポータルを建設する', tags: [], previousMessages: undefined, expectedRequests: 2 },
    { goal: '作業を続ける', tags: [], previousMessages: [{ role: 'user', content: 'original prior goal' }], expectedRequests: 2 },
  ])('uses fixed Haiku for task and any summary: $goal', async fixture => {
    const file = budget(); const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: any, init: any) => {
      expect(String(url)).toBe('https://api.anthropic.com/v1/messages');
      const body = JSON.parse(init.body); bodies.push(body);
      return reply(body.tools?.length ? [{ type: 'tool_use', id: 'done', name: 'task-complete', input: { summary: 'native proof checked' } }]
        : [{ type: 'text', text: '作業の続行' }]);
    }));
    const result = await new ShannonExecutor({ bot: botFixture() as any, publishTaskTree: () => {} }).run({
      runId: 'offline-configured', goal: fixture.goal, tags: fixture.tags, previousMessages: fixture.previousMessages as any,
      context: null, systemPrompt: 'Keep the goal and prove completion.', tools: [],
      goalContract: { goal: fixture.goal, predicates: [{ kind: 'position', dimension: 'overworld', position: { x: 0, y: 64, z: 0 }, radius: 1 }] },
    });
    expect(result.taskTree?.status).toBe('completed');
    expect(bodies).toHaveLength(fixture.expectedRequests);
    expect(bodies.every(body => body.model === MINECRAFT_HAIKU_MODEL)).toBe(true);
    expect(bodies.every(body => body.system.some((block: any) => block.cache_control?.ttl === '1h'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).requests).toBe(fixture.expectedRequests);
    expect(fs.readFileSync(file, 'utf8')).not.toContain(fixture.goal);
  });

  it('reserves before sending and keeps exhausted retries from reaching either provider', async () => {
    const file = budget('1');
    const fetcher = vi.fn(async () => reply([{ type: 'text', text: 'Need another observation' }]));
    vi.stubGlobal('fetch', fetcher);
    const result = await new ShannonExecutor({ bot: botFixture() as any, publishTaskTree: () => {} }).run({
      runId: 'offline-exhausted', goal: '石を集める', context: null, systemPrompt: 'fixture', tools: [],
    });
    expect(result.taskTree?.status).not.toBe('completed'); expect(fetcher).toHaveBeenCalledOnce();
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).requests).toBe(1);
  });

  it('preserves explicitly injected isolated clients and their declared model identity', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const requests: any[] = [];
    const modelClient: any = { messages: { stream: (request: any) => { requests.push(request);
      return { finalMessage: async () => ({ content: [{ type: 'tool_use', id: 'done', name: 'task-complete', input: { summary: 'answered' } }], usage: {} }) }; } } };
    const result = await new ShannonExecutor({ modelClient, modelIdentity: { provider: 'fixture', model: 'fixture' },
      bot: botFixture() as any, publishTaskTree: () => {}, conversation: true }).run({
      runId: 'offline-injected', goal: 'こんにちは', context: null, systemPrompt: 'fixture', tools: [],
    });
    expect(result.taskTree?.status).toBe('completed'); expect(requests[0].model).toBe('fixture');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
