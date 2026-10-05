import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import minecraftData from 'minecraft-data';
import { Vec3 } from 'vec3';
import {
  digBlockVerified,
  matchingMultiBlockStateId,
  slowDigStateIsPassing,
  ServerDigUnconfirmedError,
} from '../../src/services/minebot/utils/digBlockVerified.js';
import { cancelActiveActions, executeAction } from '../../src/services/minebot/execution/ActionExecution.js';

const registry = minecraftData('1.21.11');
const target = new Vec3(-343, 60, -114);
const stoneState = registry.blocksByName.stone.defaultState;
const waterState = registry.blocksByName.water.defaultState;

function fixture() {
  const client = new EventEmitter();
  let localState = stoneState;
  const bot: any = Object.assign(new EventEmitter(), {
    _client: client,
    registry,
    supportFeature: (feature: string) => feature === 'usesMultiblockSingleLong'
      || feature === 'usesMultiblock3DChunkCoords',
    blockAt: () => ({ stateId: localState }),
    _updateBlockState: vi.fn((_position: Vec3, stateId: number) => { localState = stateId; }),
    dig: vi.fn(async () => { localState = 0; bot.emit('blockUpdate', {}, { name: 'air' }); }),
  });
  const block: any = { name: 'stone', type: registry.blocksByName.stone.id,
    stateId: stoneState, position: target };
  return { bot, block, client, localState: () => localState };
}

