import { describe, expect, it, vi } from 'vitest';
import StartSmelting from '../../src/services/minebot/instantSkills/startSmelting.js';
import { backgroundJobs } from '../../src/services/minebot/execution/backgroundJobs.js';

function fixture(fuels: Array<{ name: string; count: number }>, options: {
  rawIron?: number;
  furnaceInput?: number;
  furnaceFuel?: { name: string; count: number };
  burningSeconds?: number;
} = {}) {
  const furnace = {
    fuel: options.burningSeconds ? 0.5 : 0,
    fuelSeconds: options.burningSeconds ?? 0,
    progress: 0,
    inputItem: () => options.furnaceInput ? { name: 'raw_iron', count: options.furnaceInput } : null,
    fuelItem: () => options.furnaceFuel ?? null,
    outputItem: () => null,
    putInput: vi.fn(async () => {}),
    putFuel: vi.fn(async () => {}),
    close: vi.fn(),
  };
  const items = [
    ...(options.rawIron === 0 ? [] : [{ name: 'raw_iron', type: 1, count: options.rawIron ?? 3 }]),
    ...fuels.map((fuel, index) => ({ ...fuel, type: index + 2 })),
  ];
  const bot: any = {
    version: '1.21.11',
    game: { dimension: 'overworld' },
    inventory: { items: () => items },
    entity: { position: { distanceTo: () => 1 } },
    blockAt: () => ({ name: 'furnace' }),
    openFurnace: vi.fn(async () => furnace),
  };
  return { bot, furnace };
}

