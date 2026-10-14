import { describe, expect, it } from 'vitest';
import { Vec3 } from 'vec3';
import { descentAllowance, fallDamage, planDescent, strandedOnHeight } from '../../src/services/minebot/utils/descent.js';

/** A small world: named blocks at cells, air elsewhere above `floor`, stone at and below it. */
function world(cells: Record<string, string>, floor = 60, at = new Vec3(0.5, 80, 0.5), health = 20) {
  return {
    entity: { position: at }, health,
    blockAt(p: Vec3) {
      const name = cells[`${p.x},${p.y},${p.z}`] ?? (p.y <= floor ? 'stone' : 'air');
      return { name, boundingBox: ['air', 'vine', 'ladder', 'water', 'short_grass'].includes(name) ? 'empty' : 'block' };
    },
  };
}

describe('getting down from a height the route planner will not leave (common run 7)', () => {
  it('counts vanilla fall damage and keeps four hearts', () => {
    expect([3, 4, 12].map(fallDamage)).toEqual([0, 1, 9]);
    expect(descentAllowance(20)).toBe(12);
    expect(descentAllowance(20, 5)).toBe(5);
    expect(descentAllowance(6)).toBe(0);
  });
  it('sees a lone log 19 blocks up as a perch: every way off is a fall the planner will not take', () => {
    const bot = world({ '0,79,0': 'jungle_log' });
    const options = planDescent(bot);
    expect(options).toHaveLength(4);
    expect(options[0]).toMatchObject({ drop: 19, damage: 16, via: 'fall', landing: 'stone' });
    expect(strandedOnHeight(bot)).toMatchObject({ drop: 19 });
  });
  it('prefers a vine down the side: the fall restarts at the bottom of the vines', () => {
    const cells: Record<string, string> = { '0,79,0': 'jungle_log' };
    for (let y = 64; y <= 79; y++) cells[`1,${y},0`] = 'vine';
    const best = planDescent(world(cells))[0];
    expect(best).toMatchObject({ dx: 1, dz: 0, via: 'climbable', damage: 0 });
    expect(best.worstDamage).toBe(16);
  });
  it('prefers water, and does not land in lava', () => {
    const best = planDescent(world({ '0,79,0': 'jungle_log', '0,61,1': 'water', '0,61,-1': 'lava', '-1,61,0': 'lava' }))[0];
    expect(best).toMatchObject({ dx: 0, dz: 1, via: 'water', damage: 0 });
    expect(planDescent(world({ '0,79,0': 'jungle_log', '0,61,-1': 'lava' })).some(o => o.dz === -1)).toBe(false);
  });
  it('is not a perch when a neighbour is level or a short step down', () => {
    expect(strandedOnHeight(world({ '0,79,0': 'stone', '1,79,0': 'stone' }))).toBeNull();
    expect(strandedOnHeight(world({ '0,79,0': 'stone', '1,76,0': 'stone' }))).toBeNull();
    expect(strandedOnHeight(world({ '0,79,0': 'stone', '1,75,0': 'stone' }))).toBeNull(); // a drop of four: the planner takes it
    expect(strandedOnHeight(world({ '0,79,0': 'stone', '1,74,0': 'stone' }))).not.toBeNull();
  });
  it('does not step into a wall, and knows nothing below an unloaded column', () => {
    const walled = world({ '0,79,0': 'stone', '1,80,0': 'stone', '-1,81,0': 'stone', '0,80,1': 'oak_leaves' });
    expect(planDescent(walled).map(o => [o.dx, o.dz])).toEqual([[0, -1]]);
    const unloaded = { ...walled, blockAt: (p: Vec3) => (p.z === -1 && p.y < 79 ? null : walled.blockAt(p)) };
    expect(planDescent(unloaded)).toEqual([]);
  });
});
