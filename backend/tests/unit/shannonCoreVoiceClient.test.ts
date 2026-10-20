import { describe, expect, it, vi } from 'vitest';
import {
  createShannonCoreVoiceClient,
  type VoiceTurnLine,
  type VoiceTurnRequest,
} from '../../src/services/integration/shannonCoreVoiceClient.js';

const token = 'a'.repeat(32);
const configuration = {
  url: 'http://127.0.0.1:4319/v1/platform/turns',
  token,
  bindingsJson: JSON.stringify([{ platform: 'discord', conversationIdPrefix: 'discord:111:', ownerUserId: '333' }]),
  timeoutMs: 3_000,
};

const request: VoiceTurnRequest = {
  requestId: 'req-1',
  conversationId: 'discord:111:222',
  voiceChannelId: '999',
  sourceUserId: '333',
  sourceDisplayName: 'ライ',
  userMessage: 'こんにちは',
  observedAt: '2026-10-20T10:00:00.000Z',
  participants: ['333', '444'],
  heard: [],
  followsShannonTurn: false,
  speakingNow: false,
};

const encoder = new TextEncoder();

/** A streaming Response whose body is cut into the given pieces; aborting the request errors the body. */
function streamResponse(
  pieces: Array<string | Uint8Array>,
  init: ResponseInit & { signal?: AbortSignal; delayMs?: number; hold?: boolean; failAfter?: boolean } = {},
): Response {
  const { signal, delayMs = 0, hold = false, failAfter = false, ...responseInit } = init;
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      signal?.addEventListener('abort', () => {
        try { controller.error(new Error('aborted')); } catch { /* already closed */ }
      }, { once: true });
      for (const piece of pieces) {
        if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
        if (signal?.aborted) return;
        controller.enqueue(typeof piece === 'string' ? encoder.encode(piece) : piece);
      }
      if (failAfter) {
        await new Promise(resolve => setTimeout(resolve, 30)); // let the reader take what was sent first
        controller.error(new Error('connection reset'));
        return;
      }
      if (!hold) controller.close();
    },
  });
  return new Response(body, responseInit);
}

function fetchReturning(make: (url: string, init: RequestInit) => Response | Promise<Response>) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => make(String(url), init ?? {}));
}

async function collect(lines: AsyncIterable<VoiceTurnLine>): Promise<VoiceTurnLine[]> {
  const out: VoiceTurnLine[] = [];
  for await (const line of lines) out.push(line);
  return out;
}

describe('createShannonCoreVoiceClient', () => {
  it('is null (never throws) when URL, token or bindings are missing or invalid', () => {
    expect(createShannonCoreVoiceClient({ url: '', token: '', bindingsJson: '', timeoutMs: 3_000 })).toBeNull();
    for (const bad of [
      { ...configuration, token: 'short' },
      { ...configuration, bindingsJson: '' },
      { ...configuration, bindingsJson: 'not-json' },
      { ...configuration, url: 'http://example.com/v1/platform/turns' },
      { ...configuration, url: 'https://example.com/wrong' },
    ]) expect(createShannonCoreVoiceClient(bad)).toBeNull();
    expect(createShannonCoreVoiceClient(configuration)).not.toBeNull();
  });

  it('knows which conversations are bound', () => {
    const client = createShannonCoreVoiceClient(configuration)!;
    expect(client.isBound('discord:111:222')).toBe(true);
    expect(client.isBound('discord:111:abc')).toBe(false);
    expect(client.isBound('discord:999:222')).toBe(false);
  });
});

