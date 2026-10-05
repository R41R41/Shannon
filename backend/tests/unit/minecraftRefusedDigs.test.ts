import { describe, expect, it } from 'vitest';
import { Vec3 } from 'vec3';
import { digRefusedAt, noteRefusedDig, refusedDigBreakCost } from '../../src/services/minebot/utils/refusedDigs.js';
import { installLavaDigGuard } from '../../src/services/minebot/utils/lavaSafety.js';

describe('a block a dig rule has refused is closed to routes for a while (paid run L78 asked for the same dig 872 times in 65 seconds)', () => {
  it('costs more than a route may while the refusal holds, and nothing after', () => {
    const bot = {};
    const cost = refusedDigBreakCost(bot);
    const block = { position: new Vec3(-512, 35, -110) };
    expect(cost(block)).toBe(0);
    noteRefusedDig(bot, block.position, 15_000, 1_000);
    expect(digRefusedAt(bot, block.position, 2_000)).toBe(true);
    expect(digRefusedAt(bot, new Vec3(-512, 36, -110), 2_000)).toBe(false);
    expect(digRefusedAt(bot, block.position, 16_001)).toBe(false);
    noteRefusedDig(bot, block.position, 15_000);
    expect(cost(block)).toBe(100);
    expect(cost({})).toBe(0);
  });

  it('is noted by the rule that refuses: the lava guard marks the block it would not let be broken', async () => {
    const lava = { name: 'lava', boundingBox: 'empty' };
    const stone = { name: 'stone', boundingBox: 'block' };
    const target = new Vec3(1, 64, 0);
    const bot: any = { entity: { position: new Vec3(0.5, 64, 0.5) }, blockAt: (p: Vec3) => p.x === 1 && p.y === 65 && p.z === 0 ? lava : stone,
      dig: async () => 'dug' };
    installLavaDigGuard(bot);
    await expect(bot.dig({ name: 'stone', position: target })).rejects.toThrow(/溶岩/);
    expect(refusedDigBreakCost(bot)({ position: target })).toBe(100);
    // A block with nothing behind it is dug and not marked.
    await expect(bot.dig({ name: 'stone', position: new Vec3(-1, 64, 0) })).resolves.toBe('dug');
    expect(refusedDigBreakCost(bot)({ position: new Vec3(-1, 64, 0) })).toBe(0);
  });
});
