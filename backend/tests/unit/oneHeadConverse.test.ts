import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { answerDiscordFromCompanion } from '../../src/services/integration/discordCompanionReply.js';
import { createShannonCoreBridge } from '../../src/services/integration/shannonCoreBridge.js';
import { converseAnswer, converseTextTurn, converseWords } from '../../src/services/integration/oneHeadConverse.js';
import { converseVoiceBody, createShannonCoreVoiceClient, type VoiceTurnRequest } from '../../src/services/integration/shannonCoreVoiceClient.js';

/**
 * One head (owner 2026-10-20, SHANNON_ONE_HEAD): every Discord message and every voice-channel utterance goes to the head's
 * POST /v1/converse in one shape, bound or not, the owner's or anyone's; this runtime's own model answers only when the head cannot.
 */
const token = 'c'.repeat(40);
const servers: Array<ReturnType<typeof createServer>> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

/** A fake head on loopback: answers /v1/converse with NDJSON lines, and records what it was sent. */
async function fakeHead(answer: (body: Record<string, unknown>) => { status: number; lines: unknown[] }) {
  const received: Array<{ path: string; body: Record<string, unknown> }> = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(chunk as Buffer));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
      received.push({ path: request.url ?? '', body });
      const result = answer(body);
      response.writeHead(result.status, { 'content-type': 'application/x-ndjson' });
      response.end(result.lines.map(line => JSON.stringify(line)).join('\n'));
    });
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing test port');
  return { url: `http://127.0.0.1:${address.port}/v1/platform/turns`, received };
}

const BINDINGS = JSON.stringify([{ platform: 'discord', conversationIdPrefix: 'discord:111:', ownerUserId: '333' }]);

function envelope(fields: Record<string, unknown> = {}) {
  return {
    channel: 'discord', requestId: 'request-1', conversationId: 'discord:777:888', sourceUserId: '444', sourceDisplayName: 'たろう',
    text: 'シャノン、おはよう', timestampIso: '2026-10-20T00:00:00.000Z', tags: ['discord'],
    discord: { guildId: '777', channelId: '888', channelName: '雑談', messageId: '901', userId: '444', isDM: false, isVoiceChannel: false },
    ...fields,
  } as any;
}

