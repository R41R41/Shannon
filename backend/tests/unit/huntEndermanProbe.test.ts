import { describe, expect, it } from 'vitest';
import { ENDERMAN_EYE, endermanLine, roofCellOccupied, roofExitCandidates } from '../../src/services/minebot/utils/huntEnderman.js';
import {
  chooseRoofClearing, compareRoofClearings, huntCandidates, roofTopCandidates, RoofTopReadings,
} from '../../src/services/minebot/utils/huntEndermanProbe.js';
import type { BlockReader } from '../../src/services/minebot/utils/localMap.js';

const anchor = { x: 0, y: 0, z: 0 }, from = { x: 0.5, y: 0, z: 0.5 };
const entity = (id: number, x: number, y = 0, z = 0.5) => ({ id, position: { x, y, z } });
function field(roof = true, blocks: Record<string, string | null> = {}): BlockReader {
  return (x, y, z) => {
    const key = `${x},${y},${z}`;
    const name = key in blocks ? blocks[key] : y < 0 ? 'stone'
      : roof && y === 2 && Math.abs(x) <= 1 && Math.abs(z) <= 1 ? 'cobblestone' : 'air';
    return name === null ? null : { name, solid: name !== 'air' };
  };
}

describe('roof hunt probe candidates', () => {
  it('admits terrain-hidden eyes through an exit, with provenance, without changing the source entity', () => {
    const read = field(true, { '6,2,0': 'warped_stem' }), target = entity(200, 12.5);
    expect(endermanLine(read, from, target.position, ENDERMAN_EYE).clear).toBe(false);
    expect(roofExitCandidates(read, anchor, target.position).length).toBeGreaterThan(0);
    expect(huntCandidates(read, from, [target], anchor)).toEqual([{ ...target, via: 'exit' }]);
    expect(target).not.toHaveProperty('via');
    expect(huntCandidates(read, from, [target], null)).toEqual([]);
  });

  it('also accepts a cap-hidden elevated target and prefers centre provenance when both routes work', () => {
    const read = field(), elevated = entity(201, 12.5, 4), level = entity(202, 12.5);
    expect(huntCandidates(read, from, [elevated, level], anchor).map(e => [e.id, e.via]))
      .toEqual([[202, 'centre'], [201, 'exit']]);
  });

  it('rejects exit-only eyes when every outside corridor lacks known footing', () => {
    const read = field(true, { '6,2,0': 'warped_stem', '2,-1,0': null, '-2,-1,0': null, '0,-1,2': null, '0,-1,-2': null });
    expect(huntCandidates(read, from, [entity(200, 12.5)], anchor)).toEqual([]);
  });

  it('excludes nearby support obstructions reserved for interior recovery, even with a possible exterior ray', () => {
    const read = field(true, { '2,2,0': 'cobblestone' }), target = entity(200, 10.5, 1);
    expect(roofExitCandidates(read, anchor, target.position).length).toBeGreaterThan(0);
    expect(huntCandidates(read, from, [target], anchor)).toEqual([]);
  });

  it('uses the same occupied-column gate as the camp, excluding all blocked exits but ignoring items and the body', () => {
    const read = field(true, { '6,2,0': 'warped_stem' }), target = entity(200, 12.5);
    const occupants = roofExitCandidates(read, anchor, target.position).map((c, i) => ({
      id: i + 300, name: 'zombie', position: { x: c.x + 0.5, y: c.y, z: c.z + 0.5 },
    }));
    const occupied = (cell: typeof anchor) => roofCellOccupied(occupants, 1, cell);
    expect(huntCandidates(read, from, [target], anchor, occupied)).toEqual([]);
    expect(roofCellOccupied([{ ...occupants[0], name: 'item' }], 1, anchor)).toBe(false);
    expect(roofCellOccupied([{ id: 1, position: from }], 1, anchor)).toBe(false);
  });

  it('orders 8–30m nearest first, then >30m nearest first; find takes the first eligible target', () => {
    const entities = [entity(48, 48.5), entity(31, 31.5), entity(30, 30.5), entity(8, 8.5), entity(20, 20.5)];
    const list = huntCandidates(field(false), from, entities, null);
    expect(list.map(e => e.id)).toEqual([8, 20, 30, 31, 48]);
    expect(list.find(e => e.id !== 8)?.id).toBe(20);
    expect(list.find(e => e.id > 30)?.id).toBe(31);
    expect(huntCandidates(field(false), from, [entity(7, 8.49), entity(49, 48.51)], null)).toEqual([]);
  });

  it('ranks horizon breadth before present individuals, and both before distance', () => {
    const options = [{ horizons: 1, visible: 8, distance: 1 }, { horizons: 4, visible: 0, distance: 15 },
      { horizons: 4, visible: 1, distance: 14 }, { horizons: 4, visible: 1, distance: 12 }];
    expect(options.sort(compareRoofClearings).map(e => e.distance)).toEqual([12, 14, 15, 1]);
  });

  it('the real clearing scan chooses a wider horizon over a nearer site with an exit-only target', () => {
    const read = field(false, { '6,2,0': 'warped_wart_block' });
    const world = { solid: (x: number, y: number, z: number) => read(x, y, z)?.solid ?? null,
      replaceable: (x: number, y: number, z: number) => read(x, y, z)?.name === 'air' };
    const options = { relocate: false, wide: false, blocks: 64, occupied: () => false, reject: () => undefined,
      visited: (c: typeof anchor) => c.y !== 0 || c.z !== 0 || ![0, 6].includes(c.x) };
    const chosen = chooseRoofClearing(read, world, from, [entity(200, 12.5)], options);
    expect(chosen).toMatchObject({ cell: { x: 6, y: 0, z: 0 }, horizons: 8, visible: 0, distance: 6 });
    expect(chooseRoofClearing(read, world, from, [], { ...options, blocks: 0 })).toBeNull();
  });
});

