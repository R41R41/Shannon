import { beforeEach, describe, expect, it, vi } from 'vitest';
const legacy = vi.hoisted(() => ({ getRecentMessages: vi.fn(async () => [{ content: 'other channel private text' }]) }));
vi.mock('../../src/services/discord/client.js', () => ({ DiscordBot: { getInstance: () => ({ getRecentMessages: legacy.getRecentMessages }) } }));
vi.mock('../../src/utils/logger.js', () => ({ logger: { error: vi.fn(), warn: vi.fn() }, createLogger: () => ({ warn: vi.fn() }) }));
import ChatOnDiscordTool from '../../src/services/llm/tools/discord/chatOnDiscord.js';
import GetDiscordRecentMessagesTool from '../../src/services/llm/tools/discord/getDiscordRecentMessages.js';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { bindDiscordConversation, hasDiscordConversation, ConversationDeniedError, type DiscordConversationRequest } from '../../src/modules/conversation/discordConversation.js';
import { createRequestDiscordConversation, registerDiscordConversationTransport, bindRequestDiscordConversation } from '../../src/services/common/discordConversationPort.js';
import { createDiscordConversationTransport } from '../../src/services/discord/conversationTransport.js';
import { RunToolRegistry } from '../../src/modules/execution/runToolRegistry.js';
import { discordDispatcher } from '../../src/services/common/adapters/discordDispatcher.js';
import { EventRouter } from '../../src/services/llm/routing/EventRouter.js';

