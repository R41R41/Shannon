import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/config/env.js', () => ({ config: { anthropic: { apiKey: 'offline-anthropic', model: 'claude-opus-4-6' },
  openaiApiKey: 'offline-openai', minecraftPlanner: { provider: 'anthropic', anthropicModel: 'claude-haiku-5-5', openAIModel: 'gpt-5.6-luna' } } }));
vi.mock('../../src/services/minebot/config/MinebotConfig.js', () => ({ CONFIG: { UI_MOD_BASE_URL: 'http://example.invalid' } }));
import { createAnthropicPlannerClient, MINECRAFT_HAIKU_MODEL } from '../../src/services/minebot/cognition/AnthropicPlannerClient.js';
import { ShannonExecutor } from '../../src/services/llm/graph/ShannonExecutor.js';

const GOOD = { input_tokens: 12, output_tokens: 30, cache_creation_input_tokens: 700, cache_read_input_tokens: 0,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 700 } };
const bot = (): any => Object.assign(new EventEmitter(), { executingSkill: false, interruptExecution: false,
  registry: { itemsByName: {} }, health: 20, food: 20, activeFurnaces: [], entities: {}, inventory: { items: () => [] },
  entity: { position: { x: 0, y: 64, z: 0 } }, game: { dimension: 'overworld' }, chat: vi.fn(),
  pathfinder: { stop: vi.fn(), setGoal: vi.fn() }, clearControlStates: vi.fn() });
const prior: any[] = [{ role: 'user', content: 'original checkpoint' }, { role: 'assistant', content: 'original observed result' }];
const state = (extra: Record<string, unknown> = {}): any => ({ runId: 'offline-native-hold', goal: '資源を集める', context: null,
  systemPrompt: 'Keep the original goal; require physical proof.', tools: [], ...extra });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
const payload = (usage: unknown, content: any[] = [{ type: 'text', text: 'Need another observation' }]) => new Response(JSON.stringify({
  type: 'message', role: 'assistant', model: MINECRAFT_HAIKU_MODEL,
  stop_reason: content.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn', content,
  ...(usage === undefined ? {} : { usage }),
}));
const done = [{ type: 'tool_use', id: 'done', name: 'task-complete', input: { summary: 'independent position verified' } }];
const contract = { goal: '資源を集める', predicates: [{ kind: 'position', dimension: 'overworld', position: { x: 0, y: 64, z: 0 }, radius: 1 }] };
const executor = (client: any, publishTaskTree: (tree: any) => void = () => {}) => new ShannonExecutor({
  modelClient: client, modelIdentity: { provider: 'anthropic', model: MINECRAFT_HAIKU_MODEL }, bot: bot(), publishTaskTree,
});
afterEach(() => { vi.restoreAllMocks(); });

const invalid = [
  { code: 'MINECRAFT_PLANNER_HAIKU_CACHE_TTL_UNKNOWN', usage: { ...GOOD, cache_creation: undefined } },
  { code: 'MINECRAFT_PLANNER_HAIKU_USAGE_INVALID', usage: undefined },
  { code: 'MINECRAFT_PLANNER_HAIKU_CACHE_TTL_INVALID', usage: { ...GOOD, cache_creation: { ephemeral_5m_input_tokens: 700, ephemeral_1h_input_tokens: 0 } } },
  { code: 'MINECRAFT_PLANNER_HAIKU_CACHE_UNCONFIRMED', usage: { ...GOOD, cache_creation_input_tokens: 0,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } } },
];

