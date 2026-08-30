import type { FcaMessage, FcaModel, FcaToolCall, FcaToolDefinition } from '../../modules/fca/index.js';
import { toAbortSignal } from './abortSignal.js';

const SKIP_THOUGHT_SIGNATURE = 'skip_thought_signature_validator';

export type GeminiPart = {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
};

type GeminiContent = { role: 'user' | 'model'; parts: GeminiPart[] };

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { value };
}

function parametersForGemini(parameters: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...parameters };
  delete rest.additionalProperties;
  delete rest.$schema;
  if (typeof rest.type !== 'string') rest.type = 'object';
  if (!rest.properties || typeof rest.properties !== 'object') rest.properties = {};
  return rest;
}

function pushContent(contents: GeminiContent[], role: 'user' | 'model', parts: GeminiPart[]): void {
  if (parts.length === 0) return;
  const last = contents[contents.length - 1];
  if (last && last.role === role) last.parts.push(...parts);
  else contents.push({ role, parts });
}

/** Gemini generateContent rejects a history whose last content is role=model. */
function ensureEndsWithUser(contents: GeminiContent[]): void {
  const last = contents[contents.length - 1];
  if (!last || last.role !== 'model') return;
  const calls = last.parts.map(part => part.functionCall).filter((call): call is NonNullable<typeof call> => !!call);
  if (calls.length) {
    contents.push({
      role: 'user',
      parts: calls.map(call => ({
        functionResponse: { name: call.name, response: { result: '結果: 未実行' } },
      })),
    });
    return;
  }
  contents.push({ role: 'user', parts: [{ text: 'ユーザーが読む返信を本文に書いて。' }] });
}

function callKey(calls: readonly { id: string }[]): string {
  return calls.map(call => call.id).join('|');
}

function cloneParts(parts: readonly GeminiPart[]): GeminiPart[] {
  return parts.map(part => ({ ...part, functionCall: part.functionCall ? { ...part.functionCall } : undefined }));
}

export function buildGeminiGenerateContentBody(input: {
  system: string;
  messages: readonly FcaMessage[];
  tools: readonly FcaToolDefinition[];
  maxTokens: number;
  temperature: number;
  modelPartsByCalls?: ReadonlyMap<string, readonly GeminiPart[]>;
}): Record<string, unknown> {
  const systemParts: string[] = input.system.trim() ? [input.system] : [];
  const callNames = new Map<string, string>();
  const contents: GeminiContent[] = [];

  for (const message of input.messages) {
    if (message.role === 'system') {
      if (message.content.trim()) systemParts.push(message.content);
      continue;
    }
    if (message.role === 'user') {
      pushContent(contents, 'user', [{ text: message.content || ' ' }]);
      continue;
    }
    if (message.role === 'tool') {
      const name = (message.toolCallId && callNames.get(message.toolCallId)) || 'unknown';
      pushContent(contents, 'user', [{
        functionResponse: { name, response: { result: message.content } },
      }]);
      continue;
    }
    for (const call of message.toolCalls ?? []) {
      if (call.id) callNames.set(call.id, call.name);
    }
    const stored = message.toolCalls?.length
      ? input.modelPartsByCalls?.get(callKey(message.toolCalls))
      : undefined;
    if (stored?.length) {
      pushContent(contents, 'model', cloneParts(stored));
      continue;
    }
    const parts: GeminiPart[] = [];
    if (message.content.trim()) parts.push({ text: message.content });
    (message.toolCalls ?? []).forEach((call, index) => {
      const part: GeminiPart = { functionCall: { name: call.name, args: asRecord(call.arguments) } };
      if (index === 0) part.thoughtSignature = SKIP_THOUGHT_SIGNATURE;
      parts.push(part);
    });
    pushContent(contents, 'model', parts.length ? parts : [{ text: ' ' }]);
  }

  if (contents.length === 0 || contents[0].role !== 'user') {
    contents.unshift({ role: 'user', parts: [{ text: ' ' }] });
  }
  ensureEndsWithUser(contents);

  const body: Record<string, unknown> = {
    systemInstruction: { parts: [{ text: systemParts.join('\n\n') || ' ' }] },
    contents,
    generationConfig: {
      temperature: input.temperature,
      maxOutputTokens: input.maxTokens,
      thinkingConfig: { thinkingLevel: 'minimal' },
    },
  };
  if (input.tools.length > 0) {
    body.tools = [{
      functionDeclarations: input.tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        parameters: parametersForGemini(tool.parameters),
      })),
    }];
  }
  return body;
}

