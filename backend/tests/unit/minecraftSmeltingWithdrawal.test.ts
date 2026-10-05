import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import WithdrawFromFurnace from '../../src/services/minebot/instantSkills/withdrawFromFurnace.js';

function furnaceFixture(initial: { input: number; fuel: number; output: number; burning?: boolean }) {
  const state = { ...initial, burning: initial.burning ?? true };
  const inventoryCounts = new Map<string, number>();
  const inventory = Object.assign(new EventEmitter(), {
    items: () => [...inventoryCounts].map(([name, count]) => ({ name, count })),
    emptySlotCount: () => 30,
  });
  const addToInventory = (name: string, count: number) => {
    inventoryCounts.set(name, (inventoryCounts.get(name) ?? 0) + count);
    inventory.emit('updateSlot');
  };
  const furnace = Object.assign(new EventEmitter(), {
    fuel: state.burning ? 1 : 0,
    totalFuel: 10,
    inputItem: () => state.input ? { name: 'raw_iron', count: state.input } : null,
    fuelItem: () => state.fuel ? { name: 'spruce_planks', count: state.fuel } : null,
    outputItem: () => state.output ? { name: 'iron_ingot', count: state.output } : null,
    takeInput: vi.fn(async () => {
      addToInventory('raw_iron', state.input);
      state.input = 0;
      furnace.emit('update');
    }),
    takeFuel: vi.fn(async () => {
      addToInventory('spruce_planks', state.fuel);
      state.fuel = 0;
      furnace.emit('update');
    }),
    takeOutput: vi.fn(async () => {
      addToInventory('iron_ingot', state.output);
      state.output = 0;
      furnace.emit('update');
    }),
    close: vi.fn(),
  });
  const bot: any = {
    version: '1.21.11',
    entity: { position: new Vec3(0, 64, 1) },
    inventory,
    currentWindow: inventory,
    entities: {},
    game: { dimension: 'overworld' },
    blockAt: () => ({ name: 'furnace' }),
    openFurnace: vi.fn(async () => furnace),
    activeFurnaces: [{ pos: { x: 0, y: 64, z: 0 }, item: 'raw_iron', count: 3 }],
  };
  const smeltOne = () => {
    if (state.input <= 0 || !state.burning) return;
    state.input -= 1;
    state.output += 1;
    if (state.output === 1) state.fuel = Math.max(0, state.fuel - 1);
    if (state.input === 0) furnace.fuel = 0;
    furnace.emit('update');
  };
  return { bot, furnace, state, inventoryCounts, smeltOne };
}

