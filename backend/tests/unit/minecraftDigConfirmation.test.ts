import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import { installDigConfirmation } from '../../src/services/minebot/utils/digConfirmation.js';

function digger(serverBreaksAfterMs: number | null) {
  const client = new EventEmitter();
  const world = new Map<string, number>([['3,64,0', 1]]);
  const events = new EventEmitter();
  const seen: number[] = []; // every state the client's world held for the block, in order
  const bot: any = {
    on: (event: string, listener: (...args: any[]) => void) => events.on(event, listener),
    removeListener: (event: string, listener: (...args: any[]) => void) => events.removeListener(event, listener),
    _client: client, registry: { blocksByStateId: { 0: { id: 0, name: 'air' }, 1: { id: 1, name: 'stone' } } },
    supportFeature: () => false,
    blockAt: (position: Vec3) => ({ stateId: world.get(`${position.x},${position.y},${position.z}`) ?? 0 }),
    // As the library does: write the state, then announce the change for that position.
    _updateBlockState: (position: Vec3, stateId: number) => {
      const before = world.get(`${position.x},${position.y},${position.z}`) ?? 0;
      world.set(`${position.x},${position.y},${position.z}`, stateId);
      seen.push(stateId);
      events.emit(`blockUpdate:${position}`, { type: before }, { type: stateId });
    },
    // The library: when its own timer runs out it marks the block as air, whatever the server thinks.
    dig: vi.fn(async (block: any) => {
      await new Promise(resolve => setTimeout(resolve, 400));
      bot._updateBlockState(block.position, 0);
      if (serverBreaksAfterMs !== null) setTimeout(() => client.emit('block_change', { location: { x: 3, y: 64, z: 0 }, type: 0 }), serverBreaksAfterMs);
    }),
  };
  // The library's own packet handler, registered before anything else as a plugin is: it applies the server's state.
  client.on('block_change', (packet: any) => bot._updateBlockState(new Vec3(packet.location.x, packet.location.y, packet.location.z), packet.type));
  installDigConfirmation(bot);
  return { bot, world, seen, block: { position: new Vec3(3, 64, 0), stateId: 1, type: 1, name: 'stone' } };
}

afterEach(() => { vi.useRealTimers(); });

describe('every dig is checked against the server (the pathfinder\'s unconfirmed "air" pushed the body back each tick)', () => {
  it('keeps the block as air when the server confirms the break, without waiting longer than that takes', async () => {
    vi.useFakeTimers();
    const { bot, world, block } = digger(50);
    let done = false;
    const digging = bot.dig(block).then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(400 + 60);
    expect(done).toBe(true);
    await digging;
    expect(world.get('3,64,0')).toBe(0);
    expect(bot.ghostBlocksRestored).toBe(0);
  });

  it('puts the block back when the server never confirms it', async () => {
    vi.useFakeTimers();
    const { bot, world, block } = digger(null);
    const digging = bot.dig(block);
    await vi.advanceTimersByTimeAsync(450);
    // The library's guess of air is undone in the instant it is made: the client never holds air the server does not.
    expect(world.get('3,64,0')).toBe(1);
    await vi.advanceTimersByTimeAsync(2000);
    await digging;
    expect(world.get('3,64,0')).toBe(1);
    expect(bot.ghostBlocksRestored).toBe(1);
  });

  it('does not take an echo of the old state for a break, and accepts a late break within the wait', async () => {
    vi.useFakeTimers();
    const echoed = digger(null);
    const first = echoed.bot.dig(echoed.block);
    await vi.advanceTimersByTimeAsync(100);
    echoed.bot._client.emit('block_change', { location: { x: 3, y: 64, z: 0 }, type: 1 });
    await vi.advanceTimersByTimeAsync(2500);
    await first;
    expect(echoed.world.get('3,64,0')).toBe(1);
    const late = digger(1500); // the server's own count finishes a second and a half after the client's
    const second = late.bot.dig(late.block);
    await vi.advanceTimersByTimeAsync(400 + 1600);
    await second;
    expect(late.world.get('3,64,0')).toBe(0);
    expect(late.bot.ghostBlocksRestored).toBe(0);
  });

  it('never shows air before the server says so, however slowly the server ticks (341 corrections in L35)', async () => {
    vi.useFakeTimers();
    const slow = digger(1900); // the server finishes its own count almost two seconds after the client's timer
    const digging = slow.bot.dig(slow.block);
    for (let elapsed = 0; elapsed < 2200; elapsed += 100) {
      await vi.advanceTimersByTimeAsync(100);
      if (elapsed + 100 < 400 + 1900) expect(slow.world.get('3,64,0')).toBe(1);
    }
    await vi.advanceTimersByTimeAsync(300);
    await digging;
    // guess (0) undone (1), then the server's break (0) kept.
    expect(slow.seen).toEqual([0, 1, 0]);
    expect(slow.world.get('3,64,0')).toBe(0);
    expect(slow.bot.ghostBlocksRestored).toBe(0);
  });

  it('does not wait for a confirmation of a block that is already air', async () => {
    vi.useFakeTimers();
    const { bot, world } = digger(null);
    world.set('3,64,0', 0);
    let done = false;
    const digging = bot.dig({ position: new Vec3(3, 64, 0), stateId: 0, type: 0, name: 'air' }).then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(450);
    expect(done).toBe(true);
    await digging;
    expect(bot.ghostBlocksRestored).toBe(0);
  });

  it('leaves the library dig reachable for callers that confirm themselves, and wraps only once', () => {
    const { bot } = digger(null);
    const wrapped = bot.dig;
    installDigConfirmation(bot);
    expect(bot.dig).toBe(wrapped);
    expect(typeof bot.unconfirmedDig).toBe('function');
  });
});
