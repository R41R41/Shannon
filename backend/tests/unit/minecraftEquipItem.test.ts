import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import minecraftData from 'minecraft-data';
import EquipItem from '../../src/services/minebot/instantSkills/equipItem.js';

// Production run 14: an explicit equip-item stone_pickaxe returned success while the hand stayed empty.

const DEST_SLOT: Record<string, number> = { hand: 36, 'off-hand': 45, head: 5, torso: 6, legs: 7, feet: 8 };

function body(opts: { slot?: number; moveWorks?: boolean; equipWorks?: boolean; itemName?: string; type?: number } = {}) {
  const item: any = { name: opts.itemName ?? 'stone_pickaxe', type: opts.type ?? 7, count: 1, slot: opts.slot ?? 10 };
  const slots: any[] = Array(46).fill(null);
  slots[item.slot] = item;
  const calls = { equip: [] as string[], move: [] as number[][], quickBar: [] as number[] };
  let quickBarSlot = 0;
  const bot: any = Object.assign(new EventEmitter(), {
    registry: minecraftData('1.21.11'),
    inventory: { slots, items: () => slots.slice(9, 45).filter(Boolean) },
    getEquipmentDestSlot: (dest: string) => DEST_SLOT[dest],
    equip: async (it: any, dest: string) => {
      calls.equip.push(dest);
      if (opts.equipWorks) {
        const to = DEST_SLOT[dest]; slots[it.slot] = null; slots[to] = it; it.slot = to; if (dest === 'hand') quickBarSlot = 0;
      }
    },
    moveSlotItem: async (from: number, to: number) => {
      calls.move.push([from, to]);
      if (opts.moveWorks !== false) { const a = slots[from]; slots[from] = slots[to]; slots[to] = a; if (a) a.slot = to; if (slots[from]) slots[from].slot = from; }
    },
    setQuickBarSlot: (i: number) => { calls.quickBar.push(i); if (opts.moveWorks !== false) quickBarSlot = i; },
    unequip: async () => {},
  });
  Object.defineProperty(bot, 'heldItem', { get: () => slots[36 + quickBarSlot] ?? null });
  Object.defineProperty(bot, 'quickBarSlot', { get: () => quickBarSlot });
  return { bot, calls, slots };
}

describe('equip-item checks the item is in the hand', () => {
  it('equip returns with an empty hand: retried through the hotbar, then reported as success', async () => {
    const { bot, calls } = body();
    const result: any = await new EquipItem(bot).runImpl('stone_pickaxe');
    expect(result).toMatchObject({ success: true });
    expect(result.result).toContain('stone_pickaxeをメインハンドに装備しました');
    expect(calls.move).toEqual([[10, 36]]);
    expect(calls.quickBar).toEqual([0]);
    expect(bot.heldItem?.name).toBe('stone_pickaxe');
  });

  it('still empty after the retry: a recoverable failure the planner can act on, not success', async () => {
    const { bot, calls } = body({ moveWorks: false });
    const result: any = await new EquipItem(bot).runImpl('stone_pickaxe');
    expect(result).toMatchObject({ success: false, failureType: 'equip_failed', recoverable: true });
    expect(result.result).toContain('ホットバー');
    expect(result.result).toContain('空きを作る');
    expect(calls.move).toEqual([[10, 36]]);
  });

  it('a working equip is unchanged: one equip call, no slot moves', async () => {
    const { bot, calls } = body({ equipWorks: true });
    const result: any = await new EquipItem(bot).runImpl('stone_pickaxe');
    expect(result).toMatchObject({ success: true });
    expect(result.result).toBe('stone_pickaxeをメインハンドに装備しました');
    expect(calls.equip).toEqual(['hand']);
    expect(calls.move).toEqual([]);
    expect(calls.quickBar).toEqual([]);
  });

  it('other destinations are not checked against the hand and are equipped as before', async () => {
    const { bot, calls } = body({ itemName: 'iron_helmet', type: 300, slot: 12 });
    const result: any = await new EquipItem(bot).runImpl('iron_helmet', 'head');
    expect(result).toMatchObject({ success: true });
    expect(result.result).toBe('iron_helmetを頭に装備しました');
    expect(calls.equip).toEqual(['head']);
    expect(calls.move).toEqual([]);
    expect(calls.quickBar).toEqual([]);
  });

  it('an item that is not in the inventory is still refused as before', async () => {
    const { bot } = body();
    const result: any = await new EquipItem(bot).runImpl('diamond_pickaxe');
    expect(result.success).toBe(false);
    expect(result.result).toContain('インベントリにdiamond_pickaxeがありません');
  });
});