describe('roof top readings do not select targets', () => {
  it('uses eyes at floor+4.62 and ground-level 8–48m range, including the exact boundaries', () => {
    const read = field(), entities = [entity(8, 8.5), entity(48, 48.5), entity(7, 8.49), entity(49, 48.51)];
    expect(roofTopCandidates(read, from, entities)).toEqual({ topCandidates: 2, topCandidateIds: [8, 48] });
    // Measuring range from the top instead would wrongly exclude the 48m boundary.
    expect(roofTopCandidates(field(false), from, entities)).toEqual(roofTopCandidates(read, from, entities));
    const highBlock = field(true, { '2,4,0': 'warped_wart_block' }), target = entity(200, 12.5);
    expect(roofTopCandidates(highBlock, from, [target]).topCandidates).toBe(0);
    expect(endermanLine(highBlock, { ...from, y: 2.38 }, target.position, ENDERMAN_EYE).clear).toBe(true);
    expect(roofTopCandidates(field(true, { '6,3,0': null }), from, [target]).topCandidates).toBe(0);
  });

  it('counts the real elevated ray, not the centre ray, and keeps a union of unique IDs across observations', () => {
    const read = field(true, { '6,2,0': 'warped_stem' }), targets = [entity(200, 12.5), entity(201, 16.5)];
    expect(endermanLine(read, from, targets[0].position, ENDERMAN_EYE).clear).toBe(false);
    const readings = new RoofTopReadings();
    for (const entities of [targets, targets.slice(1), targets.slice(0, 1)]) {
      readings.observe(read, from, entities);
    }
    expect(readings.unique).toBe(2);
    expect(roofTopCandidates(read, from, targets).topCandidateIds).toEqual([200, 201]);
    const blocked = field(true, { '6,3,0': 'warped_wart_block', '6,4,0': 'warped_wart_block' });
    expect(roofTopCandidates(blocked, from, [targets[0]])).toEqual({ topCandidates: 0, topCandidateIds: [] });
    expect(huntCandidates(read, from, [targets[0]], null)).toEqual([]);
  });

  it('deduplicates entity IDs and returns null when the floor position is unavailable', () => {
    const target = entity(200, 12.5);
    expect(roofTopCandidates(field(), from, [target, target])).toEqual({ topCandidates: 1, topCandidateIds: [200] });
    for (const position of [null, { ...from, y: NaN }]) {
      expect(roofTopCandidates(field(), position, [target])).toEqual({ topCandidates: null, topCandidateIds: null });
    }
    const readings = new RoofTopReadings();
    readings.observe(field(), null, [target]);
    expect(readings.unique).toBeNull();
    readings.observe(field(), from, []);
    expect(readings.unique).toBe(0);
    readings.observe(field(), from, [target]);
    readings.observe(field(), null, []);
    expect(readings.unique).toBe(1);
  });
});
