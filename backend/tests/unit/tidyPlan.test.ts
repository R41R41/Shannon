import { describe, expect, it } from 'vitest';
import { describeHeaps, planTidy, slotsFor, type TidyStack } from '../../src/services/minebot/utils/tidyPlan.js';

// Design flow-1111 A: tidy's plan, from the pack and a few facts (no body, no world).
const pack = (...entries: Array<[string, number, Partial<TidyStack>?]>): TidyStack[] => entries.map(([name, count, more]) => ({ name, count, ...(more ?? {}) }));
const slots = (items: TidyStack[]) => items.reduce((sum, item) => sum + slotsFor(item.count, item.stackSize ?? (item.maxDurability ? 1 : 64)), 0);
const facts = (items: TidyStack[], more: Record<string, unknown> = {}) => ({ free: 36 - slots(items), table: false, furnace: false, ...more });
const thrown = (plan: ReturnType<typeof planTidy>) => Object.fromEntries(plan.throw.map(entry => [entry.item, entry.count]));

describe('planTidy', () => {
  const mixed = () => pack(['cobblestone', 192], ['diorite', 15], ['dirt', 17], ['wooden_sword', 1], ['rotten_flesh', 4], ['raw_iron', 8], ['raw_copper', 3],
    ['iron_pickaxe', 1, { maxDurability: 250 }], ['bread', 10], ['coal', 6]);

  it('throws the scraps and the loose rock first, keeps the scaffold, and stops at room', () => {
    const items = mixed();
    const plan = planTidy(items, { room: 4 }, facts(items, { free: 1 }));
    const out = thrown(plan);
    expect(out.rotten_flesh).toBe(4);
    expect(out.diorite).toBe(15);
    expect(out.dirt).toBe(17);
    expect(out.cobblestone).toBeUndefined();   // room reached before the scaffold is cut
    expect(plan.after).toBeGreaterThanOrEqual(4);
  });

  it('cuts the scaffold to 128 and then 64 only while room is short, and throws raw copper last', () => {
    const items = pack(['cobblestone', 192], ['raw_copper', 3]);
    const ease = planTidy(items, { room: 2 }, facts(items, { free: 1 }));
    expect(thrown(ease)).toEqual({ cobblestone: 64 });
    const tight = planTidy(items, { room: 3 }, facts(items, { free: 1 }));
    expect(thrown(tight).cobblestone).toBe(128);
    expect(thrown(tight).raw_copper).toBeUndefined();
    const all = planTidy(pack(['cobblestone', 192], ['raw_copper', 3]), { room: 5 }, { free: 1, table: false, furnace: false });
    expect(thrown(all).raw_copper).toBe(3);
  });

  it('smelts raw iron when a furnace is near and fuel is held, and not otherwise', () => {
    const items = mixed();
    const near = planTidy(items, { room: 1 }, facts(items, { furnace: true }));
    expect(near.smelt).toEqual([{ item: 'raw_iron', count: 8 }]);
    expect(near.fuel).toEqual({ item: 'coal', count: 1 });
    const far = planTidy(items, { room: 1 }, facts(items, { furnace: false }));
    expect(far.smelt).toEqual([]);
    expect(far.why.join('')).toContain('炉が遠い');
    const off = planTidy(items, { room: 1, smelt: false }, facts(items, { furnace: true }));
    expect(off.smelt).toEqual([]);
    const noFuel = planTidy(pack(['raw_iron', 8]), {}, { free: 5, table: false, furnace: true });
    expect(noFuel.smelt).toEqual([]);
    expect(noFuel.why.join('')).toContain('燃料');
  });

  it('never throws raw iron while it can be smelted, and a few raw iron beside plenty of ingots go as the last thing when no furnace is there', () => {
    const items = pack(['raw_iron', 3], ['iron_ingot', 30], ['cobblestone', 64]);
    const plan = planTidy(items, { room: 30 }, { free: 0, table: false, furnace: false });
    expect(thrown(plan).raw_iron).toBe(3);
    const near = planTidy(pack(['raw_iron', 8], ['coal', 3]), { room: 30 }, { free: 0, table: false, furnace: true });
    expect(thrown(near).raw_iron).toBeUndefined();
  });

  it('smelts every raw iron and raw gold left, and keep= never stops a smelt', () => {
    const f = { free: 5, table: false, furnace: true };
    const odd = planTidy(pack(['raw_iron', 2], ['iron_ingot', 30], ['coal', 3]), { room: 30 }, f);
    expect(odd.smelt).toEqual([{ item: 'raw_iron', count: 2 }]);
    const gold = planTidy(pack(['raw_gold', 3], ['coal', 3]), { room: 30 }, f);
    expect(gold.smelt).toEqual([{ item: 'raw_gold', count: 3 }]);
    const held = planTidy(pack(['raw_iron', 8], ['coal', 3]), { room: 30, keep: [{ item: 'raw_iron', count: 8 }] }, f);
    expect(held.smelt).toEqual([{ item: 'raw_iron', count: 8 }]);
    expect(thrown(held).raw_iron).toBeUndefined();
  });

  it('does not burn the logs and planks the pack needs, nor coal that is kept', () => {
    const f = { free: 5, table: false, furnace: true };
    const wood = planTidy(pack(['raw_iron', 8], ['oak_log', 4]), { room: 30 }, f);
    expect(wood.smelt).toEqual([]);
    const more = planTidy(pack(['raw_iron', 8], ['oak_log', 10]), { room: 30 }, f);
    expect(more.fuel).toEqual({ item: 'oak_log', count: 6 });
  });

  it('keep= on coal never stops the smelt (the head holds coal back for the iron itself)', () => {
    const f = { free: 5, table: false, furnace: true };
    const coal = planTidy(pack(['raw_iron', 8], ['coal', 2]), { room: 30, keep: [{ item: 'coal', count: 2 }] }, f);
    expect(coal.smelt).toEqual([{ item: 'raw_iron', count: 8 }]);
    expect(coal.fuel).toEqual({ item: 'coal', count: 1 });
  });

  it('does not throw the third iron pickaxe when room is short', () => {
    const items = pack(['iron_pickaxe', 3, { maxDurability: 250 }], ['dirt', 40], ['cobblestone', 64]);
    const plan = planTidy(items, { room: 30 }, facts(items, { free: 1 }));
    expect(thrown(plan).iron_pickaxe).toBeUndefined();
  });

  it('treats cobblestone and cobbled deepslate as one scaffold pool, and netherrack as scaffold only in the Nether', () => {
    const both = pack(['cobblestone', 20], ['cobbled_deepslate', 30]);
    const a = planTidy(both, { room: 30 }, facts(both, { free: 1 }));
    expect(thrown(a)).toEqual({});   // 50 together are below 64: neither kind goes whole
    const big = pack(['cobblestone', 70], ['cobbled_deepslate', 30]);
    expect(thrown(planTidy(big, { room: 30 }, facts(big, { free: 1 })))).toEqual({ cobbled_deepslate: 30, cobblestone: 6 });   // the pool is then 70, trimmed to 64 as room is short
    const rack = pack(['netherrack', 40], ['cobblestone', 10]);
    const over = planTidy(rack, { room: 30 }, facts(rack, { free: 1 }));
    expect(thrown(over)).toEqual({ netherrack: 40 });   // cobblestone (8 stay anyway) is the scaffold outside the Nether
    const nether = planTidy(rack, { room: 30 }, facts(rack, { free: 1, nether: true }));
    expect(thrown(nether)).toEqual({});   // in the Nether netherrack is the scaffold, below 64; the cobblestone pool is below 64 too
  });

  it('keeps 4 gravel always, and 16 dirt when there is no scaffold rock', () => {
    const items = pack(['gravel', 100], ['dirt', 100]);
    const out = thrown(planTidy(items, { room: 20 }, facts(items, { free: 0 })));
    expect(out.gravel).toBe(96);
    expect(out.dirt).toBe(84);
    const withRock = pack(['cobblestone', 64], ['dirt', 100]);
    expect(thrown(planTidy(withRock, { room: 20 }, facts(withRock, { free: 0 }))).dirt).toBe(100);
  });

  it('keep= holds a thing back, and a named item is thrown whole whatever room says', () => {
    const items = pack(['diorite', 15], ['dirt', 70]);
    const kept = planTidy(items, { room: 5, keep: [{ item: 'dirt', count: 16 }] }, facts(items, { free: 1 }));
    expect(thrown(kept).dirt).toBe(54);   // keep 16 of 70
    const named = planTidy(pack(['cobblestone', 100], ['dirt', 5]), { items: [{ item: 'cobblestone', count: 30 }] }, { free: 30, table: false, furnace: false });
    expect(thrown(named)).toEqual({ cobblestone: 30 });
  });

  it('turns hay blocks into bread only with a table within reach', () => {
    const items = pack(['hay_block', 4], ['dirt', 3]);
    const without = planTidy(items, { room: 1 }, facts(items, { table: false }));
    expect(without.make).toEqual([]);
    const withTable = planTidy(items, { room: 1 }, facts(items, { table: true }));
    expect(withTable.make).toEqual([{ item: 'bread', count: 12, from: 'hay_block×4' }]);
  });

  it('does not make blocks of ingots or wheat bales (the slots do not shrink)', () => {
    const items = pack(['iron_ingot', 20], ['wheat', 12]);
    const plan = planTidy(items, { room: 20 }, facts(items, { table: true }));
    expect(plan.make).toEqual([]);
    expect(plan.throw).toEqual([]);
  });

  it('throws wooden tools beside better ones, but keeps a lone wooden pickaxe', () => {
    const items = pack(['wooden_pickaxe', 1, { maxDurability: 59 }], ['stone_pickaxe', 1, { maxDurability: 131 }], ['wooden_axe', 1, { maxDurability: 59 }], ['stone_sword', 1, { maxDurability: 131 }], ['iron_sword', 1, { maxDurability: 250 }]);
    const plan = planTidy(items, { room: 20 }, facts(items, { free: 0 }));
    const out = thrown(plan);
    expect(out.wooden_pickaxe).toBeUndefined();   // the drop keeps the last pickaxe of a kind, so it would free no slot
    expect(out.stone_sword).toBe(1);
    expect(out.wooden_axe).toBeUndefined();   // no better axe
    const lone = planTidy(pack(['wooden_pickaxe', 1, { maxDurability: 59 }]), { room: 30 }, { free: 5, table: false, furnace: false });
    expect(lone.throw).toEqual([]);
  });

  it('gives a no-room account of the heaps', () => {
    const words = describeHeaps(pack(['iron_ingot', 30], ['cobblestone', 64], ['bread', 5]), [{ item: 'oak_planks', count: 8 }]);
    expect(words).toContain('場所を取る物');
    expect(words).toContain('oak_planks:8');
  });
});
