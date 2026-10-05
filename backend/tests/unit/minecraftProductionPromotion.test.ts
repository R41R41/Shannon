import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOpenAIPlannerClient, minecraftPlannerProvider } from '../../src/services/minebot/cognition/OpenAIPlannerClient.js';
import { reserveMinecraftModelRequest } from '../../src/services/minebot/cognition/MinecraftModelBudget.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true }); });
describe('Minecraft planner routing and Responses protocol', () => {
  it('routes OpenAI-only production into the verified Minecraft executor without removing Anthropic support', () => {
    expect(minecraftPlannerProvider({ openaiApiKey: 'test' })).toBe('openai');
    expect(minecraftPlannerProvider({ anthropic: { apiKey: 'test' }, openaiApiKey: 'test' })).toBe('anthropic');
    expect(minecraftPlannerProvider({ anthropic: { apiKey: 'test' }, openaiApiKey: 'test', minecraftPlanner: { provider: 'openai' } })).toBe('openai');
    expect(minecraftPlannerProvider({ openaiApiKey: 'test', minecraftPlanner: { provider: 'anthropic' } })).toBeNull();
  });
  it('preserves tool call IDs, optional schemas, ordered tool results and cached-token usage', async () => {
    const fetcher = vi.fn(async (_url: any, options: any) => {
      const body = JSON.parse(options.body);
      expect(body.store).toBe(false); expect(body.model).toBe('gpt-5.6-luna');
      expect(body.reasoning.effort).toBe('none'); expect(body.tools[0].strict).toBe(false);
      expect(body.parallel_tool_calls).toBe(true);
      expect(body.input.map((item: any) => item.type ?? item.role)).toEqual(['user', 'function_call', 'function_call_output', 'user']);
      expect(body.input[1].call_id).toBe('call_a'); expect(body.input[2]).toEqual({ type: 'function_call_output', call_id: 'call_a', output: 'not yet verified' });
      return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'function_call', call_id: 'call_b', name: 'mine-block', arguments: '{"count":3}' }],
        usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 80 }, output_tokens: 20 } }));
    });
    const client = createOpenAIPlannerClient({ apiKey: 'test', fetcher });
    const response = await client.messages.stream({ model: 'ignored-anthropic-model', max_tokens: 100, system: [{ type: 'text', text: 'system' }],
      tools: [{ name: 'mine-block', description: 'mine', input_schema: { type: 'object', properties: { count: { type: 'integer' } } } }],
      messages: [{ role: 'user', content: 'goal' }, { role: 'assistant', content: [{ type: 'tool_use', id: 'call_a', name: 'task-complete', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_a', content: 'not yet verified', is_error: true }, { type: 'text', text: 'updated facts' }] }] } as any).finalMessage();
    expect(response.content[0]).toEqual({ type: 'tool_use', id: 'call_b', name: 'mine-block', input: { count: 3 } });
    expect(response.usage.input_tokens).toBe(20); expect(response.usage.cache_read_input_tokens).toBe(80);
  });
  it.each(['incomplete', 'failed'])('rejects %s output rather than executing partial tool arguments', async status => {
    const client = createOpenAIPlannerClient({ apiKey: 'test', fetcher: async () => new Response(JSON.stringify({ status, output: [] })) });
    await expect(client.messages.create({ messages: [], max_tokens: 100 } as any)).rejects.toThrow('INCOMPLETE');
  });
  it('passes task cancellation into the transport and does not leak server error bodies', async () => {
    const controller = new AbortController(); controller.abort();
    const fetcher = vi.fn(async (_url: any, options: any) => { expect(options.signal.aborted).toBe(true); return new Response('private error', { status: 401 }); });
    const client = createOpenAIPlannerClient({ apiKey: 'test', fetcher });
    await expect(client.messages.stream({ messages: [] } as any, { signal: controller.signal }).finalMessage()).rejects.toThrow('HTTP_401');
  });
});
describe('restart-resistant model reservations', () => {
  const fixture = (requests = '2', tokens = '100000') => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minebot-budget-')); dirs.push(dir);
    return { MINECRAFT_MODEL_BUDGET_FILE: path.join(dir, 'budget.json'), MINECRAFT_MODEL_DAILY_REQUEST_LIMIT: requests, MINECRAFT_MODEL_DAILY_TOKEN_RESERVATION: tokens };
  };
  it('persists reservations before dispatch and refuses the third request after reading the file again', () => {
    const env = fixture(); const body = JSON.stringify({ max_output_tokens: 100, input: 'test' });
    reserveMinecraftModelRequest(body, env); reserveMinecraftModelRequest(body, { ...env });
    expect(() => reserveMinecraftModelRequest(body, env)).toThrow('EXHAUSTED');
    const state = JSON.parse(fs.readFileSync(env.MINECRAFT_MODEL_BUDGET_FILE, 'utf8')); expect(state.requests).toBe(2);
    expect(fs.readFileSync(env.MINECRAFT_MODEL_BUDGET_FILE, 'utf8')).not.toContain('input');
    expect(fs.existsSync(`${env.MINECRAFT_MODEL_BUDGET_FILE}.lock`)).toBe(false);
  });
  it('refuses over-token requests and corrupt or concurrently locked state without clearing it', () => {
    const env = fixture('10', '1'); expect(() => reserveMinecraftModelRequest('{}', env)).toThrow('EXHAUSTED');
    fs.writeFileSync(env.MINECRAFT_MODEL_BUDGET_FILE, 'invalid'); expect(() => reserveMinecraftModelRequest('{}', env)).toThrow();
    expect(fs.readFileSync(env.MINECRAFT_MODEL_BUDGET_FILE, 'utf8')).toBe('invalid');
    fs.writeFileSync(`${env.MINECRAFT_MODEL_BUDGET_FILE}.lock`, 'other process'); expect(() => reserveMinecraftModelRequest('{}', env)).toThrow();
    expect(fs.readFileSync(`${env.MINECRAFT_MODEL_BUDGET_FILE}.lock`, 'utf8')).toBe('other process');
  });
});
