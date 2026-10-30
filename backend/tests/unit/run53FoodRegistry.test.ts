import { describe, expect, it } from 'vitest';
import registry from 'prismarine-registry';
import { installTierToolMaterialRepair } from '../../src/services/minebot/utils/registryRepairs.js';
import { foodPointsOf, itemFoodPoints } from '../../src/services/minebot/utils/foodPoints.js';

function data(version: string) {
  const source = registry(version);
  return { ...source, foodsByName: Object.fromEntries(Object.entries(source.foodsByName).map(([name, food]) => [name, { ...food }])) };
}
function body(version: string) {
  const bot = { registry: data(version), on: () => bot, inventory: { items: () => [{ name: 'porkchop', count: 10 }] } };
  installTierToolMaterialRepair(bot);
  return bot;
}
describe('run53: actual 1.21.11 food metadata agrees with the observed meal and head food ledger', () => {
  it('normalises the installed vendor data once, including cooked foods', () => {
    const bot = body('1.21.11');
    expect(itemFoodPoints(bot, 'porkchop')).toBeCloseTo(4.8);
    expect(itemFoodPoints(bot, 'chicken')).toBeCloseTo(3.2);
    expect(itemFoodPoints(bot, 'cooked_porkchop')).toBeCloseTo(20.8);
    expect(itemFoodPoints(bot, 'cooked_chicken')).toBeCloseTo(13.2);
    expect(foodPointsOf(bot).carried).toBe(48);
    installTierToolMaterialRepair(bot);
    expect(foodPointsOf(bot).carried).toBe(48);
  });
  it('keeps an older correct registry, custom food and a distinct server value unchanged', () => {
    const older = data('1.21.1');
    const prior = JSON.stringify(older.foodsByName);
    installTierToolMaterialRepair({ registry: older, on: () => undefined });
    expect(JSON.stringify(older.foodsByName)).toBe(prior);
    const custom = data('1.21.11');
    custom.foodsByName.porkchop.saturation = 99;
    custom.foodsByName.mod_stew = { ...custom.foodsByName.chicken, name: 'mod_stew', saturation: 33 };
    installTierToolMaterialRepair({ registry: custom, on: () => undefined });
    expect(custom.foodsByName.porkchop.saturation).toBe(99);
    expect(custom.foodsByName.mod_stew.saturation).toBe(33);
  });
  it('repairs a registry assigned only at login/spawn, before its food totals are read', () => {
    const listeners = new Map<string, () => void>();
    const bot: { registry?: ReturnType<typeof data>; on: (name: 'login' | 'spawn', fn: () => void) => void } = {
      on: (name, fn) => { listeners.set(name, fn); },
    };
    installTierToolMaterialRepair(bot);
    bot.registry = data('1.21.11'); listeners.get('spawn')!();
    expect(itemFoodPoints(bot, 'chicken')).toBeCloseTo(3.2);
  });
});
