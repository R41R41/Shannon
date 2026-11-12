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
    expect(out.wooden_pickaxe).toBe(1);
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
