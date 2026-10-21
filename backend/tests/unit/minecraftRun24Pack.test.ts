import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';

// Run 24: dirt, granite, diorite, andesite and cobblestone were thrown away in five calls before the descent to the diamonds (36 s, a pit
// or a walk away each); a spare stone pickaxe and an iron one were thrown into the hole dug for a throw, twice, and fetched back.
//   - drop-item takes several kinds as one list ("dirt:35,granite:27") and throws them from one place after one preparation;
//   - the body's own tidy asks for one such throw, not one per kind;
//   - a tool is never thrown by the tidy.

vi.mock('../../src/services/minebot/execution/observedWait.js', async (original) => ({
  ...(await original() as object), actionDelay: vi.fn(async () => {}),
}));

const { executeAction } = await import('../../src/services/minebot/execution/ActionExecution.js');
const { default: DropItem, parseDropList } = await import('../../src/services/minebot/instantSkills/dropItem.js');
const { clutterToThrow, tidyIfCluttered, tidyPackNow, throwKinds, MAX_KINDS_PER_THROW } = await import('../../src/services/minebot/utils/inventoryRoom.js');
const { repairTierToolMaterials } = await import('../../src/services/minebot/utils/registryRepairs.js');

const require = createRequire(import.meta.url);
const registry = require('prismarine-registry')('1.21.11');
repairTierToolMaterials(registry);
const Block = require('prismarine-block')(registry);
const stack = (name: string, count: number) => ({ name, count, type: registry.itemsByName[name].id });
const cellKey = (p: { x: number; y: number; z: number }) => `${p.x},${p.y},${p.z}`;

describe('several kinds in one throw: the list', () => {
  it('reads "name:count" pairs, a kind with no count is all of it, and a single name is not a list', () => {
    expect(parseDropList('dirt')).toBeNull();
    expect(parseDropList('dirt:35,granite:27,diorite')).toEqual([{ name: 'dirt', count: 35 }, { name: 'granite', count: 27 }, { name: 'diorite', count: null }]);
    expect(parseDropList('dirt:10, dirt:5')).toEqual([{ name: 'dirt', count: 15 }]);
    expect(parseDropList('dirt:10,dirt')).toEqual([{ name: 'dirt', count: null }]);
    expect(parseDropList(' ,dirt: ')).toEqual([{ name: 'dirt', count: null }]);
  });
});

describe('drop-item throws several kinds from one place (run 24: five calls, 36 s)', () => {
  /** A pool of lava three blocks off in a flat world, the body at the origin with the pack given: what is thrown into it is gone. */
  function lavaBody(pack: any[]) {
    const set = new Map<string, string>();
    for (const x of [3, 4]) for (const z of [-1, 0, 1]) set.set(`${x},63,${z}`, 'lava');
    const blockAt = (at: Vec3) => {
      const p = at.floored();
      const name = set.get(cellKey(p)) ?? (p.y <= 63 ? 'stone' : 'air');
      const block = Block.fromStateId(registry.blocksByName[name].defaultState, 0);
      block.position = p;
      return block;
    };
    const aimed: Vec3[] = [];
    const bot: any = Object.assign(new EventEmitter(), {
      registry, health: 20, food: 20, entities: {}, username: 'shannon', interruptExecution: false,
      entity: { position: new Vec3(0.5, 64, 0.5), height: 1.8, onGround: true, velocity: new Vec3(0, 0, 0) },
      inventory: { items: () => pack, emptySlotCount: () => 36 - pack.length, slots: [] },
      blockAt,
      toss: vi.fn(async (type: number, _meta: unknown, count: number) => {
        let left = count;
        for (const entry of [...pack]) if (entry.type === type && left > 0) { const take = Math.min(left, entry.count); entry.count -= take; left -= take; if (!entry.count) pack.splice(pack.indexOf(entry), 1); }
      }),
      equip: vi.fn(async () => {}), lookAt: vi.fn(async (point: Vec3) => { aimed.push(point); }), look: vi.fn(async () => {}),
      stopDigging: vi.fn(), clearControlStates: vi.fn(), pathfinder: { stop: vi.fn(), setGoal: vi.fn() }, heldItem: null,
    });
    const moveTo = { run: vi.fn(async () => ({ success: true })) };
    const drop = new DropItem(bot);
    bot.instantSkills = { getSkill: (name: string) => (name === 'drop-item' ? drop : name === 'move-to' ? moveTo : undefined) };
    bot.constantSkills = { getSkills: () => [] };
    return { bot, drop, pack, moveTo, aimed };
  }
  const inAction = <T>(bot: any, work: () => Promise<T>) => executeAction(bot, 'drop-item', 0, async () => ({ success: true, result: await work() }) as any);

  it('throws dirt, granite and cobblestone into the lava in one call: one aim, one wait, nobody walks off', async () => {
    const { bot, drop, pack, moveTo, aimed } = lavaBody([stack('dirt', 35), stack('granite', 27), stack('cobblestone', 100), { ...stack('stone_pickaxe', 1), maxDurability: 131, durabilityUsed: 0 }]);
    const result: any = await drop.run('dirt:35,granite:27,cobblestone:60', 1);
    expect(result.success).toBe(true);
    expect(result.result).toContain('dirtを35個');
    expect(result.result).toContain('graniteを27個');
    expect(result.result).toContain('cobblestoneを60個');
    expect(result.result).toContain('溶岩へ投げ込んで消しました');
    expect(bot.toss).toHaveBeenCalledTimes(3);
    expect(aimed.filter(point => point.x >= 3 && point.x <= 5)).toHaveLength(1);
    expect(moveTo.run).not.toHaveBeenCalled();
    const left = (name: string) => pack.filter(item => item.name === name).reduce((sum, item) => sum + item.count, 0);
    expect([left('dirt'), left('granite'), left('cobblestone'), left('stone_pickaxe')]).toEqual([0, 0, 40, 1]);
  });

  it('a kind with no count is all of it, a kind not carried is passed over, and nothing carried is said', async () => {
    const one = lavaBody([stack('dirt', 20), stack('cobblestone', 50)]);
    const result: any = await one.drop.run('dirt,gravel,cobblestone:10', 1);
    expect(result.success).toBe(true);
    expect(one.bot.toss).toHaveBeenCalledTimes(2);
    expect(one.pack.filter(item => item.name === 'dirt')).toHaveLength(0);
    expect(one.pack.find(item => item.name === 'cobblestone')?.count).toBe(40);
    const none = lavaBody([stack('cobblestone', 5)]);
    const failed: any = await none.drop.run('gravel:3,sand', 1);
    expect(failed.success).toBe(false);
    expect(failed.result).toContain('gravel');
  });

  it('a single kind is thrown as it always was (count taken from the second argument)', async () => {
    const { bot, drop, pack } = lavaBody([stack('cobblestone', 100)]);
    const result: any = await drop.run('cobblestone', 30);
    expect(result.success).toBe(true);
    expect(result.result).toContain('cobblestoneを30個');
    expect(bot.toss).toHaveBeenCalledTimes(1);
    expect(pack[0].count).toBe(70);
    void inAction;
  });
});

