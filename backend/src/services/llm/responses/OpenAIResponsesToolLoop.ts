export interface ResponsesFunctionTool {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict?: boolean;
}

export interface ResponsesFunctionCall {
  type: 'function_call';
  call_id: string;
  name: string;
  arguments: string;
}

interface ResponsesOutputText {
  type: 'output_text';
  text: string;
}

interface ResponsesMessageOutput {
  type: 'message';
  content?: ResponsesOutputText[];
}

interface ResponsesApiResponse {
  id: string;
  output?: Array<ResponsesFunctionCall | ResponsesMessageOutput | Record<string, unknown>>;
  output_text?: string;
  error?: { message?: string };
}

export interface ResponsesToolOutput {
  callId: string;
  output: string;
}

export interface ResponsesToolBatchResult<TTerminal> {
  outputs: ResponsesToolOutput[];
  terminal?: TTerminal;
}

export interface ResponsesToolLoopOptions<TTerminal> {
  instructions: string;
  input: string;
  tools: ResponsesFunctionTool[];
  execute: (
    calls: ResponsesFunctionCall[],
  ) => Promise<ResponsesToolBatchResult<TTerminal>>;
  signal?: AbortSignal;
  maxTurns?: number;
  reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high';
}

export interface ResponsesToolLoopResult<TTerminal> {
  outputText: string;
  turns: number;
  responseId: string;
  terminal?: TTerminal;
}

type FetchLike = typeof fetch;

export class OpenAIResponsesError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly responseBody?: string,
  ) {
    super(message);
    this.name = 'OpenAIResponsesError';
  }
}

/**
 * Small provider adapter for OpenAI Responses function calling.
 *
 * It deliberately owns only the protocol loop. Tool policy, execution,
 * progress UI, completion guards, and Discord delivery remain in Shannon's
 * orchestration layer so the same behavior can later serve iOS and macOS.
 */
export class OpenAIResponsesToolLoop {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly baseUrl = 'https://api.openai.com/v1',
  ) {}

  async run<TTerminal>(
    options: ResponsesToolLoopOptions<TTerminal>,
  ): Promise<ResponsesToolLoopResult<TTerminal>> {
    const maxTurns = Math.max(1, Math.min(options.maxTurns ?? 12, 30));
    // Keep the chain stateless (store:false) and carry typed output items
    // forward explicitly. This also preserves reasoning items required by
    // reasoning models without retaining server-side response state.
    const conversationInput: unknown[] = [{ role: 'user', content: options.input }];
    let lastResponseId = '';

    for (let turn = 1; turn <= maxTurns; turn++) {
      if (options.signal?.aborted) throw new DOMException('Task aborted', 'AbortError');

      const body: Record<string, unknown> = {
        model: this.model,
        instructions: options.instructions,
        input: conversationInput,
        tools: options.tools,
        tool_choice: 'auto',
        parallel_tool_calls: true,
        store: false,
      };
      if (options.reasoningEffort && options.reasoningEffort !== 'none') {
        body.reasoning = { effort: options.reasoningEffort };
      }

      const response = await this.fetchImpl(`${this.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: options.signal,
      });
      const raw = await response.text();
      if (!response.ok) {
        throw new OpenAIResponsesError(
          `OpenAI Responses API failed (${response.status})`,
          response.status,
          raw.slice(0, 4000),
        );
      }

      let parsed: ResponsesApiResponse;
      try {
        parsed = JSON.parse(raw) as ResponsesApiResponse;
      } catch {
        throw new OpenAIResponsesError('OpenAI Responses API returned invalid JSON', response.status, raw.slice(0, 4000));
      }
      if (!parsed.id) throw new OpenAIResponsesError('OpenAI Responses API response did not include an id');
      if (parsed.error?.message) throw new OpenAIResponsesError(parsed.error.message, response.status, raw.slice(0, 4000));

      lastResponseId = parsed.id;
      const calls = (parsed.output ?? []).filter(
        (item): item is ResponsesFunctionCall => item.type === 'function_call',
      );
      if (calls.length === 0) {
        return {
          outputText: extractResponsesText(parsed),
          turns: turn,
          responseId: parsed.id,
        };
      }

      const batch = await options.execute(calls);
      if (batch.terminal !== undefined) {
        return {
          outputText: '',
          turns: turn,
          responseId: parsed.id,
          terminal: batch.terminal,
        };
      }

      const byCallId = new Map(batch.outputs.map((output) => [output.callId, output.output]));
      conversationInput.push(...(parsed.output ?? []));
      conversationInput.push(...calls.map((call) => ({
        type: 'function_call_output',
        call_id: call.call_id,
        output: byCallId.get(call.call_id)
          ?? 'Tool execution failed: no result was returned for this call_id.',
      })));
    }

    throw new OpenAIResponsesError(
      `OpenAI Responses tool loop reached the ${maxTurns}-turn limit`,
      undefined,
      lastResponseId,
    );
  }
}

export function parseFunctionArguments(call: ResponsesFunctionCall): Record<string, unknown> {
  try {
    const parsed = JSON.parse(call.arguments || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch (error) {
    throw new OpenAIResponsesError(
      `Invalid JSON arguments for ${call.name}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function extractResponsesText(response: ResponsesApiResponse): string {
  if (typeof response.output_text === 'string' && response.output_text.trim()) {
    return response.output_text.trim();
  }
  return (response.output ?? [])
    .filter((item): item is ResponsesMessageOutput => item.type === 'message')
    .flatMap((item) => item.content ?? [])
    .filter((item) => item.type === 'output_text')
    .map((item) => item.text)
    .join('\n')
    .trim();
}
