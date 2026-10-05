import { budgetedMinecraftFetch } from './MinecraftModelBudget.js';
export type OpenAIReasoningEffort = 'none' | 'low' | 'medium';

export interface OpenAIStructuredDecisionGatewayOptions {
  apiKey: string;
  endpoint?: string;
  model?: string;
  reasoningEffort?: OpenAIReasoningEffort;
  timeoutMilliseconds?: number;
  fetcher?: typeof fetch;
}

/**
 * Small Responses API adapter used only by bounded Minecraft classifiers.
 * It deliberately does not share the prose/tool-calling client used by System 2.
 */
export class OpenAIStructuredDecisionGateway {
  private readonly endpoint: string;
  private readonly model: string;
  private readonly reasoningEffort: OpenAIReasoningEffort;
  private readonly timeoutMilliseconds: number;
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: OpenAIStructuredDecisionGatewayOptions) {
    if (!options.apiKey.trim()) throw new Error('OPENAI_API_KEY is required');
    this.endpoint = options.endpoint ?? 'https://api.openai.com/v1/responses';
    this.model = options.model ?? 'gpt-5.6-luna';
    this.reasoningEffort = options.reasoningEffort ?? 'none';
    this.timeoutMilliseconds = options.timeoutMilliseconds ?? 2_500;
    this.fetcher = options.fetcher ?? budgetedMinecraftFetch;
  }

  async decide<T>(request: {
    instructions: string;
    state: Record<string, unknown>;
    schemaName: string;
    schema: Record<string, unknown>;
    maxOutputTokens?: number;
  }): Promise<T> {
    const response = await this.fetcher(this.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        store: false,
        reasoning: { effort: this.reasoningEffort },
        input: [
          {
            role: 'developer',
            content: [{ type: 'input_text', text: request.instructions }],
          },
          {
            role: 'user',
            content: [{ type: 'input_text', text: JSON.stringify(request.state) }],
          },
        ],
        text: {
          verbosity: 'low',
          format: {
            type: 'json_schema',
            name: request.schemaName,
            strict: true,
            schema: request.schema,
          },
        },
        max_output_tokens: request.maxOutputTokens ?? 220,
      }),
      signal: AbortSignal.timeout(this.timeoutMilliseconds),
    });
    const payload = await response.json() as unknown;
    if (!response.ok) throw new Error(`OPENAI_RESPONSE_${response.status}`);
    const outputText = extractOutputText(payload);
    if (!outputText) throw new Error('OPENAI_RESPONSE_MISSING_OUTPUT');
    return JSON.parse(outputText) as T;
  }
}

function extractOutputText(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const direct = (value as { output_text?: unknown }).output_text;
  if (typeof direct === 'string') return direct;

  const output = (value as { output?: unknown }).output;
  if (!Array.isArray(output)) return null;
  for (const item of output) {
    if (!item || typeof item !== 'object') continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      const typed = part as { type?: unknown; text?: unknown };
      if (typed.type === 'output_text' && typeof typed.text === 'string') return typed.text;
    }
  }
  return null;
}

export function openAIReasoningEffort(value: string | undefined): OpenAIReasoningEffort {
  const normalized = value?.trim().toLowerCase();
  return normalized === 'low' || normalized === 'medium' ? normalized : 'none';
}
