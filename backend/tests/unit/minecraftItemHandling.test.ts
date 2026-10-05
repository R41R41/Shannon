import { describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import EquipItem from '../../src/services/minebot/instantSkills/equipItem.js';
import UseItemOnBlock from '../../src/services/minebot/instantSkills/useItemOnBlock.js';
import UseItem from '../../src/services/minebot/instantSkills/useItem.js';

function botWith(items: string[]) {
  const inventory = items.map((name, index) => ({ name, count: 1, type: index + 1 }));
  const bot: any = {
    registry: { itemsByName: Object.fromEntries(['bucket', 'water_bucket', 'lava_bucket', 'diamond_pickaxe', 'flint_and_steel']
      .map((name, id) => [name, { id }])) },
    heldItem: null,
    inventory: { items: () => inventory, slots: [] },
    getEquipmentDestSlot: () => 36,
    entity: { position: new Vec3(0, 100, 0) },
    equip: vi.fn(async (item: any) => { bot.heldItem = item; }),
    unequip: vi.fn(async () => {}),
    lookAt: vi.fn(async () => {}),
    activateBlock: vi.fn(async () => {}),
    blockAt: () => ({ name: 'stone', position: new Vec3(1, 99, 0) }),
  };
  return bot;
}

describe('item handling for bucket and portal work', () => {
  it('does not equip an empty bucket when water_bucket is requested', async () => {
    // Nether chain diagnosis 2026-10-01: the fuzzy match reported water_bucket equipped.
    const bot = botWith(['bucket', 'diamond_pickaxe']);
    const result = await new EquipItem(bot).runImpl('water_bucket', 'main');
    expect(result.success).toBe(false);
    expect(bot.equip).not.toHaveBeenCalled();
    const exact = await new EquipItem(bot).runImpl('bucket', 'main');
    expect(exact).toMatchObject({ success: true, result: expect.stringContaining('bucket') });
    expect(bot.heldItem.name).toBe('bucket');
  });

  it('equips the named item immediately before using it on a block', async () => {
    const bot = botWith(['diamond_pickaxe', 'flint_and_steel']);
    bot.heldItem = bot.inventory.items()[0];
    const result = await new UseItemOnBlock(bot).runImpl(1, 99, 0, 'flint_and_steel');
    expect(bot.equip).toHaveBeenCalledWith(expect.objectContaining({ name: 'flint_and_steel' }), 'hand');
    expect(result).toMatchObject({ success: true, result: expect.stringContaining('flint_and_steel') });

    const missing = await new UseItemOnBlock(botWith(['bucket'])).runImpl(1, 99, 0, 'water_bucket');
    expect(missing).toMatchObject({ success: false, failureType: 'material_missing' });
  });

  it('judges eating by the pack and the hunger bar, not by the library\'s wait (paid run L66: eaten, answered "Promise timed out")', async () => {
    const eater = (food: number, consume: (bot: any) => Promise<void>) => {
      const stack = { name: 'cooked_beef', count: 3, type: 1 };
      const bot: any = { version: '1.21.4', food, heldItem: null, inventory: { items: () => (stack.count > 0 ? [stack] : []), slots: [] },
        equip: vi.fn(async (item: any) => { bot.heldItem = item; }), activateItem: vi.fn(async () => {}), stack };
      bot.consume = vi.fn(() => consume(bot));
      return bot;
    };
    // The eating reflex was already chewing: the item goes and the bar rises, and the library's wait times out.
    const shared = eater(14, async bot => { bot.stack.count--; bot.food = 20; throw new Error('Promise timed out.'); });
    expect(await new UseItem(shared).runImpl('cooked_beef')).toMatchObject({ success: true, result: expect.stringContaining('14→20') });
    const plain = eater(10, async bot => { bot.stack.count--; bot.food = 18; });
    expect(await new UseItem(plain).runImpl('cooked_beef')).toMatchObject({ success: true, result: expect.stringContaining('残り2個') });
    // Full: nothing is eaten, and the answer says why.
    const full = eater(20, async () => { throw new Error('Food is full'); });
    expect(await new UseItem(full).runImpl('cooked_beef')).toMatchObject({ success: false, failureType: 'not_hungry' });
    // Hungry and nothing changed: a failure, with what the library said.
    const stuck = eater(8, async () => { throw new Error('Promise timed out.'); });
    const result = await new UseItem(stuck).runImpl('cooked_beef');
    expect(result).toMatchObject({ success: false });
    expect(result.result).toContain('Promise timed out');
  });

  it('a bucket is aimed at a point of the source the eyes can reach, and says what is in the way when there is none (paid run L74: seven calls on one pool)', () => {
    // Water source at (3, 63, 0), one below the level the body stands on; ground is stone at y<=63 elsewhere.
    const water = new Vec3(3, 63, 0);
    const world = (extra: (pos: Vec3) => any = () => null) => (pos: Vec3) => extra(pos)
      ?? (pos.equals(water) ? { name: 'water', boundingBox: 'empty' } : pos.y <= 63 ? { name: 'stone', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' });
    const beside: any = { entity: { position: new Vec3(2.5, 64, 0.5) }, blockAt: world() };
    const aim = (new UseItemOnBlock(beside) as any).liquidAim(water);
    expect(aim.point).toBeTruthy();
    expect(aim.point.y).toBeCloseTo(63.9); // the surface, seen from above
    // From four blocks back at the same level the bank is in the way of every point.
    const back: any = { entity: { position: new Vec3(-0.5, 64, 0.5) }, blockAt: world() };
    const hidden = (new UseItemOnBlock(back) as any).liquidAim(water);
    expect(hidden.point).toBeUndefined();
    expect(hidden.reason).toMatch(/視線を遮っています|届くのは/);
    // Too far for the hand, whatever the view.
    const far: any = { entity: { position: new Vec3(3.5, 70, 0.5) }, blockAt: world() };
    expect((new UseItemOnBlock(far) as any).liquidAim(water).reason).toContain('届くのは4.3mまで');
  });
});

