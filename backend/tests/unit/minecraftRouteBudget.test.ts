import { Vec3 } from 'vec3';
import { describe, expect, it } from 'vitest';
import { placeBlocksHeld, planFromBody } from '../../src/services/minebot/utils/routeBudget.js';
import { planRoute } from '../../src/services/minebot/utils/routePlan.js';
import { runProbe } from '../../src/services/minebot/instantSkills/probe.js';
import type { BlockReader, MapBlock } from '../../src/services/minebot/utils/localMap.js';

// Run 7 (Lai): what the body gives the plan, and probe kind=route (an estimate before the body moves; go and mine do not run it).
const STONE: MapBlock = { name: 'stone', solid: true }, AIR: MapBlock = { name: 'air', solid: false };
const rock: BlockReader = (x, y) => (y <= 63 ? STONE : AIR);
const at = (x: number, y: number, z: number) => ({ x, y, z });

/** A body over fixed blocks: `blockAt` answers as prismarine's blocks do, the pack is the stacks given. */
function bodyOver(read: BlockReader, feet = at(0, 64, 0), items: Array<{ name: string; count: number }> = []) {
  return {
    entity: { position: new Vec3(feet.x + 0.5, feet.y, feet.z + 0.5) }, entities: {}, registry: {}, version: '1.21.11',
    inventory: { items: () => items },
    blockAt: (position: Vec3) => { const block = read(position.x, position.y, position.z); return block ? { name: block.name, boundingBox: block.solid ? 'block' : 'empty', position } : null; },
  } as any;
}

describe('what the body gives the plan', () => {
  it('counts the blocks the pack can lay by default (the three go lays), not planks, gravel or other stone', () => {
    const bot = bodyOver(rock, at(0, 64, 0), [{ name: 'cobblestone', count: 30 }, { name: 'dirt', count: 5 }, { name: 'stone', count: 9 }, { name: 'oak_planks', count: 40 }, { name: 'gravel', count: 20 }]);
    expect(placeBlocksHeld(bot)).toBe(35);
  });
  it('planFromBody: null for a body with no feet; a plan otherwise', () => {
    expect(planFromBody({ entity: null } as any, [at(1, 64, 0)])).toBeNull();
    expect(planFromBody(bodyOver(rock), [at(3, 64, 0)])?.status).toBe('success');
  });
});

describe('probe kind=route', () => {
  it('says the way before the body moves: the blocks it digs, with the walls named and the sentence first', async () => {
    const wall: BlockReader = (x, y, z) => (x === 5 && y >= 64 && y <= 68 ? STONE : rock(x, y, z));
    const bot = bodyOver(wall, at(0, 64, 0), [{ name: 'iron_pickaxe', count: 1 }]);
    const answer = JSON.parse((await runProbe(bot, { kind: 'route', to: at(9, 64, 0) })).result);
    expect(answer).toMatchObject({ v: 1, kind: 'route', status: 'success' });
    expect(answer.text).toMatch(/^道 \d+ マス（歩 \d+・上り \d+・下り \d+・掘 \d+〔石 \d+〕）約 \d+ 秒/u);
    expect(answer.dig).toBeGreaterThanOrEqual(2);
    expect(answer.points.length).toBeLessThanOrEqual(13);
    expect(answer.points[answer.points.length - 1]).toEqual(at(9, 64, 0));
  });

  it('a goal in lava is said as the reason, and a goal missing is invalid input', async () => {
    const lava: BlockReader = (x, y, z) => (x === 9 && y === 64 && z === 0 ? { name: 'lava', solid: false, level: 0 } : rock(x, y, z));
    const answer = JSON.parse((await runProbe(bodyOver(lava), { kind: 'route', to: at(9, 64, 0) })).result);
    expect(answer.status).toBe('none');
    expect(answer.text).toContain('溶岩');
    const missing = await runProbe(bodyOver(rock), { kind: 'route' });
    expect(missing).toMatchObject({ success: false, failureType: 'invalid_input' });
  });
});
