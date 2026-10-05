import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { repairTierToolMaterials } from '../../src/services/minebot/utils/registryRepairs.js';

const require = createRequire(import.meta.url);

describe('1.21.11 tier-gated block dig times', () => {
  it('uses pickaxe speeds for ores and obsidian while keeping harvest limits', () => {
    const registry = require('prismarine-registry')('1.21.11');
    const Block = require('prismarine-block')(registry);
    const dig = (block: string, tool: string) => Block.fromStateId(registry.blocksByName[block].defaultState, 0)
      .digTime(registry.itemsByName[tool].id, false, false, false, [], {});
    // Nether chain diagnosis 2026-10-01: one obsidian took 75.1s with a diamond pickaxe.
    expect(dig('obsidian', 'diamond_pickaxe')).toBe(75000);
    expect(repairTierToolMaterials(registry)).toContain('incorrect_for_wooden_tool');
    expect(dig('obsidian', 'diamond_pickaxe')).toBe(9400);
    expect(dig('iron_ore', 'stone_pickaxe')).toBe(1150);
    expect(dig('diamond_ore', 'iron_pickaxe')).toBe(750);
    expect(dig('iron_ore', 'wooden_pickaxe')).toBe(7500); // still not harvestable
    expect(dig('stone', 'wooden_pickaxe')).toBe(1150);
    expect(repairTierToolMaterials(registry)).toEqual([]);
  });
});

describe('air supply default', async () => {
  const { installAirSupplyDefault } = await import('../../src/services/minebot/utils/airSupplyDefault.js');
  const { EventEmitter } = await import('node:events');
  it('treats an unsent air supply as full after login and after a respawn, but keeps a reported low value', () => {
    const bot: any = new EventEmitter();
    installAirSupplyDefault(bot);
    bot.emit('spawn');
    expect(bot.oxygenLevel).toBe(20);
    bot.oxygenLevel = 4; // metadata after a dive
    bot.emit('spawn'); // e.g. a dimension change without death
    expect(bot.oxygenLevel).toBe(4);
    bot.emit('death');
    bot.emit('spawn');
    expect(bot.oxygenLevel).toBe(20);
  });
});
