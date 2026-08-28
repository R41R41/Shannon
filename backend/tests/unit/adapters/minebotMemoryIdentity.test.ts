import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
vi.mock('../../../src/utils/logger.js', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock('../../../src/services/minebot/config/MinebotConfig.js', () => ({ CONFIG: { MAX_TASK_QUEUE_SIZE: 3 } }));
import { parseMinecraftWorldRegistry, normalizeMinecraftDimension, minecraftContextKey } from '../../../src/modules/memory/minecraftIdentity.js';
import { bindMinecraftMemory, revokeMinecraftMemory, minecraftMemoryContext, validateMinecraftEnvelope, assertMinecraftContinuation, MinecraftRecentHistory } from '../../../src/services/minebot/runtime/memoryContext.js';
import { MinebotTaskRuntime } from '../../../src/services/minebot/runtime/MinebotTaskRuntime.js';
import { minebotAdapter } from '../../../src/services/common/adapters/minebotAdapter.js';
import { deriveMemoryScope } from '../../../src/modules/memory/index.js';

describe('minebot memory identity transport', () => {
  it('passes explicit server/world identity through the native adapter', () => {
    const envelope = minebotAdapter.toEnvelope({ senderName: 'player', message: 'fixture',
      serverName: 'display', serverId: 'dev:server-a', worldId: 'world-a', dimension: 'minecraft:overworld' } as any);
    expect(envelope.minecraft?.serverId).toBe('dev:server-a');
    expect(envelope.minecraft?.worldId).toBe('world-a');
    expect(deriveMemoryScope(envelope)).not.toBeNull();
  });
  it('does not change the conversation when only a server display name changes', () => {
    const input = { senderName: 'player', message: 'fixture', serverId: 'dev:server-a', worldId: 'world-a', dimension: 'minecraft:overworld' };
    const a = minebotAdapter.toEnvelope({ ...input, serverName: 'old-name' });
    const b = minebotAdapter.toEnvelope({ ...input, serverName: 'new-name' });
    expect(a.threadId).toBe(b.threadId);
    expect(a.conversationId).toBe(b.conversationId);
  });
});

const row = { name: 'test-server', host: '127.0.0.1', port: 25565, serverId: 'server-a', worldId: 'generation-1' };
const config = (bindings: unknown[] = [row], environment = 'dev') => JSON.stringify({ version: 1, environment, bindings });
const makeBot = (identity: { serverId: string; worldId: string } | null = { serverId: 'dev:server-a', worldId: 'generation-1' }) => {
  const bot = Object.assign(new EventEmitter(), { game: { dimension: 'minecraft:overworld' }, connectedServerName: 'display',
    inventory: { items: () => [] }, entity: undefined });
  bindMinecraftMemory(bot, identity);
  return bot;
};
const envelopeFor = (bot: ReturnType<typeof makeBot>) => minebotAdapter.toEnvelope({ senderName: 'player', senderId: 'player-id',
  message: 'fixture', serverName: bot.connectedServerName, ...minecraftMemoryContext(bot) });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('operator world registry', () => {
  it('keeps memory disabled without a mapping and never infers identity from endpoint/name', () => {
    expect(parseMinecraftWorldRegistry(undefined, 'dev').resolve(row)).toBeNull();
    expect(parseMinecraftWorldRegistry('', 'dev').resolve(row)).toBeNull();
  });
  it('resolves only an exact connection and separates dev from prod', () => {
    const dev = parseMinecraftWorldRegistry(config(), 'dev');
    expect(dev.resolve(row)).toEqual({ serverId: 'dev:server-a', worldId: 'generation-1' });
    for (const changed of [{ ...row, name: 'other' }, { ...row, host: 'other' }, { ...row, port: 25566 }]) expect(dev.resolve(changed)).toBeNull();
    expect(parseMinecraftWorldRegistry(config([row], 'prod'), 'prod').resolve(row)?.serverId).toBe('prod:server-a');
  });
  it.each([
    '{', 'null', '{}', config([row], 'prod'), config([{ ...row, worldId: 'default' }]),
    config([{ ...row, host: 'bad host' }]), config([{ ...row, port: 0 }]), config([{ ...row, port: '25565' }]),
    config([{ ...row, serverId: 'a'.repeat(128) }]), config([row, row]),
    config([row, { ...row, name: 'other', port: 25566 }]),
    config([row, { ...row, name: 'other', worldId: 'other' }]),
  ])('rejects malformed/ambiguous config without echoing it (%#)', raw => {
    expect(() => parseMinecraftWorldRegistry(raw, 'dev')).toThrow('INVALID_MINECRAFT_MEMORY_IDENTITIES');
  });
  it.each([['overworld', 'minecraft:overworld'], ['the_nether', 'minecraft:the_nether'], ['end', 'minecraft:the_end'],
    ['custom:moon', 'custom:moon'], ['unknown', null], [undefined, null], ['', null]])('normalizes dimension %s without a default', (input, expected) => {
    expect(normalizeMinecraftDimension(input)).toBe(expected);
  });
});

describe('connected bot identity ownership', () => {
  it('does not share recent game history across dimensions or merge unreviewed voice/Mod input', () => {
    const bot = makeBot(); const history = new MinecraftRecentHistory<string>(bot);
    expect(history.add('game-a', true)).toEqual(['game-a']);
    expect(history.add('voice-private', false)).toEqual(['voice-private']);
    expect(history.add('game-b', true)).toEqual(['game-a', 'game-b']);
    bot.game.dimension = 'minecraft:the_nether';
    expect(history.add('nether', true)).toEqual(['nether']);
  });
  it('does not retain unscoped recent history and caps configured history', () => {
    const unknown = new MinecraftRecentHistory<string>(makeBot(null)); unknown.add('old', true);
    expect(unknown.add('new', true)).toEqual(['new']);
    const known = new MinecraftRecentHistory<number>(makeBot());
    for (let i = 0; i < 60; i++) known.add(i, true);
    expect(known.messages).toHaveLength(50); expect(known.messages[0]).toBe(10);
  });
  it('binds once, ignores mutable server display names, and does not share bindings between bot objects', () => {
    const bot = makeBot(); const before = minecraftMemoryContext(bot);
    bot.connectedServerName = 'other';
    expect(minecraftMemoryContext(bot)).toEqual(before);
    expect(minecraftMemoryContext({ game: bot.game })).toBeNull();
    expect(() => bindMinecraftMemory(bot, null)).toThrow('ALREADY_BOUND');
  });
  it('revokes an old connection permanently while permitting a new bot owner', () => {
    const old = makeBot(); const envelope = envelopeFor(old); revokeMinecraftMemory(old);
    expect(minecraftMemoryContext(old)).toBeNull();
    expect(() => validateMinecraftEnvelope(envelope, old)).toThrow('DISCONNECTED');
    expect(() => bindMinecraftMemory(old, null)).toThrow('ALREADY_BOUND');
    expect(deriveMemoryScope(envelopeFor(makeBot()))).not.toBeNull();
  });
  it('refuses forged world/conversation identity and stale dimensions', () => {
    const bot = makeBot(); const envelope = envelopeFor(bot);
    expect(() => validateMinecraftEnvelope({ ...envelope, minecraft: { ...envelope.minecraft, worldId: 'other' } }, bot)).toThrow('CONTEXT_CHANGED');
    expect(() => validateMinecraftEnvelope({ ...envelope, threadId: 'forged' }, bot)).toThrow('CONVERSATION_MISMATCH');
    bot.game.dimension = 'minecraft:the_nether';
    expect(() => validateMinecraftEnvelope(envelope, bot)).toThrow('CONTEXT_CHANGED');
  });
  it('validates and copies identity without mutating the caller', () => {
    const bot = makeBot(); const envelope = envelopeFor(bot); const before = structuredClone(envelope);
    const copy = validateMinecraftEnvelope(envelope, bot);
    copy.minecraft!.worldId = 'changed'; copy.tags.push('changed');
    expect(envelope).toEqual(before);
  });
  it('keeps unconfigured connections unscoped and refuses injected identity/legacy continuations', () => {
    const bot = makeBot(null); const envelope = envelopeFor(bot);
    expect(deriveMemoryScope(validateMinecraftEnvelope(envelope, bot))).toBeNull();
    expect(() => validateMinecraftEnvelope(envelopeFor(makeBot()), bot)).toThrow('CONTEXT_CHANGED');
    expect(() => assertMinecraftContinuation(null, envelope, bot)).toThrow('CONTINUATION_MISMATCH');
  });
  it('denies memory and continuation for an unreviewed source despite a valid physical world', () => {
    const bot = makeBot(); const envelope = envelopeFor(bot); envelope.metadata = { memoryDisabled: true };
    expect(deriveMemoryScope(envelope)).toBeNull();
    expect(() => assertMinecraftContinuation(minecraftContextKey(envelope.minecraft), envelope, bot)).toThrow('CONTINUATION_MISMATCH');
  });
});

describe('actual MinebotTaskRuntime with mock bot and executor', () => {
  const fixture = (identity?: { serverId: string; worldId: string } | null) => {
    const bot = makeBot(identity); const runtime = new MinebotTaskRuntime(bot as any);
    const executor = vi.fn(async () => ({ taskTree: { status: 'completed' } })); runtime.setExecutor(executor);
    return { bot, runtime, executor };
  };
  it('propagates explicit identity to generated system input without using the server name as worldId', async () => {
    const { bot, runtime, executor } = fixture();
    await runtime.invoke({ userMessage: 'fixture' });
    const envelope = (executor.mock.calls[0] as any)[0];
    expect(envelope.minecraft).toMatchObject(minecraftMemoryContext(bot)!);
    expect(deriveMemoryScope(envelope)).not.toBeNull();
    expect(runtime.currentState?.memoryContextKey).toBe(minecraftContextKey(envelope.minecraft));
    expect(bot.listenerCount('respawn')).toBe(0); expect(bot.listenerCount('end')).toBe(0);
  });
  it('does not enable memory for an unconfigured system task', async () => {
    const { runtime, executor } = fixture(null); await runtime.invoke({ userMessage: 'fixture' });
    expect(deriveMemoryScope((executor.mock.calls[0] as any)[0])).toBeNull();
  });
  it('does not mutate a supplied frozen envelope', async () => {
    const { bot, runtime, executor } = fixture(); const envelope = envelopeFor(bot);
    Object.freeze(envelope.minecraft); Object.freeze(envelope.metadata); Object.freeze(envelope.tags); Object.freeze(envelope);
    await runtime.invoke({ envelope }); expect(executor).toHaveBeenCalledOnce();
    expect(envelope.metadata?.bot).toBeUndefined();
  });
  it('captures queue identity immediately and rejects it after a dimension switch', async () => {
    vi.useFakeTimers(); const { bot, runtime, executor } = fixture();
    (runtime as any).isEmergencyMode = true;
    expect(runtime.addTaskToQueue({ userMessage: 'queued' }).success).toBe(true);
    const queued = (runtime as any).taskQueue[0];
    expect(queued.state.envelope.minecraft.worldId).toBe('generation-1');
    bot.game.dimension = 'minecraft:the_nether'; (runtime as any).isEmergencyMode = false;
    await (runtime as any).executeNextTask();
    expect(executor).not.toHaveBeenCalled();
    expect(runtime.currentState?.recoveryStatus).toBe('failed_terminal');
  });
  it('rejects disconnected synthetic and queued tasks before executor work', async () => {
    const { bot, runtime, executor } = fixture(); revokeMinecraftMemory(bot);
    await expect(runtime.invoke({ userMessage: 'new' })).rejects.toThrow('DISCONNECTED');
    expect(runtime.addTaskToQueue({ userMessage: 'new' }).success).toBe(false);
    expect(executor).not.toHaveBeenCalled();
  });
  it('retains scope when resuming history and rejects changing its world', async () => {
    const { bot, runtime, executor } = fixture();
    executor.mockResolvedValue({ taskTree: { status: 'waiting_for_user' }, savedMessages: ['saved'] } as any);
    await runtime.invoke({ envelope: envelopeFor(bot) });
    runtime.currentState!.recoveryStatus = 'awaiting_user';
    await runtime.resumeAwaitingUserTask('continue', { envelope: envelopeFor(bot), messages: [] });
    expect(executor).toHaveBeenCalledTimes(2);
    expect((executor.mock.calls[1] as any)[0].metadata.previousMessages).toEqual(['saved']);
    runtime.currentState!.recoveryStatus = 'awaiting_user'; bot.game.dimension = 'minecraft:the_nether';
    await expect(runtime.resumeAwaitingUserTask('continue', { envelope: envelopeFor(bot), messages: [] })).rejects.toThrow('CONTINUATION_MISMATCH');
    expect(executor).toHaveBeenCalledTimes(2);
  });
  it('refuses queued awaiting-user history after the current dimension changes', async () => {
    const { bot, runtime, executor } = fixture();
    (runtime as any).taskQueue = [{ status: 'awaiting_user', state: { envelope: envelopeFor(bot) } }];
    bot.game.dimension = 'minecraft:the_end';
    await expect(runtime.resumeAwaitingUserTask('continue', { envelope: envelopeFor(bot), messages: [] })).rejects.toThrow('CONTINUATION_MISMATCH');
    expect((runtime as any).taskQueue[0].status).toBe('awaiting_user'); expect(executor).not.toHaveBeenCalled();
  });
  it('does not relabel a queued Mod/voice task as game-chat history', async () => {
    const { bot, runtime, executor } = fixture(); const previous = envelopeFor(bot); previous.metadata = { memoryDisabled: true };
    (runtime as any).taskQueue = [{ status: 'awaiting_user', state: { envelope: previous } }];
    await expect(runtime.resumeAwaitingUserTask('continue', { envelope: envelopeFor(bot), messages: [] })).rejects.toThrow('CONTINUATION_MISMATCH');
    expect(executor).not.toHaveBeenCalled();
  });
  it.each(['end', 'kicked', 'respawn'])('cancels in-flight execution on %s and cleans up listeners', async event => {
    const { bot, runtime } = fixture(); let release!: () => void; let signal!: AbortSignal;
    runtime.setExecutor(async (_envelope, _messages, options) => { signal = options!.abortSignal!;
      await new Promise<void>(resolve => { release = resolve; }); return { taskTree: { status: 'completed' } }; });
    const running = runtime.invoke({ envelope: envelopeFor(bot) });
    if (event === 'respawn') bot.game.dimension = 'minecraft:the_nether';
    bot.emit(event); expect(signal.aborted).toBe(true); release(); await running;
    expect(runtime.currentState?.recoveryStatus).toBe('failed_terminal');
    for (const name of ['end', 'kicked', 'respawn']) expect(bot.listenerCount(name)).toBe(0);
  });
});