describe('server-confirmed dig', () => {
  it('does not mistake Mineflayer optimistic air and blockUpdate for a server break', async () => {
    const { bot, block, client, localState } = fixture();
    await expect(digBlockVerified(bot, block, 10)).rejects.toBeInstanceOf(ServerDigUnconfirmedError);
    expect(localState()).toBe(stoneState);
    expect(bot._updateBlockState).toHaveBeenCalledWith(target, stoneState);
    expect(client.listenerCount('block_change')).toBe(0);
    expect(client.listenerCount('multi_block_change')).toBe(0);
  });

  it('accepts a matching server block change, including one received during dig', async () => {
    const { bot, block, client } = fixture();
    bot.dig = vi.fn(async () => {
      client.emit('block_change', { location: target.offset(1, 0, 0), type: 0 });
      client.emit('block_change', { location: target, type: 0 });
      bot._updateBlockState(target, 0);
    });
    await expect(digBlockVerified(bot, block, 10)).resolves.toEqual({ stateId: 0, blockName: 'air' });
    expect(client.listenerCount('block_change')).toBe(0);
    expect(client.listenerCount('multi_block_change')).toBe(0);
  });

  it('waits for server proof after local optimistic air and accepts cave_air', async () => {
    const { bot, block, client, localState } = fixture();
    const caveAirState = registry.blocksByName.cave_air.defaultState;
    setTimeout(() => client.emit('block_change', { location: target, type: caveAirState }), 5);
    await expect(digBlockVerified(bot, block, 50)).resolves.toEqual({
      stateId: caveAirState, blockName: 'cave_air',
    });
    expect(localState()).toBe(caveAirState);
  });

  it('ignores unrelated or unchanged-state server packets', async () => {
    const { bot, block, client, localState } = fixture();
    bot.dig = vi.fn(async () => {
      bot._updateBlockState(target, 0);
      client.emit('block_change', { location: target.offset(1, 0, 0), type: 0 });
      client.emit('block_change', { location: target, type: stoneState });
    });
    await expect(digBlockVerified(bot, block, 10)).rejects.toMatchObject({ failureType: 'dig_unconfirmed' });
    expect(localState()).toBe(stoneState);
  });

  it('matches a 1.21.11 multi-block update at negative chunk coordinates', async () => {
    const { bot, block, client } = fixture();
    const packet = { chunkCoordinates: { x: -22, y: 3, z: -8 },
      records: [(9 << 8) | (14 << 4) | 12] };
    expect(matchingMultiBlockStateId(bot, packet, target)).toBe(0);
    expect(matchingMultiBlockStateId(bot, packet, target.offset(1, 0, 0))).toBeNull();
    bot.dig = vi.fn(async () => {
      bot._updateBlockState(target, 0);
      client.emit('multi_block_change', packet);
    });
    await expect(digBlockVerified(bot, block, 10)).resolves.toEqual({ stateId: 0, blockName: 'air' });
  });

  it('keeps the client world aligned when a server replacement arrives before local prediction', async () => {
    const { bot, block, client, localState } = fixture();
    bot.dig = vi.fn(async () => {
      client.emit('block_change', { location: target, type: waterState });
      bot._updateBlockState(target, 0); // Mineflayer's later optimistic update
    });
    await expect(digBlockVerified(bot, block, 10)).resolves.toEqual({ stateId: waterState, blockName: 'water' });
    expect(localState()).toBe(waterState);
  });

  it('removes packet listeners when the underlying dig throws', async () => {
    const { bot, block, client } = fixture();
    bot.dig = vi.fn(async () => { throw new Error('dig aborted'); });
    await expect(digBlockVerified(bot, block, 10)).rejects.toThrow('dig aborted');
    expect(client.listenerCount('block_change')).toBe(0);
    expect(client.listenerCount('multi_block_change')).toBe(0);
  });

  it('ends the server-proof wait and removes packet listeners on action cancellation', async () => {
    const { bot, block, client } = fixture();
    bot.clearControlStates = vi.fn();
    bot.stopDigging = vi.fn();
    const pending = executeAction(bot, 'dig-block-at', 0, async () => {
      await digBlockVerified(bot, block, 5000);
      return { success: true, result: 'dug' };
    });
    await new Promise(resolve => setTimeout(resolve, 5));
    cancelActiveActions(bot, 'test cancellation');
    await expect(pending).resolves.toMatchObject({ success: false, failureType: 'interrupted' });
    expect(client.listenerCount('block_change')).toBe(0);
    expect(client.listenerCount('multi_block_change')).toBe(0);
  });

  it('forces the dig look so a pending view update cannot stall the dig', async () => {
    const { bot, block, client } = fixture();
    bot.dig = vi.fn(async () => { client.emit('block_change', { location: target, type: 0 }); });
    await digBlockVerified(bot, block, 10);
    expect(bot.dig).toHaveBeenCalledWith(block, true);
  });

  it('settles the action when Mineflayer dig never resolves and is cancelled', async () => {
    const { bot, block, client } = fixture();
    bot.clearControlStates = vi.fn();
    bot.stopDigging = vi.fn();
    bot.dig = vi.fn(() => new Promise(() => {}));
    const pending = executeAction(bot, 'dig-block-at', 0, async () => {
      await digBlockVerified(bot, block, 10);
      return { success: true, result: 'dug' };
    }, { waitForQuiescence: true });
    await new Promise(resolve => setTimeout(resolve, 5));
    cancelActiveActions(bot, 'test cancellation');
    await expect(pending).resolves.toMatchObject({ success: false });
    expect(bot.stopDigging).toHaveBeenCalled();
    expect(client.listenerCount('block_change')).toBe(0);
  });

  it('gives up a stalled dig after twice its dig time plus a margin', async () => {
    vi.useFakeTimers();
    try {
      const { bot, block } = fixture();
      bot.stopDigging = vi.fn();
      bot.digTime = vi.fn(() => 1000);
      bot.dig = vi.fn(() => new Promise(() => {}));
      const pending = digBlockVerified(bot, block, 10);
      const outcome = expect(pending).rejects.toThrow('12秒以内に終わりませんでした');
      await vi.advanceTimersByTimeAsync(12_001);
      await outcome;
      expect(bot.stopDigging).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('waiting out a slow-dig state before digging (paid run L50 waited three seconds under an ice sheet for the lake to drain)', () => {
  const water = (level: number) => ({ name: 'water', boundingBox: 'empty', metadata: level, getProperties: () => ({ level }) });
  const air = { name: 'air', boundingBox: 'empty' };
  const at = (cells: Record<number, any>, entity: Record<string, unknown>) => ({
    entity: { position: new Vec3(0.5, 60.2, 0.5), onGround: false, isInWater: true, ...entity },
    blockAt: (p: Vec3) => cells[p.y] ?? air,
  }) as any;

  it('waits for a hop to land and for a draining flow, not for standing water', () => {
    expect(slowDigStateIsPassing(at({}, { isInWater: false, onGround: false }))).toBe(true);   // airborne: lands in a moment
    expect(slowDigStateIsPassing(at({}, { isInWater: false, onGround: true }))).toBe(false);   // nothing slow about it
    expect(slowDigStateIsPassing(at({ 60: water(3) }, { onGround: true }))).toBe(true);        // a flow running off
    expect(slowDigStateIsPassing(at({ 60: water(0), 61: water(0) }, {}))).toBe(false);         // afloat in a lake
    expect(slowDigStateIsPassing(at({ 60: water(0) }, { onGround: true }))).toBe(false);       // standing in a source: it stays
    expect(slowDigStateIsPassing(at({ 60: water(8) }, {}))).toBe(false);                       // under falling water: it stays
  });

  it('starts the dig at once for a body afloat in standing water', async () => {
    const { bot, block, client } = fixture();
    bot.entity = { position: new Vec3(0.5, 60.2, 0.5), onGround: false, isInWater: true };
    bot.blockAt = (p?: Vec3) => (p && p.y >= 60 && p.y <= 61 && p.x === 0 ? water(0) : { stateId: stoneState });
    bot.dig = vi.fn(async () => { client.emit('block_change', { location: target, type: waterState }); });
    const started = Date.now();
    await expect(digBlockVerified(bot, block, 50)).resolves.toMatchObject({ blockName: 'water' });
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
