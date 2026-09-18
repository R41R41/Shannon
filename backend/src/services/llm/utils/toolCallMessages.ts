import { AIMessage, BaseMessage, ToolMessage } from '@langchain/core/messages';

type NormalizedToolCalls = NonNullable<AIMessage['tool_calls']>;

interface RawOpenAIToolCall {
  id?: unknown;
  function?: {
    name?: unknown;
    arguments?: unknown;
  };
}

function parseArguments(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string' || value.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

/**
 * Older LangChain streaming adapters sometimes leave OpenAI tool calls only in
 * additional_kwargs.tool_calls. Promote them to the provider-independent
 * AIMessage.tool_calls representation so the executor cannot mistake them for
 * a text-only response.
 */
export function normalizeAIMessageToolCalls(message: AIMessage): AIMessage {
  const rawCalls = message.additional_kwargs?.tool_calls;
  if ((message.tool_calls?.length ?? 0) > 0) {
    if (Array.isArray(rawCalls)) {
      const additionalKwargs = { ...message.additional_kwargs };
      delete additionalKwargs.tool_calls;
      message.additional_kwargs = additionalKwargs;
    }
    return message;
  }
  if (!Array.isArray(rawCalls) || rawCalls.length === 0) return message;

  const normalized = rawCalls.flatMap((candidate): NormalizedToolCalls => {
    const raw = candidate as RawOpenAIToolCall;
    const name = raw.function?.name;
    if (typeof name !== 'string' || name.length === 0) return [];
    return [{
      id: typeof raw.id === 'string' ? raw.id : undefined,
      name,
      args: parseArguments(raw.function?.arguments),
    }];
  });

  if (normalized.length === 0) return message;
  message.tool_calls = normalized;
  // Avoid serializing the same call through both the normalized and legacy
  // OpenAI fields on the next request.
  const additionalKwargs = { ...message.additional_kwargs };
  delete additionalKwargs.tool_calls;
  message.additional_kwargs = additionalKwargs;
  return message;
}

function messageType(message: BaseMessage): string {
  try {
    return message.getType();
  } catch {
    return '';
  }
}

/**
 * Last-line protocol guard for Chat Completions: every assistant tool call must
 * be followed by one ToolMessage with the same id before another model call.
 * Missing entries receive a recoverable synthetic result, allowing the model
 * to retry instead of terminating the entire task with HTTP 400.
 */
export function repairMissingToolResults(messages: BaseMessage[]): {
  messages: BaseMessage[];
  repairedCallIds: string[];
} {
  const repaired: BaseMessage[] = [];
  const repairedCallIds: string[] = [];

  for (let index = 0; index < messages.length; index++) {
    const current = messages[index];
    repaired.push(current);
    if (!(current instanceof AIMessage) && messageType(current) !== 'ai') continue;

    const aiMessage = normalizeAIMessageToolCalls(current as AIMessage);
    const calls = aiMessage.tool_calls ?? [];
    if (calls.length === 0) continue;

    const answeredIds = new Set<string>();
    let cursor = index + 1;
    while (cursor < messages.length && (messages[cursor] instanceof ToolMessage || messageType(messages[cursor]) === 'tool')) {
      const toolMessage = messages[cursor] as ToolMessage;
      if (toolMessage.tool_call_id) answeredIds.add(toolMessage.tool_call_id);
      repaired.push(messages[cursor]);
      cursor++;
    }

    for (const call of calls) {
      if (!call.id || answeredIds.has(call.id)) continue;
      repaired.push(new ToolMessage({
        tool_call_id: call.id,
        content: 'ツール結果を復元できませんでした。必要なら同じツールを再実行してください。 [failure_type=missing_tool_result recoverable=true]',
      }));
      repairedCallIds.push(call.id);
    }
    index = cursor - 1;
  }

  return { messages: repaired, repairedCallIds };
}
