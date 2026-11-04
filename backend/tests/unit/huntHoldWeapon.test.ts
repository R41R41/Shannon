import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { attack } from '../../src/services/minebot/utils/primitives/attack.js';

// A hold that swings an empty hand at a blaze (S2 lab, 2026-11-02: 9 blows in 110 s beside a spawner, no kill): the best sword or axe carried goes into the hand first,
// one already held stays, and the line says what was taken up.

type Cell = { name: string; boundingBox: string };
const STONE: Cell = { name: 'stone', boundingBox: 'block' }, AIR: Cell = { name: 'air', boundingBox: 'empty' };

function flat(held: { name: string; type: number } | null, pack: Array<{ name: string; type: number; count: number }>) {
  const bot: any = Object.assign(new EventEmitter(), {
    entity: { id: 1, position: new Vec3(0.5, 64, 0.5), yaw: 0, onGround: true },
    health: 20, food: 20, game: { dimension: 'the_nether' }, entities: {} as Record<number, any>,
    registry: { blocksByName: {}, entitiesByName: { blaze: { type: 'hostile' } }, itemsByName: {}, items: {} },
    inventory: { items: () => [...pack], slots: new Array(46).fill(null) },
    heldItem: held,
    blockAt: (p: Vec3) => { const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z); return { ...(y < 64 ? STONE : AIR), position: new Vec3(x, y, z) }; },
    setControlState: () => undefined, clearControlStates: () => undefined, lookAt: async () => undefined, pathfinder: { setGoal: () => undefined },
    equips: [] as string[],
    equip: async (item: any, destination?: string) => {
      bot.equips.push(item.name);
      if (destination === 'off-hand') { bot.inventory.slots[45] = { name: item.name, durabilityUsed: 0 }; return; }
      bot.heldItem = { name: item.name, type: item.type }; bot.emit('heldItemChanged');
    },
  });
  return bot;
}
const ctx = (bot: any) => ({ bot, stop: new AbortController().signal, deadline: Date.now() + 120_000, facing: 'north' as const, base: { x: 0, y: 64, z: 0 } });
const blaze = (id: number, x: number, y: number, z: number) => ({ id, name: 'blaze', type: 'hostile', height: 1.8, width: 0.6, position: new Vec3(x, y, z) });

async function holdAgainstBlaze(bot: any) {
  bot.entities = { 5: blaze(5, 2.5, 64, 0.5) };
  const swungWith: string[] = [];
  bot.attack = () => { swungWith.push(String(bot.heldItem?.name ?? 'hand')); };
  const running = attack(ctx(bot), { mode: 'hold', target: 'blaze', maxSeconds: 3 });
  await vi.advanceTimersByTimeAsync(4_000);
  return { out: await running, swungWith };
}

describe('attack hold: what is in the hand when the blows are struck', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('an empty hand and swords in the pack: the best sword is taken up first, every blow is struck with it, and the line says so', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const bot = flat(null, [{ name: 'stone_sword', type: 3, count: 1 }, { name: 'diamond_sword', type: 7, count: 1 }, { name: 'cobblestone', type: 9, count: 20 }]);
    const { out, swungWith } = await holdAgainstBlaze(bot);
    expect(bot.equips).toEqual(['diamond_sword']);
    expect(swungWith.length).toBeGreaterThan(0);
    expect(new Set(swungWith)).toEqual(new Set(['diamond_sword']));
    expect(out.ok).toBe(true);
    expect(out.text).toContain('diamond_sword を手に持った');
  });

  it('a sword or axe already in the hand stays there (a better one in the pack is the planner\'s to choose)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const bot = flat({ name: 'iron_sword', type: 5 }, [{ name: 'diamond_sword', type: 7, count: 1 }]);
    const { out, swungWith } = await holdAgainstBlaze(bot);
    expect(bot.equips).toEqual([]);
    expect(new Set(swungWith)).toEqual(new Set(['iron_sword']));
    expect(out.text).not.toContain('手に持った');
  });

  it('a pickaxe in the hand is not a weapon: the sword in the pack is taken up; with no sword or axe at all nothing is changed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const pick = flat({ name: 'iron_pickaxe', type: 4 }, [{ name: 'iron_sword', type: 5, count: 1 }]);
    expect((await holdAgainstBlaze(pick)).swungWith.every(name => name === 'iron_sword')).toBe(true);
    expect(pick.equips).toEqual(['iron_sword']);
    const bare = flat({ name: 'iron_pickaxe', type: 4 }, [{ name: 'cobblestone', type: 9, count: 5 }]);
    const { out } = await holdAgainstBlaze(bare);
    expect(bare.equips).toEqual([]);
    expect(out.text).not.toContain('手に持った');
  });
});

describe('attack hold: a shield that breaks is replaced from the pack', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('the broken shield is swapped for the spare at once, the wear counts what the broken one had left and what the new one took, and the line says so', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const bot = flat({ name: 'iron_sword', type: 5 }, [{ name: 'shield', type: 11, count: 1 }]);
    bot.inventory.slots[45] = { name: 'shield', durabilityUsed: 300 };
    bot.entities = { 5: blaze(5, 2.5, 64, 0.5) };
    bot.attack = vi.fn();
    bot.activateItem = vi.fn();
    bot.deactivateItem = vi.fn();
    // The shield breaks 1.5 s in (the game empties the slot), and the spare takes 12 more by the end.
    setTimeout(() => { bot.inventory.slots[45] = null; }, 1_500);
    setTimeout(() => { if (bot.inventory.slots[45]) bot.inventory.slots[45].durabilityUsed = 12; }, 3_200);
    const running = attack(ctx(bot), { mode: 'hold', target: 'blaze', maxSeconds: 4 });
    await vi.advanceTimersByTimeAsync(5_000);
    const out = await running;
    expect(bot.equips).toEqual(['shield']);
    expect(out.ok).toBe(true);
    // 336 − 300 = 36 left on the broken one, 12 on the new one.
    expect(out.text).toContain('盾 −48');
    expect(out.text).toContain('予備に替えた×1');
  });

  it('no spare in the pack: the shield that broke is told as broken, and nothing is equipped', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const bot = flat({ name: 'iron_sword', type: 5 }, []);
    bot.inventory.slots[45] = { name: 'shield', durabilityUsed: 300 };
    bot.entities = { 5: blaze(5, 2.5, 64, 0.5) };
    bot.attack = vi.fn(); bot.activateItem = vi.fn(); bot.deactivateItem = vi.fn();
    setTimeout(() => { bot.inventory.slots[45] = null; }, 1_000);
    const running = attack(ctx(bot), { mode: 'hold', target: 'blaze', maxSeconds: 3 });
    await vi.advanceTimersByTimeAsync(4_000);
    const out = await running;
    expect(bot.equips).toEqual([]);
    expect(out.text).toContain('盾が壊れた');
    expect(out.text).not.toContain('予備');
  });
});