const registered = { reply: vi.fn(async () => undefined), recent: vi.fn(async () => []) };
registerDiscordConversationTransport(registered);
function request(): DiscordConversationRequest {
  return { channel: 'discord', requestId: 'request-1', conversationId: 'discord:111:222', sourceUserId: '333',
    discord: { guildId: '111', channelId: '222', messageId: '900', isDM: false, isVoiceChannel: false } };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function sdk() {
  let running = true;
  const actorDenied = new Set<bigint>(), botDenied = new Set<bigint>();
  const actor = { has: (bit: bigint) => !actorDenied.has(bit) }, bot = { has: (bit: bigint) => !botDenied.has(bit) };
  const channel = { id: '222', guildId: '111' as string | undefined, type: ChannelType.GuildText,
    recipientId: undefined as string | undefined, isTextBased: () => true, isThread: () => false,
    permissionsFor: vi.fn((id: unknown) => typeof id === 'string' ? actor : bot),
    send: vi.fn(async (_data: unknown) => undefined), messages: { fetch: vi.fn(async (_query: unknown) => new Map<string, any>()) } };
  const client = { user: { id: '999' }, channels: { cache: new Map([['222', channel]]) } };
  const transport = createDiscordConversationTransport(client as any, () => running);
  return { channel, client, transport, actorDenied, botDenied, stop: () => { running = false; } };
}

beforeEach(() => { vi.clearAllMocks(); registered.reply.mockResolvedValue(undefined); registered.recent.mockResolvedValue([]); });
describe('Discord tools require a request-bound destination', () => {
  it('does not send to a model-selected channel without a bound request', async () => {
    await new ChatOnDiscordTool()._call({ guildId: '111', channelId: '222', message: 'not authorized' });
    expect(registered.reply).not.toHaveBeenCalled();
  });
  it('does not read model-selected history without a bound request', async () => {
    await new GetDiscordRecentMessagesTool()._call({ channelId: '222', limit: 10 });
    expect(legacy.getRecentMessages).not.toHaveBeenCalled();
  });
});

describe('Discord request scope and tool ownership', () => {
  it('fails closed on malformed runtime identity fields', () => {
    expect(bindDiscordConversation({ ...request(), requestId: 42 } as any)).toBeUndefined();
    expect(bindDiscordConversation({ ...request(), discord: { ...request().discord, isDM: 'true' } } as any)).toBeUndefined();
  });
  it('keeps display names and generated timestamps out of canonical user text', async () => {
    const invokeGraph = vi.fn(async () => ({}));
    const router = new EventRouter({ invokeGraph, realtimeApi: {}, agentOrchestrator: {}, voiceProcessor: {}, isDevMode: true } as any);
    await (router as any).processDiscordMessage({ type: 'text', text: 'my actual words', userName: 'not user text', userId: '333', guildId: '', guildName: '', channelId: '222', channelName: 'DM', messageId: '900', isDM: true, recentMessages: [] });
    expect(invokeGraph.mock.calls[0][0]).toMatchObject({ text: 'my actual words', discord: { isDM: true, channelId: '222' } });
  });
  it.each(['web', 'minecraft', 'internal'])('rejects %s before transport', async channel => {
    const r = request(); r.channel = channel;
    const port = createRequestDiscordConversation(r);
    expect((await port.reply({ message: 'secret' })).status).toBe('denied');
    await expect(port.recent()).rejects.toThrow(); expect(registered.reply).not.toHaveBeenCalled(); expect(registered.recent).not.toHaveBeenCalled();
  });
  it.each(['subject', 'guild', 'channel', 'message', 'request', 'conversation', 'voice'])('rejects missing/unsupported %s', async field => {
    const r = request();
    if (field === 'subject') r.sourceUserId = '';
    if (field === 'request') r.requestId = '';
    if (field === 'conversation') r.conversationId = '';
    if (field === 'guild') r.discord!.guildId = '';
    if (field === 'channel') r.discord!.channelId = '';
    if (field === 'message') r.discord!.messageId = '';
    if (field === 'voice') r.discord!.isVoiceChannel = true;
    expect(bindDiscordConversation(r)).toBeUndefined();
  });
  it('snapshots the source instead of reading a mutated envelope', async () => {
    const r = request(), port = createRequestDiscordConversation(r);
    r.discord!.channelId = '444'; r.sourceUserId = '555';
    expect((await port.reply({ message: 'hello' })).status).toBe('sent');
    expect(registered.reply.mock.calls[0][0]).toMatchObject({ channelId: '222', subjectId: '333' });
  });
  it.each([{ channelId: '444' }, { guildId: '444' }, { channelId: '' }, { guildId: '' }])('rejects a destination override %j', async target => {
    const port = createRequestDiscordConversation(request());
    expect((await port.reply({ message: 'private', ...target })).status).toBe('denied');
    expect(registered.reply).not.toHaveBeenCalled();
  });
  it('rejects an arbitrary history channel before I/O', async () => {
    await expect(createRequestDiscordConversation(request()).recent({ channelId: '444' })).rejects.toThrow();
    expect(registered.recent).not.toHaveBeenCalled();
  });
  it.each([0, -1, 31, 1.5, NaN, Infinity])('rejects invalid history limit %s', async limit => {
    await expect(createRequestDiscordConversation(request()).recent({ limit })).rejects.toThrow();
    expect(registered.recent).not.toHaveBeenCalled();
  });
  it.each(['/etc/passwd', '../backend/.env', 'https://example.com/image.png'])('refuses attachments %s', async imageUrl => {
    expect((await createRequestDiscordConversation(request()).reply({ message: 'hello', imageUrl })).status).toBe('denied');
    expect(registered.reply).not.toHaveBeenCalled();
  });
  it('rejects empty and excessive content', async () => {
    const p = createRequestDiscordConversation(request());
    for (const message of ['', '   ', 'a'.repeat(12001)]) expect((await p.reply({ message })).status).toBe('denied');
    expect(registered.reply).not.toHaveBeenCalled();
  });
  it('does not acknowledge delivery until the adapter finishes', async () => {
    const d = deferred<void>(); registered.reply.mockReturnValueOnce(d.promise);
    let done = false; const response = createRequestDiscordConversation(request()).reply({ message: 'hello' }).then(x => { done = true; return x; });
    await Promise.resolve(); expect(done).toBe(false); d.resolve(); expect((await response).status).toBe('sent');
  });
  it('reports uncertain delivery without exposing SDK errors or retrying', async () => {
    registered.reply.mockRejectedValueOnce(new Error('secret credential'));
    const result = await createRequestDiscordConversation(request()).reply({ message: 'hello' });
    expect(result.status).toBe('unknown'); expect(result.message).not.toContain('secret'); expect(registered.reply).toHaveBeenCalledOnce();
  });
  it('cancellation denies new I/O and discards a late history result', async () => {
    const c = new AbortController(), d = deferred<any>(); registered.recent.mockReturnValueOnce(d.promise);
    const port = createRequestDiscordConversation(request(), c.signal), pending = port.recent();
    c.abort(); d.resolve([{ text: 'late private text' }]); await expect(pending).rejects.toThrow();
    expect((await port.reply({ message: 'late' })).status).toBe('denied'); expect(registered.reply).not.toHaveBeenCalled();
  });
  it('creates fresh tools per run and never inherits a catalog port', async () => {
    const chat = new ChatOnDiscordTool(), history = new GetDiscordRecentMessagesTool();
    chat.setDiscordConversationPort(createRequestDiscordConversation(request()));
    const registry = new RunToolRegistry<any>([chat, history]);
    const a = registry.createTools(), b = registry.createTools();
    const rb = request(); rb.discord!.channelId = '444'; rb.requestId = 'request-2';
    bindRequestDiscordConversation(a, request()); bindRequestDiscordConversation(b, rb);
    await a[0]._call({ message: 'A', memoryZone: 'forged' }); await b[0]._call({ message: 'B' });
    expect(registered.reply.mock.calls.map(x => x[0].channelId)).toEqual(['222', '444']);
    await registry.createTools()[0]._call({ message: 'unbound' }); expect(registered.reply).toHaveBeenCalledTimes(2);
    expect(() => new RunToolRegistry([{ name: 'bad', setDiscordConversationPort() {} }])).toThrow('createForRun');
  });
  it('retains real Zod validation through LangChain invoke despite narrowing its schema generic', async () => {
    const chat = new ChatOnDiscordTool(), history = new GetDiscordRecentMessagesTool();
    bindRequestDiscordConversation([chat, history], request());
    await expect(chat.invoke({ message: '' })).rejects.toThrow();
    await expect(history.invoke({ limit: 0 })).rejects.toThrow();
    expect(registered.reply).not.toHaveBeenCalled(); expect(registered.recent).not.toHaveBeenCalled();
    expect(await chat.invoke({ message: 'valid' })).toContain('送信完了');
    expect(await history.invoke({ limit: 1 })).toContain('unverified_conversation_history');
  });
  it('routes structured text replies through the same port, never the legacy voice bus', async () => {
    await discordDispatcher.dispatch(request() as any, { message: 'answer' } as any);
    expect(registered.reply.mock.calls[0][0]).toMatchObject({ channelId: '222' }); expect(registered.reply.mock.calls).toHaveLength(1);
    registered.reply.mockRejectedValueOnce(new Error('network unknown'));
    await expect(discordDispatcher.dispatch(request() as any, { message: 'answer' } as any)).rejects.toThrow('配信結果');
  });
  it('prevalidates all action kinds before sending anything', async () => {
    await expect(discordDispatcher.dispatch(request() as any, { discordActions: [{ type: 'reply', text: 'first' }, { type: 'voice_speak', text: 'second' }] } as any)).rejects.toThrow();
    expect(registered.reply).not.toHaveBeenCalled();
  });
  it('rejects a cross-platform plan and malformed voice flags without using the legacy bus', async () => {
    await expect(discordDispatcher.dispatch(request() as any, { channel: 'web', message: 'wrong route' })).rejects.toThrow();
    const r = request(); (r.discord as any).isVoiceChannel = 'true';
    await expect(discordDispatcher.dispatch(r as any, { channel: 'discord', message: 'wrong route' })).rejects.toThrow();
    expect(registered.reply).not.toHaveBeenCalled(); expect(registered.reply).not.toHaveBeenCalled();
  });
});

describe('Real Discord SDK adapter with a fake client', () => {
  it('refuses copied or fabricated bindings even when called directly', async () => {
    const f = sdk(), binding = bindDiscordConversation(request())!;
    expect(hasDiscordConversation({ ...binding })).toBe(false);
    await expect(f.transport.reply({ ...binding }, 'private')).rejects.toBeInstanceOf(ConversationDeniedError);
    expect(f.channel.send).not.toHaveBeenCalled();
  });
  it.each(['wrong-guild', 'wrong-channel', 'missing-channel', 'not-running', 'actor-view', 'bot-view', 'bot-send'])('denies %s at the SDK boundary', async fault => {
    const f = sdk();
    if (fault === 'wrong-guild') f.channel.guildId = '444';
    if (fault === 'wrong-channel') f.channel.id = '444';
    if (fault === 'missing-channel') f.client.channels.cache.clear();
    if (fault === 'not-running') f.stop();
    if (fault === 'actor-view') f.actorDenied.add(PermissionFlagsBits.ViewChannel);
    if (fault === 'bot-view') f.botDenied.add(PermissionFlagsBits.ViewChannel);
    if (fault === 'bot-send') f.botDenied.add(PermissionFlagsBits.SendMessages);
    expect((await createRequestDiscordConversation(request(), undefined, f.transport).reply({ message: 'private' })).status).toBe('denied');
    expect(f.channel.send).not.toHaveBeenCalled();
  });
  it('splits text, disables mentions and does not attach local files', async () => {
    const f = sdk();
    expect((await createRequestDiscordConversation(request(), undefined, f.transport).reply({ message: '@everyone' + 'x'.repeat(2000) })).status).toBe('sent');
    expect(f.channel.send).toHaveBeenCalledTimes(2);
    for (const [payload] of f.channel.send.mock.calls) expect(payload).toMatchObject({ allowedMentions: { parse: [], repliedUser: false } });
  });
  it('stops after a partial send if permissions/liveness change, returning uncertainty', async () => {
    const f = sdk(); f.channel.send.mockImplementationOnce(async () => { f.stop(); });
    const result = await createRequestDiscordConversation(request(), undefined, f.transport).reply({ message: 'x'.repeat(2100) });
    expect(result.status).toBe('unknown'); expect(f.channel.send).toHaveBeenCalledOnce();
  });
  it('uses exact DM recipient, never guild permissions for private conversations', async () => {
    const f = sdk(), r = request(); r.discord = { channelId: '222', messageId: '900', isDM: true };
    f.channel.type = ChannelType.DM; f.channel.guildId = undefined; f.channel.recipientId = '333';
    const port = createRequestDiscordConversation(r, undefined, f.transport);
    expect((await port.reply({ message: 'private' })).status).toBe('sent');
    f.channel.recipientId = '444'; expect((await port.reply({ message: 'private' })).status).toBe('denied');
    expect(f.channel.permissionsFor).not.toHaveBeenCalled(); expect(f.channel.send).toHaveBeenCalledOnce();
  });
  it('checks thread send permission without falling back to parent channel', async () => {
    const f = sdk(); f.channel.isThread = () => true; f.botDenied.add(PermissionFlagsBits.SendMessagesInThreads);
    expect((await createRequestDiscordConversation(request(), undefined, f.transport).reply({ message: 'thread' })).status).toBe('denied');
    expect(f.channel.send).not.toHaveBeenCalled();
  });
  it.each(['333', '999'])('requires current private-thread membership for %s', async missing => {
    const f = sdk(); f.channel.isThread = () => true; f.channel.type = ChannelType.PrivateThread;
    (f.channel as any).members = { cache: new Map([['333', {}], ['999', {}]]) };
    (f.channel as any).members.cache.delete(missing);
    expect((await createRequestDiscordConversation(request(), undefined, f.transport).reply({ message: 'thread' })).status).toBe('denied');
    expect(f.channel.send).not.toHaveBeenCalled();
  });
  it('requests only messages before the current source and discards foreign/future rows', async () => {
    const f = sdk(); const row = (id: string, channelId = '222', guildId = '111') => ({ id, channelId, guildId, author: { id: '333' }, content: 'quoted text', createdTimestamp: Number(id) });
    f.channel.messages.fetch.mockResolvedValue(new Map([['1', row('100')], ['2', row('101', '444')], ['3', row('102', '222', '444')], ['4', row('901')], ['5', row('900')]]));
    const result = await createRequestDiscordConversation(request(), undefined, f.transport).recent({ limit: 5 });
    expect(f.channel.messages.fetch).toHaveBeenCalledWith({ limit: 5, before: '900' });
    expect(result.map(r => r.messageId)).toEqual(['100']); expect(Object.isFrozen(result)).toBe(true);
  });
  it.each(['actor', 'bot'])('requires %s history permission before fetching', async actor => {
    const f = sdk(); (actor === 'actor' ? f.actorDenied : f.botDenied).add(PermissionFlagsBits.ReadMessageHistory);
    await expect(createRequestDiscordConversation(request(), undefined, f.transport).recent()).rejects.toThrow();
    expect(f.channel.messages.fetch).not.toHaveBeenCalled();
  });
  it('discards an in-flight history read when permissions are revoked', async () => {
    const f = sdk(); f.channel.messages.fetch.mockImplementationOnce(async () => { f.actorDenied.add(PermissionFlagsBits.ViewChannel); return new Map(); });
    await expect(createRequestDiscordConversation(request(), undefined, f.transport).recent()).rejects.toThrow();
  });
});
