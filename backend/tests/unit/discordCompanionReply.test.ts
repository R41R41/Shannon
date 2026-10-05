import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { answerDiscordFromCompanion } from '../../src/services/integration/discordCompanionReply.js';
import { createShannonCoreBridge } from '../../src/services/integration/shannonCoreBridge.js';

const token = 'c'.repeat(40);
const servers: Array<ReturnType<typeof createServer>> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

/** A fake companion on loopback: answers /v1/platform/reply as the contract says, and records what it was sent. */
async function fakeCompanion(answer: (body: Record<string, unknown>) => { status: number; body: unknown }) {
  const received: Array<{ path: string; authorization?: string; body: Record<string, unknown> }> = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(chunk as Buffer));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
      received.push({ path: request.url ?? '', authorization: request.headers.authorization, body });
      const result = answer(body);
      response.writeHead(result.status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(result.body));
    });
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing test port');
  return { url: `http://127.0.0.1:${address.port}/v1/platform/turns`, received };
}

function bridgeFor(url: string, extra: Record<string, unknown> = {}) {
  return createShannonCoreBridge({
    url, token, timeoutMs: 3_000, replyEnabled: true, replyTimeoutMs: 5_000,
    bindingsJson: JSON.stringify([
      { platform: 'discord', conversationId: 'discord::555', ownerUserId: '333', title: 'ライ氏とのDM' },
      { platform: 'discord', conversationIdPrefix: 'discord:111:', ownerUserId: '333', title: 'テストサーバー' },
    ]),
    ...extra,
  })!;
}

function envelope(fields: Record<string, unknown> = {}) {
  return {
    channel: 'discord', requestId: 'request-1', conversationId: 'discord::555', sourceUserId: '333', sourceDisplayName: 'ライ',
    text: 'マイクラで木材集めといて', timestampIso: '2026-10-06T00:00:00.000Z', tags: ['discord', 'dm'],
    discord: { guildId: '', channelId: '555', messageId: '901', userId: '333', isDM: true, isVoiceChannel: false },
    ...fields,
  } as any;
}

describe('Discord text answered by the companion (SHANNON_CORE_PLATFORM_REPLY)', () => {
  it('sends the owner\'s DM to the companion, posts her reply in the same conversation, and does not mirror it again', async () => {
    const companion = await fakeCompanion(() => ({ status: 201, body: {
      reply: '任せてください、マイクラの体に頼んでおきました。', threadId: 'platform:discord:0123456789abcdef0123456789abcdef', duplicate: false,
    } }));
    const bridge = bridgeFor(companion.url);
    const reply = vi.fn(async () => ({ status: 'sent' as const, message: 'ok' }));
    const outcome = await answerDiscordFromCompanion(envelope(), {
      requestReply: value => bridge.requestDiscordReply(value), conversation: () => ({ reply }),
    });
    expect(outcome).toBe('answered');
    expect(reply).toHaveBeenCalledWith({ message: '任せてください、マイクラの体に頼んでおきました。' });
    expect(companion.received).toEqual([{
      path: '/v1/platform/reply', authorization: `Bearer ${token}`,
      body: { platform: 'discord', requestId: '901', conversationId: 'discord::555', conversationKind: 'dm', sourceUserId: '333',
        userMessage: 'マイクラで木材集めといて', observedAt: '2026-10-06T00:00:00.000Z' },
    }]);
  });

  it('falls back to the legacy path, sending nothing, when the companion fails or refuses', async () => {
    for (const status of [403, 409, 429, 502, 503]) {
      const companion = await fakeCompanion(() => ({ status, body: { error: 'X' } }));
      const bridge = bridgeFor(companion.url);
      const reply = vi.fn(async () => ({ status: 'sent' as const, message: 'ok' }));
      expect(await answerDiscordFromCompanion(envelope(), { requestReply: value => bridge.requestDiscordReply(value), conversation: () => ({ reply }) })).toBe('fallback');
      expect(reply).not.toHaveBeenCalled();
    }
    // Nobody listening on the port at all.
    const closed = bridgeFor('http://127.0.0.1:9/v1/platform/turns');
    expect(await answerDiscordFromCompanion(envelope(), { requestReply: value => closed.requestDiscordReply(value), conversation: () => ({ reply: vi.fn() }) })).toBe('fallback');
    // A dependency that throws is a fallback too.
    expect(await answerDiscordFromCompanion(envelope(), { requestReply: async () => { throw new Error('x'); }, conversation: () => ({ reply: vi.fn() }) })).toBe('fallback');
  });

  it('never sends an unbound conversation or a friend, and keeps the legacy path when switched off', async () => {
    const companion = await fakeCompanion(() => ({ status: 201, body: { reply: 'x', threadId: 't', duplicate: false } }));
    const reply = vi.fn(async () => ({ status: 'sent' as const, message: 'ok' }));
    const on = bridgeFor(companion.url);
    const off = bridgeFor(companion.url, { replyEnabled: false });
    const run = (bridge: ReturnType<typeof bridgeFor>, value: unknown) =>
      answerDiscordFromCompanion(value as any, { requestReply: item => bridge.requestDiscordReply(item), conversation: () => ({ reply }) });
    expect(await run(on, envelope({ conversationId: 'discord:999:1', discord: { guildId: '999', channelId: '1', messageId: '902', isDM: false } }))).toBe('fallback');
    expect(await run(on, envelope({ sourceUserId: 'friend', sourceDisplayName: 'ミキ' }))).toBe('fallback');
    expect(await run(off, envelope())).toBe('fallback');
    expect(companion.received).toEqual([]);
    expect(reply).not.toHaveBeenCalled();
  });

  it('does not answer twice when sending her reply fails', async () => {
    const companion = await fakeCompanion(() => ({ status: 201, body: { reply: 'はい。', threadId: 't', duplicate: false } }));
    const bridge = bridgeFor(companion.url);
    const reply = vi.fn(async () => ({ status: 'unknown' as const, message: 'x' }));
    expect(await answerDiscordFromCompanion(envelope(), { requestReply: value => bridge.requestDiscordReply(value), conversation: () => ({ reply }) })).toBe('send_failed');
  });
});
