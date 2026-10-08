import { cacheMinecraftHaikuRequest, MINECRAFT_HAIKU_MODEL, validateMinecraftHaikuUsage } from './AnthropicPlannerClient.js';
import { budgetedMinecraftFetch } from './MinecraftModelBudget.js';

export interface AnthropicStructuredDecisionGatewayOptions {
  apiKey: string;
  model: string;
  endpoint?: string;
  timeoutMilliseconds?: number;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
}
export interface AnthropicCognitionConfig {
  anthropic?: { apiKey?: string };
  minecraftPlanner?: { provider?: string; anthropicModel?: string };
}
/** Only an explicit Haiku planner choice enables this replacement; missing selected credentials cannot become Luna. */
export function configuredAnthropicCognition(config: AnthropicCognitionConfig): AnthropicStructuredDecisionGatewayOptions | undefined {
  const planner = config.minecraftPlanner;
  const selected = planner?.provider ?? 'auto';
  if (planner?.anthropicModel?.trim() !== MINECRAFT_HAIKU_MODEL || selected === 'openai') return undefined;
  if (selected !== 'anthropic' && !(selected === 'auto' && config.anthropic?.apiKey?.trim())) return undefined;
  return { model: MINECRAFT_HAIKU_MODEL, apiKey: config.anthropic?.apiKey?.trim() ?? '' };
}

type Request = { instructions: string; state: Record<string, unknown>; schemaName: string;
  schema: Record<string, unknown>; maxOutputTokens?: number; signal?: AbortSignal };
type Field = { type: 'string' | 'number'; enum?: string[]; minimum?: number; maximum?: number };

/** Native JSON classifier only: no tools, replay, OpenAI fallback, or authority inferred from a model response. */
export class AnthropicStructuredDecisionGateway {
  constructor(private readonly options: AnthropicStructuredDecisionGatewayOptions) {
    if (!options.apiKey.trim()) throw new Error('MINECRAFT_COGNITION_ANTHROPIC_KEY_REQUIRED');
    if (options.model !== MINECRAFT_HAIKU_MODEL) throw new Error('MINECRAFT_COGNITION_ANTHROPIC_MODEL_INVALID');
  }

  async decide<T>(request: Request): Promise<T> {
    // These two classifiers have a closed, flat, required object schema. Unknown shapes are not sent or guessed.
    const fields = classifierFields(request.schema);
    const signals = [AbortSignal.timeout(this.options.timeoutMilliseconds ?? 2_500), this.options.signal, request.signal]
      .filter((signal): signal is AbortSignal => signal !== undefined);
    const signal = AbortSignal.any(signals); signal.throwIfAborted();
    const requestedOutput = request.maxOutputTokens ?? 220;
    if (!Number.isSafeInteger(requestedOutput) || requestedOutput < 1) throw new Error('MINECRAFT_COGNITION_OUTPUT_LIMIT_INVALID');
    const nativeSchema = { ...request.schema, properties: Object.fromEntries(Object.entries(fields).map(([name, field]) => {
      const { minimum, maximum, ...supported } = field;
      return [name, { ...supported, ...(minimum !== undefined || maximum !== undefined
        ? { description: `Allowed numeric range: ${minimum ?? 'unbounded'} to ${maximum ?? 'unbounded'}.` } : {}) }];
    })) };
    const body = cacheMinecraftHaikuRequest({ model: this.options.model,
      // Adaptive thinking is output too. Reserve the serialized native ceiling, not the old 140/220 prose ceiling.
      max_tokens: Math.min(8192, Math.max(1024, requestedOutput)), thinking: { type: 'adaptive' },
      output_config: { effort: 'low', format: { type: 'json_schema', schema: nativeSchema } },
      system: request.instructions, messages: [{ role: 'user', content: JSON.stringify(request.state) }] });
    const response = await (this.options.fetcher ?? budgetedMinecraftFetch)(this.options.endpoint ?? 'https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'x-api-key': this.options.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      signal, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`MINECRAFT_COGNITION_ANTHROPIC_HTTP_${response.status}`);
    const payload: any = await response.json(); signal.throwIfAborted();
    if (payload?.type !== 'message' || !Array.isArray(payload.content)) throw new Error('MINECRAFT_COGNITION_RESPONSE_INVALID');
    // The supplied metered fetch observes the original provider usage first; failure here never resends it.
    validateMinecraftHaikuUsage(payload.usage);
    if (payload.stop_reason !== 'end_turn') throw new Error('MINECRAFT_COGNITION_RESPONSE_INCOMPLETE');
    if (payload.content.some((block: any) => !['text', 'thinking', 'redacted_thinking'].includes(block?.type))) throw new Error('MINECRAFT_COGNITION_RESPONSE_INVALID');
    const text = payload.content.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('');
    let value: unknown;
    try { value = JSON.parse(text); } catch { throw new Error('MINECRAFT_COGNITION_JSON_INVALID'); }
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== Object.keys(fields).length) throw new Error('MINECRAFT_COGNITION_JSON_INVALID');
    const record = value as Record<string, unknown>;
    for (const [name, field] of Object.entries(fields)) {
      const item = record[name];
      if (!Object.hasOwn(record, name) || typeof item !== field.type
        || field.type === 'number' && (typeof item !== 'number' || !Number.isFinite(item)
          || field.minimum !== undefined && item < field.minimum || field.maximum !== undefined && item > field.maximum)
        || field.enum && !field.enum.includes(item as string)) throw new Error('MINECRAFT_COGNITION_JSON_INVALID');
    }
    return value as T;
  }
}

function classifierFields(schema: Record<string, unknown>): Record<string, Field> {
  const properties = schema.properties;
  if (schema.type !== 'object' || schema.additionalProperties !== false || !properties || typeof properties !== 'object'
    || Array.isArray(properties) || !Array.isArray(schema.required)) throw new Error('MINECRAFT_COGNITION_SCHEMA_UNSUPPORTED');
  const fields = properties as Record<string, Field>;
  if (!Object.keys(fields).length || schema.required.length !== Object.keys(fields).length || new Set(schema.required).size !== Object.keys(fields).length
    || schema.required.some(name => typeof name !== 'string' || !Object.hasOwn(fields, name))) throw new Error('MINECRAFT_COGNITION_SCHEMA_UNSUPPORTED');
  for (const field of Object.values(fields)) {
    if (!field || !['number', 'string'].includes(field.type)
      || Object.keys(field).some(key => !['type', 'enum', 'minimum', 'maximum'].includes(key))
      || field.enum !== undefined && (field.type !== 'string' || !Array.isArray(field.enum) || !field.enum.length || field.enum.some(item => typeof item !== 'string'))
      || [field.minimum, field.maximum].some(limit => limit !== undefined && (field.type !== 'number' || !Number.isFinite(limit)))) throw new Error('MINECRAFT_COGNITION_SCHEMA_UNSUPPORTED');
  }
  return fields;
}
