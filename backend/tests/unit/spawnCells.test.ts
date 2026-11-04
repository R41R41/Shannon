import { describe, expect, it } from 'vitest';
import { blazeSpawnRate, greedySpawnBlocks, spawnAxisCdf, spawnCells } from '../../src/services/minebot/utils/spawnCells.js';
import type { StandBlock, StandCell, StandReader } from '../../src/services/minebot/utils/standability.js';

const air: StandBlock = { name: 'air', boundingBox: 'empty' }, cube: StandBlock = { name: 'cobblestone', boundingBox: 'block' };
const sp = { x: 0, y: 20, z: 0 }, key = (p: StandCell) => `${p.x},${p.y},${p.z}`;
const world = (cells: Record<string, StandBlock | null> = {}): StandReader => (x, y, z) => cells[`${x},${y},${z}`] === undefined ? air : cells[`${x},${y},${z}`];

describe('ordinary blaze spawner geometry', () => {
  it('integrates the triangular distribution at integer block boundaries on all three levels', () => {
    const r = spawnCells(world(), sp);
    expect(r.cells).toHaveLength(243);
    expect(r.pMin).toBeCloseTo(1, 12); expect(r.pMax).toBeCloseTo(1, 12);
    const xs = [-4, -3, -2, -1, 0, 1, 2, 3, 4].map(x => r.cells.filter(c => c.x === x).reduce((n, c) => n + c.weight, 0));
    [1, 8, 16, 24, 30, 24, 16, 8, 1].forEach((n, i) => expect(xs[i]).toBeCloseTo(n / 128, 14));
    expect(r.cells.find(c => c.x === 0 && c.z === 0 && c.y === 20)!.weight).toBeCloseTo((30 / 128) ** 2 / 3);
    expect(spawnAxisCdf(-4)).toBe(0); expect(spawnAxisCdf(4)).toBe(1);
  });
  it('has no floor or light test: empty air, torches, dry light and fire remain valid', () => {
    for (const name of ['torch', 'light', 'fire']) {
      const r = spawnCells(world({ '0,20,0': { name, boundingBox: 'empty' } }), sp);
      expect(r.pMin).toBeCloseTo(1, 12);
    }
  });
  it('integrates collisions across block edges and stops feet or head cubes, slabs, soul sand and liquids', () => {
    for (const b of [cube, { name: 'stone_slab', shapes: [[0, 0, 0, 1, 0.5, 1]] }, { name: 'soul_sand' }, { name: 'lava' }]) {
      const r = spawnCells(world({ '0,20,0': b }), sp);
      expect(r.cells.find(c => key(c) === '0,20,0')!.state).toBe('blocked');
      expect(r.cells.find(c => key(c) === '0,19,0')!.state).toBe('blocked');
      expect(r.cells.find(c => key(c) === '0,21,0')!.state).toBe('open');
      const beside = r.cells.find(c => key(c) === '1,20,0')!;
      expect(beside.state).toBe('partial'); expect(beside.pMax).toBeLessThan(beside.weight);
    }
    const r = spawnCells(world({ '0,20,0': cube }), sp);
    const w = (spawnAxisCdf(0.8) - spawnAxisCdf(-0.8)) ** 2 * 2 / 3;
    expect(1 - r.pMin).toBeCloseTo(w, 7);
  });
  it('does not invent slab state or treat unloaded cells as air', () => {
    for (const b of [null, { name: 'stone_slab', boundingBox: 'block' }]) {
      const r = spawnCells(world({ '0,20,0': b }), sp);
      expect(r.pMin).toBeLessThan(r.pMax); expect(r.cells.some(c => c.state === 'unknown')).toBe(true);
    }
  });
  it('uses the actual vertical collision shape rather than rejecting every occupied head cell', () => {
    const high = { name: 'test_shape', shapes: [[0, 0.9, 0, 1, 1, 1]] };
    const r = spawnCells(world({ '0,21,0': high }), sp);
    expect(r.cells.find(c => key(c) === '0,20,0')!.state).toBe('open');
    expect(r.cells.find(c => key(c) === '0,21,0')!.state).toBe('blocked');
    // A floor immediately below the feet only touches the AABB and is not a collision.
    expect(spawnCells(world({ '0,19,0': cube }), sp).cells.find(c => key(c) === '0,20,0')!.state).toBe('open');
  });
  it('is translation invariant and does not mutate the input', () => {
    const a = spawnCells(world({ '0,20,0': cube }), sp), shifted = { x: -18, y: 76, z: 31 };
    const b = spawnCells((x, y, z) => x === shifted.x && y === shifted.y && z === shifted.z ? cube : air, shifted);
    expect(a.pMin).toBeCloseTo(b.pMin, 12); expect(cube).toEqual({ name: 'cobblestone', boundingBox: 'block' });
  });
  it('greedily chooses the centre, then honours eligibility and recalculates overlapping coverage', () => {
    const candidates = [{ x: 4, y: 20, z: 4 }, { x: 0, y: 20, z: 0 }, { x: 1, y: 20, z: 0 }];
    const r = greedySpawnBlocks(world(), sp, { candidates, maxBlocks: 3, targetPerMinute: 0 });
    expect(r.steps[0].at).toEqual(candidates[1]);
    const changed: Record<string, StandBlock> = {};
    for (const step of r.steps) {
      changed[key(step.at)] = cube;
      expect(step.pMin).toBeCloseTo(spawnCells(world(changed), sp).pMin, 12);
    }
    const limited = greedySpawnBlocks(world(), sp, { candidates, maxBlocks: 1, eligible: p => p.x === 4 });
    expect(limited.steps[0].at).toEqual(candidates[0]); expect(limited.reached).toBe(false);
  });
  it('does not overshoot a requested minimum rate and records failure to reach a constrained target', () => {
    const r = greedySpawnBlocks(world(), sp, { candidates: [{ x: 0, y: 20, z: 0 }], targetPerMinute: 2.7, minPerMinute: 9.5 });
    expect(r.steps).toEqual([]); expect(r.reached).toBe(false);
  });
});

describe('retry-aware rate', () => {
  it('includes all-failed ticks and the extra spawn tick after countdown', () => {
    expect(blazeSpawnRate(1).cycleTicks).toBe(500.5);
    expect(blazeSpawnRate(1).perMinute).toBeCloseTo(9.59040959);
    expect(blazeSpawnRate(0.1).perMinute).toBeCloseTo(2.77813067);
    expect(blazeSpawnRate(0.002443135071).perMinute).toBeCloseTo(2);
    expect(blazeSpawnRate(0).perMinute).toBe(0); expect(blazeSpawnRate(0).cycleTicks).toBe(Infinity);
    expect(() => blazeSpawnRate(-1)).toThrow();
  });
});
