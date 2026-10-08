import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../src/config/env.js', () => ({ config: { anthropic: { apiKey: 'offline', model: 'claude-sonnet-5-5' } } }));
vi.mock('../../src/services/minebot/config/MinebotConfig.js', () => ({ CONFIG: { UI_MOD_BASE_URL: 'http://example.invalid' } }));
import { createAnthropicPlannerClient, MINECRAFT_HAIKU_MODEL } from '../../src/services/minebot/cognition/AnthropicPlannerClient.js';
import { ShannonExecutor } from '../../src/services/llm/graph/ShannonExecutor.js';

const GOOD = { input_tokens: 12, output_tokens: 30, cache_creation_input_tokens: 700, cache_read_input_tokens: 0,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 700 } };
const bot = (): any => Object.assign(new EventEmitter(), { executingSkill: false, interruptExecution: false,
  registry: { itemsByName: {} }, health: 20, food: 20, activeFurnaces: [], entities: {}, inventory: { items: () => [] },
  entity: { position: { x: 0, y: 64, z: 0 } }, game: { dimension: 'overworld' }, chat: vi.fn(),
  pathfinder: { stop: vi.fn(), setGoal: vi.fn() }, clearControlStates: vi.fn() });
const state = (extra: Record<string, unknown> = {}): any => ({ runId: 'offline-signed', goal: '現在位置を確認する', context: null,
  systemPrompt: 'Keep the original goal and require native proof.', tools: [{ name: 'offline-observe', description: 'Observe only',
    input_schema: { type: 'object', properties: {} } }], ...extra });
const contract = { goal: '現在位置を確認する', predicates: [{ kind: 'position', dimension: 'overworld', position: { x: 0, y: 64, z: 0 }, radius: 1 }] };
const tool = (id: string, name: string, input: unknown = {}): any => ({ type: 'tool_use', id, name, input });
const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'cache_control').map(([key, child]) => [key, canonical(child)])) : value;

// Independent fake server checks the official prefix-binding invariant at the
// actual native HTTP boundary, rather than checking an Executor implementation.
function signedTransport(replies: any[][], beforeReply?: (index: number, body: any) => void) {
  const sent: any[] = []; const signatures = new Map<string, any>(); let summaries = 0;
  const fetcher = vi.fn(async (_url: unknown, init: any) => {
    const body = JSON.parse(init.body); const clean = canonical(body);
    for (let index = 0; index < body.messages.length; index++) {
      const content = body.messages[index].content;
      for (const block of Array.isArray(content) ? content : []) if (block.type === 'thinking') {
        const prefix = signatures.get(block.signature);
        if (!prefix || JSON.stringify(prefix) !== JSON.stringify({ system: clean.system, tools: clean.tools,
          messages: clean.messages.slice(0, index) })) throw new Error('FAKE_SIGNED_PREFIX_MISMATCH');
      }
    }
    if (!body.tools?.length) {
      summaries++; sent.push(body);
      return new Response(JSON.stringify({ type: 'message', role: 'assistant', model: MINECRAFT_HAIKU_MODEL,
        stop_reason: 'end_turn', content: [{ type: 'text', text: '確認済みの位置と実行結果を保持し、残りを続行する。' }], usage: GOOD }));
    }
    const index = sent.filter(request => request.tools?.length).length;
    sent.push(body); beforeReply?.(index, body);
    const signature = `offline-signature-${index}`;
    signatures.set(signature, { system: clean.system, tools: clean.tools, messages: clean.messages });
    return new Response(JSON.stringify({ type: 'message', role: 'assistant', model: MINECRAFT_HAIKU_MODEL,
      stop_reason: 'tool_use', content: [{ type: 'thinking', thinking: `offline reasoning ${index}`, signature }, ...replies[index]], usage: GOOD }));
  });
  return { fetcher, sent, summaries: () => summaries };
}
const native = (transport: ReturnType<typeof signedTransport>, body: any, extra: any = {}) => new ShannonExecutor({
  modelClient: createAnthropicPlannerClient({ apiKey: 'offline-only', model: MINECRAFT_HAIKU_MODEL, fetcher: transport.fetcher as any }),
  modelIdentity: { provider: 'anthropic', model: MINECRAFT_HAIKU_MODEL }, bot: body, publishTaskTree: () => {},
  llmTools: new Map([['offline-observe', async () => 'observed result '.repeat(200)]]), ...extra,
});
afterEach(() => { vi.restoreAllMocks(); });

