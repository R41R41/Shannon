import { ChatOpenAI } from '@langchain/openai';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import type { FcaMessage, FcaModel } from '../../modules/fca/index.js';
import { toAbortSignal } from './abortSignal.js';

export function fcaHistoryToLangChain(system: string, history: readonly FcaMessage[]): BaseMessage[] {
  const extraSystems: string[] = [];
  const rest: BaseMessage[] = [];
  for (const message of history) {
    if (message.role === 'system') {
      if (message.content.trim()) extraSystems.push(message.content);
      continue;
    }
    if (message.role === 'user') {
      rest.push(new HumanMessage(message.content));
      continue;
    }
    if (message.role === 'tool') {
      rest.push(new ToolMessage({ content: message.content, tool_call_id: message.toolCallId ?? '' }));
      continue;
    }
    rest.push(new AIMessage({
      content: message.content,
      tool_calls: (message.toolCalls ?? []).map(call => ({
        id: call.id, name: call.name,
        args: call.arguments && typeof call.arguments === 'object' && !Array.isArray(call.arguments)
          ? call.arguments as Record<string, unknown> : {},
        type: 'tool_call' as const,
      })),
    }));
  }
  const systemText = extraSystems.length ? `${system}\n\n${extraSystems.join('\n\n')}` : system;
  return [new SystemMessage(systemText), ...rest];
}

/** Stateless OpenAI adapter for the shared FCA kernel. Catalog is per-call, not a process singleton. */
export function createOpenAiFcaModel(input: { apiKey: string; model: string; maxTokens: number; temperature: number; timeoutMs?: number }): FcaModel {
  if (!input.apiKey || !/^[A-Za-z0-9._:-]{1,100}$/.test(input.model)
    || !Number.isSafeInteger(input.maxTokens) || input.maxTokens < 1 || input.maxTokens > 8000
    || !Number.isFinite(input.temperature) || input.temperature < 0 || input.temperature > 2) {
    throw new Error('FCA_MODEL_CONFIG_INVALID');
  }
  const model = new ChatOpenAI({
    apiKey: input.apiKey, model: input.model, maxTokens: input.maxTokens, maxRetries: 0,
    timeout: input.timeoutMs ?? 30000, temperature: input.temperature,
  });
  return { async next(request, signal) {
    signal.throwIfAborted();
    const messages = fcaHistoryToLangChain(request.system, request.messages);
    const abort = toAbortSignal(signal);
    const result = request.tools.length
      ? await model.bindTools(request.tools.map(tool => ({ type: 'function' as const, function: { name: tool.name, description: tool.description, parameters: tool.parameters } })),
        { parallel_tool_calls: false }).invoke(messages, { signal: abort })
      : await model.invoke(messages, { signal: abort });
    signal.throwIfAborted();
    const content = typeof result.content === 'string' ? result.content : '';
    const toolCalls = (result.tool_calls ?? []).map(call => ({ id: call.id ?? '', name: call.name, arguments: call.args }));
    return { content, toolCalls: Object.freeze(toolCalls) };
  } };
}
