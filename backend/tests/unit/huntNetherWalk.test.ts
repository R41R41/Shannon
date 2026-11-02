import { describe, expect, it } from 'vitest';
import { Vec3 } from 'vec3';
import { SOUL_SAND_COST, SOUL_SAND_SLOWNESS, soulSandStepCost } from '../../src/services/minebot/utils/huntNetherWalk.js';

// Soul sand under the destination of a step costs what the slowness costs (S2, 2026-11-02): a way round when it is not much longer, the valley when it is the only way.
const SAND = 5000;
const world = (sandCells: string[]) => ({ registry: { blocksByName: { soul_sand: { minStateId: SAND, maxStateId: SAND } } },
  world: { getBlockStateId: (p: Vec3) => sandCells.includes(`${p.x},${p.y},${p.z}`) ? SAND : 1 } });

describe('soul sand under a step', () => {
  it('costs the time it takes: 40% of the pace is 2.5 times the time, 1.5 over a plain step', () => {
    expect(SOUL_SAND_SLOWNESS).toBe(0.4);
    expect(SOUL_SAND_COST).toBeCloseTo(1.5, 10);
  });

  it('prices the destination cell by the block under its feet, and only soul sand', () => {
    const cost = soulSandStepCost(world(['10,63,5']));
    expect(cost({ position: { x: 10, y: 64, z: 5 } })).toBeCloseTo(1.5, 10);    // soul sand at y 63, the feet at 64
    expect(cost({ position: { x: 10, y: 63, z: 5 } })).toBe(0);                 // the sand is in the cell itself, not under it
    expect(cost({ position: { x: 11, y: 64, z: 5 } })).toBe(0);
    expect(cost({})).toBe(0);
  });

  it('says nothing where the world cannot be read, or the game has no such block', () => {
    expect(soulSandStepCost({})({ position: { x: 0, y: 0, z: 0 } })).toBe(0);
    expect(soulSandStepCost({ registry: { blocksByName: {} }, world: { getBlockStateId: () => 1 } })({ position: { x: 0, y: 0, z: 0 } })).toBe(0);
  });
});
