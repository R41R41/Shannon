import { describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import { laneProbeFields, laneReport, type LaneCandidate, type LaneCell } from '../../src/services/minebot/utils/huntLane.js';
import type { CampReader } from '../../src/services/minebot/utils/huntCamp.js';
import { solidBetween } from '../../src/services/minebot/utils/probeTools.js';
import { standableAt } from '../../src/services/minebot/utils/standability.js';

const SPAWNER = { x: 0, y: 20, z: 0 }, FROM = { x: 1, y: 20, z: 1 };
const key = (p: LaneCell) => `${p.x},${p.y},${p.z}`;
/** A five by five room, four cells high, in rock. All coordinates and creatures here are synthetic. */
const room = (changes: Record<string, string | null> = {}): CampReader => (x, y, z) => {
  const k = `${x},${y},${z}`;
  const name = k in changes ? changes[k] : k === key(SPAWNER) ? 'spawner'
    : Math.abs(x) <= 2 && Math.abs(z) <= 2 && y >= 20 && y <= 23 ? 'air' : 'netherrack';
  return name === null ? null : { name, solid: !['air', 'cave_air', 'void_air', 'lava', 'water', 'fire', 'soul_fire'].includes(name) };
};
const eastOpening = () => {
  const changes: Record<string, string | null> = {};
  for (const x of [3, 4, 5]) for (const y of [20, 21]) changes[`${x},${y},0`] = 'air';
  for (const x of [2, 3, 4, 5]) changes[`${x},22,0`] = 'air';
  changes['5,19,0'] = 'air';
  for (const z of [-1, 1]) for (const y of [20, 21]) changes[`5,${y},${z}`] = 'air';
  for (const y of [20, 21]) changes[`6,${y},0`] = 'air';
  return changes;
};
const EAST_FROM = { x: 5, y: 20, z: 0 };
const east = (read: CampReader, from = EAST_FROM) => laneReport(read, SPAWNER, from).candidates.find(c => c.direction === 'east')!;
const at = (c: LaneCandidate, p: LaneCell) => c.build.find(b => key(b.at) === key(p))!;
/** An unlimited, loaded stone floor and open air, with synthetic changes only. */
const flat = (changes: Record<string, string | null> = {}): CampReader => (x, y, z) => {
  const k = `${x},${y},${z}`, name = k in changes ? changes[k] : k === key(SPAWNER) ? 'spawner' : y < 20 ? 'stone' : 'air';
  return name === null ? null : { name, solid: !['air', 'water', 'lava', 'fire', 'soul_fire'].includes(name) };
};
/** A corridor with a step down into a gap at lid height. Its lower floor is two below the roof walk. */
const lidBridge: CampReader = (x, y, z) => {
  const name = key({ x, y, z }) === key(SPAWNER) ? 'spawner'
    : x >= -5 && x <= 6 && z >= 1 && z <= 3 && y >= (x <= 4 ? 21 : 22) && y <= 24 ? 'air' : 'stone';
  return { name, solid: name !== 'air' };
};
const BRIDGE_FROM = { x: 5, y: 22, z: 2 };

describe('laneReport: read-only lane geometry and counts', () => {
  it('counts two open cells per feet layer, without requiring a floor, and counts columns only once', () => {
    const r = laneReport(room(), SPAWNER, FROM);
    expect(r.spawn).toEqual({ min: { x: -4, y: 19, z: -4 }, max: { x: 4, y: 21, z: 4 }, spaces: 49, columns: 25, unknown: 0 });
    const bottomless = laneReport(room({ '1,19,1': 'air' }), SPAWNER, FROM);
    expect(bottomless.spawn.spaces).toBe(50);
    expect(bottomless.spawn.columns).toBe(25);
  });

  it('sorts all four directions by the actual missing solids, with the more enclosed direction first', () => {
    const r = laneReport(room(eastOpening()), SPAWNER, FROM);
    expect(r.spawn).toMatchObject({ spaces: 53, columns: 27 });
    expect(r.candidates.map(c => c.required.total)).toEqual([...r.candidates.map(c => c.required.total)].sort((a, b) => a - b));
    expect(r.candidates[0].direction).not.toBe('east');
    expect(r.candidates.at(-1)!.direction).toBe('east');
    expect(new Set(r.candidates.map(c => c.direction)).size).toBe(4);
    const c = r.candidates.at(-1)!;
    expect(c.plug).toMatchObject({ x: 1, y: 21, z: 0, name: 'air', state: 'air' });
    expect(c.lane.map(p => p.feet.x)).toEqual([2, 3, 4]);
    expect(c.waiting.feet).toMatchObject({ x: 5, y: 20, z: 0, state: 'air' });
  });

  it('counts lids, three roofs, the single head-height plug and all eight enclosure cells without duplicates', () => {
    const c = east(room(eastOpening()));
    // 27 spawnable columns, minus the three lane columns and the plug accounted for separately.
    expect(c.required).toEqual({ lid: 23, roof: 3, plug: 1, enclosure: 8, total: 35, unknown: 0, complete: true });
    expect(c.build).toHaveLength(35);
    expect(new Set(c.build.map(b => key(b.at))).size).toBe(35);
    expect(c.build.slice(0, 8).every(b => b.part === 'enclosure')).toBe(true);
    expect(c.build.slice(8, 11).every(b => b.part === 'roof')).toBe(true);
    const plug = c.build.find(b => b.part === 'plug')!;
    expect(plug.supportAfter).not.toBeNull();
    expect(c.build.findIndex(b => key(b.at) === key(plug.supportAfter!))).toBeLessThan(c.build.indexOf(plug));
    expect(c.build.filter(b => b.part === 'lid').every(b => b.at.y === 21 && !(b.at.z === 0 && b.at.x >= 1 && b.at.x <= 4))).toBe(true);
    expect(at(c, { x: 4, y: 22, z: 0 })).toMatchObject({ inReach: true, distance: 1.33 });
    expect(c.build.some(b => !b.inReach)).toBe(true);
    const read = room(eastOpening());
    const oneAlreadyThere: CampReader = (x, y, z) => x === 3 && y === 22 && z === 0 ? { name: 'stone', boundingBox: 'block' } : read(x, y, z);
    expect(east(oneAlreadyThere).required.roof).toBe(2);
  });

  it('moves an unsupported nearer lid after a farther one that gives it a face, keeping present and projected support separate', () => {
    const c = east(room({ '3,21,1': 'air' }));
    const near = at(c, { x: 2, y: 21, z: 1 });
    expect(near.supportNow).toBe(false);
    expect(near.supportAfter).not.toBeNull();
    expect(c.build.findIndex(b => key(b.at) === key(near.supportAfter!))).toBeLessThan(c.build.indexOf(near));
    expect(near.noSupport).toBe(false);
    for (const [index, b] of c.build.entries()) if (b.supportAfter) {
      expect(c.build.slice(0, index).some(p => key(p.at) === key(b.supportAfter!))).toBe(true);
      expect(Math.abs(b.at.x - b.supportAfter.x) + Math.abs(b.at.y - b.supportAfter.y) + Math.abs(b.at.z - b.supportAfter.z)).toBe(1);
    }
  });

  it('marks every cell overlapped by a creature box, including its head and neighbouring cell rather than only its feet', () => {
    const r = laneReport(room(eastOpening()), SPAWNER, FROM, { entities: [
      { id: 12, name: 'blaze', position: { x: 2.95, y: 21.8, z: 0.5 }, width: 0.6, height: 1.8 },
      { id: 13, name: 'piglin', position: { x: 5.5, y: 20, z: 1.5 } },
    ] });
    const c = r.candidates.find(c => c.direction === 'east')!;
    expect(at(c, { x: 2, y: 22, z: 0 }).occupied).toEqual([12]);
    expect(at(c, { x: 3, y: 22, z: 0 }).occupied).toEqual([12]);
    expect(at(c, { x: 5, y: 21, z: 1 }).occupied).toEqual([13]);
    expect(at(c, { x: 4, y: 22, z: 0 }).occupied).toEqual([]);
  });

  it('reports the six-blaze threshold in the nine-cubed box, excluding distant blazes and other mobs', () => {
    const entities = Array.from({ length: 6 }, (_, id) => ({ id, name: 'blaze', position: { x: 0.5, y: 20, z: 0.5 } }));
    entities.push({ id: 7, name: 'blaze', position: { x: 5.31, y: 20, z: 0.5 } }, { id: 8, name: 'piglin', position: FROM });
    const r = laneReport(room(), SPAWNER, FROM, { entities });
    expect(r.blaze).toEqual({ count: 6, limit: 6, atLimit: true, min: { x: -4, y: 16, z: -4 }, max: { x: 5, y: 25, z: 5 } });
    expect(r.text).toContain('6体以上で湧き止めの条件に達している');
    expect(laneReport(room(), SPAWNER, FROM, { entities: entities.slice(0, 5) }).blaze.atLimit).toBe(false);
    // Box intersection, not just the entity's feet inside the bounds.
    expect(laneReport(room(), SPAWNER, FROM, { entities: [{ id: 9, name: 'blaze', position: { x: 5.2, y: 20, z: 0.5 } }] }).blaze.count).toBe(1);
  });

  it('marks lava, water and fire inside or next to the interior, and an unsupported floor over 48 open cells', () => {
    const changes: Record<string, string> = { ...eastOpening(), '3,20,0': 'lava', '5,20,1': 'water', '4,21,0': 'fire' };
    for (let y = -30; y <= 19; y++) changes[`5,${y},0`] = 'air';
    for (const p of [{ x: 4, y: 19, z: 0 }, { x: 6, y: 19, z: 0 }, { x: 5, y: 19, z: -1 }, { x: 5, y: 19, z: 1 }]) changes[key(p)] = 'air';
    const c = east(room(changes));
    expect(c.hazards).toEqual(expect.arrayContaining([
      expect.objectContaining({ x: 3, y: 20, z: 0, name: 'lava', inside: true }),
      expect.objectContaining({ x: 5, y: 20, z: 1, name: 'water', inside: false }),
      expect.objectContaining({ x: 4, y: 21, z: 0, name: 'fire', inside: true }),
    ]));
    expect(at(c, { x: 5, y: 19, z: 0 })).toMatchObject({ supportNow: false, supportAfter: null, noSupport: true, below: { depth: 48, end: 'open' } });
    expect(c.clear).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'lava' })]));
  });

  it('keeps unloaded targets and faces unknown, and reports lower-layer spawn space left by the specified head-height lid', () => {
    const unknown = laneReport(() => null, SPAWNER, FROM);
    expect(unknown.spawn).toMatchObject({ spaces: 0, columns: 0, unknown: 243 });
    expect(unknown.candidates[0].required.total).toBe(0);
    expect(unknown.candidates[0].required.unknown).toBe(12);
    expect(unknown.candidates[0].build.every(p => p.supportNow === null && p.below.end === 'unloaded')).toBe(true);
    const c = east(room({ '1,19,1': 'air' }));
    expect(c.remainingOutsideLane).toBe(1);
    // A plug is one solid head cell only, so a lower pair can remain open in that column too.
    expect(east(room({ '1,19,0': 'air' })).remainingOutsideLane).toBe(1);
  });

  it('keeps coordinates, block names and place names out of the short Japanese sentence', () => {
    const report = laneReport(room(), SPAWNER, FROM), text = report.text, best = report.candidates[0];
    expect(text).toContain('必要数の順');
    expect(text.split('\n').at(-1)).toBe(`立ち位置は${new Set(best.build.filter(p => p.group !== null).map(p => p.group)).size}組、着けない${best.build.filter(p => p.noStand === 'unreachable').length}マス。`);
    expect(text).not.toMatch(/\(|\)|x=|y=|z=|netherrack|spawner|c1|run59/u);
  });

  it('offers collision floors with two open body cells, within 4.3 metres of the eye, and never places in the body', () => {
    const read = flat(), c = east(read), offered = c.build.filter(p => p.standAt);
    expect(offered.length).toBeGreaterThan(10);
    const projected = new Set<string>();
    const planned = new Set(c.build.map(p => key(p.at)));
    for (const p of c.build) {
      if (!p.standAt) continue;
      const q = p.standAt;
      expect(read(q.x, q.y - 1, q.z)).toMatchObject({ name: 'stone', solid: true });
      expect(read(q.x, q.y, q.z)?.name).toBe('air');
      expect(read(q.x, q.y + 1, q.z)?.name).toBe('air');
      expect(projected.has(key(q))).toBe(false);
      expect(projected.has(key({ ...q, y: q.y + 1 }))).toBe(false);
      expect(planned.has(key(q))).toBe(false);
      expect(planned.has(key({ ...q, y: q.y + 1 }))).toBe(false);
      expect(Math.hypot(q.x - p.at.x, q.y + 1.62 - (p.at.y + 0.5), q.z - p.at.z)).toBeLessThanOrEqual(4.3);
      expect([key(q), key({ ...q, y: q.y + 1 })]).not.toContain(key(p.at));
      expect(p).toMatchObject({ noStand: null, fireNear: false });
      const current: CampReader = (x, y, z) => projected.has(key({ x, y, z })) ? { name: 'cobblestone', solid: true } : read(x, y, z);
      expect(solidBetween((x, y, z) => current(x, y, z) ?? null, [q.x + 0.5, q.y + 1.62, q.z + 0.5], [p.at.x + 0.5, p.at.y + 0.5, p.at.z + 0.5])).toEqual([]);
      if (!p.blockedByCreature && p.at.state === 'air' && (p.supportNow === true || (p.supportAfter && projected.has(key(p.supportAfter))))) projected.add(key(p.at));
    }
    // Partial collision floors agree with fill and the walking destination.
    for (const name of ['stone_slab', 'stone_stairs', 'oak_fence']) {
      const partial = east(flat({ '5,19,0': name }));
      expect(partial.build[0]).toMatchObject({ standAt: EAST_FROM, walk: 0 });
    }
    const lowBlock = { name: 'stone', solid: true, top: 0.5 };
    const lowFloor: CampReader = (x, y, z) => x === 5 && y === 19 && z === 0 ? lowBlock : read(x, y, z);
    expect(east(lowFloor).build[0].standAt).toEqual(EAST_FROM);
  });

  it('uses the shared cardinal hazard rules and actual floor, and refuses a cell beside an open hole (a push would drop the body)', () => {
    for (const name of ['fire', 'soul_fire', 'lava', 'water', 'magma_block']) {
      const read = flat({ '6,20,1': name }), c = east(read);
      expect(c.build.some(p => p.standAt)).toBe(true);
      for (const p of c.build) if (p.standAt) {
        expect(standableAt(read, p.standAt).ok).toBe(true);
        expect(p.fireNear).toBe(false);
      }
      expect(c.build[0].standAt).toEqual(EAST_FROM);
    }
    const hole: Record<string, string> = {};
    for (let y = 15; y <= 19; y++) hole[`6,${y},0`] = 'air';
    const c = east(flat(hole));
    expect(c.build[0].standAt).not.toEqual(EAST_FROM);
    for (const p of c.build) if (p.standAt) expect(Math.abs(p.standAt.x - 6) + Math.abs(p.standAt.z) > 1).toBe(true);
  });

  it('prefers fewer walking steps before the old waiting-cell rank', () => {
    const c = east(flat());
    // The waiting cell is the origin here, so it wins with zero steps.
    expect(c.build[0].standAt).toEqual({ x: 5, y: 20, z: 0 });
    expect(c.build[0].walk).toBe(0);
    const from = { x: 7, y: 20, z: -1 }, nearby = east(flat(), from).build[0];
    expect(nearby).toMatchObject({ standAt: from, walk: 0 });
    const c2 = east(flat({ '6,20,0': 'fire' }), { x: 4, y: 20, z: 0 });
    expect(c2.build[0].standAt).not.toEqual({ x: 5, y: 20, z: 0 });
    expect(c2.build[0].standAt).not.toBeNull();
    // Among the safe cells, (4,20,0) is the nearest and still sees the first enclosure cell.
    expect(c2.build[0].standAt).toEqual({ x: 4, y: 20, z: 0 });
  });

  it('uses the old distance and shelter rank when walking steps tie', () => {
    // A creature excludes the origin as a placement footing; the two side footings tie on walking steps.
    const from = { x: 7, y: 20, z: 0 }, base = { '7,19,0': 'stone_slab' };
    const firstAt = (read: CampReader) => laneReport(read, SPAWNER, from, { entities: [
      { id: 20, name: 'piglin', position: { x: 7.5, y: 20, z: 0.5 } },
    ] }).candidates.find(c => c.direction === 'east')!.build[0];
    const first = firstAt(flat(base));
    expect(first).toMatchObject({ standAt: { x: 7, y: 20, z: -1 }, walk: 1 });
    // Both side footings are one step away and equally far from the waiting cell.
    const sheltered = firstAt(flat({ ...base, '4,21,1': 'stone' }));
    expect(sheltered).toMatchObject({ standAt: { x: 7, y: 20, z: 1 }, walk: 1 });
  });

  it('treats half blocks as opaque even when the reader marks them non-solid', () => {
    const read = flat();
    const slab: CampReader = (x, y, z) => x === 5 && y === 21 && z === -1 ? { name: 'stone_slab', solid: false } : read(x, y, z);
    const c = east(slab), p = at(c, { x: 5, y: 20, z: -1 });
    // This slab cuts the eye-to-centre line from the waiting cell to the lower enclosure block.
    expect(p.standAt).not.toEqual({ x: 5, y: 20, z: 0 });
  });

  it('skips a visible safe footing beyond a wall and selects a reachable alternative', () => {
    const base = flat();
    const read: CampReader = (x, y, z) => x === 4 && (y === 20 || y === 21) ? { name: 'stone', solid: true } : base(x, y, z);
    const from = { x: 2, y: 20, z: 0 }, c = east(read, from), roof = at(c, { x: 4, y: 22, z: 0 });
    // The old preferred waiting cell still has a floor, two empty cells and a clear placement line.
    expect(read(5, 19, 0)?.solid).toBe(true);
    expect([read(5, 20, 0)?.name, read(5, 21, 0)?.name]).toEqual(['air', 'air']);
    expect(solidBetween((x, y, z) => read(x, y, z) ?? null, [5.5, 21.62, 0.5], [4.5, 22.5, 0.5])).toEqual([]);
    expect(roof).toMatchObject({ standAt: from, walk: 0, noStand: null });
    expect(c.build.filter(p => p.standAt).every(p => p.standAt!.x < 4)).toBe(true);
  });

  it.each(['up', 'down'] as const)('walks one step %s but never two', direction => {
    for (const rise of [1, 2]) {
      const from = { x: 11, y: direction === 'up' ? 20 : 20 + rise, z: 0 };
      const read: CampReader = (x, y, z) => {
        const height = (direction === 'up' ? x < 10 : x >= 10) ? 20 + rise : 20;
        const name = key({ x, y, z }) === key(SPAWNER) ? 'spawner' : y < height ? 'stone' : 'air';
        return { name, solid: name !== 'air' };
      };
      const c = east(read, from), p = at(c, direction === 'up' ? { x: 5, y: 22, z: 0 } : { x: 5, y: 20, z: -1 });
      if (rise === 1) expect(p).toMatchObject({ standAt: { x: 9, y: direction === 'up' ? 21 : 20, z: 0 }, walk: 2, noStand: null });
      else expect(p).toMatchObject({ standAt: null, walk: null, group: null, noStand: 'unreachable' });
    }
  });

  it('does not use planned blocks as a passage, even while they are currently air', () => {
    const read = flat(), c = east(read, FROM);
    // All exits from this origin put the body's head in a planned lid or plug.
    expect(c.build.some(p => key(p.at) === '2,21,1')).toBe(true);
    expect(read(2, 20, 1)?.name).toBe('air');
    expect(read(2, 21, 1)?.name).toBe('air');
    expect(at(c, { x: 5, y: 20, z: -1 })).toMatchObject({ standAt: null, walk: null, group: null, noStand: 'unreachable' });
    expect(c.build.every(p => p.standAt === null)).toBe(true);
    expect(east(read).build.some(p => p.standAt)).toBe(true);
  });

  it('reaches later footings across a floor gap by walking on preceding projected lids', () => {
    const report = laneReport(lidBridge, SPAWNER, BRIDGE_FROM);
    const c = report.candidates.find(c => c.direction === 'east')!, far = at(c, { x: -4, y: 21, z: 2 });
    expect(far.standAt).not.toBeNull(); expect(far.walk).toBeGreaterThan(0);
    expect(standableAt(lidBridge, far.standAt!).why).toBe('no_floor');
    const floor = { ...far.standAt!, y: far.standAt!.y - 1 };
    const earlier = c.build.slice(0, c.build.indexOf(far));
    expect(earlier.some(p => key(p.at) === key(floor) && p.standAt !== null)).toBe(true);
    expect(lidBridge(floor.x, floor.y, floor.z)?.name).toBe('air');
    // These are useful planned stands, but the real wire must not describe their missing floor as currently present.
    const wire = laneProbeFields(report);
    expect(wire.text).toContain('現在の足場・経路の保証ではない');
    expect(wire.rows.projection).toContain('先行する設置が成功した後');
    const prior = new Set(earlier.filter(p => p.standAt && !p.blockedByCreature && p.at.state === 'air').map(p => key(p.at)));
    const projected: CampReader = (x, y, z) => prior.has(key({ x, y, z })) ? { name: 'cobblestone', solid: true } : lidBridge(x, y, z);
    expect(standableAt(projected, far.standAt!).ok).toBe(true);
    // An uninterrupted chain of earlier lids connects the raised origin to that footing.
    for (let x = far.standAt!.x; x <= 4; x++) expect(prior.has(key({ x, y: 21, z: far.standAt!.z }))).toBe(true);
  });

  it('never stands on or routes over a future lid, or one whose earlier placement is creature-blocked', () => {
    const report = laneReport(lidBridge, SPAWNER, BRIDGE_FROM, { entities: [
      { id: 90, name: 'blaze', position: { x: 4.5, y: 21, z: 2.5 }, width: 0.6, height: 0.8 },
    ] });
    const c = report.candidates.find(c => c.direction === 'east')!, projected = new Set<string>();
    const planned = new Set(c.build.map(p => key(p.at)));
    let newFloors = 0;
    for (const p of c.build) {
      if (p.standAt) {
        const floor = { ...p.standAt, y: p.standAt.y - 1 };
        if (planned.has(key(floor))) { expect(projected.has(key(floor))).toBe(true); newFloors++; }
        const current: CampReader = (x, y, z) => projected.has(key({ x, y, z })) ? { name: 'cobblestone', solid: true } : lidBridge(x, y, z);
        expect(standableAt(current, p.standAt).ok).toBe(true);
        // Replay reachability using only this prefix: no future block is a floor or a body passage.
        const future = new Set([...planned].filter(k => !projected.has(k)));
        const seen = new Set([key(BRIDGE_FROM)]), queue = [BRIDGE_FROM];
        for (let i = 0; i < queue.length; i++) for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const dy of [0, 1, -1]) {
          const q = { x: queue[i].x + dx, y: queue[i].y + dy, z: queue[i].z + dz };
          if (seen.has(key(q)) || !standableAt(current, q, { ignore: future }).ok) continue;
          const above = dy === 1 ? { ...queue[i], y: queue[i].y + 2 } : { ...q, y: q.y + 2 };
          if (dy !== 0 && (planned.has(key(above)) || current(above.x, above.y, above.z)?.solid)) continue;
          seen.add(key(q)); queue.push(q);
        }
        expect(seen.has(key(p.standAt))).toBe(true);
      }
      if (p.standAt && !p.blockedByCreature && p.at.state === 'air'
        && (p.supportNow === true || (p.supportAfter && projected.has(key(p.supportAfter))))) projected.add(key(p.at));
    }
    expect(newFloors).toBeGreaterThan(0);
    expect(projected.has('4,21,2')).toBe(false);
  });

  it('does not cross a fire barrier to reach an otherwise safe placement footing', () => {
    const base = flat(), from = { x: 12, y: 20, z: 0 };
    const read: CampReader = (x, y, z) => x === 10 && y === 20 ? { name: 'fire', solid: false } : base(x, y, z);
    expect(standableAt(read, from).ok).toBe(true);
    const p = at(east(read, from), { x: 5, y: 20, z: -1 });
    expect(p).toMatchObject({ standAt: null, walk: null, noStand: 'unreachable' });
  });

  it('stops at 2000 visited feet cells and reports unreachable beyond the boundary', () => {
    for (const startX of [2008, 2009]) {
      const base = flat();
      // A single-file corridor opens onto the placement area at x=9. There is no alternate route.
      const read = vi.fn<Parameters<CampReader>, ReturnType<CampReader>>((x, y, z) =>
        x >= 10 && (z !== 0 || x > startX) && y >= 20 ? { name: 'stone', solid: true } : base(x, y, z));
      const p = at(east(read, { x: startX, y: 20, z: 0 }), { x: 5, y: 20, z: -1 });
      if (startX === 2008) expect(p).toMatchObject({ standAt: { x: 9, y: 20, z: 0 }, walk: 1999, noStand: null });
      else expect(p).toMatchObject({ standAt: null, walk: null, group: null, noStand: 'unreachable' });
      expect(read.mock.calls.length).toBeLessThan(40_000);
    }
  });

  it('returns null with out_of_reach, hazard or unloaded instead of inventing a footing', () => {
    const nowhere: CampReader = () => ({ name: 'air', solid: false });
    for (const p of east(nowhere).build) expect(p).toMatchObject({ standAt: null, group: null, noStand: 'out_of_reach', fireNear: null });
    for (const p of east(() => null).build) expect(p).toMatchObject({ standAt: null, group: null, noStand: 'unloaded', fireNear: null });
    const burning: CampReader = (x, y, z) => y === 19 ? { name: 'magma_block', solid: true } : flat()(x, y, z);
    for (const p of east(burning).build) expect(p).toMatchObject({ standAt: null, group: null, noStand: 'hazard', fireNear: null });
    const unreadNeighbours: CampReader = (x, y, z) => y === 22 ? null : flat()(x, y, z);
    expect(east(unreadNeighbours).build.every(p => p.standAt === null && p.noStand === 'unloaded')).toBe(true);
  });

  it('never gives a footing on a one-wide bridge: a push to its side drops the body into the hollow below', () => {
    // flat ground at x <= 0, a bridge of stone at x 1..6, z 2 one cell below the feet, hollow everywhere else under y 20
    const bridge: CampReader = (x, y, z) => {
      const name = x === 0 && y === 21 && z === 0 ? 'spawner' : y < 20 ? (x <= 0 || (z === 2 && x >= 1 && x <= 6 && y === 19) ? 'stone' : 'air') : 'air';
      return { name, solid: !['air', 'water', 'lava', 'fire', 'soul_fire'].includes(name) };
    };
    const report = laneReport(bridge, { x: 0, y: 21, z: 0 }, { x: -2, y: 20, z: 2 });
    expect(report.candidates.some(c => c.build.some(p => p.standAt))).toBe(true);
    for (const c of report.candidates) {
      const prior = new Set<string>();
      for (const p of c.build) {
        if (p.standAt && p.standAt.x > 0) {
          // A later, wider projected lid can be safe above the bridge; the original one-wide floor remains refused.
          expect(p.standAt.y).toBeGreaterThan(20);
          expect(prior.has(key({ ...p.standAt, y: p.standAt.y - 1 }))).toBe(true);
        }
        if (p.standAt && !p.blockedByCreature && p.at.state === 'air'
          && (p.supportNow === true || (p.supportAfter && prior.has(key(p.supportAfter))))) prior.add(key(p.at));
      }
    }
  });

  it('keeps a wide room within the 16,000 characters the receipt keeps: the build rows of the plans after the first are left out', () => {
    // an open floor: nine by nine columns of lid cells in every direction (about seventy placements a plan)
    const report = laneReport(flat(), SPAWNER, EAST_FROM);
    expect(report.candidates.length).toBe(4);
    expect(report.candidates.every(c => c.build.length > 50)).toBe(true);
    const wire = laneProbeFields(report) as any;
    expect(JSON.stringify(wire).length).toBeLessThanOrEqual(16_000);
    expect(wire.candidates[0].build.length).toBe(report.candidates[0].build.length);
    expect(wire.candidates[1]).toMatchObject({ build: [], buildOmitted: report.candidates[1].build.length });
    // every row of the first plan still points at cells that exist
    for (const row of wire.candidates[0].build) expect(wire.cells[wire.facts[row[0]][0]]).toBeTruthy();
  });

  it('does not let stone two cells down cancel lava one cell down beside the footing', () => {
    // the bridge of the previous test, with lava at y 19 and stone at y 18 on both sides of it
    const bridge: CampReader = (x, y, z) => {
      let name = 'air';
      if (x === 0 && y === 21 && z === 0) name = 'spawner';
      else if (y < 19 && x <= 0) name = 'stone';
      else if (y === 19) name = x <= 0 ? 'stone' : z === 2 && x >= 1 && x <= 6 ? 'stone' : 'lava';
      else if (y === 18) name = 'stone';
      else if (y < 18) name = 'stone';
      return { name, solid: !['air', 'water', 'lava', 'fire', 'soul_fire'].includes(name) };
    };
    const report = laneReport(bridge, { x: 0, y: 21, z: 0 }, { x: -2, y: 20, z: 2 });
    for (const p of report.candidates.flatMap(c => c.build)) if (p.standAt) expect(p.standAt.x <= 0 || p.standAt.z !== 2).toBe(true);
  });

  it('keeps one-based groups consecutive, with a common footing and at most six placements', () => {
    const c = east(flat()), seen = new Set<number>();
    let previous: number | null = null;
    for (const p of c.build) {
      if (p.group !== previous && p.group !== null) { expect(seen.has(p.group)).toBe(false); seen.add(p.group); }
      previous = p.group;
      expect(p.group === null).toBe(p.standAt === null);
    }
    expect([...seen]).toEqual(Array.from({ length: seen.size }, (_, i) => i + 1));
    expect(c.build.filter(p => p.group === 1)).toHaveLength(6);
    for (const group of seen) {
      const rows = c.build.filter(p => p.group === group);
      expect(rows.length).toBeLessThanOrEqual(6);
      expect(new Set(rows.map(p => key(p.standAt!))).size).toBe(1);
    }
  });

  it('defers creature-blocked placements to their group’s tail without moving a prerequisite behind its user', () => {
    const entities = [{ id: 90, name: 'blaze', position: { x: 5.5, y: 20, z: -0.5 }, width: 0.6, height: 1.8 }];
    const c = laneReport(flat(), SPAWNER, EAST_FROM, { entities }).candidates.find(c => c.direction === 'east')!;
    const occupied = at(c, { x: 5, y: 20, z: -1 });
    expect(occupied).toMatchObject({ occupied: [90], blockedByCreature: true });
    expect(c.build.indexOf(occupied)).toBeGreaterThan(0);
    const group = c.build.filter(p => p.group === occupied.group);
    expect(group.some(p => !p.blockedByCreature)).toBe(true);
    expect(group.map(p => p.blockedByCreature)).toEqual([...group.map(p => p.blockedByCreature)].sort());
    for (const group of new Set(c.build.map(p => p.group).filter(g => g !== null))) {
      const flags = c.build.filter(p => p.group === group).map(p => p.blockedByCreature);
      expect(flags).toEqual([...flags].sort());
    }
    for (const [i, p] of c.build.entries()) {
      expect(p.blockedByCreature).toBe(p.occupied.length > 0);
      if (p.supportAfter) expect(c.build.slice(0, i).some(b => key(b.at) === key(p.supportAfter!))).toBe(true);
    }
  });

  it('appends the new wire columns while old readers can still decode all the original fields', () => {
    const r = laneReport(flat(), SPAWNER, EAST_FROM), wire = laneProbeFields(r);
    expect(wire.rows.build).toEqual(['fact', 'partIndex', 'supportAfterCell', 'flags', 'standAtCell', 'group', 'walk']);
    expect(wire.rows.facts).toEqual(['cell', 'supportNow', 'occupiedCount', 'belowDepth', 'belowEnd', 'needsClearing', 'standFact']);
    expect(wire.rows.cells).toEqual(['x', 'y', 'z', 'name', 'state']);
    expect(wire.rows.standFacts).toEqual(['noStand', 'blockedByCreature', 'fireNear']);
    expect(wire.rows.lane).toEqual(['feetCell', 'headCell']);
    expect(wire.rows.waiting).toEqual(['feetCell', 'headCell']);
    expect(wire.rows.hazards).toEqual(['cell', 'inside']);
    expect(wire.rows.parts).toEqual(['enclosure', 'roof', 'plug', 'lid']);
    expect(wire.candidates.some(c => c.build.some(row => typeof row[6] === 'number'))).toBe(true);
    expect(wire.candidates.some(c => c.build.some(row => row[6] === null))).toBe(true);
    expect(wire.rows.flags).toEqual({ inReach: 1, visibleNow: 2, noSupport: 4 });
    for (const [i, c] of wire.candidates.entries()) for (const [j, row] of c.build.entries()) {
      const original = r.candidates[i].build[j], fact = wire.facts[row[0] as number];
      expect(Object.keys(original)).toEqual(['at', 'part', 'supportNow', 'supportAfter', 'occupied', 'distance', 'inReach', 'visible', 'noSupport', 'below', 'needsClearing', 'standAt', 'noStand', 'group', 'blockedByCreature', 'fireNear', 'walk']);
      expect(wire.cells[fact[0]]).toEqual([original.at.x, original.at.y, original.at.z, original.at.name, original.at.state]);
      expect(fact.slice(1, 6)).toEqual([original.supportNow, original.occupied.length, original.below.depth, original.below.end, original.needsClearing]);
      expect(row.slice(0, 4)).toEqual([row[0], wire.rows.parts.indexOf(original.part), row[2], (original.inReach ? 1 : 0) | (original.visible ? 2 : 0) | (original.noSupport ? 4 : 0)]);
      expect(row[2] === null ? null : wire.cells[row[2] as number].slice(0, 3)).toEqual(original.supportAfter ? [original.supportAfter.x, original.supportAfter.y, original.supportAfter.z] : null);
      expect(row).toHaveLength(7);
      const standAtCell = row[4];
      expect(standAtCell === null ? null : wire.cells[standAtCell].slice(0, 3)).toEqual(original.standAt ? [original.standAt.x, original.standAt.y, original.standAt.z] : null);
      expect(row[5]).toBe(original.group);
      expect(row[6]).toBe(original.walk);
      expect(wire.standFacts[fact[6]]).toEqual([original.noStand, original.blockedByCreature, original.fireNear]);
    }
  });

  it('retains the best build order in full, the others in full or told as left out, and the appended columns, including large coordinates', () => {
    const r = laneReport((x, y, z) => key({ x, y, z }) === key(SPAWNER) ? { name: 'spawner', solid: true } : { name: 'air', solid: false }, SPAWNER, FROM);
    const wire = laneProbeFields(r);
    const roundTrip = JSON.parse(JSON.stringify({ v: 1, kind: 'lane', found: true, ...wire }));
    // (a wire past the receipt's 16,000 characters leaves the build rows of the plans after the first out, and says how many: buildOmitted)
    expect(roundTrip.candidates.map((c: { build: unknown[][]; buildOmitted?: number }) => c.build.length + (c.buildOmitted ?? 0))).toEqual(r.candidates.map(c => c.build.length));
    expect(roundTrip.candidates[0].build.length).toBe(r.candidates[0].build.length);
    expect(JSON.stringify(roundTrip).length).toBeLessThanOrEqual(16_000);
    for (const [i, c] of wire.candidates.entries()) for (const [j, row] of c.build.entries()) {
      const fact = wire.facts[row[0] as number];
      const p = wire.cells[fact[0]];
      const original = r.candidates[i].build[j];
      expect(p.slice(0, 3)).toEqual([original.at.x, original.at.y, original.at.z]);
      expect(fact[1]).toBe(original.supportNow);
      expect(fact[2]).toBe(original.occupied.length);
      expect(Number(row[3]) & 1).toBe(original.inReach ? 1 : 0);
      expect(Number(row[3]) & 2).toBe(original.visible ? 2 : 0);
      expect(Number(row[3]) & 4).toBe(original.noSupport ? 4 : 0);
    }
    const shifted = { x: -12_345_678, y: 100, z: 12_345_678 };
    const distant = laneReport((x, y, z) => key({ x, y, z }) === key(shifted) ? { name: 'spawner', solid: true } : { name: 'air', solid: false }, shifted, shifted);
    const decoded = JSON.parse(JSON.stringify(laneProbeFields(distant)));
    expect(decoded.candidates.map((c: { build: unknown[][]; buildOmitted?: number }) => c.build.length + (c.buildOmitted ?? 0))).toEqual(distant.candidates.map(c => c.build.length));
    // All columns of the rows that are kept; the plans left out are told, never silently dropped.
    expect(decoded.candidates.every((c: { build: unknown[][] }) => c.build.every(row => row.length === 7))).toBe(true);
    expect(distant.candidates.map(c => c.required)).toEqual(r.candidates.map(c => c.required));
  });
});

