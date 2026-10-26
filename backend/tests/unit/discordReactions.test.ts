import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { answerDiscordFromCompanion } from '../../src/services/integration/discordCompanionReply.js';
import { createShannonCoreBridge } from '../../src/services/integration/shannonCoreBridge.js';
import { converseAnswer, converseReaction, converseReactionBody, type DiscordReactionInput } from '../../src/services/integration/oneHeadConverse.js';
import { reactionInput, type ReactionRelayOptions } from '../../src/services/discord/reactionRelay.js';

/**
 * Emoji reactions (the head's rich chat §4, owner request 2026-10-26): her reaction from the head's answer becomes a real one on the message
 * she answered, and anyone's reaction on a message the bot reads goes to the head (`POST /v1/platform/reactions`).
 */
const token = 'c'.repeat(40);
const servers: Array<ReturnType<typeof createServer>> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

async function fakeHead(answer: (path: string, body: Record<string, unknown>) => { status: number; text: string }) {
  const received: Array<{ path: string; authorization?: string; body: Record<string, unknown> }> = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(chunk as Buffer));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
      received.push({ path: request.url ?? '', authorization: request.headers.authorization, body });
      const result = answer(request.url ?? '', body);
      response.writeHead(result.status, { 'content-type': 'application/json' });
      response.end(result.text);
    });
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing test port');
  return { url: `http://127.0.0.1:${address.port}/v1/platform/turns`, received };
}

const BINDINGS = JSON.stringify([{ platform: 'discord', conversationIdPrefix: 'discord:111:', ownerUserId: '333' }]);

function envelope() {
  return {
    channel: 'discord', requestId: 'request-1', conversationId: 'discord:777:888', sourceUserId: '444', sourceDisplayName: 'たろう',
    text: '今日ケーキ焼いた', timestampIso: '2026-10-26T00:00:00.000Z', tags: ['discord'],
    discord: { guildId: '777', channelId: '888', channelName: '雑談', messageId: '901', userId: '444', isDM: false, isVoiceChannel: false },
  } as any;
}

function input(fields: Partial<DiscordReactionInput> = {}): DiscordReactionInput {
  return {
    guildId: '777', channelId: '888', messageId: '902', authorId: '999', authorIsShannon: true, content: 'ケーキいいですね！',
    actorId: '444', actorName: 'たろう', emoji: { name: '😂', id: null }, on: true, at: new Date('2026-10-26T00:01:00.000Z'), ...fields,
  };
}

describe('her reaction from the head', () => {
  it('is read from the done line as one short emoji; anything else is none', () => {
    expect(converseAnswer(JSON.stringify({ type: 'done', reply: 'おいしそう！', threadId: 't', duplicate: false, reaction: '🎂' })))
      .toEqual({ reply: 'おいしそう！', threadId: 't', duplicate: false, reaction: '🎂' });
    expect(converseAnswer(JSON.stringify({ type: 'done', reply: 'うん', threadId: 't', duplicate: false }))).not.toHaveProperty('reaction');
    for (const bad of [42, '', '<:x:1>', '@everyone', 'a b', 'x'.repeat(40)]) expect(converseReaction(bad)).toBeNull();
  });

  it('is put on the message she answered, after her reply is posted, through the request-bound conversation', async () => {
    const head = await fakeHead(() => ({ status: 200, text: [
      { type: 'decision', respond: true }, { type: 'sentence', index: 0, text: 'おいしそう！' },
      { type: 'done', reply: 'おいしそう！', threadId: 'platform:discord:x', duplicate: false, reaction: '🎂' },
    ].map(line => JSON.stringify(line)).join('\n') }));
    const bridge = createShannonCoreBridge({ url: head.url, token, timeoutMs: 3_000, bindingsJson: BINDINGS, oneHead: true, replyTimeoutMs: 5_000 })!;
    const order: string[] = [];
    const reply = vi.fn(async () => { order.push('reply'); return { status: 'sent' as const, message: 'ok' }; });
    const react = vi.fn(async () => { order.push('react'); return { status: 'sent' as const, message: 'ok' }; });
    const outcome = await answerDiscordFromCompanion(envelope(), { requestReply: value => bridge.requestDiscordReply(value), conversation: () => ({ reply, react }) });
    expect(outcome).toBe('answered');
    expect(react).toHaveBeenCalledWith({ emojiId: '🎂' });
    expect(order).toEqual(['reply', 'react']);
  });

  it('is not added when her reply could not be posted, and a failed reaction leaves the answer answered', async () => {
    const requestReply = async () => ({ status: 'available' as const, reply: 'うん', threadId: 't', duplicate: false, reaction: '👍' });
    const react = vi.fn(async () => ({ status: 'denied' as const, message: 'no' }));
    expect(await answerDiscordFromCompanion(envelope(), { requestReply,
      conversation: () => ({ reply: async () => ({ status: 'unknown' as const, message: 'x' }), react }) })).toBe('send_failed');
    expect(react).not.toHaveBeenCalled();
    expect(await answerDiscordFromCompanion(envelope(), { requestReply,
      conversation: () => ({ reply: async () => ({ status: 'sent' as const, message: 'ok' }), react }) })).toBe('answered');
    expect(react).toHaveBeenCalledOnce();
  });
});

