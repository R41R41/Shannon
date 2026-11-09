import { describe, expect, it } from 'vitest';
import { pickaxeWords, pickaxesOf } from '../../src/services/minebot/utils/primitives/go.js';

const bot = (items: Array<{ name: string; maxDurability?: number; durabilityUsed?: number }>) => ({ inventory: { items: () => items } });

describe('go: the pickaxe left after digging (1107b)', () => {
  it('best pickaxe first', () => {
    expect(pickaxesOf(bot([{ name: 'wooden_pickaxe', maxDurability: 59, durabilityUsed: 0 }, { name: 'stone_pickaxe', maxDurability: 131, durabilityUsed: 31 }])))
      .toEqual([{ name: 'stone_pickaxe', left: 100 }, { name: 'wooden_pickaxe', left: 59 }]);
  });

  it('says nothing when the go dug nothing and lost nothing', () => {
    const b = bot([{ name: 'stone_pickaxe', maxDurability: 131, durabilityUsed: 0 }]);
    expect(pickaxeWords(b, pickaxesOf(b), 0)).toBe('');
  });

  it('says the uses left after digging, and warns when near breaking', () => {
    const start = [{ name: 'stone_pickaxe' }];
    expect(pickaxeWords(bot([{ name: 'stone_pickaxe', maxDurability: 131, durabilityUsed: 31 }]), start, 4)).toBe('・stone_pickaxe 残り 100');
    expect(pickaxeWords(bot([{ name: 'stone_pickaxe', maxDurability: 131, durabilityUsed: 120 }]), start, 4)).toBe('・stone_pickaxe 残り 11（もうすぐ壊れる。canDig を減らすか予備を作る）');
  });

  it('says a pickaxe broke, and when none is left', () => {
    const start = [{ name: 'stone_pickaxe' }, { name: 'wooden_pickaxe' }];
    expect(pickaxeWords(bot([{ name: 'wooden_pickaxe', maxDurability: 59, durabilityUsed: 9 }]), start, 2)).toBe('・stone_pickaxe が壊れた・wooden_pickaxe 残り 50');
    expect(pickaxeWords(bot([]), start, 2)).toBe('・stone_pickaxe・wooden_pickaxe が壊れた・ツルハシ無し（石・鉄を掘るには作り直す）');
  });
});