const scans = vi.hoisted(() => ({ hits: [] as Array<{ position: Vec3 }> }));
vi.mock('../../src/services/minebot/utils/loadedBlockScan.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/services/minebot/utils/loadedBlockScan.js')>(),
  scanLoadedBlocks: vi.fn(() => ({ hits: scans.hits })),
}));
const { runProbe, PROBE_KINDS, default: Probe } = await import('../../src/services/minebot/instantSkills/probe.js');

describe('probe kind=lane', () => {
  const makeBot = (dimension = 'the_nether') => {
    const read = room(eastOpening());
    return { entity: { position: new Vec3(1.5, 20, 1.5) }, game: { dimension }, registry: {}, entities: {},
      blockAt: (p: LaneCell) => { const b = read(p.x, p.y, p.z); return b ? { ...b, boundingBox: b.solid ? 'block' : 'empty' } : null; },
      dig: vi.fn(), placeBlock: vi.fn(), setControlState: vi.fn(), lookAt: vi.fn(), chat: vi.fn(), placeMemory: { remember: vi.fn() } } as any;
  };

  it('accepts an explicit spawner and exposes the parameter and kind, without any action or memory write', async () => {
    const bot = makeBot();
    expect(PROBE_KINDS).toContain('lane');
    expect(new Probe(bot).params.some(p => p.name === 'spawner')).toBe(true);
    expect(new Probe(bot).description).toContain('standAt/walkは先行する設置が成功した後');
    const answer = await runProbe(bot, { kind: 'lane', spawner: SPAWNER });
    expect(answer.success).toBe(true);
    const report = JSON.parse(answer.result);
    expect(Object.keys(report).slice(0, 3)).toEqual(['v', 'kind', 'text']);
    expect(report).toMatchObject({ kind: 'lane', found: true, spawner: SPAWNER });
    expect(report.candidates).toHaveLength(4);
    for (const f of [bot.dig, bot.placeBlock, bot.setControlState, bot.lookAt, bot.chat, bot.placeMemory.remember]) expect(f).not.toHaveBeenCalled();
    expect(answer.result.length).toBeLessThan(16_000);
  });

  it('searches the nearest loaded spawner when omitted, reports absence and rejects nonfinite input', async () => {
    scans.hits = [{ position: new Vec3(0, 20, 0) }];
    expect(JSON.parse((await runProbe(makeBot(), { kind: 'lane' })).result).found).toBe(true);
    scans.hits = [];
    expect(JSON.parse((await runProbe(makeBot(), { kind: 'lane' })).result).found).toBe(false);
    expect(JSON.parse((await runProbe(makeBot('overworld'), { kind: 'lane', spawner: SPAWNER })).result).text).not.toContain('overworld');
    expect((await runProbe(makeBot(), { kind: 'lane', spawner: { x: NaN, y: 20, z: 0 } })).failureType).toBe('invalid_input');
  });
});