describe('executor native evidence failure admission', () => {
  it.each(invalid)('keeps $code closed and does not pay again when a caller attempts continuation', async fixture => {
    const rawUsage: unknown[] = [];
    const fetcher = vi.fn(async () => { rawUsage.push(fixture.usage ?? null); return payload(fixture.usage); });
    const client = createAnthropicPlannerClient({ apiKey: 'offline-native', model: MINECRAFT_HAIKU_MODEL, fetcher: fetcher as any });
    const first = await executor(client).run(state());
    expect(first.recoveryStatus).toBe('failed_terminal'); expect(first.providerEvidenceFailure).toBe(fixture.code);
    expect(first.taskTree).toMatchObject({ status: 'error', recoveryStatus: 'failed_terminal' });
    expect(first.toolCallCount).toBe(0); expect(fetcher).toHaveBeenCalledOnce();
    const retried = await executor(client).run(state({ previousMessages: first.messages }));
    expect(retried.recoveryStatus).toBe('failed_terminal'); expect(retried.providerEvidenceFailure).toBe(fixture.code);
    expect(retried.messages).toEqual(first.messages); expect(fetcher).toHaveBeenCalledOnce();
    expect(rawUsage).toEqual([fixture.usage ?? null]);
  });

  it('does not turn a paid resume-summary proof failure into a mechanical summary and another paid request', async () => {
    const fetcher = vi.fn(async () => payload({ ...GOOD, cache_creation: undefined }));
    const client = createAnthropicPlannerClient({ apiKey: 'offline-native', model: MINECRAFT_HAIKU_MODEL, fetcher: fetcher as any });
    const result = await executor(client).run(state({ previousMessages: prior }));
    expect(result.recoveryStatus).toBe('failed_terminal'); expect(result.providerEvidenceFailure).toBe('MINECRAFT_PLANNER_HAIKU_CACHE_TTL_UNKNOWN');
    expect(result.messages).toEqual(prior); expect(result.iterations).toBe(0); expect(result.toolCallCount).toBe(0);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([new Error('owner stopped'), new DOMException('owner stopped', 'AbortError')])('pays neither title nor resume summary after an original abort: %s', async reason => {
    const fetcher = vi.fn(async () => payload(GOOD, done));
    const client = createAnthropicPlannerClient({ apiKey: 'offline-native', model: MINECRAFT_HAIKU_MODEL, fetcher: fetcher as any });
    const controller = new AbortController(); controller.abort(reason);
    for (const extra of [{ goal: '安全を確認してから必要な資源を集めてネザーポータルを建設する' }, { previousMessages: prior }]) {
      const result = await executor(client).run(state({ ...extra, abortSignal: controller.signal }));
      expect(result.taskTree?.status).toBe('error'); expect(result.recoveryStatus).toBeUndefined();
      expect(result.providerEvidenceFailure).toBeUndefined(); expect(result.iterations).toBe(0);
      if ('previousMessages' in extra) expect(result.messages).toEqual(prior);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('keeps known usage from an abort-ignoring resume response and sends no main request', async () => {
    const answer = deferred<Response>(); const entered = deferred<void>(); const rawUsage: unknown[] = [];
    let originalSignal: AbortSignal | undefined;
    const fetcher = vi.fn(async (_url: unknown, init: any) => { originalSignal = init.signal; entered.resolve();
      const response = await answer.promise; rawUsage.push((await response.clone().json() as any).usage); return response; });
    const client = createAnthropicPlannerClient({ apiKey: 'offline-native', model: MINECRAFT_HAIKU_MODEL, fetcher: fetcher as any });
    const controller = new AbortController();
    const running = executor(client).run(state({ previousMessages: prior, abortSignal: controller.signal }));
    await entered.promise; controller.abort(new Error('owner stopped')); answer.resolve(payload(GOOD));
    const result = await running;
    expect(originalSignal?.aborted).toBe(true); expect(rawUsage).toEqual([GOOD]); expect(fetcher).toHaveBeenCalledOnce();
    expect(result.messages).toEqual(prior); expect(result.taskTree?.status).toBe('error'); expect(result.providerEvidenceFailure).toBeUndefined();
  });

  it('does not publish a late title after the original run was aborted', async () => {
    const title = deferred<Response>(), titleStarted = deferred<void>(); const publish = vi.fn();
    const fetcher = vi.fn(async (_url: unknown, init: any) => { const body = JSON.parse(init.body);
      if (!body.tools?.length) { titleStarted.resolve(); return title.promise; }
      return payload(GOOD, done);
    });
    const client = createAnthropicPlannerClient({ apiKey: 'offline-native', model: MINECRAFT_HAIKU_MODEL, fetcher: fetcher as any });
    const controller = new AbortController();
    const goal = '安全を確認してから必要な資源を集めてネザーポータルを建設する';
    const running = executor(client, publish).run(state({ goal, goalContract: { ...contract, goal }, abortSignal: controller.signal }));
    await titleStarted.promise; await new Promise<void>(resolve => setImmediate(resolve));
    const updates = publish.mock.calls.length; controller.abort(new Error('owner stopped'));
    title.resolve(payload(GOOD, [{ type: 'text', text: '遅れた見出し' }]));
    const result = await running; expect(result.taskTree?.status).toBe('completed');
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(publish).toHaveBeenCalledTimes(updates); expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('joins a paid title after main completion before a late title evidence loss can be returned as completed', async () => {
    const title = deferred<Response>(), titleStarted = deferred<void>(); const rawUsage: unknown[] = [];
    const fetcher = vi.fn(async (_url: unknown, init: any) => {
      if (!JSON.parse(init.body).tools?.length) {
        titleStarted.resolve(); const response = await title.promise; rawUsage.push((await response.clone().json() as any).usage); return response;
      }
      rawUsage.push(GOOD); return payload(GOOD, done);
    });
    const client = createAnthropicPlannerClient({ apiKey: 'offline-native', model: MINECRAFT_HAIKU_MODEL, fetcher: fetcher as any });
    const goal = '安全を確認してから必要な資源を集めてネザーポータルを建設する'; let returned = false;
    const running = executor(client).run(state({ goal, goalContract: { ...contract, goal } })).then(result => { returned = true; return result; });
    await titleStarted.promise; await new Promise<void>(resolve => setImmediate(resolve));
    expect(returned).toBe(false); expect(rawUsage).toEqual([GOOD]);
    title.resolve(payload({ ...GOOD, cache_creation: undefined }));
    const result = await running;
    expect(result.recoveryStatus).toBe('failed_terminal'); expect(result.taskTree?.status).toBe('error');
    expect(result.providerEvidenceFailure).toBe('MINECRAFT_PLANNER_HAIKU_CACHE_TTL_UNKNOWN');
    expect(rawUsage).toEqual([GOOD, { input_tokens: 12, output_tokens: 30, cache_creation_input_tokens: 700, cache_read_input_tokens: 0 }]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each(['success', 'ordinary-failure'])('preserves parallel title %s and normal main completion', async outcome => {
    const title = deferred<any>(); let returned = false;
    const create = vi.fn(() => title.promise);
    const finalMessage = vi.fn(async () => ({ content: done, usage: {} }));
    const publish = vi.fn(); const client: any = { messages: { create, stream: () => ({ finalMessage }) } };
    const goal = '安全を確認してから必要な資源を集めてネザーポータルを建設する';
    const running = executor(client, publish).run(state({ goal, goalContract: { ...contract, goal } })).then(result => { returned = true; return result; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(finalMessage).toHaveBeenCalledOnce(); expect(returned).toBe(false);
    if (outcome === 'success') title.resolve({ content: [{ type: 'text', text: '資源集め' }] });
    else title.resolve(Promise.reject(new Error('ordinary title unavailable')));
    const result = await running;
    expect(result.taskTree?.status).toBe('completed'); expect(result.providerEvidenceFailure).toBeUndefined();
    expect(result.taskTree?.goal).toBe(outcome === 'success' ? '資源集め' : goal);
    expect(create).toHaveBeenCalledOnce(); expect(finalMessage).toHaveBeenCalledOnce();
  });

  it('holds an already in-flight main answer after concurrent title evidence failed without executing its tools', async () => {
    const main = deferred<Response>(), mainStarted = deferred<void>(); const rawUsage: unknown[] = [];
    const fetcher = vi.fn(async (_url: unknown, init: any) => {
      if (!JSON.parse(init.body).tools?.length) {
        const usage = { ...GOOD, cache_creation: undefined }; rawUsage.push(usage); return payload(usage);
      }
      mainStarted.resolve(); const response = await main.promise; rawUsage.push((await response.clone().json() as any).usage); return response;
    });
    const client = createAnthropicPlannerClient({ apiKey: 'offline-native', model: MINECRAFT_HAIKU_MODEL, fetcher: fetcher as any });
    const goal = '安全を確認してから必要な資源を集めてネザーポータルを建設する';
    const running = executor(client).run(state({ goal, goalContract: { ...contract, goal } }));
    await mainStarted.promise; await new Promise<void>(resolve => setImmediate(resolve)); main.resolve(payload(GOOD, done));
    const result = await running;
    expect(result.recoveryStatus).toBe('failed_terminal'); expect(result.providerEvidenceFailure).toBe('MINECRAFT_PLANNER_HAIKU_CACHE_TTL_UNKNOWN');
    expect(result.toolCallCount).toBe(0); expect(result.taskTree?.status).toBe('error');
    expect(fetcher).toHaveBeenCalledTimes(2); expect(rawUsage).toEqual([{ ...GOOD, cache_creation: undefined }, GOOD]);
  });

  it('preserves ordinary summary fallback and ordinary provider continuation policy', async () => {
    const create = vi.fn(async () => { throw new Error('ordinary summary unavailable'); });
    const finalMessage = vi.fn(async () => ({ content: done, usage: {} }));
    const client: any = { messages: { create, stream: () => ({ finalMessage }) } };
    const completed = await executor(client).run(state({ previousMessages: prior, goalContract: contract }));
    expect(completed.taskTree?.status).toBe('completed'); expect(completed.providerEvidenceFailure).toBeUndefined();
    expect(create).toHaveBeenCalledOnce(); expect(finalMessage).toHaveBeenCalledOnce();
    const ordinary: any = { messages: { stream: () => ({ finalMessage: async () => { throw new Error('ordinary transport failure'); } }) } };
    expect((await executor(ordinary).run(state())).recoveryStatus).toBe('awaiting_user');
  });

  it.each(['main', 'resume-summary'])('holds a known provider refusal during %s without a paid automatic continuation', async stage => {
    const known = { type: 'message', role: 'assistant', model: MINECRAFT_HAIKU_MODEL,
      stop_reason: 'refusal', stop_details: { category: 'general_harms' },
      content: [{ type: 'text', text: 'offline refusal' }], usage: GOOD };
    const rawUsage: unknown[] = [];
    const fetcher = vi.fn(async () => { rawUsage.push(known.usage); return new Response(JSON.stringify(known)); });
    const client = createAnthropicPlannerClient({ apiKey: 'offline-native', model: MINECRAFT_HAIKU_MODEL, fetcher: fetcher as any });
    const first = await executor(client).run(state(stage === 'resume-summary' ? { previousMessages: prior } : {}));
    expect(first.recoveryStatus).toBe('failed_terminal'); expect(first.providerEvidenceFailure).toBe('MINECRAFT_PLANNER_REFUSED');
    expect(first.taskTree).toMatchObject({ status: 'error', recoveryStatus: 'failed_terminal' });
    expect(first.taskTree?.strategy).toContain('拒否'); expect(first.toolCallCount).toBe(0);
    if (stage === 'resume-summary') expect(first.messages).toEqual(prior);
    const retry = await executor(client).run(state({ previousMessages: first.messages }));
    expect(retry.recoveryStatus).toBe('failed_terminal'); expect(retry.providerEvidenceFailure).toBe('MINECRAFT_PLANNER_REFUSED');
    expect(fetcher).toHaveBeenCalledOnce(); expect(rawUsage).toEqual([GOOD]);
  });

  it('joins a late paid title refusal before classifying an earlier verified main result', async () => {
    const title = deferred<Response>(), entered = deferred<void>();
    const fetcher = vi.fn(async (_url: unknown, init: any) => {
      if (!JSON.parse(init.body).tools?.length) { entered.resolve(); return title.promise; }
      return payload(GOOD, done);
    });
    const client = createAnthropicPlannerClient({ apiKey: 'offline-native', model: MINECRAFT_HAIKU_MODEL, fetcher: fetcher as any });
    const goal = '安全を確認してから必要な資源を集めてネザーポータルを建設する'; let returned = false;
    const running = executor(client).run(state({ goal, goalContract: { ...contract, goal } })).then(value => { returned = true; return value; });
    await entered.promise; await new Promise<void>(resolve => setImmediate(resolve)); expect(returned).toBe(false);
    title.resolve(new Response(JSON.stringify({ type: 'message', role: 'assistant', model: MINECRAFT_HAIKU_MODEL,
      stop_reason: 'refusal', content: [{ type: 'text', text: 'offline title refusal' }], usage: GOOD })));
    const result = await running;
    expect(result.recoveryStatus).toBe('failed_terminal'); expect(result.providerEvidenceFailure).toBe('MINECRAFT_PLANNER_REFUSED');
    expect(result.taskTree?.status).toBe('error'); expect(fetcher).toHaveBeenCalledTimes(2);
  });

});