function asCallId(raw: unknown, index: number): string {
  const text = typeof raw === 'string' ? raw.replace(/[^A-Za-z0-9_-]/g, '_') : '';
  return /^[A-Za-z0-9_-]{1,80}$/.test(text) ? text.slice(0, 80) : `gemini_call_${index}`;
}

function asGeminiPart(value: unknown): GeminiPart | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as {
    text?: unknown;
    thought?: unknown;
    thoughtSignature?: unknown;
    thought_signature?: unknown;
    functionCall?: { id?: unknown; name?: unknown; args?: unknown };
  };
  const part: GeminiPart = {};
  if (typeof row.text === 'string') part.text = row.text;
  if (row.thought === true) part.thought = true;
  const signature = typeof row.thoughtSignature === 'string' ? row.thoughtSignature
    : typeof row.thought_signature === 'string' ? row.thought_signature
    : '';
  if (signature) part.thoughtSignature = signature;
  if (row.functionCall && typeof row.functionCall.name === 'string') {
    part.functionCall = { name: row.functionCall.name, args: asRecord(row.functionCall.args) };
  }
  if (!part.text && !part.functionCall && !part.thoughtSignature) return null;
  return part;
}

export function parseGeminiGenerateContentResponse(json: unknown): {
  content: string;
  toolCalls: FcaToolCall[];
  modelParts: GeminiPart[];
} {
  const candidate = json && typeof json === 'object' ? (json as { candidates?: unknown }).candidates : undefined;
  const first = Array.isArray(candidate) ? candidate[0] : undefined;
  const parts = first && typeof first === 'object'
    ? (first as { content?: { parts?: unknown } }).content?.parts
    : undefined;
  const list = Array.isArray(parts) ? parts : [];
  const texts: string[] = [];
  const toolCalls: FcaToolCall[] = [];
  const modelParts: GeminiPart[] = [];
  for (const raw of list) {
    const part = asGeminiPart(raw);
    if (!part) continue;
    modelParts.push(part);
    if (typeof part.text === 'string' && !part.thought) texts.push(part.text);
    if (part.functionCall) {
      const rawFc = raw && typeof raw === 'object' ? (raw as { functionCall?: { id?: unknown } }).functionCall : undefined;
      toolCalls.push({
        id: asCallId(rawFc?.id, toolCalls.length + 1),
        name: part.functionCall.name,
        arguments: part.functionCall.args,
      });
    }
  }
  return { content: texts.join(''), toolCalls, modelParts };
}

/** Stateless Gemini REST adapter except thought signatures, which must be echoed on later tool turns. */
export function createGeminiFcaModel(input: {
  apiKey: string;
  model: string;
  maxTokens: number;
  temperature: number;
  timeoutMs?: number;
}): FcaModel {
  if (!input.apiKey || !/^[A-Za-z0-9._:-]{1,100}$/.test(input.model)
    || !Number.isSafeInteger(input.maxTokens) || input.maxTokens < 1 || input.maxTokens > 8000
    || !Number.isFinite(input.temperature) || input.temperature < 0 || input.temperature > 2) {
    throw new Error('FCA_MODEL_CONFIG_INVALID');
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(input.model)}:generateContent`;
  const modelPartsByCalls = new Map<string, readonly GeminiPart[]>();
  return {
    async next(request, signal) {
      signal.throwIfAborted();
      const body = buildGeminiGenerateContentBody({
        system: request.system,
        messages: request.messages,
        tools: request.tools,
        maxTokens: input.maxTokens,
        temperature: input.temperature,
        modelPartsByCalls,
      });
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': input.apiKey,
        },
        body: JSON.stringify(body),
        signal: toAbortSignal(signal),
      });
      const raw = await response.text();
      signal.throwIfAborted();
      let json: unknown = {};
      try { json = raw ? JSON.parse(raw) : {}; } catch { json = { error: { message: 'GEMINI_NON_JSON' } }; }
      if (!response.ok) {
        const err = json && typeof json === 'object' ? (json as { error?: { status?: unknown; message?: unknown } }).error : undefined;
        const status = typeof err?.status === 'string' ? err.status : `HTTP_${response.status}`;
        const detail = typeof err?.message === 'string' ? err.message.slice(0, 180) : '';
        throw new Error(`Gemini ${status}${detail ? `: ${detail}` : ''}`);
      }
      const parsed = parseGeminiGenerateContentResponse(json);
      if (parsed.toolCalls.length && parsed.modelParts.length) {
        modelPartsByCalls.set(callKey(parsed.toolCalls), parsed.modelParts);
      }
      return { content: parsed.content, toolCalls: Object.freeze(parsed.toolCalls) };
    },
  };
}