describe('start-smelting fuel selection', () => {
  it('uses available planks when requested coal is absent', async () => {
    const { bot, furnace } = fixture([{ name: 'spruce_planks', count: 2 }]);
    const result = await new StartSmelting(bot).runImpl(0, 64, 0, 'raw_iron', 'coal', 3);

    expect(result.success).toBe(true);
    expect(result.result).toContain('spruce_planks');
    expect(furnace.putInput).toHaveBeenCalledWith(1, null, 3);
    expect(furnace.putFuel).toHaveBeenCalledWith(2, null, 2);
  });

  it('accepts an explicitly requested wooden fuel when no high-efficiency fuel exists', async () => {
    const { bot, furnace } = fixture([{ name: 'spruce_planks', count: 2 }]);
    const result = await new StartSmelting(bot).runImpl(0, 64, 0, 'raw_iron', 'spruce_planks', 3);

    expect(result.success).toBe(true);
    expect(furnace.putFuel).toHaveBeenCalledWith(2, null, 2);
  });

  it('keeps preferring coal over requested planks when coal is available', async () => {
    const { bot, furnace } = fixture([
      { name: 'spruce_planks', count: 3 },
      { name: 'coal', count: 1 },
    ]);
    const result = await new StartSmelting(bot).runImpl(0, 64, 0, 'raw_iron', 'spruce_planks', 3);

    expect(result.success).toBe(true);
    expect(result.result).toContain('効率のためcoalを使用');
    expect(furnace.putFuel).toHaveBeenCalledWith(3, null, 1);
  });

  it('does not silently accept an item that is not fuel', async () => {
    const { bot, furnace } = fixture([{ name: 'spruce_planks', count: 3 }]);
    const result = await new StartSmelting(bot).runImpl(0, 64, 0, 'raw_iron', 'cobblestone', 3);

    expect(result).toMatchObject({ success: false, failureType: 'invalid_fuel' });
    expect(furnace.putInput).not.toHaveBeenCalled();
    expect(furnace.putFuel).not.toHaveBeenCalled();
  });

  it('tracks the eight ingots possible from ten raw iron and one coal', async () => {
    const { bot, furnace } = fixture([{ name: 'coal', count: 1 }], { rawIron: 10 });
    const result = await new StartSmelting(bot).runImpl(0, 64, 0, 'raw_iron', 'coal', 10);

    expect(result).toMatchObject({ success: true });
    expect(result.result).toContain('約8個のみ精錬可能');
    expect(result.result).toContain('残り2個には燃料追加');
    expect(furnace.putInput).toHaveBeenCalledWith(1, null, 10);
    expect(furnace.putFuel).toHaveBeenCalledWith(2, null, 1);
    expect(bot.activeFurnaces).toMatchObject([{ item: 'raw_iron', count: 8 }]);
  });

  it('continues ten raw iron using fuel already in the furnace and none in inventory', async () => {
    const { bot, furnace } = fixture([], { rawIron: 10, furnaceFuel: { name: 'coal', count: 2 } });
    const result = await new StartSmelting(bot).runImpl(0, 64, 0, 'raw_iron', 'coal', 10);

    expect(result).toMatchObject({ success: true });
    expect(furnace.putInput).toHaveBeenCalledWith(1, null, 10);
    expect(furnace.putFuel).not.toHaveBeenCalled();
    expect(bot.activeFurnaces).toMatchObject([{ item: 'raw_iron', count: 10 }]);
  });

  it('resumes input already inside a partly fueled furnace with empty inventory', async () => {
    const { bot, furnace } = fixture([], { rawIron: 0, furnaceInput: 10, furnaceFuel: { name: 'coal', count: 1 } });
    const result = await new StartSmelting(bot).runImpl(0, 64, 0, 'raw_iron', 'coal', 10);

    expect(result).toMatchObject({ success: true });
    expect(result.result).toContain('約8個のみ精錬可能');
    expect(furnace.putInput).not.toHaveBeenCalled();
    expect(furnace.putFuel).not.toHaveBeenCalled();
    expect(bot.activeFurnaces).toMatchObject([{ item: 'raw_iron', count: 8 }]);
  });

  it('uses the held fuel that smelts most and exposes unfueled input as a background-job fact', async () => {
    // Campaign segment 7: one log was requested for six raw iron while planks and sticks were held.
    const { bot, furnace } = fixture([{ name: 'oak_log', count: 1 }, { name: 'oak_planks', count: 3 },
      { name: 'stick', count: 2 }], { rawIron: 6 });
    const result = await new StartSmelting(bot).runImpl(0, 64, 0, 'raw_iron', 'oak_log', 6);

    expect(result.success).toBe(true);
    expect(result.result).toContain('より多く精錬できる所持燃料oak_planks');
    expect(result.result).toContain('約4個のみ精錬可能');
    expect(result.result).toContain('oak_log x1, stick x2');
    expect(furnace.putFuel).toHaveBeenCalledWith(3, null, 3);
    expect(bot.activeFurnaces).toMatchObject([{ item: 'raw_iron', count: 4, unfueledCount: 2 }]);
    expect(backgroundJobs(bot)).toMatchObject([{ count: 4, unfueledInputCount: 2 }]);
    expect(backgroundJobs(bot)[0].instruction).toContain('never smelt without fuel');
  });

  it('never suggests or burns the last working tool as fuel', async () => {
    // Paid run 2026-10-01: the fuel list named wooden_pickaxe and the model burned its only pickaxe.
    const listed = fixture([{ name: 'oak_planks', count: 1 }, { name: 'wooden_pickaxe', count: 1 }, { name: 'stick', count: 2 }]);
    const partial = await new StartSmelting(listed.bot).runImpl(0, 64, 0, 'raw_iron', 'oak_planks', 3);
    expect(partial.result).not.toContain('wooden_pickaxe');
    expect(partial.result).toContain('stick x2');

    const explicit = fixture([{ name: 'wooden_pickaxe', count: 1 }, { name: 'stick', count: 2 }], { rawIron: 1 });
    const kept = await new StartSmelting(explicit.bot).runImpl(0, 64, 0, 'raw_iron', 'wooden_pickaxe', 1);
    expect(kept.success).toBe(true);
    expect(kept.result).toContain('最後の道具のため燃料にせず');
    expect(explicit.furnace.putFuel).toHaveBeenCalledWith(3, null, 2);

    const onlyTool = fixture([{ name: 'wooden_pickaxe', count: 1 }], { rawIron: 1 });
    const refused = await new StartSmelting(onlyTool.bot).runImpl(0, 64, 0, 'raw_iron', 'wooden_pickaxe', 1);
    expect(refused).toMatchObject({ success: false, failureType: 'material_missing' });
    expect(onlyTool.furnace.putFuel).not.toHaveBeenCalled();

    const spare = fixture([{ name: 'wooden_pickaxe', count: 2 }], { rawIron: 3 });
    await new StartSmelting(spare.bot).runImpl(0, 64, 0, 'raw_iron', 'wooden_pickaxe', 3);
    expect(spare.furnace.putFuel).toHaveBeenCalledWith(2, null, 1);
  });

  it('recognizes fuel already burning after its slot becomes empty', async () => {
    const { bot, furnace } = fixture([], { rawIron: 0, furnaceInput: 10, burningSeconds: 70 });
    const result = await new StartSmelting(bot).runImpl(0, 64, 0, 'raw_iron', 'coal', 10);

    expect(result).toMatchObject({ success: true });
    expect(result.result).toContain('約7個のみ精錬可能');
    expect(furnace.putFuel).not.toHaveBeenCalled();
    expect(bot.activeFurnaces).toMatchObject([{ item: 'raw_iron', count: 7 }]);
  });
});
