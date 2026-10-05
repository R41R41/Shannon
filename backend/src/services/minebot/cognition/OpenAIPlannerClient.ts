import type Anthropic from '@anthropic-ai/sdk';
import { budgetedMinecraftFetch } from './MinecraftModelBudget.js';

interface Options { apiKey: string; model?: string; endpoint?: string; timeoutMs?: number; fetcher?: typeof fetch; parallelToolCalls?: boolean;
  /** Routes one run's requests to the same prompt cache (measured: read back when the prefix blocks are identical). */
  promptCacheKey?: string;
  /** How much the model thinks before answering. 'none' answers at once (the setting every run up to L37 used). Thinking is billed as output tokens. */
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high' }

/** Responses transport for the existing Minecraft executor. The executor keeps
 * sole ownership of tools, contracts, interruption and completion verification.
 * No provider-hosted tools and no dependency on the general chat/FCA path.
 */
export function createOpenAIPlannerClient(options: Options): Pick<Anthropic, 'messages'> {
  if (!options.apiKey.trim()) throw new Error('MINECRAFT_PLANNER_OPENAI_KEY_REQUIRED');
  const run = async (request: any, requestOptions?: { signal?: AbortSignal }) => {
    const input: any[] = [];
    for (const message of request.messages) {
      const content = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
      let text: any[] = [];
      const flush = () => { if (text.length) input.push({ role: message.role, content: text }); text = []; };
      for (const block of content) {
        if (block.type === 'text') text.push({ type: message.role === 'assistant' ? 'output_text' : 'input_text', text: block.text });
        else if (block.type === 'tool_use') {
          flush(); input.push({ type: 'function_call', call_id: block.id, name: block.name, arguments: JSON.stringify(block.input) });
        } else if (block.type === 'tool_result') {
          flush(); input.push({ type: 'function_call_output', call_id: block.tool_use_id,
            output: typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '') });
        } else if (block.type === 'image' && message.role === 'user') {
          const source = block.source;
          text.push({ type: 'input_image', image_url: source.type === 'base64'
            ? `data:${source.media_type};base64,${source.data}` : source.url });
        } else if (!['thinking', 'redacted_thinking'].includes(block.type)) throw new Error('MINECRAFT_PLANNER_CONTENT_UNSUPPORTED');
      }
      flush();
    }
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 30_000);
    const signal = requestOptions?.signal ? AbortSignal.any([timeout, requestOptions.signal]) : timeout;
    const response = await (options.fetcher ?? budgetedMinecraftFetch)(options.endpoint ?? 'https://api.openai.com/v1/responses', {
      method: 'POST', headers: { authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json' }, signal,
      body: JSON.stringify({ model: options.model ?? 'gpt-5.6-luna', store: false, reasoning: { effort: options.reasoningEffort ?? 'none' }, input,
        instructions: typeof request.system === 'string' ? request.system : (request.system ?? []).map((b: any) => b.text).join('\n'),
        max_output_tokens: Math.min(request.max_tokens ?? 4096, 4096),
        tools: (request.tools ?? []).map((tool: any) => ({ type: 'function', name: tool.name,
          description: tool.description, parameters: tool.input_schema, strict: false })),
        // The model may batch independent observations/plan updates. Executor
        // dispatch remains ordered and physical ownership/cancellation unchanged.
        parallel_tool_calls: options.parallelToolCalls ?? true,
        ...(options.promptCacheKey ? { prompt_cache_key: options.promptCacheKey } : {}) }),
    });
    if (!response.ok) throw new Error(`MINECRAFT_PLANNER_OPENAI_HTTP_${response.status}`);
    const payload: any = await response.json();
    if (payload.status && payload.status !== 'completed') throw new Error('MINECRAFT_PLANNER_RESPONSE_INCOMPLETE');
    const content: any[] = [];
    for (const item of payload.output ?? []) {
      if (item.type === 'function_call') {
        const parsed = JSON.parse(item.arguments);
        if (!item.call_id || !item.name || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('MINECRAFT_PLANNER_INVALID_TOOL_CALL');
        content.push({ type: 'tool_use', id: item.call_id, name: item.name, input: parsed });
      } else if (item.type === 'message') for (const block of item.content ?? []) {
        if (block.type === 'refusal') throw new Error('MINECRAFT_PLANNER_REFUSED');
        if (block.type === 'output_text') content.push({ type: 'text', text: block.text });
      }
    }
    if (!content.length) throw new Error('MINECRAFT_PLANNER_EMPTY_OUTPUT');
    return { content, usage: { input_tokens: Math.max(0, (payload.usage?.input_tokens ?? 0) - (payload.usage?.input_tokens_details?.cached_tokens ?? 0)),
      cache_read_input_tokens: payload.usage?.input_tokens_details?.cached_tokens ?? 0, output_tokens: payload.usage?.output_tokens ?? 0 } };
  };
  return { messages: { create: run, stream: (request: any, requestOptions: any) => ({ finalMessage: () => run(request, requestOptions) }) } } as unknown as Pick<Anthropic, 'messages'>;
}

export function minecraftPlannerProvider(config: { anthropic?: { apiKey?: string }; openaiApiKey?: string; minecraftPlanner?: { provider?: string } }): 'anthropic' | 'openai' | null {
  const selected = config.minecraftPlanner?.provider ?? 'auto';
  if ((selected === 'auto' || selected === 'anthropic') && config.anthropic?.apiKey) return 'anthropic';
  if ((selected === 'auto' || selected === 'openai') && config.openaiApiKey) return 'openai';
  return null;
}
