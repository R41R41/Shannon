import { describe, expect, it, vi } from 'vitest';
import { cacheMinecraftHaikuRequest, createAnthropicPlannerClient, MINECRAFT_HAIKU_MODEL, MINECRAFT_SONNET_MODEL,
  MINECRAFT_HAIKU_PROTOCOL_PREFIX, isAnthropicCacheEvidenceError, AnthropicPlannerRefusalError, isAnthropicPlannerTerminalError } from '../../src/services/minebot/cognition/AnthropicPlannerClient.js';

const usage = { input_tokens: 25, output_tokens: 40, cache_creation_input_tokens: 700, cache_read_input_tokens: 0,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 700 } };
const reply = (extra: any = {}) => ({ type: 'message', model: MINECRAFT_HAIKU_MODEL, role: 'assistant', stop_reason: 'tool_use',
  content: [{ type: 'thinking', thinking: 'prior reasoning', signature: 'sig' },
    { type: 'tool_use', id: 'new-call', name: 'mine-block', input: { count: 1 } }], usage, ...extra });
const response = (payload: any) => new Response(JSON.stringify(payload), { status: 200 });
const request = () => ({ max_tokens: 16384,
  system: [{ type: 'text', text: 'The original task and authority remain here.', cache_control: { type: 'ephemeral' } }],
  tools: [{ name: 'mine-block', input_schema: { type: 'object', properties: { count: { type: 'integer' } } },
    cache_control: { type: 'ephemeral' } }],
  messages: [{ role: 'user', content: 'エンドラを倒す' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'original-call', name: 'mine-block', input: { count: 1 } },
      { type: 'thinking', thinking: 'prior reasoning', signature: 'sig' }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'original-call', content: 'verified partial result\nCurrent state changes each turn', is_error: true }] }] });
const markers = (body: any) => [...(body.tools ?? []), ...(body.system ?? []),
  ...body.messages.flatMap((m: any) => Array.isArray(m.content) ? m.content : [])]
  .filter((b: any) => b.cache_control).map((b: any) => b.cache_control);

