import {
  FcaError, type FcaBoundTool, type FcaLimits, type FcaMessage, type FcaPolicy, type FcaRunInput, type FcaRunResult, type FcaToolCall,
} from './types.js';

const CALL_ID = /^[A-Za-z0-9_-]{1,80}$/;
const NAME = /^[A-Za-z0-9_-]{1,80}$/;

function integer(value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new FcaError('FCA_CONFIG');
  return value;
}

export function parseFcaLimits(limits: FcaLimits): Required<Pick<FcaLimits, 'maxTurns' | 'maxToolCalls' | 'maxToolCallsPerTurn'>> & { maxElapsedMs?: number } {
  const maxTurns = integer(limits.maxTurns, 1, 64);
  const maxToolCalls = integer(limits.maxToolCalls, 1, 128);
  const maxToolCallsPerTurn = integer(limits.maxToolCallsPerTurn, 1, 16);
  if (limits.maxElapsedMs !== undefined && (!Number.isSafeInteger(limits.maxElapsedMs) || limits.maxElapsedMs < 1)) throw new FcaError('FCA_CONFIG');
  return { maxTurns, maxToolCalls, maxToolCallsPerTurn, ...(limits.maxElapsedMs !== undefined ? { maxElapsedMs: limits.maxElapsedMs } : {}) };
}

export function catalogTools(tools: readonly FcaBoundTool[]): ReadonlyMap<string, FcaBoundTool> {
  const catalog = new Map<string, FcaBoundTool>();
  for (const tool of tools) {
    if (!NAME.test(tool.name) || !tool.description.trim() || tool.description.length > 2000 || catalog.has(tool.name)
      || typeof tool.execute !== 'function' || !tool.parameters || typeof tool.parameters !== 'object') throw new FcaError('FCA_CONFIG');
    catalog.set(tool.name, tool);
  }
  return catalog;
}

export function validateFcaToolCalls(calls: unknown, maxPerTurn: number): readonly FcaToolCall[] {
  if (!Array.isArray(calls) || calls.length > maxPerTurn) throw new FcaError('FCA_MODEL');
  const ids = new Set<string>();
  const result: FcaToolCall[] = [];
  for (const call of calls) {
    if (!call || !CALL_ID.test(call.id) || ids.has(call.id) || !NAME.test(call.name)) throw new FcaError('FCA_MODEL');
    ids.add(call.id);
    result.push({ id: call.id, name: call.name, arguments: call.arguments });
  }
  return Object.freeze(result);
}

function assistantMessage(content: string, toolCalls: readonly FcaToolCall[]): FcaMessage {
  return { role: 'assistant', content, ...(toolCalls.length ? { toolCalls } : {}) };
}

function definitions(tools: readonly FcaBoundTool[]): FcaBoundTool[] {
  return tools.map(tool => Object.freeze({ name: tool.name, description: tool.description, parameters: tool.parameters, execute: tool.execute.bind(tool) }));
}

/** One-shot session: model turns, injected tools only, no destination or memory. */
export async function runFcaLoop(input: FcaRunInput): Promise<FcaRunResult> {
  if (typeof input.system !== 'string' || !input.system.trim() || input.system.length > 200000) throw new FcaError('FCA_CONFIG');
  const limits = parseFcaLimits(input.limits);
  const baseCatalog = catalogTools(input.tools);
  const now = input.now ?? Date.now;
  const started = now();
  const messages: FcaMessage[] = [...input.messages];
  let calls = 0;
  let lastContent = '';
  const policy: FcaPolicy = input.policy;
  if (policy.kind === 'terminal-tool' && !baseCatalog.has(policy.name)) throw new FcaError('FCA_CONFIG');

  for (let turn = 1; turn <= limits.maxTurns; turn++) {
    input.signal.throwIfAborted();
    const elapsedMs = now() - started;
    if (limits.maxElapsedMs !== undefined && elapsedMs >= limits.maxElapsedMs) {
      return Object.freeze({ messages: Object.freeze([...messages]), turns: turn - 1, content: lastContent, stop: 'time' });
    }
    const prepared = await input.hooks?.beforeModel?.({ turn, messages: Object.freeze([...messages]), elapsedMs }) ?? {};
    const activeTools = prepared.tools ? [...catalogTools(prepared.tools).values()] : [...baseCatalog.values()];
    const response = await input.model.next({
      system: input.system, messages: Object.freeze([...messages, ...(prepared.ephemeral ?? [])]),
      tools: definitions(activeTools),
    }, input.signal);
    input.signal.throwIfAborted();
    if (!response || typeof response.content !== 'string' || response.content.length > 20000) throw new FcaError('FCA_MODEL');
    const toolCalls = validateFcaToolCalls(response.toolCalls, limits.maxToolCallsPerTurn);
    lastContent = response.content;
    messages.push(assistantMessage(response.content, toolCalls));

    if (!toolCalls.length) {
      const decision = input.hooks?.onTextOnly?.({ turn, content: response.content })
        ?? (policy.kind === 'text' ? 'complete' : 'fail');
      if (decision === 'complete') return Object.freeze({ messages: Object.freeze([...messages]), turns: turn, content: response.content, stop: 'complete' });
      if (decision === 'fail') throw new FcaError('FCA_NO_TERMINAL');
      continue;
    }

    const plan = input.hooks?.planCalls?.(toolCalls, { turn }) ?? { execute: toolCalls };
    for (const row of plan.synthetic ?? []) {
      messages.push({ role: 'tool', content: row.content, toolCallId: row.call.id });
    }
    if (!plan.execute.length) continue;
    if (calls + plan.execute.length > limits.maxToolCalls) throw new FcaError('FCA_TOOL_BUDGET');

    const catalog = catalogTools(activeTools);
    const results: { call: FcaToolCall; content: string; done?: boolean; value?: unknown }[] = [];
    let terminal: { value?: unknown } | undefined;
    for (const call of plan.execute) {
      const tool = catalog.get(call.name);
      if (!tool) throw new FcaError('FCA_TOOL_NOT_ALLOWED');
      calls += 1;
      const result = await tool.execute(call.arguments, input.signal);
      input.signal.throwIfAborted();
      if (!result || typeof result.content !== 'string' || result.content.length > 100000) throw new FcaError('FCA_MODEL');
      messages.push({ role: 'tool', content: result.content, toolCallId: call.id });
      results.push({ call, content: result.content, done: result.done, value: result.value });
      if (result.done) {
        terminal = { value: result.value };
        if (policy.kind === 'terminal-tool' && policy.drain === 'until-terminal') break;
      }
    }
    if (terminal) {
      return Object.freeze({ messages: Object.freeze([...messages]), turns: turn, content: lastContent, stop: 'terminal', value: terminal.value });
    }
    const after = await input.hooks?.afterTools?.({ turn, content: lastContent, toolCalls, results }) ?? 'continue';
    if (after === 'complete') return Object.freeze({ messages: Object.freeze([...messages]), turns: turn, content: lastContent, stop: 'complete' });
    if (after === 'fail') throw new FcaError('FCA_NO_TERMINAL');
  }
  if (policy.kind === 'text') return Object.freeze({ messages: Object.freeze([...messages]), turns: limits.maxTurns, content: lastContent, stop: 'turns' });
  throw new FcaError('FCA_NO_TERMINAL');
}
