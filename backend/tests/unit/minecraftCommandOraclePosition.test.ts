import { describe, expect, it } from 'vitest';
import { prepareAssertion } from '../../src/services/minebot/testing/MinecraftCommandOracle.js';

describe('Minecraft command oracle Y-coordinate proof', () => {
  it('reads the server entity Pos[1] independently of the client position', () => {
    expect(prepareAssertion({ type: 'position_y_between', min: 44.9, max: 45.1 })).toEqual({
      prepare: ['execute store result score @s sh_test run data get entity @s Pos[1] 100'],
      positive: 'if score @s sh_test matches 4490..4510',
      negative: 'unless score @s sh_test matches 4490..4510',
    });
  });

  it('supports negative world heights and rejects reversed ranges', () => {
    expect(prepareAssertion({ type: 'position_y_between', min: -63.5, max: -63 })).toMatchObject({
      positive: 'if score @s sh_test matches -6350..-6300',
    });
    expect(() => prepareAssertion({ type: 'position_y_between', min: 45, max: 44 })).toThrow('ASSERTION_RANGE_INVALID');
  });
});
