import { describe, expect, it } from 'vitest';
import minecraftData from 'minecraft-data';
import { withWoodForms } from '../../src/services/minebot/utils/primitives/woodRecipes.js';

/** Run 59 leg 2: 4 stripped oak logs in the pack, and "missing: oak_log×1" for planks and a crafting table. */
const mcData = minecraftData('1.21.11');
const id = (name: string) => mcData.itemsByName[name]!.id;
const bot = { registry: mcData };
const planksFromLog = { result: { id: id('oak_planks'), count: 4, metadata: null }, inShape: null, outShape: null,
  ingredients: [{ id: id('oak_log'), metadata: null, count: 1 }], delta: [{ id: id('oak_log'), metadata: null, count: -1 }, { id: id('oak_planks'), metadata: null, count: 4 }],
  requiresTable: false };

describe('planks from any form of their wood', () => {
  it('gives the oak planks recipe again for the stripped log, the wood and the stripped wood', () => {
    const all = withWoodForms(bot, 'oak_planks', [planksFromLog]);
    const takes = (name: string) => all.find(recipe => recipe.delta.some((entry: any) => entry.id === id(name) && entry.count < 0));
    for (const name of ['oak_log', 'stripped_oak_log', 'oak_wood', 'stripped_oak_wood']) expect(takes(name), name).toBeTruthy();
    const stripped = takes('stripped_oak_log');
    expect(stripped.ingredients).toEqual([{ id: id('stripped_oak_log'), metadata: null, count: 1 }]);
    expect(stripped.result).toEqual(planksFromLog.result);
    // The library's own recipe is not changed.
    expect(planksFromLog.ingredients[0]!.id).toBe(id('oak_log'));
  });
  it('a crimson plank takes the stems and hyphae; other items and a recipe with no wood are left as they are', () => {
    const stem = { ...planksFromLog, result: { id: id('crimson_planks'), count: 4, metadata: null }, ingredients: [{ id: id('crimson_stem'), metadata: null, count: 1 }],
      delta: [{ id: id('crimson_stem'), metadata: null, count: -1 }, { id: id('crimson_planks'), metadata: null, count: 4 }] };
    const all = withWoodForms(bot, 'crimson_planks', [stem]);
    expect(all.some(recipe => recipe.delta.some((entry: any) => entry.id === id('stripped_crimson_hyphae') && entry.count < 0))).toBe(true);
    expect(withWoodForms(bot, 'stick', [planksFromLog])).toHaveLength(1);
    expect(withWoodForms(bot, 'oak_planks', [{ ...planksFromLog, delta: [{ id: id('cobblestone'), metadata: null, count: -1 }] }])).toHaveLength(1);
  });
});
