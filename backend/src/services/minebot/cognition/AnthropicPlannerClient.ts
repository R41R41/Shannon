import type Anthropic from '@anthropic-ai/sdk';

interface Options { apiKey: string; model: string; endpoint?: string; timeoutMs?: number;
  /** The transport, so a run can meter every request against its budget. */
  fetcher: typeof fetch;
  /**
   * How readily the model thinks before an answer (it decides per request; this is its guidance).
   * Kept the same for a whole run: changing it between requests discards the prompt cache.
   */
  effort?: 'low' | 'medium' | 'high';
  /** For a key that is not tied to one workspace: the workspace whose budget and limits the requests run under. */
  workspaceId?: string }

const ENDPOINT = 'https://api.anthropic.com/v1/messages';
/** Output bound per answer, thinking included. Also what a budget reserves per request. */
const MAX_OUTPUT_TOKENS = 8192;

/**
 * Where the conversation is marked for the prompt cache. The executor already
 * marks the tools and the instructions; without a mark in the conversation,
 * every earlier turn would be read at the full price on every call. The last
 * thing the model itself said is the latest point that will be identical in
 * the next request (the newest tool result carries a live-state note that is
 * replaced each time), so the mark goes there.
 */
export function markConversationForCache(messages: any[]): any[] {
  let index = -1;
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]?.role === 'assistant' && Array.isArray(messages[i].content) && messages[i].content.length) { index = i; break; }
  if (index < 0) return messages;
  const content = messages[index].content;
  // A thinking block cannot carry the mark: use the last block that can.
  let block = content.length - 1;
  while (block >= 0 && ['thinking', 'redacted_thinking'].includes(content[block]?.type)) block--;
  if (block < 0) return messages;
  const marked = content.map((item: any, i: number) => i === block ? { ...item, cache_control: { type: 'ephemeral' } } : item);
  return messages.map((message, i) => i === index ? { ...message, content: marked } : message);
}

/** Whether the model takes adaptive thinking and an effort level (the 4.6 generation and later; not Haiku 4.5). */
export function thinksAdaptively(model: string): boolean { return !model.startsWith('claude-haiku-4-5'); }

/**
 * Messages API transport for the Minecraft executor, which already speaks this
 * request shape. One model for every request of a run (as the OpenAI transport
 * does), so a comparison between planners is a comparison of one thing.
 */
export function createAnthropicPlannerClient(options: Options): Pick<Anthropic, 'messages'> {
  if (!options.apiKey.trim()) throw new Error('MINECRAFT_PLANNER_ANTHROPIC_KEY_REQUIRED');
  if (!/^claude-[a-z0-9-]+$/.test(options.model)) throw new Error('MINECRAFT_PLANNER_ANTHROPIC_MODEL_INVALID');
  if (options.workspaceId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(options.workspaceId)) throw new Error('MINECRAFT_PLANNER_ANTHROPIC_WORKSPACE_INVALID');
  const run = async (request: any, requestOptions?: { signal?: AbortSignal }) => {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 60_000);
    const signal = requestOptions?.signal ? AbortSignal.any([timeout, requestOptions.signal]) : timeout;
    const body: Record<string, unknown> = { model: options.model, max_tokens: Math.min(request.max_tokens ?? MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS),
      ...(request.system !== undefined ? { system: request.system } : {}),
      ...(request.tools?.length ? { tools: request.tools } : {}),
      messages: markConversationForCache(request.messages ?? []),
      // These models think adaptively; a sampling temperature is not sent alongside it. Haiku 4.5 takes neither
      // adaptive thinking nor an effort level: it answers without thinking, the nearest it has to a low effort.
      ...(thinksAdaptively(options.model) ? { thinking: { type: 'adaptive' }, output_config: { effort: options.effort ?? 'low' } } : {}) };
    const response = await options.fetcher(options.endpoint ?? ENDPOINT, {
      method: 'POST', headers: { 'x-api-key': options.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json',
        ...(options.workspaceId ? { 'anthropic-workspace-id': options.workspaceId } : {}) }, signal,
      body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`MINECRAFT_PLANNER_ANTHROPIC_HTTP_${response.status}`);
    const payload: any = await response.json();
    if (payload?.type !== 'message' || !Array.isArray(payload.content)) throw new Error('MINECRAFT_PLANNER_RESPONSE_INVALID');
    if (payload.stop_reason === 'refusal') throw new Error('MINECRAFT_PLANNER_REFUSED');
    if (!payload.content.some((block: any) => block.type === 'text' || block.type === 'tool_use')) throw new Error('MINECRAFT_PLANNER_EMPTY_OUTPUT');
    return payload;
  };
  return { messages: { create: run, stream: (request: any, requestOptions: any) => ({ finalMessage: () => run(request, requestOptions) }) } } as unknown as Pick<Anthropic, 'messages'>;
}
