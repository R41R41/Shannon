import { describe, expect, it, vi } from 'vitest';
import { createShannonCoreBridge, ShannonCoreBridgeError } from '../../src/services/integration/shannonCoreBridge.js';

const token = 'a'.repeat(32);
const configuration = {
  url: 'http://127.0.0.1:4319/v1/platform/turns',
  token,
  bindingsJson: JSON.stringify([{
    platform: 'discord', conversationId: 'discord:111:222', ownerUserId: '333', title: 'Discord test',
  }]),
  timeoutMs: 3_000,
};

describe('Shannon canonical-core bridge', () => {
  it('is disabled by default and rejects partial, public-http, or short-token configuration', () => {
    expect(createShannonCoreBridge({ url: '', token: '', timeoutMs: 3_000 })).toBeNull();
    for (const candidate of [
      { ...configuration, token: '' },
      { ...configuration, bindingsJson: '' },
      { ...configuration, bindingsJson: 'not-json' },
      { ...configuration, token: 'short' },
      { ...configuration, url: 'http://example.com/v1/platform/turns' },
      { ...configuration, url: 'https://example.com/wrong' },
    ]) expect(() => createShannonCoreBridge(candidate)).toThrow(ShannonCoreBridgeError);
  });

  it('mirrors only bound conversations, and never another person without a display name', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 201 }));
    const bridge = createShannonCoreBridge(configuration, fetcher as typeof fetch)!;

    await bridge.mirrorDiscordTurn({ ...envelope(), sourceUserId: '444' }, '名前の分からない人への返信');
    await bridge.mirrorDiscordTurn({ ...envelope(), conversationId: 'discord:111:999' }, '別チャンネルへの返信');
    expect(fetcher).not.toHaveBeenCalled();

    await bridge.mirrorDiscordTurn(envelope(), '本人への返信');
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('mirrors another person in a bound conversation with their account, shown name and conversation kind', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 201 }));
    const bridge = createShannonCoreBridge(configuration, fetcher as typeof fetch)!;

    await bridge.mirrorDiscordTurn(friendEnvelope(), 'いいですね、楽しんできてください。');
    expect(fetcher).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      platform: 'discord', requestId: '901', conversationId: 'discord:111:222', sourceUserId: '444',
      userMessage: '私は辛いものが苦手', shannonReply: 'いいですね、楽しんできてください。',
      observedAt: '2026-09-17T10:00:00.000Z',
      conversationKind: 'channel', sourceDisplayName: 'ミキ', sourceKind: 'person',
    });

    // The envelope's display name wins; a Discord user name is the fallback; an over-long name is cut.
    await bridge.mirrorDiscordTurn({ ...friendEnvelope(), sourceDisplayName: 'みき', requestId: 'request-9' }, '返信');
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body)).sourceDisplayName).toBe('みき');
    await bridge.mirrorDiscordTurn({ ...friendEnvelope(), sourceDisplayName: 'あ'.repeat(200) }, '返信');
    expect(JSON.parse(String(fetcher.mock.calls[2]?.[1]?.body)).sourceDisplayName).toHaveLength(80);

    // An owner-authored turn keeps exactly today's body.
    await bridge.mirrorDiscordTurn({ ...envelope(), sourceDisplayName: 'ライ' }, '本人への返信');
    const ownerBody = JSON.parse(String(fetcher.mock.calls[3]?.[1]?.body));
    expect(Object.keys(ownerBody).sort()).toEqual([
      'conversationId', 'observedAt', 'platform', 'requestId', 'shannonReply', 'sourceUserId', 'userMessage',
    ]);
  });

  it('marks a direct message as a dm when that conversation is bound', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 201 }));
    const bridge = createShannonCoreBridge({
      ...configuration,
      bindingsJson: JSON.stringify([{ platform: 'discord', conversationId: 'discord:dm:444', ownerUserId: '333' }]),
    }, fetcher as typeof fetch)!;
    await bridge.mirrorDiscordTurn({
      ...friendEnvelope(), conversationId: 'discord:dm:444', discord: { ...friendEnvelope().discord, isDM: true },
    }, '返信');
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).conversationKind).toBe('dm');
  });

  it('never fails the Discord turn when the core declines to remember another person', async () => {
    for (const status of [403, 409, 429]) {
      const declined = createShannonCoreBridge(configuration, vi.fn(async () => new Response('secret', { status })) as typeof fetch)!;
      await expect(declined.mirrorDiscordTurn(friendEnvelope(), '返信')).resolves.toBeUndefined();
    }
    const broken = createShannonCoreBridge(configuration, vi.fn(async () => new Response('secret', { status: 500 })) as typeof fetch)!;
    await expect(broken.mirrorDiscordTurn(friendEnvelope(), '返信')).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
  });

  it('supports one exact-owner binding across every channel in a configured Discord guild', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 201 }));
    const bridge = createShannonCoreBridge({
      ...configuration,
      bindingsJson: JSON.stringify([{
        platform: 'discord', conversationIdPrefix: 'discord:111:', ownerUserId: '333', title: 'Discord community',
      }]),
    }, fetcher as typeof fetch)!;

    await bridge.mirrorDiscordTurn(envelope(), '最初のチャンネル');
    await bridge.mirrorDiscordTurn({ ...envelope(), requestId: 'request-2', conversationId: 'discord:111:999', discord: {
      ...envelope().discord, channelId: '999', messageId: '901',
    } }, '次のチャンネル');
    await bridge.mirrorDiscordTurn({ ...envelope(), requestId: 'request-3', conversationId: 'discord:112:222', discord: {
      ...envelope().discord, guildId: '112', messageId: '902',
    } }, '別ギルド');
    await bridge.mirrorDiscordTurn({ ...envelope(), requestId: 'request-4', conversationId: 'discord:111:not-a-channel', discord: {
      ...envelope().discord, channelId: 'not-a-channel', messageId: '903',
    } }, '不正なチャンネル');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('reads a bounded projection from the sibling context route, naming another person as a participant', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      schemaVersion: 1,
      stateVersion: 7,
      updatedAt: '2026-09-17T10:00:00.000Z',
      projection: '[Shannon shared state v7]\n今日の関心: 分散システム',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const bridge = createShannonCoreBridge(configuration, fetcher as typeof fetch)!;

    const owner = await bridge.readDiscordContext(envelope());
    expect(owner).toEqual({
      status: 'available', stateVersion: 7, updatedAt: '2026-09-17T10:00:00.000Z',
      projection: '[Shannon shared state v7]\n今日の関心: 分散システム',
    });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[0]).toBe('http://127.0.0.1:4319/v1/platform/context');
    const requestBody = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(requestBody).toEqual({ platform: 'discord', conversationId: 'discord:111:222', sourceUserId: '333' });

    const friend = await bridge.readDiscordContext(friendEnvelope());
    expect(friend.status).toBe('available');
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({
      platform: 'discord', conversationId: 'discord:111:222', sourceUserId: '444',
      conversationKind: 'channel', participants: ['444'],
    });

    expect(await bridge.readDiscordContext({ ...friendEnvelope(), conversationId: 'discord:111:999' })).toEqual({ status: 'ineligible' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('falls back without throwing when the canonical context is unavailable or malformed', async () => {
    const unavailable = createShannonCoreBridge(configuration, vi.fn(async () => {
      throw new Error('network detail');
    }) as typeof fetch)!;
    expect(await unavailable.readDiscordContext(envelope())).toEqual({ status: 'unavailable' });

    const malformed = createShannonCoreBridge(configuration, vi.fn(async () => new Response(JSON.stringify({
      schemaVersion: 1, stateVersion: 2, updatedAt: 'invalid', projection: 'secret',
    }), { status: 200 })) as typeof fetch)!;
    expect(await malformed.readDiscordContext(envelope())).toEqual({ status: 'unavailable' });
  });

  it('posts a bounded completed Discord turn with the dedicated bearer token', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 201 }));
    const bridge = createShannonCoreBridge(configuration, fetcher as typeof fetch);
    await bridge?.mirrorDiscordTurn(envelope(), '覚えておくね。');

    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(configuration.url);
    expect(init).toMatchObject({
      method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      platform: 'discord', requestId: '900', conversationId: 'discord:111:222', sourceUserId: '333',
      userMessage: '僕はうなぎが好き', shannonReply: '覚えておくね。', observedAt: '2026-09-17T10:00:00.000Z',
    });
  });

  it('never sends malformed, voice, empty, or oversized turns', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 201 }));
    const bridge = createShannonCoreBridge(configuration, fetcher as typeof fetch)!;
    await expect(bridge.mirrorDiscordTurn({ ...envelope(), channel: 'web' } as any, 'reply')).rejects.toMatchObject({ code: 'REQUEST_INVALID' });
    await expect(bridge.mirrorDiscordTurn({ ...envelope(), discord: { ...envelope().discord, isVoiceChannel: true } } as any, 'reply')).rejects.toMatchObject({ code: 'REQUEST_INVALID' });
    await expect(bridge.mirrorDiscordTurn(envelope(), ' '.repeat(4))).rejects.toMatchObject({ code: 'REQUEST_INVALID' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('returns only a safe error code for network and non-success responses', async () => {
    const network = createShannonCoreBridge(configuration, vi.fn(async () => { throw new Error('secret URL detail'); }) as typeof fetch)!;
    await expect(network.mirrorDiscordTurn(envelope(), 'reply')).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
    const rejected = createShannonCoreBridge(configuration, vi.fn(async () => new Response('secret', { status: 403 })) as typeof fetch)!;
    await expect(rejected.mirrorDiscordTurn(envelope(), 'reply')).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
  });
});

function friendEnvelope() {
  return {
    ...envelope(), sourceUserId: '444', text: '私は辛いものが苦手',
    discord: { ...envelope().discord, messageId: '901', userId: '444', userName: 'ミキ' },
  } as any;
}

function envelope() {
  return {
    channel: 'discord', requestId: 'request-1', conversationId: 'discord:111:222', sourceUserId: '333',
    text: '僕はうなぎが好き', timestampIso: '2026-09-17T10:00:00.000Z', tags: ['discord'],
    discord: { guildId: '111', channelId: '222', messageId: '900', isDM: false, isVoiceChannel: false },
  } as any;
}
