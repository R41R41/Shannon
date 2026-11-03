import { describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import { laneProbeFields, laneReport, type LaneCandidate, type LaneCell } from '../../src/services/minebot/utils/huntLane.js';
import type { CampReader } from '../../src/services/minebot/utils/huntCamp.js';
import { solidBetween } from '../../src/services/minebot/utils/probeTools.js';

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
const east = (read: CampReader) => laneReport(read, SPAWNER, FROM).candidates.find(c => c.direction === 'east')!;
const at = (c: LaneCandidate, p: LaneCell) => c.build.find(b => key(b.at) === key(p))!;
/** An unlimited, loaded stone floor and open air, with synthetic changes only. */
const flat = (changes: Record<string, string | null> = {}): CampReader => (x, y, z) => {
  const k = `${x},${y},${z}`, name = k in changes ? changes[k] : k === key(SPAWNER) ? 'spawner' : y < 20 ? 'stone' : 'air';
  return name === null ? null : { name, solid: !['air', 'water', 'lava', 'fire', 'soul_fire'].includes(name) };
};

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
    const changes = { ...eastOpening(), '3,20,0': 'lava', '5,20,1': 'water', '4,21,0': 'fire' };
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
    expect(text).toContain(`立ち位置つきの建築順（${new Set(best.build.filter(p => p.group !== null).map(p => p.group)).size}組）。立てる所が無いマス${best.build.filter(p => !p.standAt).length}個`);
    expect(text).not.toMatch(/\(|\)|x=|y=|z=|netherrack|spawner|c1|run59/u);
  });

  it('offers only full floors with two open body cells, within 4.3 metres of the eye, and never places in the body', () => {
    const read = flat(), c = east(read), offered = c.build.filter(p => p.standAt);
    expect(offered.length).toBeGreaterThan(10);
    const projected = new Set<string>();
    for (const p of c.build) {
      if (!p.standAt) continue;
      const q = p.standAt;
      expect(read(q.x, q.y - 1, q.z)).toMatchObject({ name: 'stone', solid: true });
      expect(read(q.x, q.y, q.z)?.name).toBe('air');
      expect(read(q.x, q.y + 1, q.z)?.name).toBe('air');
      expect(projected.has(key(q))).toBe(false);
      expect(projected.has(key({ ...q, y: q.y + 1 }))).toBe(false);
      expect(Math.hypot(q.x - p.at.x, q.y + 1.62 - (p.at.y + 0.5), q.z - p.at.z)).toBeLessThanOrEqual(4.3);
      expect([key(q), key({ ...q, y: q.y + 1 })]).not.toContain(key(p.at));
      expect(p).toMatchObject({ noStand: null, fireNear: false });
      const current: CampReader = (x, y, z) => projected.has(key({ x, y, z })) ? { name: 'cobblestone', solid: true } : read(x, y, z);
      expect(solidBetween(current, [q.x + 0.5, q.y + 1.62, q.z + 0.5], [p.at.x + 0.5, p.at.y + 0.5, p.at.z + 0.5])).toEqual([]);
      if (!p.blockedByCreature && p.at.state === 'air' && (p.supportNow === true || (p.supportAfter && projected.has(key(p.supportAfter))))) projected.add(key(p.at));
    }
    // A slab is a collision block, but not a full floor even when its reader says solid.
    const slab = east(flat({ '5,19,0': 'stone_slab' }));
    expect(slab.build.filter(p => p.standAt).every(p => key(p.standAt!) !== '5,20,0')).toBe(true);
    // A non-full custom box must not be promoted to a full floor either.
    const lowBlock = { name: 'stone', solid: true, top: 0.5 };
    const lowFloor: CampReader = (x, y, z) => x === 5 && y === 19 && z === 0 ? lowBlock : read(x, y, z);
    expect(east(lowFloor).build.filter(p => p.standAt).every(p => key(p.standAt!) !== '5,20,0')).toBe(true);
  });

  it('avoids fire even diagonally adjacent, as well as water, lava, magma and an open edge', () => {
    for (const name of ['fire', 'soul_fire', 'lava', 'water', 'magma_block']) {
      const c = east(flat({ '6,20,1': name }));
      expect(c.build.some(p => p.standAt)).toBe(true);
      for (const p of c.build) if (p.standAt) {
        const q = p.standAt;
        expect(Math.max(Math.abs(q.x - 6), Math.abs(q.z - 1)) > 1 || q.y > 21 || q.y < 18).toBe(true);
        expect(p.fireNear).toBe(false);
      }
    }
    const hole: Record<string, string> = {};
    for (let y = 15; y <= 19; y++) hole[`6,${y},0`] = 'air';
    const c = east(flat(hole));
    expect(c.build.filter(p => p.standAt).every(p => key(p.standAt!) !== '5,20,0')).toBe(true);
  });

  it('prefers the nearest valid footing to this direction’s waiting cell', () => {
    const c = east(flat());
    // The waiting cell is safe and in reach of the first enclosure block; no other cell is closer.
    expect(c.build[0].standAt).toEqual({ x: 5, y: 20, z: 0 });
    const c2 = east(flat({ '6,20,1': 'fire' }));
    expect(c2.build[0].standAt).not.toEqual({ x: 5, y: 20, z: 0 });
    expect(c2.build[0].standAt).not.toBeNull();
    // Among the safe cells, (4,20,0) is the nearest and still sees the first enclosure cell.
    expect(c2.build[0].standAt).toEqual({ x: 4, y: 20, z: 0 });
  });

  it('breaks equal-distance ties by being outside the spawn columns or under a cap, then by a wall towards the spawner', () => {
    // The waiting floor is not a full box, so several cells at distance one compete.
    const base = { '5,19,0': 'stone_slab' };
    const outside = east(flat(base)).build[0].standAt!;
    expect(Math.hypot(outside.x - 5, outside.y - 20, outside.z)).toBe(1);
    expect(Math.abs(outside.x) > 4 || Math.abs(outside.z) > 4).toBe(true);
    // A cap already in the world puts the inside candidate on an equal footing with the outside ones.
    expect(east(flat({ ...base, '4,22,0': 'stone' })).build[0].standAt).toEqual({ x: 4, y: 20, z: 0 });
    // This wall shields the outside candidate to the east, while the equally near southern one is exposed.
    expect(east(flat({ ...base, '4,21,0': 'stone' })).build[0].standAt).toEqual({ x: 6, y: 20, z: 0 });
  });

  it('treats half blocks as opaque even when the reader marks them non-solid', () => {
    const read = flat();
    const slab: CampReader = (x, y, z) => x === 5 && y === 21 && z === -1 ? { name: 'stone_slab', solid: false } : read(x, y, z);
    const c = east(slab), p = at(c, { x: 5, y: 20, z: -1 });
    // This slab cuts the eye-to-centre line from the waiting cell to the lower enclosure block.
    expect(p.standAt).not.toEqual({ x: 5, y: 20, z: 0 });
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
    const c = laneReport(flat(), SPAWNER, FROM, { entities }).candidates.find(c => c.direction === 'east')!;
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
    const r = laneReport(room(eastOpening()), SPAWNER, FROM), wire = laneProbeFields(r);
    expect(wire.rows.build).toEqual(['fact', 'partIndex', 'supportAfterCell', 'flags', 'standAtCell', 'group']);
    expect(wire.rows.facts).toEqual(['cell', 'supportNow', 'occupiedCount', 'belowDepth', 'belowEnd', 'needsClearing', 'standFact']);
    expect(wire.rows.cells).toEqual(['x', 'y', 'z', 'name', 'state']);
    expect(wire.rows.flags).toEqual({ inReach: 1, visibleNow: 2, noSupport: 4 });
    for (const [i, c] of wire.candidates.entries()) for (const [j, row] of c.build.entries()) {
      const original = r.candidates[i].build[j], fact = wire.facts[row[0] as number];
      expect(Object.keys(original).slice(0, 11)).toEqual(['at', 'part', 'supportNow', 'supportAfter', 'occupied', 'distance', 'inReach', 'visible', 'noSupport', 'below', 'needsClearing']);
      expect(wire.cells[fact[0]]).toEqual([original.at.x, original.at.y, original.at.z, original.at.name, original.at.state]);
      expect(fact.slice(1, 6)).toEqual([original.supportNow, original.occupied.length, original.below.depth, original.below.end, original.needsClearing]);
      expect(row.slice(0, 4)).toEqual([row[0], wire.rows.parts.indexOf(original.part), row[2], (original.inReach ? 1 : 0) | (original.visible ? 2 : 0) | (original.noSupport ? 4 : 0)]);
      expect(row[2] === null ? null : wire.cells[row[2] as number].slice(0, 3)).toEqual(original.supportAfter ? [original.supportAfter.x, original.supportAfter.y, original.supportAfter.z] : null);
      expect(row).toHaveLength(6);
      const standAtCell = row[4];
      expect(standAtCell === null ? null : wire.cells[standAtCell].slice(0, 3)).toEqual(original.standAt ? [original.standAt.x, original.standAt.y, original.standAt.z] : null);
      expect(row[5]).toBe(original.group);
      expect(wire.standFacts[fact[6]]).toEqual([original.noStand, original.blockedByCreature, original.fireNear]);
    }
  });

  it('retains all four build orders and the appended columns, including large coordinates', () => {
    const r = laneReport((x, y, z) => key({ x, y, z }) === key(SPAWNER) ? { name: 'spawner', solid: true } : { name: 'air', solid: false }, SPAWNER, FROM);
    const wire = laneProbeFields(r);
    const roundTrip = JSON.parse(JSON.stringify({ v: 1, kind: 'lane', found: true, ...wire }));
    expect(roundTrip.candidates.map((c: { build: unknown[][] }) => c.build.length)).toEqual(r.candidates.map(c => c.build.length));
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
    expect(decoded.candidates.map((c: { build: unknown[][] }) => c.build.length)).toEqual(distant.candidates.map(c => c.build.length));
    // The receiver's 16k truncation lives outside this read-only change. Preserve all columns and all plans;
    // do not make an oversized receipt pass by silently dropping footings, directions or null cells.
    expect(decoded.candidates.every((c: { build: unknown[][] }) => c.build.every(row => row.length === 6))).toBe(true);
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
