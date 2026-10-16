import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';
import DigBlockAt from '../../src/services/minebot/instantSkills/digBlockAt.js';
import MineBlock from '../../src/services/minebot/instantSkills/mineBlock.js';

// Production run 14: "stone_pickaxe を装備しました" was logged and coal ore was then dug by bare hand (15 s each, no drop)
// with the pickaxes in inventory slots 10/12. bot.equip() resolving is not the tool being in the hand.

const coal = (p: Vec3) => ({ name: 'coal_ore', boundingBox: 'block', diggable: true, position: p, harvestTools: { 7: true } });
const pickaxeAt = (slot: number) => ({ name: 'stone_pickaxe', type: 7, count: 1, slot, maxDurability: 131, durabilityUsed: 0 });

/** A body whose bot.equip() resolves without changing the hand (the failure seen in production). */
function body(opts: { slot?: number; moveWorks?: boolean; equipWorks?: boolean; hotbar?: any[] } = {}) {
  const target = new Vec3(5, 40, 5);
  const pickaxe = pickaxeAt(opts.slot ?? 10);
  const slots: any[] = Array(46).fill(null);
  slots[pickaxe.slot] = pickaxe;
  (opts.hotbar ?? []).forEach((item, i) => { slots[36 + i] = item; });
  const calls = { equip: 0, move: [] as number[][], quickBar: [] as number[], dig: 0 };
  let quickBarSlot = 0;
  const bot: any = Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(5.5, 40, 4.5), onGround: true, isInWater: false }, health: 20, oxygenLevel: 20,
    version: '1.21.11', registry: minecraftData('1.21.11'), entities: {}, inventory: { slots, items: () => slots.filter(Boolean), emptySlotCount: () => 10 },
    equip: async (item: any) => {
      calls.equip++;
      if (opts.equipWorks) { slots[36] = item; slots[item.slot] = null; item.slot = 36; quickBarSlot = 0; }
    },
    moveSlotItem: async (from: number, to: number) => {
      calls.move.push([from, to]);
      if (opts.moveWorks !== false) { const a = slots[from]; slots[from] = slots[to]; slots[to] = a; if (a) a.slot = to; if (slots[from]) slots[from].slot = from; }
    },
    setQuickBarSlot: (index: number) => { calls.quickBar.push(index); if (opts.moveWorks !== false) quickBarSlot = index; },
    digTime: () => 15_000, canDigBlock: () => true,
    blockAt: (at: Vec3) => { const p = at.floored(); return p.equals(target) ? coal(target) : p.y >= 41 ? { name: 'air', boundingBox: 'empty' } : { name: 'stone', boundingBox: 'block', diggable: true, position: p }; },
    dig: async () => { calls.dig++; throw new Error('not reached in these cases'); },
  });
  // Getters, defined after Object.assign (which would copy their values once).
  Object.defineProperty(bot, 'heldItem', { get: () => slots[36 + quickBarSlot] ?? null });
  Object.defineProperty(bot, 'quickBarSlot', { get: () => quickBarSlot });
  return { bot, calls, slots, pickaxe };
}

