import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { repairTierToolMaterials } from '../../src/services/minebot/utils/registryRepairs.js';
import { chooseTool, installToolChoice, wearCostSeconds } from '../../src/services/minebot/utils/toolChoice.js';

const require = createRequire(import.meta.url);
const registry = require('prismarine-registry')('1.21.11');
repairTierToolMaterials(registry);
const Block = require('prismarine-block')(registry);
const block = (name: string) => Block.fromStateId(registry.blocksByName[name].defaultState, 0);
const item = (name: string, used = 0) => ({ type: registry.itemsByName[name].id, name, maxDurability: registry.itemsByName[name].maxDurability, durabilityUsed: used });
const bag = ['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe'].map(name => item(name));
const pick = (blockName: string, items = bag, requireHarvest = true) => chooseTool(block(blockName), items, { requireHarvest })?.name ?? 'hand';

describe('tool choice by time and wear', () => {
  it('keeps the better pickaxes for what needs them (L109: the iron pickaxe broke on stone)', () => {
    expect(pick('stone')).toBe('stone_pickaxe');
    expect(pick('iron_ore')).toBe('stone_pickaxe');
    expect(pick('diamond_ore')).toBe('iron_pickaxe');
    expect(pick('obsidian')).toBe('diamond_pickaxe');
  });

  it('uses a better tool when it is the only one that will do', () => {
    expect(pick('stone', [item('iron_pickaxe')])).toBe('iron_pickaxe');
    expect(pick('iron_ore', [item('wooden_pickaxe'), item('iron_pickaxe')])).toBe('iron_pickaxe');
  });

  it('clears soft blocks without spending a pickaxe', () => {
    expect(pick('dirt', bag, false)).toBe('hand');
    expect(pick('oak_planks', [item('iron_pickaxe'), item('stone_axe')], false)).toBe('stone_axe');
  });

  it('digs netherrack with the diamond pickaxe, not the hand four times slower (end1109f22/f24)', () => {
    expect(pick('netherrack', [item('diamond_pickaxe', 75)], false)).toBe('diamond_pickaxe');
    expect(pick('netherrack', [item('iron_pickaxe'), item('diamond_pickaxe')], false)).toBe('iron_pickaxe');
    // Nearly worn out: kept for what only it breaks, the hand clears the way.
    expect(pick('netherrack', [item('diamond_pickaxe', 1561 - 40)], false)).toBe('hand');
    expect(pick('dirt', [item('diamond_pickaxe')], false)).toBe('hand');
    expect(pick('obsidian', [item('diamond_pickaxe', 1561 - 40)])).toBe('diamond_pickaxe');
  });

  it('prices wear by material and only for things that wear', () => {
    expect(wearCostSeconds(item('iron_pickaxe'))).toBeGreaterThan(wearCostSeconds(item('stone_pickaxe')));
    expect(wearCostSeconds({ name: 'cobblestone' })).toBe(0);
  });

  it('is what the pathfinder and collectblock use once installed', () => {
    const bot: any = { inventory: { items: () => bag }, entity: { effects: {} }, pathfinder: { bestHarvestTool: () => null },
      tool: { getDigTime: () => 0 } };
    installToolChoice(bot);
    expect(bot.pathfinder.bestHarvestTool(block('stone')).name).toBe('stone_pickaxe');
    const costs = bag.map(tool => bot.tool.getDigTime(block('stone'), tool));
    expect(costs.indexOf(Math.min(...costs))).toBe(1);
  });
});