describe('a reaction to the head', () => {
  it('is the conversation, the message and its words, who wrote it, who reacted and with what', () => {
    expect(converseReactionBody(input())).toEqual({
      version: 1, platform: 'discord', conversationId: 'discord:777:888', messageId: '902',
      author: { userId: '999', shannon: true }, excerpt: 'ケーキいいですね！', actor: { userId: '444', displayName: 'たろう' },
      emoji: '😂', on: true, observedAt: '2026-10-26T00:01:00.000Z',
    });
    expect(converseReactionBody(input({ emoji: { name: 'party_parrot', id: '1234' }, on: false }))).toMatchObject({ emoji: ':party_parrot:', on: false });
    expect(converseReactionBody(input({ content: 'これ https://cdn.discordapp.com/attachments/1/2/a.png' }))?.excerpt).toBe('これ （画像）');
    expect(converseReactionBody(input({ guildId: null }))).toBeNull();
    expect(converseReactionBody(input({ emoji: { name: null, id: '1' } }))).toBeNull();
  });

  it('goes to POST /v1/platform/reactions with the service token, only with one head on, and never throws', async () => {
    const head = await fakeHead(() => ({ status: 202, text: JSON.stringify({ recorded: true }) }));
    const bridge = createShannonCoreBridge({ url: head.url, token, timeoutMs: 3_000, bindingsJson: BINDINGS, oneHead: true })!;
    expect(await bridge.sendDiscordReaction(input())).toBe('sent');
    expect(head.received[0]).toMatchObject({ path: '/v1/platform/reactions', authorization: `Bearer ${token}`, body: { messageId: '902', emoji: '😂' } });
    const off = createShannonCoreBridge({ url: head.url, token, timeoutMs: 3_000, bindingsJson: BINDINGS, replyEnabled: true })!;
    expect(await off.sendDiscordReaction(input())).toBe('ineligible');
    const older = await fakeHead(() => ({ status: 404, text: '{}' }));
    const oldBridge = createShannonCoreBridge({ url: older.url, token, timeoutMs: 3_000, bindingsJson: BINDINGS, oneHead: true })!;
    expect(await oldBridge.sendDiscordReaction(input())).toBe('unavailable');
    expect(head.received).toHaveLength(1);
  });
});

describe('the relay of Discord reaction events', () => {
  const her = { id: '999' };
  const options = (fields: Partial<ReactionRelayOptions> = {}): ReactionRelayOptions => ({
    isRunning: () => true, skipGuild: () => false, accepts: () => true, nickname: user => `nick:${user.id}`,
    send: async () => undefined, now: () => new Date('2026-10-26T00:01:00.000Z'), ...fields,
  });
  const message = (fields: Record<string, unknown> = {}) => ({
    partial: false, id: '902', guildId: '777', channelId: '888', content: 'ケーキいいですね！', author: { id: '999' }, ...fields,
  });
  const reaction = (fields: Record<string, unknown> = {}) => ({ emoji: { name: '😂', id: null }, message: message(), ...fields }) as any;
  const user = (fields: Record<string, unknown> = {}) => ({ id: '444', bot: false, partial: false, ...fields }) as any;

  it('reads someone\'s reaction on her message, fetching a partial message first', async () => {
    const fetched = message({ id: '903' });
    const partial = reaction({ message: { partial: true, fetch: async () => fetched } });
    expect(await reactionInput({ user: her } as any, options(), partial, user(), true)).toMatchObject({
      messageId: '903', authorIsShannon: true, actorId: '444', actorName: 'nick:444', emoji: { name: '😂', id: null }, on: true,
    });
  });

  it('sends nothing for her own reaction, another bot\'s, a place the bot does not read, or while stopped', async () => {
    const accepts = vi.fn(() => true);
    expect(await reactionInput({ user: her } as any, options({ accepts }), reaction(), user({ id: '999' }), true)).toBeNull();
    expect(await reactionInput({ user: her } as any, options(), reaction(), user({ bot: true }), true)).toBeNull();
    expect(await reactionInput({ user: her } as any, options({ accepts: () => false }), reaction(), user(), true)).toBeNull();
    expect(await reactionInput({ user: her } as any, options({ skipGuild: () => true }), reaction(), user(), true)).toBeNull();
    expect(await reactionInput({ user: her } as any, options({ isRunning: () => false }), reaction(), user(), true)).toBeNull();
    expect(accepts).not.toHaveBeenCalled();
  });

  it('tells the place rule whether the message was hers, and names another author by nickname', async () => {
    const accepts = vi.fn(() => true);
    const result = await reactionInput({ user: her } as any, options({ accepts }), reaction({ message: message({ author: { id: '555' } }) }), user(), false);
    expect(accepts).toHaveBeenCalledWith({ guildId: '777', channelId: '888', onHerMessage: false });
    expect(result).toMatchObject({ authorId: '555', authorName: 'nick:555', authorIsShannon: false, on: false });
  });
});