describe('dig-block-at puts the tool in the hand, and checks it is there', () => {
  it('equip resolves with an empty hand: moves the tool into an empty hotbar slot, selects it, and digs with it', async () => {
    const { bot, calls, slots } = body();
    const result: any = await new DigBlockAt(bot).runImpl(5, 40, 5);
    expect(calls.move).toEqual([[10, 36]]);
    expect(calls.quickBar).toEqual([0]);
    expect(bot.heldItem?.name).toBe('stone_pickaxe');
    expect(slots[36]?.name).toBe('stone_pickaxe');
    expect(result.failureType).not.toBe('equip_failed');
    expect(result.failureType).toBe('dig_unconfirmed'); // the dig was started (no server packets in the fake), pickaxe in hand
  });

  it('uses an empty hotbar slot rather than displacing the held item', async () => {
    const sword = { name: 'stone_sword', type: 3, count: 1, slot: 36 };
    const { bot, calls } = body({ hotbar: [sword] });
    await new DigBlockAt(bot).runImpl(5, 40, 5);
    expect(calls.move).toEqual([[10, 37]]);
    expect(calls.quickBar).toEqual([1]);
    expect(bot.heldItem?.name).toBe('stone_pickaxe');
  });

  it('does not dig, and says equip_failed, when the tool still is not in the hand after the retry', async () => {
    const { bot, calls } = body({ moveWorks: false });
    const result: any = await new DigBlockAt(bot).runImpl(5, 40, 5);
    expect(result).toMatchObject({ success: false, failureType: 'equip_failed', recoverable: true });
    expect(result.result).toContain('stone_pickaxe');
    expect(result.result).toContain('equip-item');
    expect(result.result).toContain('ホットバー');
    expect(calls.move).toEqual([[10, 36]]); // retried once, not looped
    expect(calls.dig).toBe(0);
  });

  it('leaves an ordinary equip alone: no retry, no slot moves, when the tool is in the hand afterwards', async () => {
    const { bot, calls } = body({ equipWorks: true });
    const result: any = await new DigBlockAt(bot).runImpl(5, 40, 5);
    expect(calls.equip).toBe(1);
    expect(calls.move).toEqual([]);
    expect(calls.quickBar).toEqual([]);
    expect(result.failureType).not.toBe('equip_failed');
    expect(result.failureType).toBe('dig_unconfirmed');
  });

  it('a pickaxe already held needs no equip result at all (existing behaviour)', async () => {
    const { bot, calls, slots, pickaxe } = body();
    slots[10] = null; slots[36] = pickaxe; pickaxe.slot = 36;
    const result: any = await new DigBlockAt(bot).runImpl(5, 40, 5);
    expect(calls.move).toEqual([]);
    expect(result.failureType).not.toBe('equip_failed');
    expect(result.failureType).toBe('dig_unconfirmed');
  });

  it('a block dug only to be gone (collect=false) may still be broken by hand, and says so', async () => {
    const { bot, calls } = body({ moveWorks: false });
    const result: any = await new DigBlockAt(bot).runImpl(5, 40, 5, false);
    expect(result.failureType).not.toBe('equip_failed');
    expect(result.failureType).toBe('dig_unconfirmed');
  });
});

describe('mine-block does not call a hand-dug ore a lost drop', () => {
  const registry = minecraftData('1.21.11');
  const mineWith = async (digResult: any) => {
    const items: any[] = [{ name: 'stone_pickaxe', type: registry.itemsByName.stone_pickaxe.id, count: 1 }];
    let dug = false;
    const bot: any = Object.assign(new EventEmitter(), {
      executingSkill: false, interruptExecution: false, clearControlStates: vi.fn(), stopDigging: vi.fn(), deactivateItem: vi.fn(),
      pathfinder: { stop: vi.fn(), setGoal: vi.fn() },
      version: '1.21.11', registry, entities: {}, entity: { position: new Vec3(0, 100, 0) },
      inventory: { items: () => items, emptySlotCount: () => 36 },
      blockAt: () => ({ name: dug ? 'air' : 'coal_ore' }), findBlocks: () => [new Vec3(1, 100, 0)],
      instantSkills: { getSkill: (name: string) => ({ run: async () => {
        if (name === 'dig-block-at') { dug = true; return digResult; }
        return { success: true, result: 'ok' };
      } }) } });
    return new MineBlock(bot).runImpl('coal_ore', 1, 8);
  };

  it('hand-dug (no proper tool in hand, so no drop by design): an explicit failure, not drops_lost success', async () => {
    const result: any = await mineWith({ success: true, result: 'ok', handDug: true });
    expect(result).toMatchObject({ success: false, failureType: 'hand_dug_no_drop', recoverable: true });
    expect(result.result).toContain('素手で掘ったためドロップはありません');
  });

  it('dug with the tool and nothing arrived: still drops_lost, as before', async () => {
    const result: any = await mineWith({ success: true, result: 'ok' });
    expect(result).toMatchObject({ success: true, failureType: 'drops_lost' });
  });

  it('an equip failure ends the order with its own failure type and message', async () => {
    const result: any = await mineWith({ success: false, failureType: 'equip_failed', recoverable: true, result: 'stone_pickaxeを手に持てなかった' });
    expect(result).toMatchObject({ success: false, failureType: 'equip_failed' });
    expect(result.result).toContain('装備失敗');
  });
});
