/**
 * dc-voice: the body's client for the head's `/v1/platform/voice/*` (protocol: dc-voice-protocol.md).
 *
 * - turn:   one utterance in, NDJSON out (decision first, then sentences). Read line by line, abortable.
 * - speech: one sentence in, raw PCM (s16le, 24 kHz, mono) out, chunked.
 * - fillers / mouth (say, poll, result, wording) / said: small JSON calls.
 *
 * Nothing here throws: every call returns a result whose `status` says what happened. The fetch is injectable
 * (same style as `createShannonCoreBridge`). URL, token and bindings are the same as the text bridge's.
 */
import {
  bounded,
  matchesConversation,
  validBridgeUrl,
  validatedBindings,
  type ShannonCoreBridgeBinding,
  type ShannonCoreBridgeConfiguration,
} from './shannonCoreBridge.js';
import { ONE_HEAD_CONVERSE_PATH, type ConverseTurn } from './oneHeadConverse.js';

// ── Wire types ──────────────────────────────────────────────────────────────

export interface VoiceHeardItem {
  userId: string;
  name: string;
  text: string;
  /** ISO time */
  at: string;
}

export interface VoiceTurnRequest {
  requestId: string;
  conversationId: string;
  voiceChannelId: string;
  /** The conversation's channel name (one head only: `where.title`; the old turn body does not carry it). */
  conversationTitle?: string;
  sourceUserId: string;
  sourceDisplayName: string;
  userMessage: string;
  /** ISO time the utterance ended */
  observedAt: string;
  participants: string[];
  heard: VoiceHeardItem[];
  followsShannonTurn: boolean;
  speakingNow: boolean;
  /** How long before the utterance began she last finished speaking (ms; 0: speaking). The head's follow-up window of 「話しかけられたか」. */
  shannonSpokeMsAgo?: number;
  /** A backchannel the body already started playing without waiting for the decision (solo VC only). */
  fillerId?: string;
  situation?: string;
  sttMs?: number;
  utteranceMs?: number;
}

export interface VoiceTurnDecision {
  respond: boolean;
  reason?: string;
  filler: { id: string; text: string } | null;
}

export type VoiceTurnLine =
  | { type: 'sentence'; index: number; text: string; voiceText?: string }
  | { type: 'intent'; kind: string; delivered?: boolean; taskId?: string }
  | {
    type: 'done';
    reply: string;
    silent?: boolean;
    reason?: string;
    threadId?: string;
    duplicate?: boolean;
    timings?: { decisionMs?: number; firstSentenceMs?: number; totalMs?: number };
  }
  | { type: 'error'; status: number; error: string };

export type VoiceUnavailableReason =
  | 'not_bound' | 'timeout' | 'http' | 'network' | 'protocol' | 'aborted';

export type VoiceUnavailable = { status: 'unavailable'; reason: VoiceUnavailableReason; httpStatus?: number };

export type VoiceTurnOpenResult =
  | {
    status: 'ok';
    decision: VoiceTurnDecision;
    /** ms from the request being sent until the decision line was read */
    decisionMs: number;
    /** The rest of the lines. Ends after `done` / `error`; a broken stream yields a synthetic `error` line. */
    lines: AsyncIterable<VoiceTurnLine>;
    /** Stop reading and drop the connection. */
    cancel(): void;
  }
  | { status: 'rate_limited' }
  | VoiceUnavailable;

export type VoiceSpeechResult =
  | { status: 'ok'; chunks: AsyncIterable<Buffer>; firstChunkHeaderMs?: number }
  | VoiceUnavailable;

export interface VoiceFillerItem { id: string; text: string; style: string }

export type MouthPriority = 'low' | 'normal' | 'high';

export interface MouthQueueItem {
  id: string;
  text?: string;
  facts?: string[];
  source: string;
  key?: string;
  priority: MouthPriority;
  maxWaitMs: number;
  tags?: string;
  createdAt?: string;
}

