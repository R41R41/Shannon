import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import { installLinkWatch, LATE_KEEPALIVE_MS } from '../../src/services/minebot/utils/linkWatch.js';
import { installArrivalNote } from '../../src/services/minebot/utils/arrivalNote.js';
import { installDigConfirmation, PAUSE_MS, ServerNotConfirmingError, STOP_AFTER, STREAK_MS } from '../../src/services/minebot/utils/digConfirmation.js';
import { captureWorldObservation } from '../../src/services/minebot/cognition/worldFrame.js';

// Run 24, in the Nether (18:11:23 the gate, 18:12:02 "Timed out"):
//   - the connection is recorded (keep-alives in and out, how late, the dimension changes) so that a drop can be read afterwards, and the
//     keep-alive clock of a dead client is taken off it;
//   - twelve digs in sixteen seconds were put back one after another as "not confirmed": a streak waits, then stops with the reason;
//   - a body that went back in by itself after a drop says so, so that it is not taken for a respawn.

afterEach(() => { vi.useRealTimers(); });

describe('the record of the link (utils/linkWatch)', () => {
  function link() {
    const rawWrite = vi.fn();
    const client: any = Object.assign(new EventEmitter(), { write: rawWrite, socket: { readableLength: 0, writableLength: 0 }, state: 'play' });
    const events = new EventEmitter();
    const bot: any = { _client: client, on: events.on.bind(events), removeListener: events.removeListener.bind(events), emit: events.emit.bind(events), game: { dimension: 'minecraft:the_nether' } };
    let clock = 1_000_000;
    const watch = installLinkWatch(bot, { now: () => clock, checkMs: 1_000_000 })!;
    return { client, bot, watch, rawWrite, tick: (ms: number) => { clock += ms; } };
  }
  const keepAlive = (id: bigint) => ({ keepAliveId: id });

  it('times each answer to a keep-alive, and says when one is not answered', () => {
    const { client, watch, tick, rawWrite: write } = link();
    client.emit('keep_alive', keepAlive(1000n));
    expect(watch.stats.unanswered).toBe(1);
    expect(watch.behind()).toBe(false);
    tick(LATE_KEEPALIVE_MS + 500);
    expect(watch.behind()).toBe(true);                   // heard, and not answered for over three seconds
    client.write('keep_alive', { keepAliveId: 1000n });
    expect(watch.stats.maxAnswerMs).toBe(LATE_KEEPALIVE_MS + 500);
    expect(watch.stats.unanswered).toBe(0);
    expect(watch.behind()).toBe(false);
    expect(write).toHaveBeenCalledWith('keep_alive', { keepAliveId: 1000n });     // the answer still goes out
  });

  it('measures how late a keep-alive came by the server\'s own clock (its ids are milliseconds)', () => {
    const { client, watch, tick } = link();
    client.emit('keep_alive', keepAlive(10_000n));
    tick(25_000);                                        // 25 s on this side...
    client.emit('keep_alive', keepAlive(25_000n));       // ...for 15 s on the server's clock: 10 s late
    expect(watch.stats.maxLateMs).toBe(10_000);
    // the ids as the library may give them: a pair of numbers
    client.emit('keep_alive', { keepAliveId: [0, 40_000] });
    expect(watch.stats.keepAlivesIn).toBe(3);
  });

  it('is silent when no keep-alive has come for twenty seconds, and says its state in a sentence', () => {
    const { client, watch, tick } = link();
    client.emit('keep_alive', keepAlive(1n));
    client.write('keep_alive', {});
    tick(21_000);
    expect(watch.behind()).toBe(true);
    const sentence = watch.snapshot();
    expect(sentence).toContain('keep-alive 受信 21秒前');
    expect(sentence).toContain('状態 play');
  });

  it('notes the dimension change and how soon the first position and the first chunk came', () => {
    const { bot, watch, tick } = link();
    bot.emit('respawn');
    tick(1500); bot.emit('move');
    tick(2500); bot.emit('chunkColumnLoad');
    bot.emit('move'); bot.emit('chunkColumnLoad');
    expect(watch.stats.dimensionChanges).toEqual([{ at: expect.any(Number), to: 'minecraft:the_nether', firstPositionMs: 1500, firstChunkMs: 4000 }]);
  });

  it('at the end of the connection takes the keep-alive listeners off the dead client, so that none handled late starts a clock', () => {
    const { client, bot } = link();
    client.on('keep_alive', () => {});
    expect(client.listenerCount('keep_alive')).toBeGreaterThan(1);
    bot.emit('end', 'socketClosed');
    expect(client.listenerCount('keep_alive')).toBe(0);
    const raw = client.write;
    expect(typeof raw).toBe('function');
  });

  it('is installed once, and a body with no client gets none', () => {
    const { bot, watch } = link();
    expect(installLinkWatch(bot)).toBe(watch);
    expect(installLinkWatch({ on: () => {} } as any)).toBeNull();
  });
});