describe('turn', () => {
  it('reads NDJSON split anywhere (inside a line, inside a multi-byte character) and a last line without newline', async () => {
    const full = [
      '{"type":"decision","respond":true,"reason":"named","filler":{"id":"un","text":"うん。"}}\n',
      '{"type":"sentence","index":0,"text":"はい、聞いてるよ。","voiceText":"[softly] はい、聞いてるよ。"}\n',
      '{"type":"intent","kind":"none","delivered":false}\n',
      '{"type":"sentence","index":1,"text":"どうしたの？"}\n',
      '{"type":"done","reply":"はい、聞いてるよ。どうしたの？","threadId":"t1","duplicate":false,"timings":{"decisionMs":50,"totalMs":900}}',
    ].join('');
    const bytes = encoder.encode(full);
    const pieces: Uint8Array[] = [];
    for (let at = 0; at < bytes.length; at += 7) pieces.push(bytes.subarray(at, at + 7)); // 7 bytes: splits characters
    const fetcher = fetchReturning((_url, init) => streamResponse(pieces, { signal: init.signal as AbortSignal, status: 200, headers: { 'content-type': 'application/x-ndjson' } }));
    const client = createShannonCoreVoiceClient(configuration, fetcher as typeof fetch)!;

    const open = await client.turn(request);
    expect(open.status).toBe('ok');
    if (open.status !== 'ok') return;
    expect(open.decision).toEqual({ respond: true, reason: 'named', filler: { id: 'un', text: 'うん。' } });
    const lines = await collect(open.lines);
    expect(lines.map(line => line.type)).toEqual(['sentence', 'intent', 'sentence', 'done']);
    expect(lines[0]).toEqual({ type: 'sentence', index: 0, text: 'はい、聞いてるよ。', voiceText: '[softly] はい、聞いてるよ。' });
    expect(lines[3]).toMatchObject({ type: 'done', reply: 'はい、聞いてるよ。どうしたの？', threadId: 't1', timings: { totalMs: 900 } });
  });

  it('posts exactly the fields the head accepts, with the bearer token, to /v1/platform/voice/turn', async () => {
    const fetcher = fetchReturning(() => streamResponse(['{"type":"decision","respond":false,"filler":null}\n{"type":"done","reply":"","silent":true,"reason":"table_talk"}\n'], { status: 200 }));
    const client = createShannonCoreVoiceClient(configuration, fetcher as typeof fetch)!;
    await client.turn({
      ...request,
      userMessage: 'あ'.repeat(1500),
      situation: '洞窟',
      sttMs: 420.4,
      utteranceMs: 3100,
      heard: [{ userId: '444', name: 'ミキ', text: '寒い', at: '2026-10-20T09:59:50.000Z' }],
    });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:4319/v1/platform/voice/turn');
    expect((init!.headers as Record<string, string>).authorization).toBe(`Bearer ${token}`);
    const body = JSON.parse(String(init!.body));
    expect(Object.keys(body).sort()).toEqual([
      'conversationId', 'followsShannonTurn', 'heard', 'observedAt', 'participants', 'platform', 'requestId',
      'situation', 'sourceDisplayName', 'sourceUserId', 'speakingNow', 'sttMs', 'userMessage', 'utteranceMs', 'voiceChannelId',
    ]);
    expect(body.platform).toBe('discord');
    expect(body.userMessage).toHaveLength(1000);
    expect(body.sttMs).toBe(420);
  });

  it('does not call the head for a conversation that is not bound', async () => {
    const fetcher = fetchReturning(() => new Response('{}'));
    const client = createShannonCoreVoiceClient(configuration, fetcher as typeof fetch)!;
    const open = await client.turn({ ...request, conversationId: 'discord:999:1' });
    expect(open).toEqual({ status: 'unavailable', reason: 'not_bound' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('gives up on a decision that does not arrive in time (and drops the connection)', async () => {
    let aborted = false;
    const fetcher = fetchReturning((_url, init) => {
      (init.signal as AbortSignal).addEventListener('abort', () => { aborted = true; });
      return streamResponse([], { signal: init.signal as AbortSignal, status: 200, hold: true });
    });
    const client = createShannonCoreVoiceClient(configuration, fetcher as typeof fetch)!;
    const startedAt = Date.now();
    const open = await client.turn(request, { decisionTimeoutMs: 60 });
    expect(open).toEqual({ status: 'unavailable', reason: 'timeout' });
    expect(Date.now() - startedAt).toBeLessThan(400);
    expect(aborted).toBe(true);
  });

  it('times out when the headers never come either', async () => {
    const fetcher = fetchReturning((_url, init) => new Promise<Response>((_resolve, reject) => {
      (init.signal as AbortSignal).addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const client = createShannonCoreVoiceClient(configuration, fetcher as typeof fetch)!;
    expect(await client.turn(request, { decisionTimeoutMs: 40 })).toEqual({ status: 'unavailable', reason: 'timeout' });
  });

  it('maps HTTP failures: 429 is rate_limited, others unavailable, a non-decision first line is a protocol error', async () => {
    const run = async (make: () => Response) => createShannonCoreVoiceClient(configuration, fetchReturning(make) as typeof fetch)!.turn(request);
    expect(await run(() => new Response('{"error":"RATE_LIMITED"}', { status: 429 }))).toEqual({ status: 'rate_limited' });
    expect(await run(() => new Response('{"error":"PLATFORM_VOICE_DISABLED"}', { status: 503 }))).toEqual({ status: 'unavailable', reason: 'http', httpStatus: 503 });
    expect(await run(() => new Response('{"error":"BAD_REQUEST"}', { status: 400 }))).toEqual({ status: 'unavailable', reason: 'http', httpStatus: 400 });
    expect(await run(() => streamResponse(['{"type":"sentence","index":0,"text":"x"}\n'], { status: 200 }))).toEqual({ status: 'unavailable', reason: 'protocol' });
    expect(await run(() => streamResponse(['not json\n'], { status: 200 }))).toEqual({ status: 'unavailable', reason: 'protocol' });
  });

  it('turns a connection that breaks after the decision into an error line (never an exception)', async () => {
    const fetcher = fetchReturning((_url, init) => streamResponse(
      ['{"type":"decision","respond":true,"filler":null}\n{"type":"sentence","index":0,"text":"うん。"}\n'],
      { signal: init.signal as AbortSignal, status: 200, failAfter: true },
    ));
    const client = createShannonCoreVoiceClient(configuration, fetcher as typeof fetch)!;
    const open = await client.turn(request);
    if (open.status !== 'ok') throw new Error('expected ok');
    const lines = await collect(open.lines);
    expect(lines.map(line => line.type)).toEqual(['sentence', 'error']);
    expect(lines[1]).toMatchObject({ type: 'error', error: 'STREAM_BROKEN' });
  });

  it('turns a stream that ends without done into an error line, and passes the head error line through', async () => {
    const ended = createShannonCoreVoiceClient(configuration, fetchReturning(() => streamResponse(
      ['{"type":"decision","respond":true,"filler":null}\n{"type":"sentence","index":0,"text":"うん。"}\n'], { status: 200 })) as typeof fetch)!;
    const open1 = await ended.turn(request);
    if (open1.status !== 'ok') throw new Error('expected ok');
    expect((await collect(open1.lines)).at(-1)).toMatchObject({ type: 'error', error: 'STREAM_ENDED' });

    const failing = createShannonCoreVoiceClient(configuration, fetchReturning(() => streamResponse(
      ['{"type":"decision","respond":true,"filler":null}\n{"type":"error","status":502,"error":"MODEL_UNAVAILABLE"}\n{"type":"sentence","index":9,"text":"後ろ"}\n'], { status: 200 })) as typeof fetch)!;
    const open2 = await failing.turn(request);
    if (open2.status !== 'ok') throw new Error('expected ok');
    // The error line is terminal: nothing after it is delivered.
    expect(await collect(open2.lines)).toEqual([{ type: 'error', status: 502, error: 'MODEL_UNAVAILABLE' }]);
  });

  it('stops reading when the caller aborts', async () => {
    const controller = new AbortController();
    const fetcher = fetchReturning((_url, init) => streamResponse(
      ['{"type":"decision","respond":true,"filler":null}\n'], { signal: init.signal as AbortSignal, status: 200, hold: true },
    ));
    const client = createShannonCoreVoiceClient(configuration, fetcher as typeof fetch)!;
    const open = await client.turn(request, { signal: controller.signal });
    if (open.status !== 'ok') throw new Error('expected ok');
    setTimeout(() => controller.abort(), 20);
    const lines = await collect(open.lines);
    expect(lines).toEqual([{ type: 'error', status: 0, error: 'ABORTED' }]);
  });

  it('reports a caller abort before the decision as aborted, not as a head failure', async () => {
    const controller = new AbortController();
    const fetcher = fetchReturning((_url, init) => new Promise<Response>((_resolve, reject) => {
      (init.signal as AbortSignal).addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const client = createShannonCoreVoiceClient(configuration, fetcher as typeof fetch)!;
    setTimeout(() => controller.abort(), 20);
    expect(await client.turn(request, { signal: controller.signal, decisionTimeoutMs: 2_000 })).toEqual({ status: 'unavailable', reason: 'aborted' });
  });
});

describe('speech', () => {
  it('streams PCM chunks as they come and sends text and style', async () => {
    const pcm = [Uint8Array.from([1, 0, 2, 0]), Uint8Array.from([3, 0]), Uint8Array.from([4, 0, 5, 0])];
    const fetcher = fetchReturning(() => streamResponse(pcm, {
      status: 200, headers: { 'content-type': 'audio/l16;rate=24000;channels=1', 'x-shannon-first-chunk-ms': '310' },
    }));
    const client = createShannonCoreVoiceClient(configuration, fetcher as typeof fetch)!;
    const result = await client.speech('こんにちは', { style: '[softly]' });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.firstChunkHeaderMs).toBe(310);
    const received: Buffer[] = [];
    for await (const chunk of result.chunks) received.push(chunk);
    expect(Buffer.concat(received)).toEqual(Buffer.from([1, 0, 2, 0, 3, 0, 4, 0, 5, 0]));
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body))).toEqual({ text: 'こんにちは', style: '[softly]' });
    expect(fetcher.mock.calls[0]![0]).toBe('http://127.0.0.1:4319/v1/platform/voice/speech');
  });

  it('reports a JSON error before any audio as unavailable (the caller then uses VOICEPEAK)', async () => {
    const run = (response: Response) => createShannonCoreVoiceClient(configuration, fetchReturning(() => response) as typeof fetch)!.speech('x');
    expect(await run(new Response('{"error":"ELEVEN_SPEECH_NOT_CONFIGURED"}', { status: 503 }))).toEqual({ status: 'unavailable', reason: 'http', httpStatus: 503 });
    expect(await run(new Response('{"ok":1}', { status: 200, headers: { 'content-type': 'application/json' } }))).toMatchObject({ status: 'unavailable', reason: 'protocol' });
  });

  it('ends quietly when the audio stream breaks midway', async () => {
    const fetcher = fetchReturning((_url, init) => streamResponse([Uint8Array.from([1, 0, 2, 0])], {
      signal: init.signal as AbortSignal, status: 200, headers: { 'content-type': 'audio/l16;rate=24000;channels=1' }, failAfter: true,
    }));
    const result = await createShannonCoreVoiceClient(configuration, fetcher as typeof fetch)!.speech('x');
    if (result.status !== 'ok') throw new Error('expected ok');
    const received: Buffer[] = [];
    for await (const chunk of result.chunks) received.push(chunk);
    expect(Buffer.concat(received)).toEqual(Buffer.from([1, 0, 2, 0]));
  });

  it('gives up when no audio starts within the first-byte timeout', async () => {
    const fetcher = fetchReturning((_url, init) => new Promise<Response>((_resolve, reject) => {
      (init.signal as AbortSignal).addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const result = await createShannonCoreVoiceClient(configuration, fetcher as typeof fetch)!.speech('x', { firstByteTimeoutMs: 40 });
    expect(result).toEqual({ status: 'unavailable', reason: 'timeout' });
  });
});

describe('fillers, mouth and said', () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('reads the filler list and skips malformed items', async () => {
    const fetcher = fetchReturning(() => json({ items: [{ id: 'un', text: 'うん。', style: '' }, { id: '', text: 'x' }, { text: 'y' }, { id: 'hai', text: 'はい。', style: '[softly]' }] }));
    const client = createShannonCoreVoiceClient(configuration, fetcher as typeof fetch)!;
    expect(await client.fillers()).toEqual({ status: 'ok', items: [{ id: 'un', text: 'うん。', style: '' }, { id: 'hai', text: 'はい。', style: '[softly]' }] });
    expect(fetcher.mock.calls[0]![0]).toBe('http://127.0.0.1:4319/v1/platform/voice/fillers');
    expect(fetcher.mock.calls[0]![1]!.method).toBe('GET');
    const down = createShannonCoreVoiceClient(configuration, fetchReturning(() => json({ error: 'PLATFORM_VOICE_DISABLED' }, 503)) as typeof fetch)!;
    expect(await down.fillers()).toEqual({ status: 'unavailable', reason: 'http', httpStatus: 503 });
  });

  it('long-polls the mouth queue and parses its items', async () => {
    const fetcher = fetchReturning(() => json({ items: [
      { id: 'm1', text: 'ダイヤ見つけた！', source: 'minecraft:milestone', priority: 'high', maxWaitMs: 3000, tags: '[excited]', createdAt: '2026-10-20T10:00:00Z' },
      { id: 'm2', facts: ['鉄のツルハシを作った'], source: 'minecraft:craft', priority: 'weird' },
      { id: 'm3', source: 'no-text' },
    ] }));
    const client = createShannonCoreVoiceClient(configuration, fetcher as typeof fetch)!;
    const polled = await client.mouthPoll(25_000);
    expect(polled.status).toBe('ok');
    if (polled.status !== 'ok') return;
    expect(polled.items.map(item => item.id)).toEqual(['m1', 'm2']);
    expect(polled.items[1]).toMatchObject({ priority: 'normal', maxWaitMs: 8000, facts: ['鉄のツルハシを作った'] });
    expect(fetcher.mock.calls[0]![0]).toBe('http://127.0.0.1:4319/v1/platform/voice/mouth/poll');
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body))).toEqual({ waitMs: 25_000 });
  });

  it('posts results, said and say; asks wording and understands say:false', async () => {
    const fetcher = fetchReturning((url) => {
      if (url.endsWith('/wording')) return json({ say: true, text: 'お、鉄のツルハシだね。', tags: '[excited]' });
      if (url.endsWith('/say')) return json({ id: 'srv-1', accepted: true }, 202);
      return new Response(null, { status: 204 });
    });
    const client = createShannonCoreVoiceClient(configuration, fetcher as typeof fetch)!;
    expect(await client.mouthResult({ id: 'm1', status: 'declined' })).toEqual({ status: 'ok' });
    expect(await client.said({ conversationId: 'discord:111:222', text: 'ダイヤ見つけた！', source: 'mouth', at: '2026-10-20T10:00:00Z' })).toEqual({ status: 'ok' });
    expect(await client.say({ text: 'やあ', source: 'x' })).toEqual({ status: 'ok', id: 'srv-1', accepted: true });
    expect(await client.wording({ conversationId: 'discord:111:222', facts: ['a'], source: 's', participants: ['333'], heard: [] }))
      .toEqual({ status: 'ok', say: true, text: 'お、鉄のツルハシだね。', tags: '[excited]' });
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body))).toEqual({ id: 'm1', status: 'declined' });

    const silent = createShannonCoreVoiceClient(configuration, fetchReturning(() => json({ say: false })) as typeof fetch)!;
    expect(await silent.wording({ conversationId: 'discord:111:222', facts: ['a'], source: 's', participants: [], heard: [] })).toEqual({ status: 'ok', say: false });
  });

  it('never throws on network errors', async () => {
    const client = createShannonCoreVoiceClient(configuration, (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch)!;
    expect(await client.mouthResult({ id: 'x', status: 'spoken' })).toMatchObject({ status: 'unavailable', reason: 'network' });
    expect(await client.mouthPoll(1000)).toMatchObject({ status: 'unavailable' });
    expect(await client.fillers()).toMatchObject({ status: 'unavailable' });
    expect(await client.speech('x')).toMatchObject({ status: 'unavailable' });
    expect(await client.turn(request)).toMatchObject({ status: 'unavailable' });
  });
});
