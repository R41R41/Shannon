import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAnthropicPlannerClient, markConversationForCache, MINECRAFT_HAIKU_PROTOCOL_PREFIX } from '../../src/services/minebot/cognition/AnthropicPlannerClient.js';
import { ActualUsageBudget, anthropicUsageCostUsd, modelUsageCostUsd } from '../../src/services/minebot/testing/AcceptanceBudget.js';

const ok = (payload: unknown) => new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
const reply = { type: 'message', role: 'assistant', stop_reason: 'tool_use',
  content: [{ type: 'thinking', thinking: '…', signature: 's' }, { type: 'tool_use', id: 't1', name: 'move-to', input: { x: 1 } }],
  usage: { input_tokens: 900, cache_creation_input_tokens: 1500, cache_read_input_tokens: 25000, output_tokens: 200 } };

describe('Messages API transport for the planner', () => {
  it('sends the executor\'s request as it is, with one model, adaptive thinking at a fixed effort, and no sampling temperature', async () => {
    const fetcher = vi.fn(async (_url: any, _init: any) => ok({ ...reply, usage: { ...reply.usage, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1500 } } }));
    const client = createAnthropicPlannerClient({ apiKey: 'k', model: 'claude-sonnet-5-5', effort: 'low', fetcher: fetcher as any });
    const system = [{ type: 'text', text: 'rules', cache_control: { type: 'ephemeral' } }];
    const tools = [{ name: 'move-to', description: 'd', input_schema: { type: 'object' }, cache_control: { type: 'ephemeral' } }];
    const response: any = await (client.messages as any).stream({ model: 'claude-haiku-4-5-20251001', max_tokens: 16384, temperature: 1, system, tools,
      messages: [{ role: 'user', content: 'go' }] }).finalMessage();
    const [url, init] = fetcher.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.headers).toMatchObject({ 'x-api-key': 'k', 'anthropic-version': '2023-06-01' });
    expect(body).toMatchObject({ model: 'claude-sonnet-5-5', max_tokens: 8192, thinking: { type: 'adaptive' }, output_config: { effort: 'low' } });
    expect(body.system).toEqual([{ type: 'text', text: MINECRAFT_HAIKU_PROTOCOL_PREFIX, cache_control: { type: 'ephemeral', ttl: '1h' } },
      { ...system[0], cache_control: { type: 'ephemeral', ttl: '1h' } }]);
    expect(body.tools).toEqual([{ ...tools[0], cache_control: { type: 'ephemeral', ttl: '1h' } }]);
    expect(body).not.toHaveProperty('temperature');
    // The reply reaches the executor whole: its thinking block goes back unchanged on the next turn.
    expect(response.content).toEqual(reply.content);
    expect(response.usage).toMatchObject(reply.usage);
  });

  it('marks the conversation for the cache at the last thing the model said, never on a thinking block or the changing tail', () => {
    const messages = [
      { role: 'user', content: 'goal' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'x', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'b', name: 'y', input: {} }, { type: 'thinking', thinking: 't', signature: 's' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b', content: 'ok\n## 現在の状態 …' }] },
    ];
    const marked = markConversationForCache(messages);
    expect(marked[3].content[0]).toMatchObject({ type: 'tool_use', id: 'b', cache_control: { type: 'ephemeral' } });
    expect(marked[3].content[1]).not.toHaveProperty('cache_control');
    expect(JSON.stringify([marked[0], marked[1], marked[2], marked[4]])).not.toContain('cache_control');
    expect(messages[3].content[0]).not.toHaveProperty('cache_control'); // the history itself is left alone
    expect(markConversationForCache([{ role: 'user', content: 'first turn' }])).toEqual([{ role: 'user', content: 'first turn' }]);
  });

  it('turns a refusal by the provider into an error with its status, and rejects an answer with nothing to act on', async () => {
    const refused = createAnthropicPlannerClient({ apiKey: 'k', model: 'claude-opus-5-5',
      fetcher: (async () => new Response('{"type":"error","error":{"type":"overloaded_error"}}', { status: 529 })) as any });
    await expect((refused.messages as any).create({ messages: [] })).rejects.toThrow('MINECRAFT_PLANNER_ANTHROPIC_HTTP_529');
    const empty = createAnthropicPlannerClient({ apiKey: 'k', model: 'claude-opus-5-5',
      fetcher: (async () => ok({ type: 'message', content: [{ type: 'thinking', thinking: 't', signature: 's' }], usage: {} })) as any });
    await expect((empty.messages as any).create({ messages: [] })).rejects.toThrow('MINECRAFT_PLANNER_EMPTY_OUTPUT');
    expect(() => createAnthropicPlannerClient({ apiKey: ' ', model: 'claude-opus-5-5', fetcher: fetch })).toThrow('MINECRAFT_PLANNER_ANTHROPIC_KEY_REQUIRED');
  });

  it('names the workspace for a key that is not tied to one, and only then', async () => {
    const seen: any[] = [];
    const fetcher = (async (_url: any, init: any) => { seen.push(init.headers); return ok({ ...reply, usage: { ...reply.usage, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1500 } } }); }) as any;
    await (createAnthropicPlannerClient({ apiKey: 'k', model: 'claude-sonnet-5-5', workspaceId: 'wrkspc_01ABC', fetcher }).messages as any).create({ messages: [{ role: 'user', content: 'go' }] });
    await (createAnthropicPlannerClient({ apiKey: 'k', model: 'claude-sonnet-5-5', fetcher }).messages as any).create({ messages: [{ role: 'user', content: 'go' }] });
    expect(seen[0]).toMatchObject({ 'anthropic-workspace-id': 'wrkspc_01ABC' });
    expect(seen[1]).not.toHaveProperty('anthropic-workspace-id');
    expect(() => createAnthropicPlannerClient({ apiKey: 'k', model: 'claude-sonnet-5-5', workspaceId: 'bad id\n', fetcher })).toThrow('MINECRAFT_PLANNER_ANTHROPIC_WORKSPACE_INVALID');
  });
});

