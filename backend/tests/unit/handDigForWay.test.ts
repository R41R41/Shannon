import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { Vec3 } from 'vec3';
import { handDigForWay, HAND_DIG_MAX_HARDNESS } from '../../src/services/minebot/utils/toolChoice.js';
import { estimateStep } from '../../src/services/minebot/utils/tunnelWalk.js';

// Run 62 (03:46, the synthesis's #19): no pickaxe and no block in a Nether valley 16 below the gate; the only way up was a stair carved in netherrack by hand.
const require = createRequire(import.meta.url);
const registry = require('prismarine-registry')('1.21.11');
const Block = require('prismarine-block')(registry);
const block = (name: string, at = new Vec3(0, 0, 0)) => { const made = Block.fromStateId(registry.blocksByName[name].defaultState, 0); made.position = at; return made; };
const item = (name: string, slot = 36) => ({ type: registry.itemsByName[name].id, name, count: 1, slot, maxDurability: registry.itemsByName[name].maxDurability ?? 0, durabilityUsed: 0 });

describe('a body with no pickaxe digs the soft blocks by hand to make its way (run 62 #19)', () => {
  it('netherrack and stone yes, cobblestone, end stone and obsidian no; with any pickaxe it digs as before', () => {
    expect(HAND_DIG_MAX_HARDNESS).toBeGreaterThanOrEqual(1.5);
    for (const name of ['netherrack', 'stone', 'basalt', 'blackstone', 'dirt', 'nether_bricks'].filter(n => registry.blocksByName[n])) {
      const b = block(name);
      expect(handDigForWay(b, [item('rotten_flesh')]), name).toBe(!b.harvestTools || b.hardness <= HAND_DIG_MAX_HARDNESS);
    }
    expect(handDigForWay(block('netherrack'), [])).toBe(true);
    expect(handDigForWay(block('stone'), [])).toBe(true);
    expect(handDigForWay(block('cobblestone'), [])).toBe(false);
    expect(handDigForWay(block('end_stone'), [])).toBe(false);
    expect(handDigForWay(block('obsidian'), [])).toBe(false);
    expect(handDigForWay(block('netherrack'), [item('wooden_pickaxe')])).toBe(false);
  });

  it('the tunnel walk prices a stair step up into netherrack by hand (it was no step at all)', () => {
    // The body at (0,64,0) on netherrack; the step up to (1,65,0) needs (1,65,0) and (1,66,0) dug and stands on (1,64,0); the head room over the feet (0,66,0) too.
    const rule = (p: Vec3) => (p.y <= 64 || p.x >= 1 ? 'netherrack' : 'air');
    const bot = (items: any[]) => ({
      entity: { position: new Vec3(0.5, 64, 0.5), effects: {}, onGround: true },
      inventory: { items: () => items },
      blockAt: (p: Vec3) => block(rule(p.floored()), p.floored()),
    }) as any;
    const step = estimateStep(bot([item('rotten_flesh')]), { x: 0, y: 64, z: 0 }, { x: 1, y: 65, z: 0 }, { blocks: 0 });
    expect(step).not.toBeNull();
    expect(step!.digs).toBeGreaterThanOrEqual(2);
    expect(step!.ms).toBeGreaterThan(2 * 1500); // by hand: about 2 s a block
    const obsidian = (p: Vec3) => (p.y <= 64 ? 'netherrack' : p.x >= 1 ? 'obsidian' : 'air');
    const shut = { ...bot([]), blockAt: (p: Vec3) => block(obsidian(p.floored()), p.floored()) };
    expect(estimateStep(shut, { x: 0, y: 64, z: 0 }, { x: 1, y: 65, z: 0 }, { blocks: 0 })).toBeNull();
  });
});
