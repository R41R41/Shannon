import { describe, expect, it, vi } from 'vitest';
import { CompanionBodyClient } from '../../src/services/minebot/integration/CompanionBodyClient.js';
import { CompanionRuntimeTasks } from '../../src/services/minebot/integration/CompanionRuntimeTasks.js';
import { companionPrimaryModelFromMetadata, supportedCompanionPrimaryModels } from '../../src/services/minebot/integration/companionPrimaryModel.js';
import { createPinnedMinecraftPlanners } from '../../src/services/minebot/cognition/configuredMinecraftPlanner.js';

const HAIKU = 'claude-haiku-5-5', SONNET = 'claude-sonnet-5-5';
const ID = '7d0c1c5e-3b0a-4a51-9c58-2f6a8f0f3b11';
const pin = { mode: 'sonnet' as const, model: SONNET, revision: 17 };
const request = () => ({ id: ID, goal: '木を集める', surface: 'text' as const, createdAt: '2026-10-09T00:00:00Z', leaseExpiresAt: '2026-10-09T00:01:30Z', primaryModel: { ...pin } });
const usage = { input_tokens: 10, output_tokens: 2, cache_creation_input_tokens: 700, cache_read_input_tokens: 0,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 700 } };

describe('original companion request pins its primary model', () => {
  it('advertises only credential-backed exact capabilities and preserves the trusted request revision', async () => {
    expect(supportedCompanionPrimaryModels({ anthropic: {} })).toEqual([]);
    const models = supportedCompanionPrimaryModels({ anthropic: { apiKey: 'offline-fixture-secret-not-returned' } });
    expect(models).toEqual([HAIKU, SONNET]);
    const sent: any[] = [];
    const client = new CompanionBodyClient({ baseUrl: 'http://127.0.0.1:4329', token: 'x'.repeat(43), serverId: 'offline',
      supportedPrimaryModels: () => models,
      fetcher: vi.fn(async (_url, init) => { sent.push(JSON.parse(init!.body as string)); return new Response(JSON.stringify({ request: request(), cancel: [] })); }) as typeof fetch });
    const claimed = await client.claim([], 0);
    expect(sent[0]).toEqual({ scopeKey: 'owner', waitSeconds: 0, holding: [], supportedPrimaryModels: [HAIKU, SONNET] });
    expect(claimed?.request?.primaryModel).toEqual(pin);
    expect(Object.isFrozen(claimed?.request?.primaryModel)).toBe(true);
  });

  it.each([{ ...pin, mode: ['sonnet'] }, { ...pin, model: HAIKU }, { ...pin, revision: -1 }, pin])('never silently executes an unsupported or malformed pin: %j', async selection => {
    const sent: Array<{ url: string; body: any }> = [];
    const client = new CompanionBodyClient({ baseUrl: 'http://127.0.0.1:4329', token: 'x'.repeat(43), serverId: 'offline',
      supportedPrimaryModels: () => [HAIKU], fetcher: vi.fn(async (url, init) => {
        sent.push({ url: String(url), body: JSON.parse(init!.body as string) });
        return new Response(JSON.stringify(String(url).endsWith('/claim') ? { request: { ...request(), primaryModel: selection }, cancel: [ID, 'malformed-id'] } : { state: 'failed', recorded: true }));
      }) as typeof fetch });
    expect(await client.claim([], 0)).toEqual({ request: null, cancel: [ID] });
    expect(sent[1]).toEqual({ url: `http://127.0.0.1:4329/v1/body/minecraft/requests/${ID}/report`, body: { scopeKey: 'owner', outcome: 'failed', code: 'unsupported' } });
  });

  it('carries the pin into runtime metadata without allowing later caller mutation to alter the active task', () => {
    const putTaskFirst = vi.fn(() => ({ success: true, taskId: 'task' }));
    const runtime: any = { putTaskFirst, removeTask: vi.fn(), getTaskListState: () => ({ tasks: [] }) };
    const tasks = new CompanionRuntimeTasks(runtime, { envelope: req => ({ tags: ['companion_task'], metadata: { companionTask: { requestId: req.id } } }),
      waiting: () => 0, deaths: () => 0, inventory: () => ({}) });
    const original = request();
    expect(tasks.start(original)).toEqual({ taskId: 'task' });
    const metadata = (putTaskFirst.mock.calls as any)[0][1].metadata;
    original.primaryModel.revision = 18; original.primaryModel.model = HAIKU;
    expect(companionPrimaryModelFromMetadata(metadata)).toEqual(pin);
    expect(() => companionPrimaryModelFromMetadata({ minecraftPrimaryModel: pin })).toThrow('PIN_INVALID');
    expect(() => companionPrimaryModelFromMetadata({ ...metadata, minecraftPrimaryModel: { ...pin, revision: -1 } })).toThrow('PIN_INVALID');
  });

  it('pins the actual wire model despite later preference/config changes and keeps auxiliary calls on Haiku', async () => {
    const sent: any[] = [];
    const fetcher = vi.fn(async (_url, init) => {
      const body = JSON.parse(init!.body as string); sent.push(body);
      return new Response(JSON.stringify({ type: 'message', model: body.model, content: [{ type: 'text', text: 'synthetic' }], stop_reason: 'end_turn', usage }));
    }) as typeof fetch;
    const config = { anthropic: { apiKey: 'offline-only' }, minecraftPlanner: { provider: 'openai', anthropicModel: HAIKU, openAIModel: 'unrelated' } };
    const selection = { ...pin };
    const pair = createPinnedMinecraftPlanners(config, selection, fetcher);
    selection.model = HAIKU; selection.revision++;
    config.minecraftPlanner.anthropicModel = 'different';
    const input = { system: 'Return an observation.', messages: [{ role: 'user', content: 'synthetic' }], max_tokens: 20 };
    await (pair.primary.client.messages as any).create(input);
    await (pair.auxiliary.client.messages as any).create(input);
    await (pair.primary.client.messages as any).create(input);
    expect(sent.map(body => body.model)).toEqual([SONNET, HAIKU, SONNET]);
    expect(sent.map(body => body.output_config.effort)).toEqual(['medium', 'low', 'medium']);
    expect(sent.every(body => body.system[0].cache_control.ttl === '1h')).toBe(true);
    expect(() => createPinnedMinecraftPlanners({ anthropic: {} }, pin, fetcher)).toThrow('KEY_REQUIRED');
  });
});