describe('one ledger for either planner', () => {
  const directories: string[] = [];
  afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

  it('prices uncached input, cache writes, cache reads and output at each model\'s own rates', () => {
    expect(anthropicUsageCostUsd('claude-sonnet-5-5', { ...reply.usage, cache_creation: { ephemeral_5m_input_tokens: 1500, ephemeral_1h_input_tokens: 0 } })).toBeCloseTo((900 * 2 + 1500 * 2.5 + 25000 * 0.2 + 200 * 10) / 1e6, 10);
    expect(anthropicUsageCostUsd('claude-opus-5-5', reply.usage)).toBeCloseTo((900 * 4 + 1500 * 5 + 25000 * 0.2 + 200 * 20) / 1e6, 10);
    expect(modelUsageCostUsd('claude-opus-5-5', reply.usage)).toBe(anthropicUsageCostUsd('claude-opus-5-5', reply.usage));
    expect(modelUsageCostUsd('gpt-5.6-luna', { input_tokens: 1000, output_tokens: 100, input_tokens_details: { cached_tokens: 400 } }))
      .toBeCloseTo((600 * 0.2 + 400 * 0.02 + 100 * 1.2) / 1e6, 10);
    expect(anthropicUsageCostUsd('claude-unknown', reply.usage)).toBeNull();
    expect(anthropicUsageCostUsd('claude-haiku-4-5', reply.usage)).toBeCloseTo((900 * 1 + 1500 * 1.25 + 25000 * 0.1 + 200 * 5) / 1e6, 10);
  });

  it('asks Haiku 4.5 without adaptive thinking or an effort level, which it does not take (the cheaper planner the user asked to compare)', async () => {
    const fetcher = vi.fn(async (_url: any, _init: any) => ok(reply));
    const client = createAnthropicPlannerClient({ apiKey: 'k', model: 'claude-haiku-4-5', effort: 'low', fetcher: fetcher as any });
    await (client.messages as any).stream({ max_tokens: 4096, messages: [{ role: 'user', content: 'go' }] }).finalMessage();
    const body = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(body.model).toBe('claude-haiku-4-5');
    expect(body).not.toHaveProperty('thinking');
    expect(body).not.toHaveProperty('output_config');
  });

  it('reserves and settles a Claude request against the same cap, and refuses a model it has no price for', () => {
    const root = path.resolve('saves/minecraft/progressive_reports');
    fs.mkdirSync(root, { recursive: true });
    const directory = fs.mkdtempSync(path.join(root, 'unit-ledger-'));
    directories.push(directory);
    const budget = new ActualUsageBudget(path.join(directory, 'ledger.json'), { maxUsd: 1, maxRequests: 10, margin: 1.25 });
    const body = JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 8192, messages: [{ role: 'user', content: 'x'.repeat(4000) }] });
    const reservation = budget.reserve(body);
    // The bound: every request byte written to the cache at the write price, the whole output limit, plus the margin.
    expect(reservation.reservedUsd).toBeCloseTo(((Buffer.byteLength(body) + 4096) * 5 + 8192 * 20) / 1e6 * 1.25, 10);
    const settled = budget.settle(reservation.request, reply.usage, 'claude-opus-5-5');
    expect(settled.chargedUsd).toBeCloseTo(anthropicUsageCostUsd('claude-opus-5-5', reply.usage)! * 1.25, 10);
    expect(() => budget.reserve(JSON.stringify({ model: 'claude-fable-5-1', max_tokens: 100 }))).toThrow('ACCEPTANCE_MODEL_OR_OUTPUT_BOUND_INVALID');
    // The usual planner is reserved and settled exactly as before.
    const luna = budget.reserve(JSON.stringify({ model: 'gpt-5.6-luna', max_output_tokens: 4096, input: [] }));
    expect(budget.settle(luna.request, { input_tokens: 1000, output_tokens: 100 }).chargedUsd).toBeCloseTo((1000 * 0.2 + 100 * 1.2) / 1e6 * 1.25, 10);
  });
});
