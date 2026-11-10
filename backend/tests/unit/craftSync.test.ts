import { describe, expect, it } from 'vitest';
import { resolveWoodName, roomFor } from '../../src/services/minebot/utils/primitives/craftSync.js';

/** Task 193a86b0 (11/10): 「craft item=planks」 refused as no item name; a full pack's craft lost its materials. */
const names = ['oak_planks', 'spruce_planks', 'birch_planks', 'oak_log', 'spruce_log', 'stripped_spruce_log', 'crimson_stem', 'crimson_planks',
  'oak_slab', 'spruce_slab', 'stick', 'oak_door', 'oak_boat'];
const bot = (items: Array<[string, number]>, slots = 36) => ({
  registry: { itemsByName: Object.fromEntries(names.map((name, id) => [name, { id, name, stackSize: name.endsWith('_door') || name.endsWith('_boat') ? 1 : 64 }])) },
  inventory: { items: () => items.map(([name, count]) => ({ name, count })), slots: Array.from({ length: 45 }, (_, slot) => slot >= 9 && slot - 9 < items.length ? {} : null) },
  _free: slots - items.length,
});

describe('a generic wood name is the kind the pack holds', () => {
  it('takes the kind with the most logs and planks, any form; else oak', () => {
    expect(resolveWoodName(bot([['spruce_log', 2], ['stripped_spruce_log', 3], ['oak_log', 1]]), 'planks')).toBe('spruce_planks');
    expect(resolveWoodName(bot([]), 'planks')).toBe('oak_planks');
    expect(resolveWoodName(bot([['spruce_planks', 4]]), 'slab')).toBe('spruce_slab');
    expect(resolveWoodName(bot([['spruce_log', 4]]), 'door')).toBe('oak_door');
    expect(resolveWoodName(bot([['crimson_planks', 4]]), 'log')).toBe('crimson_stem');
  });
  it('gives back a name the registry knows, and one that is not a wood name', () => {
    expect(resolveWoodName(bot([['spruce_log', 4]]), 'oak_planks')).toBe('oak_planks');
    expect(resolveWoodName(bot([['spruce_log', 4]]), 'pickaxe')).toBe('pickaxe');
  });
});

describe('room for a craft\'s result', () => {
  it('is a free slot or a stack of it that is not full', () => {
    const full = (items: Array<[string, number]>) => ({ ...bot(items), inventory: { items: () => items.map(([name, count]) => ({ name, count })), slots: Array.from({ length: 45 }, () => ({ name: 'x', count: 1 })) } });
    expect(roomFor(full([['oak_planks', 60]]), 'oak_planks')).toBe(true);
    expect(roomFor(full([['oak_planks', 64]]), 'oak_planks')).toBe(false);
    expect(roomFor(full([['oak_log', 3]]), 'stick')).toBe(false);
  });
  it('counts an ingredient the craft uses up whole as room (its slot is free when the result comes)', () => {
    const full = (items: Array<[string, number]>) => ({ ...bot(items), inventory: { items: () => items.map(([name, count]) => ({ name, count })), slots: Array.from({ length: 45 }, () => ({ name: 'x', count: 1 })) } });
    const ids = Object.fromEntries(names.map((name, id) => [name, id]));
    const items = names.map((name, id) => ({ id, name }));
    const planks = { delta: [{ id: ids.oak_log, count: -1 }, { id: ids.oak_planks, count: 4 }] };
    const withItems = (b: any) => ({ ...b, registry: { ...b.registry, items } });
    expect(roomFor(withItems(full([['oak_log', 1]])), 'oak_planks', planks, 1)).toBe(true);
    expect(roomFor(withItems(full([['oak_log', 3]])), 'oak_planks', planks, 3)).toBe(true);
    expect(roomFor(withItems(full([['oak_log', 3]])), 'oak_planks', planks, 2)).toBe(false);
  });
});