describe.each([MINECRAFT_HAIKU_MODEL, MINECRAFT_SONNET_MODEL])('%s native Minecraft transport', (model) => {
  it('keeps the native tool loop and original authority with exactly four ordered 1h markers', async () => {
    const input = request(), before = JSON.stringify(input);
    const fetcher = vi.fn(async (_url: any, _init: any) => response(reply()));
    const client = createAnthropicPlannerClient({ apiKey: 'offline-fixture', model, fetcher: fetcher as any });
    const result = await (client.messages as any).stream(input).finalMessage();
    const [url, init] = fetcher.mock.calls[0]; const body = JSON.parse(init.body);
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(body).toMatchObject({ model, max_tokens: 8192,
      thinking: { type: 'adaptive' }, output_config: { effort: 'low' } });
    expect(body.system[0].text).toBe(MINECRAFT_HAIKU_PROTOCOL_PREFIX);
    expect(body.system[1].text).toBe(input.system[0].text);
    expect(body.tools[0].input_schema).toEqual(input.tools[0].input_schema);
    expect(markers(body)).toEqual(Array.from({ length: 4 }, () => ({ type: 'ephemeral', ttl: '1h' })));
    expect(body.messages[1].content[0]).toMatchObject({ id: 'original-call', name: 'mine-block', input: { count: 1 } });
    expect(body.messages[1].content[1]).toEqual(input.messages[1].content[1]);
    expect(body.messages[2]).toEqual(input.messages[2]);
    expect(body).not.toHaveProperty('temperature'); expect(body).not.toHaveProperty('top_p');
    expect(body).not.toHaveProperty('top_k'); expect(body.thinking).not.toHaveProperty('budget_tokens');
    expect(result).toEqual(reply()); expect(JSON.stringify(input)).toBe(before);
  });

  it('uses the same fixed useful prefix for a short reflection and a different dynamic input', async () => {
    const bodies: any[] = [];
    const fetcher = (async (_url: any, init: any) => { bodies.push(JSON.parse(init.body)); return response(reply()); }) as any;
    const client = createAnthropicPlannerClient({ apiKey: 'offline-fixture', model, fetcher });
    for (const content of ['first short observation', 'different observation']) {
      await (client.messages as any).create({ max_tokens: 60, system: 'Return the reflection in the required JSON schema.', messages: [{ role: 'user', content }] });
    }
    expect(bodies[0].system).toEqual(bodies[1].system);
    expect(bodies[0].system[0].text).toContain('This protocol supplies no additional completion condition');
    expect(bodies[0].messages).not.toEqual(bodies[1].messages);
    expect(bodies[0].max_tokens).toBe(1024);
    expect(markers(bodies[0])).toEqual([{ type: 'ephemeral', ttl: '1h' }, { type: 'ephemeral', ttl: '1h' }]);
    // Actual token count and cache reuse are verified by the separate live gate, not inferred from a string length.
  });

  it('is idempotent and does not put the breakpoint on the changing tool-result tail', () => {
    const first = cacheMinecraftHaikuRequest(request());
    expect(cacheMinecraftHaikuRequest(first)).toEqual(first);
    expect(first.messages.at(-1).content[0]).not.toHaveProperty('cache_control');
    expect(first.messages[1].content[1]).not.toHaveProperty('cache_control');
  });

  it('keeps images and tool-result identity intact', async () => {
    const input = request() as any;
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'offline-fixture' } };
    input.messages[2].content.push(image);
    const prepared = cacheMinecraftHaikuRequest(input);
    expect(prepared.messages[2].content[1]).toEqual(image);
    expect(prepared.messages[2].content[0]).toEqual(input.messages[2].content[0]);
  });

  it('refuses a fifth breakpoint or invalid cache metadata before transmission', async () => {
    const fetcher = vi.fn(async () => response(reply()));
    const client = createAnthropicPlannerClient({ apiKey: 'offline-fixture', model, fetcher: fetcher as any });
    const fifth = { ...request(), cache_control: { type: 'ephemeral', ttl: '1h' } };
    await expect((client.messages as any).create(fifth)).rejects.toThrow('BREAKPOINT_LIMIT');
    const bad = request() as any; bad.tools[0].cache_control.type = 'permanent';
    await expect((client.messages as any).create(bad)).rejects.toThrow('CACHE_CONTROL_INVALID');
    expect(fetcher).not.toHaveBeenCalled();
    expect(() => createAnthropicPlannerClient({ apiKey: 'offline-fixture', model,
      cacheTTL: '5m', fetcher: fetcher as any })).toThrow('CACHE_TTL_REQUIRED');
  });

  it('does not silently cache thinking or unsupported nested subcontent', () => {
    const thinking = request() as any; thinking.messages[1].content[1].cache_control = { type: 'ephemeral' };
    expect(() => cacheMinecraftHaikuRequest(thinking)).toThrow('CACHE_THINKING_INVALID');
    const nested = request() as any;
    nested.messages[2].content[0].content = [{ type: 'text', text: 'result', cache_control: { type: 'ephemeral' } }];
    expect(() => cacheMinecraftHaikuRequest(nested)).toThrow('CACHE_SUBCONTENT_INVALID');
  });

  it('records known usage before a mandatory-cache failure and never resends it', async () => {
    const recorded: any[] = []; const noCache = { ...usage, cache_creation_input_tokens: 0,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } };
    const fetcher = vi.fn(async () => { const payload = reply({ usage: noCache }); recorded.push(payload.usage); return response(payload); });
    const client = createAnthropicPlannerClient({ apiKey: 'offline-fixture', model, fetcher: fetcher as any });
    await expect((client.messages as any).create(request())).rejects.toThrow('CACHE_UNCONFIRMED');
    expect(recorded).toEqual([noCache]); expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('accepts confirmed read usage while preserving all native accounting fields', async () => {
    const hit = { ...usage, cache_creation_input_tokens: 0, cache_read_input_tokens: 900,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } };
    const client = createAnthropicPlannerClient({ apiKey: 'offline-fixture', model,
      fetcher: (async () => response(reply({ usage: hit }))) as any });
    const result = await (client.messages as any).create(request());
    expect(result.usage).toEqual(hit);
  });

  it.each(['usage', 'ttl', 'uncached'] as const)('holds later create and stream requests after %s evidence failure without another paid send', async kind => {
    const bad: any = { ...usage };
    if (kind === 'usage') delete bad.output_tokens;
    if (kind === 'ttl') delete bad.cache_creation;
    if (kind === 'uncached') Object.assign(bad, { cache_creation_input_tokens: 0,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } });
    const recorded: any[] = [];
    const fetcher = vi.fn(async () => { recorded.push(bad); return response(reply({ usage: bad })); });
    const client = createAnthropicPlannerClient({ apiKey: 'offline-fixture', model, fetcher: fetcher as any });
    const first = await (client.messages as any).create(request()).catch((error: unknown) => error);
    expect(isAnthropicCacheEvidenceError(first)).toBe(true);
    await expect((client.messages as any).create(request())).rejects.toBe(first);
    await expect((client.messages as any).stream(request()).finalMessage()).rejects.toBe(first);
    expect(recorded).toEqual([bad]); expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('holds a cache write with unknown TTL after recording usage without resending', async () => {
    const unknownTTL: any = { ...usage }; delete unknownTTL.cache_creation;
    const recorded: any[] = [];
    const fetcher = vi.fn(async () => { recorded.push(unknownTTL); return response(reply({ usage: unknownTTL })); });
    const client = createAnthropicPlannerClient({ apiKey: 'offline-fixture', model, fetcher: fetcher as any });
    await expect((client.messages as any).create(request())).rejects.toThrow('CACHE_TTL_UNKNOWN');
    expect(recorded).toEqual([unknownTTL]); expect(fetcher).toHaveBeenCalledTimes(1);
    const readOnly = { ...unknownTTL, cache_creation_input_tokens: 0, cache_read_input_tokens: 700 };
    const hit = createAnthropicPlannerClient({ apiKey: 'offline-fixture', model,
      fetcher: (async () => response(reply({ usage: readOnly }))) as any });
    expect((await (hit.messages as any).create(request())).usage).toEqual(readOnly);
  });

  it('holds later paid sends when a 200 response cannot expose its cache usage', async () => {
    const fetcher = vi.fn(async () => new Response('not-json-offline-fixture', { status: 200 }));
    const client = createAnthropicPlannerClient({ apiKey: 'offline-fixture', model, fetcher: fetcher as any });
    await expect((client.messages as any).create(request())).rejects.toThrow('USAGE_INVALID');
    await expect((client.messages as any).create(request())).rejects.toThrow('USAGE_INVALID');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not admit a later in-flight response after another request loses cache evidence', async () => {
    let finish!: () => void;
    const wait = new Promise<void>(resolve => { finish = resolve; });
    let calls = 0;
    const fetcher = vi.fn(async () => {
      const index = ++calls;
      if (index === 2) await wait;
      return response(reply({ usage: index === 1 ? null : usage }));
    });
    const client = createAnthropicPlannerClient({ apiKey: 'offline-fixture', model, fetcher: fetcher as any });
    const first = (client.messages as any).create(request()).catch((error: unknown) => error);
    const second = (client.messages as any).create(request()).catch((error: unknown) => error);
    const failed = await first; finish();
    expect(isAnthropicCacheEvidenceError(failed)).toBe(true);
    expect(await second).toBe(failed);
    await expect((client.messages as any).create(request())).rejects.toBe(failed);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each(['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'].flatMap(field => [
    [field, 'missing'], [field, 'null']
  ] as const))('holds %s %s instead of guessing zero', async (field, kind) => {
    const malformed: any = { ...usage }; if (kind === 'missing') delete malformed[field]; else malformed[field] = null;
    const fetcher = vi.fn(async () => response(reply({ usage: malformed })));
    const client = createAnthropicPlannerClient({ apiKey: 'offline-fixture', model, fetcher: fetcher as any });
    await expect((client.messages as any).create(request())).rejects.toThrow('USAGE_INVALID');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects an unexpected 5m write and truncated output after accounting', async () => {
    for (const payload of [reply({ usage: { ...usage, cache_creation: { ephemeral_5m_input_tokens: 1, ephemeral_1h_input_tokens: 699 } } }),
      reply({ stop_reason: 'max_tokens' })]) {
      const recorded: any[] = [];
      const fetcher = vi.fn(async () => { recorded.push(payload.usage); return response(payload); });
      const client = createAnthropicPlannerClient({ apiKey: 'offline-fixture', model, fetcher: fetcher as any });
      await expect((client.messages as any).create(request())).rejects.toThrow();
      expect(recorded).toEqual([payload.usage]); expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it('does not dispatch after caller cancellation and preserves bounded transport errors without error text', async () => {
    const cancelled = new AbortController(); cancelled.abort(new Error('fixture-cancelled'));
    const fetcher = vi.fn(async () => response(reply()));
    const client = createAnthropicPlannerClient({ apiKey: 'offline-fixture', model, fetcher: fetcher as any });
    await expect((client.messages as any).create(request(), { signal: cancelled.signal })).rejects.toThrow('fixture-cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    let observedSignal: AbortSignal | undefined;
    const refusing = createAnthropicPlannerClient({ apiKey: 'offline-fixture', model,
      fetcher: (async (_url: any, init: any) => { observedSignal = init.signal; return new Response('private-error-fixture', { status: 401 }); }) as any });
    await expect((refusing.messages as any).create(request())).rejects.toThrow('HTTP_401');
    expect(observedSignal).toBeInstanceOf(AbortSignal);
  });

  it('cancels an in-flight native request once without fallback or replay', async () => {
    const controller = new AbortController(); let observed: AbortSignal | undefined;
    const fetcher = vi.fn((_url: any, init: any) => new Promise<Response>((_resolve, reject) => {
      observed = init.signal; observed!.addEventListener('abort', () => reject(observed!.reason), { once: true });
    }));
    const client = createAnthropicPlannerClient({ apiKey: 'offline-fixture', model, fetcher: fetcher as any });
    const result = (client.messages as any).create(request(), { signal: controller.signal });
    controller.abort(new Error('fixture-in-flight-cancelled'));
    await expect(result).rejects.toThrow('fixture-in-flight-cancelled');
    expect(observed?.aborted).toBe(true); expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects a late response after cancellation even if the body transport ignores it', async () => {
    const controller = new AbortController(); const recorded: any[] = [];
    let finish!: (payload: any) => void;
    const json = new Promise(resolve => { finish = resolve; });
    const fetcher = vi.fn(async () => ({ ok: true, json: async () => { const payload: any = await json; recorded.push(payload.usage); return payload; } }));
    const client = createAnthropicPlannerClient({ apiKey: 'offline-fixture', model, fetcher: fetcher as any });
    const pending = (client.messages as any).create(request(), { signal: controller.signal });
    await Promise.resolve(); controller.abort(new Error('fixture-late-cancelled')); finish(reply());
    await expect(pending).rejects.toThrow('fixture-late-cancelled');
    expect(recorded).toEqual([usage]); expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([['general_harms', 'general_harms'], ['unexpected-private-detail', 'unknown'], [undefined, 'unknown']])(
    'keeps a metered refusal terminal with a closed category: %s', async (category, expected) => {
      const recorded: any[] = []; const payload = reply({ stop_reason: 'refusal', stop_details: { category } });
      const fetcher = vi.fn(async () => { recorded.push(payload.usage); return response(payload); });
      const client = createAnthropicPlannerClient({ apiKey: 'offline-fixture', model, fetcher: fetcher as any });
      const error = await (client.messages as any).create(request()).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(AnthropicPlannerRefusalError);
      expect(isAnthropicPlannerTerminalError(error)).toBe(true); expect(isAnthropicCacheEvidenceError(error)).toBe(false);
      expect(error.category).toBe(expected); expect(error.message).toBe('MINECRAFT_PLANNER_REFUSED');
      await expect((client.messages as any).create(request())).rejects.toBe(error);
      await expect((client.messages as any).stream(request()).finalMessage()).rejects.toBe(error);
      expect(recorded).toEqual([usage]); expect(fetcher).toHaveBeenCalledTimes(1);
    });

  it('does not accept an in-flight success after a concurrent refusal stopped the client', async () => {
    let finish!: (value: Response) => void;
    const fetcher = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }))
      .mockResolvedValueOnce(response(reply({ stop_reason: 'refusal' })));
    const client = createAnthropicPlannerClient({ apiKey: 'offline-fixture', model, fetcher: fetcher as any });
    const pending = (client.messages as any).create(request());
    const error = await (client.messages as any).create(request()).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(AnthropicPlannerRefusalError); finish(response(reply()));
    await expect(pending).rejects.toBe(error); expect(fetcher).toHaveBeenCalledTimes(2);
    await expect((client.messages as any).create(request())).rejects.toBe(error);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('preserves the legacy pre-5.5 refusal contract', async () => {
    const fetcher = vi.fn(async () => response(reply({ stop_reason: 'refusal' })));
    const client = createAnthropicPlannerClient({ apiKey: 'offline-fixture', model: 'claude-sonnet-4-6', fetcher: fetcher as any });
    for (let i = 0; i < 2; i++) await expect((client.messages as any).create(request())).rejects.toThrow('MINECRAFT_PLANNER_REFUSED');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('retains legacy pre-5.5 Sonnet cache behavior unless its caller explicitly requests another TTL', async () => {
    for (const cacheTTL of [undefined, '1h'] as const) {
      const fetcher = vi.fn(async (_url: any, _init: any) => response(reply()));
      const client = createAnthropicPlannerClient({ apiKey: 'offline-fixture', model: 'claude-sonnet-4-6', cacheTTL, fetcher: fetcher as any });
      await (client.messages as any).create(request()); const body = JSON.parse(fetcher.mock.calls[0][1].body);
      expect(body.system[0].text).toBe(request().system[0].text);
      expect(body.system).toHaveLength(1);
      expect(markers(body)).toEqual(Array.from({ length: 3 }, () => cacheTTL ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' }));
    }
  });
});