describe('withdraw-from-furnace active smelting', () => {
  it('by default does not stand at the furnace for a long remainder: returns at once with the time left, input and fuel untouched (paid runs L97, L98, L100 waited 6-12 minutes a run)', async () => {
    const { bot, furnace, state } = furnaceFixture({ input: 3, fuel: 2, output: 0 });
    const result: any = await new WithdrawFromFurnace(bot).runImpl(0, 64, 0);
    expect(result).toMatchObject({ success: false, failureType: 'waiting_external' });
    expect(result.result).toContain('残り約30秒');
    expect(furnace.takeInput).not.toHaveBeenCalled();
    expect(furnace.takeFuel).not.toHaveBeenCalled();
    expect(state).toMatchObject({ input: 3, fuel: 2, output: 0 });
  });

  it('by default waits out a short remainder (two items, about twenty seconds)', async () => {
    const { bot, inventoryCounts, smeltOne } = furnaceFixture({ input: 2, fuel: 1, output: 0 });
    const withdrawing = new WithdrawFromFurnace(bot).runImpl(0, 64, 0);
    await new Promise(resolve => setImmediate(resolve));
    smeltOne();
    smeltOne();
    const result = await withdrawing;
    expect(result).toMatchObject({ success: true });
    expect(inventoryCounts.get('iron_ingot')).toBe(2);
  });

  it('does not remove raw iron or fuel before an all asked to wait completes', async () => {
    const { bot, furnace, state, inventoryCounts, smeltOne } = furnaceFixture({
      input: 3, fuel: 2, output: 0,
    });
    const withdrawing = new WithdrawFromFurnace(bot).runImpl(0, 64, 0, 'all', true);
    await new Promise(resolve => setImmediate(resolve));

    expect(furnace.takeInput).not.toHaveBeenCalled();
    expect(furnace.takeFuel).not.toHaveBeenCalled();
    expect(state).toMatchObject({ input: 3, fuel: 2, output: 0 });

    smeltOne();
    smeltOne();
    smeltOne();
    const result = await withdrawing;
    expect(result).toMatchObject({ success: true });
    expect(result.result).toContain('iron_ingot x3');
    expect(inventoryCounts.get('iron_ingot')).toBe(3);
    expect(inventoryCounts.get('raw_iron')).toBeUndefined();
    expect(furnace.takeInput).not.toHaveBeenCalled();
    expect(bot.activeFurnaces).toEqual([]);
  });

  it('waits for remaining input even when one ingot is already in the output slot', async () => {
    const { bot, furnace, state, inventoryCounts, smeltOne } = furnaceFixture({
      input: 2, fuel: 1, output: 1,
    });
    const withdrawing = new WithdrawFromFurnace(bot).runImpl(0, 64, 0, 'all', true);
    await new Promise(resolve => setImmediate(resolve));

    expect(furnace.takeInput).not.toHaveBeenCalled();
    expect(furnace.takeFuel).not.toHaveBeenCalled();
    expect(furnace.takeOutput).not.toHaveBeenCalled();
    expect(state.input).toBe(2);

    smeltOne();
    smeltOne();
    const result = await withdrawing;
    expect(result).toMatchObject({ success: true });
    expect(inventoryCounts.get('iron_ingot')).toBe(3);
    expect(inventoryCounts.get('raw_iron')).toBeUndefined();
  });

  it('takes only finished output in nonblocking all mode and preserves the ongoing job', async () => {
    const { bot, furnace, state, inventoryCounts } = furnaceFixture({
      input: 2, fuel: 1, output: 1,
    });
    const result = await new WithdrawFromFurnace(bot).runImpl(0, 64, 0, 'all', false);

    expect(result).toMatchObject({ success: false, failureType: 'waiting_external' });
    expect(result.result).toContain('材料2個の精錬は未完了');
    expect(inventoryCounts.get('iron_ingot')).toBe(1);
    expect(state).toMatchObject({ input: 2, fuel: 1 });
    expect(furnace.takeInput).not.toHaveBeenCalled();
    expect(furnace.takeFuel).not.toHaveBeenCalled();
    expect(bot.activeFurnaces).toHaveLength(1);
  });

  it('leaves unprocessed input available for refueling when fuel runs out', async () => {
    const { bot, furnace, state, inventoryCounts } = furnaceFixture({
      input: 2, fuel: 0, output: 1, burning: false,
    });
    const result = await new WithdrawFromFurnace(bot).runImpl(0, 64, 0, 'all', true);

    expect(result).toMatchObject({ success: false, failureType: 'material_missing' });
    expect(result.result).toContain('燃料を追加してください');
    expect(state.input).toBe(2);
    expect(inventoryCounts.get('iron_ingot')).toBe(1);
    expect(furnace.takeInput).not.toHaveBeenCalled();
    expect(bot.activeFurnaces).toEqual([]);
  });

  it('preserves the explicit input-slot withdrawal needed to cancel a job', async () => {
    const { bot, furnace, inventoryCounts } = furnaceFixture({
      input: 2, fuel: 1, output: 1,
    });
    const result = await new WithdrawFromFurnace(bot).runImpl(0, 64, 0, 'input');

    expect(result).toMatchObject({ success: true });
    expect(inventoryCounts.get('raw_iron')).toBe(2);
    expect(furnace.takeInput).toHaveBeenCalledOnce();
    expect(furnace.takeFuel).not.toHaveBeenCalled();
  });
});