describe('a Discord message in the one shape', () => {
  it('is the words, who, where and before whom; a file is said to be there, and its own follow-up stays here', () => {
    expect(converseTextTurn(envelope())).toEqual({
      version: 1, requestId: '901', observedAt: '2026-10-20T00:00:00.000Z', modality: 'text',
      where: { platform: 'discord', conversationId: 'discord:777:888', conversationKind: 'channel', title: '雑談' },
      who: { userId: '444', displayName: 'たろう' }, presence: { participants: ['444'] }, words: 'シャノン、おはよう',
    });
    expect(converseWords('見て\n画像: https://cdn.discordapp.com/attachments/1/2/a.png')).toBe('見て\n画像: （画像）');
    expect(converseWords('[追加要件への回答] はい')).toBeNull();
    expect(converseTextTurn(envelope({ discord: { messageId: '9', isDM: true, isVoiceChannel: false }, conversationId: 'discord::555' }))?.where)
      .toEqual({ platform: 'discord', conversationId: 'discord::555', conversationKind: 'dm' });
    expect(converseTextTurn(envelope({ discord: { messageId: '9', isVoiceChannel: true } }))).toBeNull();
  });

  it('reads the answer from the done line, an empty reply as nothing to say, and an error as no answer', () => {
    const lines = (...rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n');
    expect(converseAnswer(lines({ type: 'decision' }, { type: 'sentence', text: 'おはよう。' }, { type: 'done', reply: 'おはよう。', threadId: 't', duplicate: false })))
      .toEqual({ reply: 'おはよう。', threadId: 't', duplicate: false });
    expect(converseAnswer(lines({ type: 'done', reply: '', threadId: 't', silent: true }))?.reply).toBe('');
    expect(converseAnswer(lines({ type: 'decision' }, { type: 'error', status: 502 }))).toBeNull();
    expect(converseAnswer('')).toBeNull();
  });
});

describe('Discord text through the head (SHANNON_ONE_HEAD)', () => {
  it('sends a message nobody bound, from someone who is not the owner, and posts her answer', async () => {
    const head = await fakeHead(() => ({ status: 200, lines: [{ type: 'decision', respond: true }, { type: 'sentence', index: 0, text: 'おはよう！' },
      { type: 'done', reply: 'おはよう！', threadId: 'platform:discord:x', duplicate: false }] }));
    const bridge = createShannonCoreBridge({ url: head.url, token, timeoutMs: 3_000, bindingsJson: BINDINGS, oneHead: true, replyTimeoutMs: 5_000 })!;
    const reply = vi.fn(async () => ({ status: 'sent' as const, message: 'ok' }));
    const outcome = await answerDiscordFromCompanion(envelope(), { requestReply: value => bridge.requestDiscordReply(value), conversation: () => ({ reply }) });
    expect(outcome).toBe('answered');
    expect(reply).toHaveBeenCalledWith({ message: 'おはよう！' });
    expect(head.received[0]).toMatchObject({ path: '/v1/converse', body: { modality: 'text', who: { userId: '444' } } });
  });

  it('posts nothing when she had nothing to say, and leaves the message to this runtime only when the head cannot answer', async () => {
    const silent = await fakeHead(() => ({ status: 200, lines: [{ type: 'decision', respond: false }, { type: 'done', reply: '', silent: true }] }));
    const quiet = createShannonCoreBridge({ url: silent.url, token, timeoutMs: 3_000, bindingsJson: BINDINGS, oneHead: true })!;
    const reply = vi.fn(async () => ({ status: 'sent' as const, message: 'ok' }));
    expect(await answerDiscordFromCompanion(envelope(), { requestReply: value => quiet.requestDiscordReply(value), conversation: () => ({ reply }) })).toBe('answered');
    expect(reply).not.toHaveBeenCalled();
    for (const status of [403, 502, 503]) {
      const down = await fakeHead(() => ({ status, lines: [{ error: 'X' }] }));
      const bridge = createShannonCoreBridge({ url: down.url, token, timeoutMs: 3_000, bindingsJson: BINDINGS, oneHead: true })!;
      expect(await answerDiscordFromCompanion(envelope(), { requestReply: value => bridge.requestDiscordReply(value), conversation: () => ({ reply }) })).toBe('fallback');
    }
    const broken = await fakeHead(() => ({ status: 200, lines: [{ type: 'decision' }, { type: 'error', status: 502 }] }));
    const bridge = createShannonCoreBridge({ url: broken.url, token, timeoutMs: 3_000, bindingsJson: BINDINGS, oneHead: true })!;
    expect((await bridge.requestDiscordReply(envelope())).status).toBe('unavailable');
  });
});

describe('a voice-channel utterance through the head (SHANNON_ONE_HEAD)', () => {
  const request: VoiceTurnRequest = {
    requestId: 'req-1', conversationId: 'discord:777:888', voiceChannelId: '999', sourceUserId: '444', sourceDisplayName: 'たろう',
    userMessage: 'こんにちは', observedAt: '2026-10-20T10:00:00.000Z', participants: ['444', '333'], heard: [], followsShannonTurn: false,
    speakingNow: false, fillerId: 'un', sttMs: 420,
  };

  it('is the same utterance in the one shape', () => {
    expect(converseVoiceBody(request)).toEqual({
      version: 1, requestId: 'req-1', observedAt: '2026-10-20T10:00:00.000Z', modality: 'voice',
      where: { platform: 'discord', conversationId: 'discord:777:888', conversationKind: 'channel', voiceChannelId: '999' },
      who: { userId: '444', displayName: 'たろう' },
      presence: { participants: ['444', '333'], heard: [], followsShannonTurn: false, speakingNow: false },
      words: 'こんにちは', voice: { fillerId: 'un', sttMs: 420 },
    });
  });

  it('is sent for a channel nobody bound, to /v1/converse, and reads past her face', async () => {
    const urls: string[] = [];
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      urls.push(String(url));
      const body = [{ type: 'decision', respond: true, reason: 'solo', filler: null }, { type: 'expression', affect: 'joy' },
        { type: 'sentence', index: 0, text: 'こんにちは。' }, { type: 'done', reply: 'こんにちは。', threadId: 't', duplicate: false }]
        .map(line => JSON.stringify(line)).join('\n');
      return new Response(body, { status: 200 });
    });
    const client = createShannonCoreVoiceClient({ url: 'http://127.0.0.1:4319/v1/platform/turns', token, bindingsJson: BINDINGS, timeoutMs: 3_000, oneHead: true },
      fetcher as unknown as typeof fetch)!;
    expect(client.isBound('discord:777:888')).toBe(true);
    const open = await client.turn(request);
    expect(open.status).toBe('ok');
    if (open.status !== 'ok') return;
    const lines = [];
    for await (const line of open.lines) lines.push(line);
    expect(lines.map(line => line.type)).toEqual(['sentence', 'done']);
    expect(urls[0]).toBe('http://127.0.0.1:4319/v1/converse');
    const off = createShannonCoreVoiceClient({ url: 'http://127.0.0.1:4319/v1/platform/turns', token, bindingsJson: BINDINGS, timeoutMs: 3_000 })!;
    expect(off.isBound('discord:777:888')).toBe(false);
  });
});