describe('the body\'s own tidy asks for one throw of several kinds, and never throws a tool', () => {
  const item = (name: string, count = 1) => ({ name, count, type: registry.itemsByName[name]?.id ?? 1, maxDurability: name.endsWith('_pickaxe') ? 250 : undefined, durabilityUsed: 0 });
  const room = (items: any[]) => ({ inventory: { items: () => items, emptySlotCount: () => 36 - items.length } }) as any;
  const filler = (n: number) => Array.from({ length: n }, (_, i) => ({ name: ['coal', 'bread', 'iron_ingot', 'sand_x', 'bone', 'string'][i % 6] + (i >= 6 ? i : ''), count: 1, type: 1 }));

  it('one drop-item with the list for the kinds over their limits', async () => {
    const pack = [...Array.from({ length: 9 }, () => stack('cobblestone', 64)), ...Array.from({ length: 4 }, () => stack('andesite', 64)), ...Array.from({ length: 4 }, () => stack('dirt', 64)), ...filler(10)];
    const call = vi.fn(async () => ({ success: true }));
    const note = await tidyIfCluttered(room(pack), call, { now: () => 1000 });
    expect(call).toHaveBeenCalledTimes(1);
    const args = call.mock.calls[0] as unknown as string[];
    expect(args[0]).toBe('drop-item');
    expect(args[1]).toMatch(/^cobblestone:480,andesite:256/);
    expect(args).toHaveLength(2);
    expect(note).toContain('cobblestone×480');
    expect(note).toContain('andesite×256');
  });

  it('a single kind keeps the plain call', async () => {
    const pack = [...Array.from({ length: 9 }, () => stack('cobblestone', 64)), ...filler(10)];
    const call = vi.fn(async () => ({ success: true }));
    await tidyIfCluttered(room(pack), call, { now: () => 1000 });
    expect(call).toHaveBeenCalledWith('drop-item', 'cobblestone', 480);
    expect(throwKinds(call as any, [{ name: 'dirt', count: 3 }])).toBeDefined();
    expect(MAX_KINDS_PER_THROW).toBeGreaterThanOrEqual(3);
  });

  it('the plan of a nearly full pack is thrown in one call too (tidyPackNow)', async () => {
    const pack = [stack('andesite', 64), stack('diorite', 64), stack('granite', 64), stack('tuff', 64), stack('dirt', 64), stack('gravel', 64), ...filler(26)];
    const call = vi.fn(async () => ({ success: true }));
    await tidyPackNow(room(pack), call, {});
    expect(call.mock.calls.filter(args => (args as unknown as string[])[0] === 'drop-item')).toHaveLength(1);
  });

  it('a spare pickaxe, an iron one, a sword are never named', () => {
    const pack = [item('iron_pickaxe'), item('stone_pickaxe'), item('stone_pickaxe'), item('stone_pickaxe'), item('iron_sword'), ...filler(5)];
    expect(clutterToThrow(room(pack))).toEqual([]);
    expect(clutterToThrow(room([...pack, ...Array.from({ length: 9 }, () => stack('cobblestone', 64))])).map(entry => entry.name)).toEqual(['cobblestone']);
  });
});