describe('native Haiku preserved thinking through real Executor requests', () => {
  it('keeps the signed prefix exact while contracts, plans, live facts, lessons and human feedback change', async () => {
    const body = bot(); const original = state(); const checkpoints: any[] = [];
    let lessonCall = 0, feedbackCall = 0;
    const transport = signedTransport([
      [tool('contract', 'set-goal-contract', contract), tool('plan', 'manage-task-tree', { operations: [
        { action: 'create', id: 'root', goal: contract.goal, postconditions: contract.predicates } ] }), tool('observe', 'offline-observe')],
      [tool('observe-next', 'offline-observe')],
      [tool('done', 'task-complete', { summary: 'native position verified' })],
    ], index => { if (index === 0) { original.tools[0].description = 'caller changed description'; body.health = 19; } });
    const learning = { promptSection: () => ++lessonCall === 1 ? 'Lessons\n- [first] preserve original facts' : 'Lessons\n- [first] preserve original facts\n- [second] retain newer observation',
      recordAction: vi.fn() };
    const result = await native(transport, body, { learning }).run({ ...original,
      getHumanFeedback: () => ++feedbackCall === 1 ? null : '元のゴールを維持して続けて',
      onCheckpoint: (checkpoint: any) => checkpoints.push(checkpoint) });
    expect(result.taskTree?.status).toBe('completed'); expect(result.recoveryStatus).toBeUndefined();
    expect(transport.fetcher).toHaveBeenCalledTimes(3);
    const [first, second, third] = transport.sent;
    expect(canonical(second.messages.slice(0, first.messages.length))).toEqual(canonical(first.messages));
    expect(second.system).toEqual(first.system); expect(second.tools).toEqual(first.tools);
    expect(canonical(third.messages.slice(0, second.messages.length))).toEqual(canonical(second.messages));
    expect(third.system).toEqual(first.system); expect(third.tools).toEqual(first.tools);
    expect(first.tools[0].description).toBe('Observe only');
    expect(JSON.stringify(second.messages)).toContain('offline-signature-0');
    expect(JSON.stringify(second.messages)).toContain('変更不可の完了条件（設定済み）');
    expect(JSON.stringify(second.messages)).toContain('ユーザーからのリアルタイムフィードバック');
    expect(JSON.stringify(second.messages)).toContain('[second] retain newer observation');
    expect(JSON.stringify(second.messages).match(/\[first\] preserve original facts/g)).toHaveLength(1);
    const results = second.messages.find((message: any) => Array.isArray(message.content) && message.content.some((block: any) => block.tool_use_id === 'observe'));
    const observation = results.content.find((block: any) => block.tool_use_id === 'observe');
    expect(observation.content).toContain('文字省略'); expect(observation.content).not.toContain('現在の状態');
    const newTexts = second.messages.slice(first.messages.length).flatMap((message: any) =>
      Array.isArray(message.content) ? message.content.filter((block: any) => block.type === 'text').map((block: any) => block.text) : []);
    expect(newTexts.join('\n')).toContain('"health":19');
    expect(canonical(checkpoints[0].messages.slice(0, first.messages.length))).toEqual(canonical(first.messages));
    const signed = checkpoints[0].messages[first.messages.length];
    expect(signed.content[0]).toEqual({ type: 'thinking', thinking: 'offline reasoning 0', signature: 'offline-signature-0' });
  });

  it('saves the sent observation at interruption and starts summary compaction as a fresh signed session on resume', async () => {
    const controller = new AbortController(); let checkpoint: any;
    const firstTransport = signedTransport([[tool('observe', 'offline-observe')]]);
    const interrupted = await native(firstTransport, bot()).run(state({ goalContract: contract, abortSignal: controller.signal,
      onCheckpoint: (value: any) => { checkpoint = structuredClone(value); controller.abort(new Error('owner stopped')); } }));
    expect(interrupted.messages).toEqual(checkpoint.messages);
    expect(canonical(checkpoint.messages.slice(0, firstTransport.sent[0].messages.length))).toEqual(canonical(firstTransport.sent[0].messages));
    const previous = structuredClone(checkpoint);
    const resumedTransport = signedTransport([[tool('observe-again', 'offline-observe')], [tool('done', 'task-complete', { summary: 'native position verified' })]]);
    const resumed = await native(resumedTransport, bot()).run(state({ previousMessages: checkpoint.messages,
      previousTaskNodes: checkpoint.taskNodes, previousWorkspaceSnapshot: checkpoint.cognitiveWorkspace }));
    expect(resumed.taskTree?.status).toBe('completed'); expect(resumedTransport.summaries()).toBe(1);
    const [summary, first, second] = resumedTransport.sent;
    expect(summary.tools).toBeUndefined(); expect(JSON.stringify(summary.messages)).toContain('observed result');
    expect(JSON.stringify(summary.messages)).not.toContain('offline-signature-0');
    expect(JSON.stringify(first.messages)).not.toContain('offline-signature-0');
    expect(canonical(second.messages.slice(0, first.messages.length))).toEqual(canonical(first.messages));
    expect(second.system).toEqual(first.system); expect(second.tools).toEqual(first.tools);
    expect(checkpoint).toEqual(previous);
  });

  it('retains the legacy live-result rendering and unsupplemented checkpoint for explicitly selected old planners', async () => {
    const calls: any[] = [], checkpoints: any[] = []; let index = 0;
    const client: any = { messages: { stream: (request: any) => {
      calls.push(structuredClone(request));
      return { finalMessage: async () => ({ usage: {}, content: ++index === 1
        ? [tool('observe', 'offline-observe')] : [tool('done', 'task-complete', { summary: 'legacy complete' })] }) };
    } } };
    const result = await new ShannonExecutor({ modelClient: client, modelIdentity: { provider: 'anthropic', model: 'claude-sonnet-5-5' },
      bot: bot(), publishTaskTree: () => {}, llmTools: new Map([['offline-observe', async () => 'legacy observation']]) }).run(state({ tools: [], goalContract: contract,
      previousTaskNodes: [{ id: 'root', goal: contract.goal, status: 'pending', children: [], postconditions: contract.predicates }],
      onCheckpoint: (checkpoint: any) => checkpoints.push(checkpoint) }));
    expect(result.taskTree?.status).toBe('completed'); expect(calls).toHaveLength(2);
    const initialText = calls[0].messages[0].content[0].text;
    expect(initialText).toContain(contract.goal); expect(initialText).toContain('現在の状態');
    expect(checkpoints[0].messages[0]).toEqual({ role: 'user', content: contract.goal });
    expect(calls[1].messages[0]).toEqual(checkpoints[0].messages[0]);
    const legacyResult = calls[1].messages.find((message: any) => Array.isArray(message.content)
      && message.content.some((block: any) => block.tool_use_id === 'observe')).content[0];
    expect(legacyResult.content).toContain('legacy observation'); expect(legacyResult.content).toContain('現在の状態');
  });
});