export type MouthResultStatus =
  | 'spoken' | 'dropped_busy' | 'expired' | 'superseded' | 'not_in_voice' | 'disabled' | 'interrupted' | 'declined';

export interface VoiceSaidRequest {
  conversationId: string;
  text: string;
  source: 'mouth' | 'reply';
  at: string;
  interrupted?: boolean;
  spokenText?: string;
}

export interface VoiceWordingRequest {
  conversationId: string;
  facts: string[];
  source: string;
  participants: string[];
  heard: VoiceHeardItem[];
  situation?: string;
}

export interface ShannonCoreVoiceClient {
  /** Whether this conversation is bound to the head (same rule as the text bridge). */
  isBound(conversationId: string): boolean;
  turn(request: VoiceTurnRequest, options?: { signal?: AbortSignal; decisionTimeoutMs?: number; lineIdleTimeoutMs?: number }): Promise<VoiceTurnOpenResult>;
  speech(text: string, options?: { style?: string; signal?: AbortSignal; firstByteTimeoutMs?: number; idleTimeoutMs?: number }): Promise<VoiceSpeechResult>;
  fillers(options?: { signal?: AbortSignal }): Promise<{ status: 'ok'; items: VoiceFillerItem[] } | VoiceUnavailable>;
  say(body: { text?: string; facts?: string[]; source: string; key?: string; priority?: MouthPriority; maxWaitMs?: number; tags?: string }, options?: { signal?: AbortSignal }): Promise<{ status: 'ok'; id: string; accepted: boolean } | VoiceUnavailable>;
  mouthPoll(waitMs: number, options?: { signal?: AbortSignal }): Promise<{ status: 'ok'; items: MouthQueueItem[] } | VoiceUnavailable>;
  mouthResult(result: { id: string; status: MouthResultStatus }, options?: { signal?: AbortSignal }): Promise<{ status: 'ok' } | VoiceUnavailable>;
  wording(request: VoiceWordingRequest, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<{ status: 'ok'; say: boolean; text?: string; tags?: string } | VoiceUnavailable>;
  said(request: VoiceSaidRequest, options?: { signal?: AbortSignal }): Promise<{ status: 'ok' } | VoiceUnavailable>;
}

export const VOICE_DECISION_TIMEOUT_MS = 4_000;
const LINE_IDLE_TIMEOUT_MS = 30_000;
const SPEECH_FIRST_BYTE_TIMEOUT_MS = 6_000;
const SPEECH_IDLE_TIMEOUT_MS = 6_000;
const WORDING_TIMEOUT_MS = 4_000;

// ── Factory ─────────────────────────────────────────────────────────────────

/** Null when URL/token/bindings are not configured or not valid (never throws). */
export function createShannonCoreVoiceClient(
  bridgeConfig: ShannonCoreBridgeConfiguration,
  fetcher: typeof fetch = fetch,
): ShannonCoreVoiceClient | null {
  const url = bridgeConfig.url?.trim() ?? '';
  const token = bridgeConfig.token?.trim() ?? '';
  const bindingsJson = bridgeConfig.bindingsJson?.trim() ?? '';
  if (!validBridgeUrl(url) || token.length < 32 || !bindingsJson) return null;
  let bindings: readonly ShannonCoreBridgeBinding[];
  try {
    bindings = validatedBindings(bindingsJson);
  } catch {
    return null;
  }
  const smallTimeoutMs = Number.isSafeInteger(bridgeConfig.timeoutMs)
    ? Math.min(10_000, Math.max(500, bridgeConfig.timeoutMs))
    : 3_000;
  const base = new URL(url);
  const endpoint = (path: string): string => {
    const u = new URL(base.toString());
    u.pathname = `/v1/platform/voice/${path}`;
    return u.toString();
  };
  const authHeaders = { authorization: `Bearer ${token}` };
  const jsonHeaders = { ...authHeaders, 'content-type': 'application/json' };
  // One head: every utterance goes to `POST /v1/converse` in the one shape, bound or not; the head decides who is present.
  const oneHead = bridgeConfig.oneHead === true;
  const turnUrl = (): string => {
    if (!oneHead) return endpoint('turn');
    const u = new URL(base.toString());
    u.pathname = ONE_HEAD_CONVERSE_PATH;
    return u.toString();
  };

  const isBound = (conversationId: string): boolean =>
    bounded(conversationId, 240) && (oneHead || bindings.some(candidate => matchesConversation(candidate, conversationId)));

  /** A small JSON POST. 2xx -> ok (json may be undefined for 204); everything else -> unavailable. */
  async function postJson(
    path: string,
    body: unknown,
    options: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<{ status: 'ok'; json: Record<string, unknown> | undefined } | VoiceUnavailable> {
    const link = linkAbort(options.signal, options.timeoutMs ?? smallTimeoutMs);
    try {
      const response = await fetcher(endpoint(path), {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify(body),
        redirect: 'error',
        signal: link.signal,
      });
      if (response.status < 200 || response.status >= 300) {
        void response.body?.cancel().catch(() => undefined);
        return { status: 'unavailable', reason: 'http', httpStatus: response.status };
      }
      if (response.status === 204) return { status: 'ok', json: undefined };
      try {
        const decoded = await response.json() as unknown;
        return { status: 'ok', json: isRecord(decoded) ? decoded : undefined };
      } catch {
        return { status: 'ok', json: undefined };
      }
    } catch {
      return { status: 'unavailable', reason: link.reason() };
    } finally {
      link.dispose();
    }
  }

  const client: ShannonCoreVoiceClient = {
    isBound,

    async turn(request, options = {}): Promise<VoiceTurnOpenResult> {
      if (!isBound(request.conversationId)) return { status: 'unavailable', reason: 'not_bound' };
      const decisionTimeoutMs = options.decisionTimeoutMs ?? VOICE_DECISION_TIMEOUT_MS;
      const lineIdleTimeoutMs = options.lineIdleTimeoutMs ?? LINE_IDLE_TIMEOUT_MS;
      const controller = new AbortController();
      const unlink = relayAbort(options.signal, controller);
      let timedOut = false;
      const decisionTimer = setTimeout(() => { timedOut = true; controller.abort(); }, decisionTimeoutMs);
      const sentAt = Date.now();
      const fail = (reason: VoiceUnavailableReason, httpStatus?: number): VoiceTurnOpenResult => {
        clearTimeout(decisionTimer);
        unlink();
        controller.abort();
        return { status: 'unavailable', reason, ...(httpStatus === undefined ? {} : { httpStatus }) };
      };
      const classify = (): VoiceUnavailableReason =>
        timedOut ? 'timeout' : options.signal?.aborted ? 'aborted' : 'network';

      let response: Response;
      try {
        response = await fetcher(turnUrl(), {
          method: 'POST',
          headers: jsonHeaders,
          body: JSON.stringify(oneHead ? converseVoiceBody(request) : turnBody(request)),
          redirect: 'error',
          signal: controller.signal,
        });
      } catch {
        return fail(classify());
      }
      if (response.status === 429) {
        void response.body?.cancel().catch(() => undefined);
        clearTimeout(decisionTimer);
        unlink();
        return { status: 'rate_limited' };
      }
      if (response.status !== 200 || !response.body) {
        void response.body?.cancel().catch(() => undefined);
        return fail('http', response.status);
      }

      const reader = createLineReader(response.body.getReader());
      // First line must be the decision.
      const first = await reader.next();
      clearTimeout(decisionTimer);
      if (first.kind !== 'line') return fail(first.kind === 'end' ? 'protocol' : classify());
      const decision = parseDecision(first.value);
      if (!decision) return fail('protocol');
      const decisionMs = Date.now() - sentAt;

      async function* rest(): AsyncGenerator<VoiceTurnLine> {
        let terminal = false;
        try {
          while (!terminal) {
            const idle = setTimeout(() => controller.abort(), lineIdleTimeoutMs);
            let next: LineReadResult;
            try {
              next = await reader.next();
            } finally {
              clearTimeout(idle);
            }
            if (next.kind === 'end') {
              yield { type: 'error', status: 0, error: 'STREAM_ENDED' };
              return;
            }
            if (next.kind === 'broken') {
              yield { type: 'error', status: 0, error: options.signal?.aborted ? 'ABORTED' : 'STREAM_BROKEN' };
              return;
            }
            const line = parseLine(next.value);
            if (!line) continue;
            if (line.type === 'done' || line.type === 'error') terminal = true;
            yield line;
          }
        } finally {
          unlink();
          controller.abort();
        }
      }

      return {
        status: 'ok',
        decision,
        decisionMs,
        lines: { [Symbol.asyncIterator]: () => rest() },
        cancel: () => { unlink(); controller.abort(); },
      };
    },

    async speech(text, options = {}): Promise<VoiceSpeechResult> {
      const controller = new AbortController();
      const unlink = relayAbort(options.signal, controller);
      let timedOut = false;
      const firstByteTimer = setTimeout(() => { timedOut = true; controller.abort(); }, options.firstByteTimeoutMs ?? SPEECH_FIRST_BYTE_TIMEOUT_MS);
      const fail = (reason: VoiceUnavailableReason, httpStatus?: number): VoiceSpeechResult => {
        clearTimeout(firstByteTimer);
        unlink();
        controller.abort();
        return { status: 'unavailable', reason, ...(httpStatus === undefined ? {} : { httpStatus }) };
      };
      let response: Response;
      try {
        response = await fetcher(endpoint('speech'), {
          method: 'POST',
          headers: jsonHeaders,
          body: JSON.stringify({
            text: text.slice(0, 400),
            ...(options.style ? { style: options.style } : {}),
          }),
          redirect: 'error',
          signal: controller.signal,
        });
      } catch {
        return fail(timedOut ? 'timeout' : options.signal?.aborted ? 'aborted' : 'network');
      }
      clearTimeout(firstByteTimer);
      const contentType = response.headers.get('content-type') ?? '';
      if (response.status !== 200 || !response.body) {
        void response.body?.cancel().catch(() => undefined);
        unlink();
        return { status: 'unavailable', reason: 'http', httpStatus: response.status };
      }
      if (!/^audio\/l16/i.test(contentType)) {
        void response.body.cancel().catch(() => undefined);
        unlink();
        return { status: 'unavailable', reason: 'protocol', httpStatus: response.status };
      }
      const headerMs = Number(response.headers.get('x-shannon-first-chunk-ms'));
      const reader = response.body.getReader();
      const idleTimeoutMs = options.idleTimeoutMs ?? SPEECH_IDLE_TIMEOUT_MS;
      async function* chunks(): AsyncGenerator<Buffer> {
        try {
          while (true) {
            const idle = setTimeout(() => controller.abort(), idleTimeoutMs);
            let step: ReadableStreamReadResult<Uint8Array>;
            try {
              step = await reader.read();
            } catch {
              return; // a broken stream just ends; the caller plays what it has
            } finally {
              clearTimeout(idle);
            }
            if (step.done) return;
            if (step.value && step.value.byteLength > 0) yield Buffer.from(step.value);
          }
        } finally {
          unlink();
          controller.abort();
        }
      }
      return {
        status: 'ok',
        chunks: { [Symbol.asyncIterator]: () => chunks() },
        ...(Number.isFinite(headerMs) && response.headers.has('x-shannon-first-chunk-ms') ? { firstChunkHeaderMs: headerMs } : {}),
      };
    },

    async fillers(options = {}) {
      const link = linkAbort(options.signal, smallTimeoutMs * 2);
      try {
        const response = await fetcher(endpoint('fillers'), {
          method: 'GET',
          headers: authHeaders,
          redirect: 'error',
          signal: link.signal,
        });
        if (response.status !== 200) {
          void response.body?.cancel().catch(() => undefined);
          return { status: 'unavailable' as const, reason: 'http' as const, httpStatus: response.status };
        }
        const decoded = await response.json() as unknown;
        const rawItems = isRecord(decoded) && Array.isArray(decoded.items) ? decoded.items : [];
        const items: VoiceFillerItem[] = [];
        for (const raw of rawItems) {
          if (!isRecord(raw) || !bounded(raw.id, 80) || !bounded(raw.text, 400)) continue;
          items.push({ id: raw.id.trim(), text: raw.text.trim(), style: typeof raw.style === 'string' ? raw.style : '' });
        }
        return { status: 'ok' as const, items };
      } catch {
        return { status: 'unavailable' as const, reason: link.reason() };
      } finally {
        link.dispose();
      }
    },

    async say(body, options = {}) {
      const result = await postJson('say', body, options);
      if (result.status !== 'ok') return result;
      const json = result.json;
      return { status: 'ok' as const, id: typeof json?.id === 'string' ? json.id : '', accepted: json?.accepted === true };
    },

    async mouthPoll(waitMs, options = {}) {
      const result = await postJson('mouth/poll', { waitMs }, { signal: options.signal, timeoutMs: waitMs + 8_000 });
      if (result.status !== 'ok') return result;
      const rawItems = Array.isArray(result.json?.items) ? result.json!.items as unknown[] : [];
      const items: MouthQueueItem[] = [];
      for (const raw of rawItems) {
        const item = parseMouthItem(raw);
        if (item) items.push(item);
      }
      return { status: 'ok' as const, items };
    },

    async mouthResult(result, options = {}) {
      const posted = await postJson('mouth/result', result, options);
      return posted.status === 'ok' ? { status: 'ok' as const } : posted;
    },

    async wording(request, options = {}) {
      const body = {
        conversationId: request.conversationId,
        facts: request.facts.slice(0, 5),
        source: request.source,
        participants: request.participants.slice(0, 50),
        heard: request.heard.slice(0, 8),
        ...(request.situation ? { situation: request.situation.slice(0, 300) } : {}),
      };
      const result = await postJson('wording', body, { signal: options.signal, timeoutMs: options.timeoutMs ?? WORDING_TIMEOUT_MS });
      if (result.status !== 'ok') return result;
      if (result.json?.say !== true || !bounded(result.json.text, 400)) return { status: 'ok' as const, say: false };
      return {
        status: 'ok' as const,
        say: true,
        text: (result.json.text as string).trim(),
        ...(typeof result.json.tags === 'string' && result.json.tags ? { tags: result.json.tags } : {}),
      };
    },

    async said(request, options = {}) {
      const posted = await postJson('said', request, options);
      return posted.status === 'ok' ? { status: 'ok' as const } : posted;
    },
  };
  return Object.freeze(client);
}

// ── Request / line helpers ──────────────────────────────────────────────────

function turnBody(request: VoiceTurnRequest) {
  return {
    platform: 'discord' as const,
    requestId: request.requestId,
    conversationId: request.conversationId,
    voiceChannelId: request.voiceChannelId,
    sourceUserId: request.sourceUserId,
    sourceDisplayName: request.sourceDisplayName.slice(0, 80),
    userMessage: request.userMessage.slice(0, 1000),
    observedAt: request.observedAt,
    participants: request.participants.slice(0, 50),
    heard: request.heard.slice(0, 8).map(item => ({
      userId: item.userId, name: item.name.slice(0, 80), text: item.text.slice(0, 1000), at: item.at,
    })),
    followsShannonTurn: request.followsShannonTurn,
    speakingNow: request.speakingNow,
    ...(request.shannonSpokeMsAgo === undefined ? {} : { shannonSpokeMsAgo: Math.max(0, Math.round(request.shannonSpokeMsAgo)) }),
    ...(request.fillerId ? { fillerId: request.fillerId.slice(0, 80) } : {}),
    ...(request.situation ? { situation: request.situation.slice(0, 300) } : {}),
    ...(request.sttMs === undefined ? {} : { sttMs: Math.max(0, Math.round(request.sttMs)) }),
    ...(request.utteranceMs === undefined ? {} : { utteranceMs: Math.max(0, Math.round(request.utteranceMs)) }),
  };
}

/** One head: the same utterance in the one shape of `POST /v1/converse` (`oneHeadConverse.ts`). */
export function converseVoiceBody(request: VoiceTurnRequest): ConverseTurn {
  const body = turnBody(request);
  const title = request.conversationTitle?.trim().slice(0, 80);
  return {
    version: 1, requestId: body.requestId, observedAt: body.observedAt, modality: 'voice',
    where: { platform: 'discord', conversationId: body.conversationId, conversationKind: 'channel', voiceChannelId: body.voiceChannelId,
      ...(title ? { title } : {}) },
    who: { userId: body.sourceUserId, displayName: body.sourceDisplayName },
    presence: {
      participants: body.participants, heard: body.heard, followsShannonTurn: body.followsShannonTurn, speakingNow: body.speakingNow,
      ...(body.shannonSpokeMsAgo === undefined ? {} : { shannonSpokeMsAgo: body.shannonSpokeMsAgo }),
      ...(body.situation ? { situation: body.situation } : {}),
    },
    words: body.userMessage,
    voice: {
      ...(body.fillerId ? { fillerId: body.fillerId } : {}), ...(body.sttMs === undefined ? {} : { sttMs: body.sttMs }),
      ...(body.utteranceMs === undefined ? {} : { utteranceMs: body.utteranceMs }),
    },
  };
}

function parseDecision(raw: unknown): VoiceTurnDecision | null {
  if (!isRecord(raw) || raw.type !== 'decision' || typeof raw.respond !== 'boolean') return null;
  let filler: VoiceTurnDecision['filler'] = null;
  if (isRecord(raw.filler) && bounded(raw.filler.id, 80)) {
    filler = { id: raw.filler.id.trim(), text: typeof raw.filler.text === 'string' ? raw.filler.text : '' };
  }
  return { respond: raw.respond, ...(typeof raw.reason === 'string' ? { reason: raw.reason } : {}), filler };
}

function parseLine(raw: unknown): VoiceTurnLine | null {
  if (!isRecord(raw) || typeof raw.type !== 'string') return null;
  switch (raw.type) {
    case 'sentence':
      if (typeof raw.text !== 'string' || !raw.text.trim()) return null;
      return {
        type: 'sentence',
        index: Number.isSafeInteger(raw.index) ? raw.index as number : 0,
        text: raw.text,
        ...(typeof raw.voiceText === 'string' && raw.voiceText.trim() ? { voiceText: raw.voiceText } : {}),
      };
    case 'intent':
      return {
        type: 'intent',
        kind: typeof raw.kind === 'string' ? raw.kind : 'none',
        ...(typeof raw.delivered === 'boolean' ? { delivered: raw.delivered } : {}),
        ...(typeof raw.taskId === 'string' ? { taskId: raw.taskId } : {}),
      };
    case 'done': {
      const timings = isRecord(raw.timings) ? raw.timings : undefined;
      return {
        type: 'done',
        reply: typeof raw.reply === 'string' ? raw.reply : '',
        ...(typeof raw.silent === 'boolean' ? { silent: raw.silent } : {}),
        ...(typeof raw.reason === 'string' ? { reason: raw.reason } : {}),
        ...(typeof raw.threadId === 'string' ? { threadId: raw.threadId } : {}),
        ...(typeof raw.duplicate === 'boolean' ? { duplicate: raw.duplicate } : {}),
        ...(timings ? { timings: {
          ...(typeof timings.decisionMs === 'number' ? { decisionMs: timings.decisionMs } : {}),
          ...(typeof timings.firstSentenceMs === 'number' ? { firstSentenceMs: timings.firstSentenceMs } : {}),
          ...(typeof timings.totalMs === 'number' ? { totalMs: timings.totalMs } : {}),
        } } : {}),
      };
    }
    case 'error':
      return {
        type: 'error',
        status: typeof raw.status === 'number' ? raw.status : 0,
        error: typeof raw.error === 'string' ? raw.error : 'ERROR',
      };
    default:
      return null;
  }
}

function parseMouthItem(raw: unknown): MouthQueueItem | null {
  if (!isRecord(raw) || !bounded(raw.id, 200) || !bounded(raw.source, 200)) return null;
  const text = typeof raw.text === 'string' && raw.text.trim() ? raw.text.trim() : undefined;
  const facts = Array.isArray(raw.facts)
    ? raw.facts.filter((fact): fact is string => typeof fact === 'string' && fact.trim().length > 0).slice(0, 5)
    : undefined;
  if (!text && !(facts && facts.length > 0)) return null;
  const priority: MouthPriority = raw.priority === 'low' || raw.priority === 'high' ? raw.priority : 'normal';
  const maxWaitMs = Number.isFinite(raw.maxWaitMs) ? Math.min(60_000, Math.max(500, raw.maxWaitMs as number)) : defaultMaxWait(priority);
  return {
    id: raw.id.trim(),
    ...(text ? { text } : { facts }),
    source: raw.source.trim(),
    ...(bounded(raw.key, 200) ? { key: raw.key.trim() } : {}),
    priority,
    maxWaitMs,
    ...(typeof raw.tags === 'string' && raw.tags ? { tags: raw.tags } : {}),
    ...(typeof raw.createdAt === 'string' ? { createdAt: raw.createdAt } : {}),
  };
}

export function defaultMaxWait(priority: MouthPriority): number {
  return priority === 'low' ? 4_000 : priority === 'high' ? 3_000 : 8_000;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ── NDJSON line reader ──────────────────────────────────────────────────────

type LineReadResult =
  | { kind: 'line'; value: unknown }
  | { kind: 'end' }
  | { kind: 'broken' };

/** Reads JSON lines from a byte stream; a non-JSON line is skipped, a cut final line is parsed if it is whole JSON. */
function createLineReader(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const decoder = new TextDecoder();
  let pending = '';
  let finished = false;
  const lines: string[] = [];
  return {
    async next(): Promise<LineReadResult> {
      while (true) {
        while (lines.length > 0) {
          const text = lines.shift()!;
          try {
            return { kind: 'line', value: JSON.parse(text) as unknown };
          } catch {
            continue;
          }
        }
        if (finished) return { kind: 'end' };
        let step: ReadableStreamReadResult<Uint8Array>;
        try {
          step = await reader.read();
        } catch {
          finished = true;
          return { kind: 'broken' };
        }
        if (step.done) {
          finished = true;
          pending += decoder.decode();
          if (pending.trim()) lines.push(pending);
          pending = '';
          continue;
        }
        pending += decoder.decode(step.value, { stream: true });
        const parts = pending.split('\n');
        pending = parts.pop() ?? '';
        for (const part of parts) if (part.trim()) lines.push(part);
      }
    },
  };
}

// ── Abort helpers ───────────────────────────────────────────────────────────

/** Abort `target` when `source` aborts. Returns a function that detaches. */
function relayAbort(source: AbortSignal | undefined, target: AbortController): () => void {
  if (!source) return () => undefined;
  if (source.aborted) {
    target.abort();
    return () => undefined;
  }
  const onAbort = () => target.abort();
  source.addEventListener('abort', onAbort, { once: true });
  return () => source.removeEventListener('abort', onAbort);
}

/** A signal that aborts on the caller's signal or after `timeoutMs`; `reason()` says which. */
function linkAbort(signal: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  const unlink = relayAbort(signal, controller);
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  return {
    signal: controller.signal,
    reason: (): VoiceUnavailableReason => (timedOut ? 'timeout' : signal?.aborted ? 'aborted' : 'network'),
    dispose: () => { clearTimeout(timer); unlink(); },
  };
}
