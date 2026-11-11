import { Vec3 } from 'vec3';
import { describe, expect, it } from 'vitest';
import { budgetOf, footingHeld, goBudgetFor, placeBlocksHeld, roadNeeded } from '../../src/services/minebot/utils/routeBudget.js';
import { planRoute } from '../../src/services/minebot/utils/routePlan.js';
import { runProbe } from '../../src/services/minebot/instantSkills/probe.js';
import type { BlockReader, MapBlock } from '../../src/services/minebot/utils/localMap.js';

// Run 7 (Lai): the body knows how many blocks a way needs; the numbers a hand left out come from the plan, and a limit the way cannot keep is said before the body moves.
const STONE: MapBlock = { name: 'stone', solid: true }, AIR: MapBlock = { name: 'air', solid: false };
const rock: BlockReader = (x, y) => (y <= 63 ? STONE : AIR);
const FLOOR = { maxDig: 40, maxPlace: 24 };
const at = (x: number, y: number, z: number) => ({ x, y, z });

/** A body over fixed blocks: `blockAt` answers as prismarine's blocks do, the pack is the stacks given. */
function bodyOver(read: BlockReader, feet = at(0, 64, 0), items: Array<{ name: string; count: number }> = []) {
  return {
    entity: { position: new Vec3(feet.x + 0.5, feet.y, feet.z + 0.5) }, entities: {}, registry: {}, version: '1.21.11',
    inventory: { items: () => items },
    blockAt: (position: Vec3) => { const block = read(position.x, position.y, position.z); return block ? { name: block.name, boundingBox: block.solid ? 'block' : 'empty', position } : null; },
  } as any;
}

describe('budgetOf: a limit the hand left out is the plan\'s number', () => {
  it('never under what the go had, and a fifth and two over a way that needs more', () => {
    const little = planRoute(rock, at(0, 64, 0), [at(0, 58, 0)], { placeBlocks: 20 });
    expect(budgetOf(little, {}, FLOOR)).toMatchObject({ maxDig: 40, maxPlace: 24 });
    const long = planRoute(rock, at(0, 64, 0), [at(0, 34, 0)], { placeBlocks: 60, maxDig: 80 });
    expect(long.totals.dig).toBe(30);
    expect(budgetOf(long, {}, { maxDig: 10, maxPlace: 24 }).maxDig).toBe(Math.ceil(30 * 1.2) + 2);
  });

  it('a limit the hand gave is kept, and a way over it is told with the number the way needs', () => {
    const plan = planRoute(rock, at(0, 64, 0), [at(0, 34, 0)], { placeBlocks: 0, maxDig: 16 });
    expect(plan.status).toBe('over');
    const budget = budgetOf(plan, { maxDig: 16 }, FLOOR);
    expect(budget.maxDig).toBe(16);
    expect(budget.over).toMatchObject({ code: 'limit_dig' });
    expect(budget.over!.needed).toBeGreaterThan(16);
    expect(budget.over!.text).toMatch(/この道は掘る所が \d+ あり、上限 16 を超える/u);
    expect(budget.over!.text.length).toBeLessThanOrEqual(90);
  });

  it('a limit of the hand that the plan keeps says nothing', () => {
    const plan = planRoute(rock, at(0, 64, 0), [at(0, 58, 0)], { placeBlocks: 20, maxDig: 16 });
    expect(budgetOf(plan, { maxDig: 16, maxPlace: 10 }, FLOOR).over).toBeUndefined();
  });
});

describe('what the body gives the plan', () => {
  it('counts the cheap blocks the pack can lay, and names the default footing it holds', () => {
    const bot = bodyOver(rock, at(0, 64, 0), [{ name: 'cobblestone', count: 30 }, { name: 'dirt', count: 5 }, { name: 'oak_planks', count: 40 }, { name: 'gravel', count: 20 }]);
    expect(placeBlocksHeld(bot)).toBe(35);
    expect(footingHeld(bot)).toEqual(['cobblestone', 'dirt']);
    expect(footingHeld(bodyOver(rock))).toEqual([]);
  });

  it('roadNeeded: the blocks a mine\'s way digs, grown by a fifth and two; null when no way is planned', () => {
    const bot = bodyOver(rock, at(0, 64, 0), [{ name: 'iron_pickaxe', count: 1 }]);
    const needed = roadNeeded(bot, [at(6, 58, 0)], name => name === 'stone');
    expect(needed).toBeGreaterThanOrEqual(Math.ceil(15 * 1.2) + 2);
    expect(roadNeeded(bot, [at(6, 58, 0)], () => false)).toBeNull();
    expect(roadNeeded({ entity: null } as any, [at(1, 64, 0)], () => true)).toBeNull();
  });

  it('goBudgetFor: nothing is planned for a place far off, and a limit of 0 is not read as a ceiling to check', () => {
    const bot = bodyOver(rock, at(0, 64, 0), [{ name: 'iron_pickaxe', count: 1 }]);
    const input = { range: 0, maxDrop: 3, waterOk: false, diggable: (name: string) => name === 'stone', placeBlocks: 0, floor: FLOOR };
    expect(goBudgetFor(bot, [at(200, 64, 0)], { ...input, asked: {} })).toBeNull();
    const none = goBudgetFor(bot, [at(6, 58, 0)], { ...input, asked: { maxDig: 0 } });
    expect(none?.over).toBeUndefined();
    const over = goBudgetFor(bot, [at(6, 58, 0)], { ...input, asked: { maxDig: 5 } });
    expect(over?.over?.code).toBe('limit_dig');
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