describe('a streak of digs the server does not confirm waits, then stops (run 24: twelve in sixteen seconds in the Nether)', () => {
  function digger() {
    const client = new EventEmitter();
    const world = new Map<string, number>();
    const events = new EventEmitter();
    const bot: any = {
      on: (event: string, listener: (...args: any[]) => void) => events.on(event, listener),
      removeListener: (event: string, listener: (...args: any[]) => void) => events.removeListener(event, listener),
      _client: client, registry: { blocksByStateId: { 0: { id: 0, name: 'air' }, 1: { id: 1, name: 'stone' } } }, supportFeature: () => false,
      blockAt: (position: Vec3) => ({ stateId: world.get(`${position.x},${position.y},${position.z}`) ?? 1 }),
      _updateBlockState: (position: Vec3, stateId: number) => { const before = world.get(`${position.x},${position.y},${position.z}`) ?? 1; world.set(`${position.x},${position.y},${position.z}`, stateId); events.emit(`blockUpdate:${position}`, { type: before }, { type: stateId }); },
      dig: vi.fn(async (block: any) => { await new Promise(resolve => setTimeout(resolve, 100)); bot._updateBlockState(block.position, 0); }),
    };
    client.on('block_change', (packet: any) => bot._updateBlockState(new Vec3(packet.location.x, packet.location.y, packet.location.z), packet.type));
    installDigConfirmation(bot);
    const block = (x: number) => ({ position: new Vec3(x, 64, 0), stateId: 1, type: 1, name: 'netherrack' });
    return { bot, client, block };
  }
  const run = async (promise: Promise<unknown>, ms: number) => { const outcome = promise.then(() => 'done', (error: Error) => error); await vi.advanceTimersByTimeAsync(ms); return outcome; };

  it('the fourth unconfirmed dig waits first, the sixth is refused with the reason, and the streak ends after STREAK_MS', async () => {
    vi.useFakeTimers();
    const { bot, block } = digger();
    for (let i = 0; i < 3; i++) expect(await run(bot.dig(block(i)), 100 + 2000 + 50)).toBe('done');
    expect(bot.ghostBlocksRestored).toBe(3);
    // the fourth: PAUSE_MS first, so it is not done when only the dig's own time has passed
    let fourth = false;
    const digging = bot.dig(block(3)).then(() => { fourth = true; });
    await vi.advanceTimersByTimeAsync(100 + 2000 + 50);
    expect(fourth).toBe(false);
    await vi.advanceTimersByTimeAsync(PAUSE_MS);
    await digging;
    expect(fourth).toBe(true);
    expect(await run(bot.dig(block(4)), PAUSE_MS + 100 + 2000 + 50)).toBe('done');
    // five unconfirmed within the streak: the next is refused at once, with what the link was doing
    expect(STOP_AFTER).toBe(5);
    const refused = await run(bot.dig(block(5)), 10);
    expect(refused).toBeInstanceOf(ServerNotConfirmingError);
    expect((refused as ServerNotConfirmingError).failureType).toBe('server_not_confirming');
    expect((refused as Error).message).toContain('5回続けて');
    expect(bot.dig).toBeDefined();
    // and after the streak is old, digging goes on
    await vi.advanceTimersByTimeAsync(STREAK_MS + 1000);
    expect(await run(bot.dig(block(6)), 100 + 2000 + 50)).toBe('done');
  });

  it('a dig the server confirms ends the streak', async () => {
    vi.useFakeTimers();
    const { bot, client, block } = digger();
    for (let i = 0; i < 4; i++) await run(bot.dig(block(i)), 100 + 2000 + 3000 + 50);
    const digging = bot.dig(block(10)).then(() => 'done');
    await vi.advanceTimersByTimeAsync(PAUSE_MS + 50);
    client.emit('block_change', { location: { x: 10, y: 64, z: 0 }, type: 0 });
    await vi.advanceTimersByTimeAsync(300);
    await digging;
    // confirmed: the next one is not paused (done after its own time alone)
    expect(await run(bot.dig(block(11)), 100 + 2000 + 50)).toBe('done');
  });
});

describe('a reconnect is not a respawn (run 24: a shelter dug over magma)', () => {
  const body = () => { const events = new EventEmitter(); return Object.assign({ on: events.on.bind(events), emit: events.emit.bind(events) }, { arrival: undefined as any }); };

  it('says what the arrival was: the first of a connection, after a drop, after a death, through a portal', () => {
    let clock = 10_000;
    const reconnected: any = body();
    installArrivalNote(reconnected, 'reconnect', () => clock);
    expect(reconnected.arrival).toMatchObject({ kind: 'reconnect' });
    clock += 1000; reconnected.emit('spawn');
    expect(reconnected.arrival).toEqual({ kind: 'reconnect', at: 11_000 });
    clock += 5000; reconnected.emit('spawn');                       // a later spawn with no death: another dimension
    expect(reconnected.arrival.kind).toBe('portal');
    clock += 5000; reconnected.emit('death'); reconnected.emit('spawn');
    expect(reconnected.arrival.kind).toBe('respawn');
    const first: any = body();
    installArrivalNote(first, 'login', () => clock);
    first.emit('spawn');
    expect(first.arrival.kind).toBe('login');
  });

  it('is in the observation for two minutes, with died true only for a respawn', () => {
    const frameOf = (arrival: any) => captureWorldObservation({ arrival, inventory: { items: () => [] } } as any);
    const now = Date.now();
    expect(frameOf({ kind: 'reconnect', at: now - 20_000 }).arrival).toMatchObject({ kind: 'reconnect', died: false });
    expect(frameOf({ kind: 'respawn', at: now - 5_000 }).arrival).toMatchObject({ kind: 'respawn', died: true });
    expect(frameOf({ kind: 'reconnect', at: now - 300_000 }).arrival).toBeUndefined();
    expect(frameOf(undefined).arrival).toBeUndefined();
  });
});
