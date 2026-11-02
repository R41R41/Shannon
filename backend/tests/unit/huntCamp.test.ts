import { describe, expect, it } from 'vitest';
import { CAMP_RANGE, campSite, campWords, hideoutWords, hideoutsFrom, seenFromSpawner, type CampReader } from '../../src/services/minebot/utils/huntCamp.js';
import { LAYERS, SPAWNER, ground } from './fixtures/blazeSpawnerRoom.js';

// Where to stand at a blaze spawner (S2, 2026-11-02). The fixture is the REAL ground of a staged natural world's fortress, read by the lab probe (map_blaze) round its spawner at
// (-101, 56, -115): the spawner room is five by five with a one-block brick wall and a fence over it, floor at y 55; north of it the corridor has a three-wide shaft that goes
// down, with a one-block ledge at each side. The staged stand of the lab was on that ledge; the room's north opening is the cells beside the shaft.

const inRoom = (cell: { x: number; z: number }) => cell.x >= -103 && cell.x <= -99 && cell.z >= -117 && cell.z <= -113;

describe('campSite: the cells within three blocks of the spawner to stand on', () => {
  it('on the lab\'s real ground the camp is in the room, not at the shaft: every cell offered has no pit within three cells', () => {
    const site = campSite(ground(), SPAWNER, 6);
    expect(site.cells.length).toBeGreaterThan(0);
    for (const cell of site.cells) {
      expect(Math.hypot(cell.x - SPAWNER.x, cell.z - SPAWNER.z), `${cell.x},${cell.y},${cell.z}`).toBeLessThanOrEqual(CAMP_RANGE + 1e-6);
      expect(cell.y).toBe(56);
    }
    const best = site.cells[0];
    expect(inRoom(best)).toBe(true);
    expect(best.pits).toBe(0);
    expect(best.walls).toBeGreaterThanOrEqual(1);
  });

  it('the cells at the room\'s north opening, beside the shaft, are ranked below those inside (a pit three cells north of them)', () => {
    const site = campSite(ground(), SPAWNER, 40);
    const north = site.cells.filter(cell => cell.z === -117 && cell.x >= -102 && cell.x <= -100);
    expect(north.length).toBeGreaterThan(0);
    for (const cell of north) expect(cell.pits).toBeGreaterThanOrEqual(1);
    const firstNorth = site.cells.indexOf(north[0]);
    const lastInside = Math.max(...site.cells.map((cell, index) => (cell.pits === 0 ? index : -1)));
    expect(lastInside).toBeLessThan(firstNorth);
  });

  it('a cell with an edge is not offered at all: take the room\'s west wall and floor away and the cells beside the gap go', () => {
    const change: Record<string, string> = {};
    for (let y = 53; y <= 57; y++) for (let z = -117; z <= -113; z++) change[`-104,${y},${z}`] = 'air';
    for (let y = 50; y <= 55; y++) for (let z = -117; z <= -113; z++) for (const x of [-103]) change[`${x},${y},${z}`] = 'air';
    const site = campSite(ground(change), SPAWNER, 40);
    // (the row z -117 keeps its wall block at y 56 on that side: nothing there to fall through)
    expect(site.cells.some(cell => cell.x === -102 && cell.z >= -116 && cell.z <= -113)).toBe(false);
    expect(site.rejected.edge + site.rejected.notStanding).toBeGreaterThan(0);
  });

  it('fire in or beside a cell takes it out (go\'s own rule), and the fire near the spawner is counted', () => {
    const clean = campSite(ground(), SPAWNER, 40);
    const burning = campSite(ground({ '-103,56,-113': 'fire', '-100,57,-116': 'fire' }), SPAWNER, 40);
    expect(burning.fire).toBe(2);
    expect(clean.cells.some(cell => cell.x === -103 && cell.z === -113)).toBe(true);
    expect(burning.cells.some(cell => cell.x === -103 && cell.z === -113)).toBe(false);
    expect(burning.cells.some(cell => cell.x === -102 && cell.z === -113)).toBe(false);
    expect(burning.rejected.hazard).toBeGreaterThan(0);
  });

  it('unloaded cells are not stood on, and said apart', () => {
    const site = campSite(() => null, SPAWNER);
    expect(site.cells).toEqual([]);
    expect(site.rejected.unloaded).toBeGreaterThan(0);
    expect(campWords(site)).toContain('未ロード');
  });

  it('the words: the cell, its distance and its walls; with none, why', () => {
    const site = campSite(ground(), SPAWNER, 2);
    const words = campWords(site);
    expect(words).toContain('野営向きの足場');
    expect(words).toMatch(/\(-10\d, 56, -11\d\) [0-3](\.\d)?m・壁\d面/u);
    const none = campWords({ spawner: SPAWNER, cells: [], considered: 10, rejected: { notStanding: 4, hazard: 3, edge: 3, unloaded: 0 }, fire: 0 });
    expect(none).toContain('縁の無い足場が無い');
    expect(none).toContain('縁あり 3');
  });
});

// Where to go when the health runs low (S2, 2026-11-02, S4's c1 trials): a footing that no blaze of the spawner can see, a walk from the camp. A synthetic ground: a flat floor at y 55
// with the spawner a block at (0, 56, 0), and a wall over it where a test puts one.
const flatGround = (blocks: Record<string, string> = {}): CampReader => (x, y, z) => {
  const key = `${x},${y},${z}`;
  if (key in blocks) { const name = blocks[key]; return { name, solid: !['air', 'fire', 'lava', 'water'].includes(name) }; }
  if (Math.abs(x) > 40 || Math.abs(z) > 40 || y < 50 || y > 80) return null;
  if (x === 0 && y === 56 && z === 0) return { name: 'spawner', solid: true };
  return y <= 55 ? { name: 'netherrack', solid: true } : { name: 'air', solid: false };
};
const wallOf = (x: number, z0: number, z1: number, name = 'nether_bricks', top = 61): Record<string, string> => {
  const cells: Record<string, string> = {};
  for (let z = z0; z <= z1; z++) for (let y = 56; y <= top; y++) cells[`${x},${y},${z}`] = name;
  return cells;
};
const ORIGIN = { x: 0, y: 56, z: 0 };
const AT_CAMP = { x: 2, y: 56, z: 0 };

describe('hideoutsFrom: a footing no blaze of the spawner can see', () => {
  it('in the open there is none, and the words say to go away from the spawner', () => {
    const none = hideoutsFrom(flatGround(), ORIGIN, AT_CAMP);
    expect(none).toEqual([]);
    expect(hideoutWords(none)).toContain('40 歩内に無い');
  });

  it('a tall wall makes a shadow: the footings are behind it, nearest first, and the camp itself is seen', () => {
    const read = flatGround(wallOf(6, -6, 6));
    expect(seenFromSpawner(read, ORIGIN, AT_CAMP)).toBe(true);
    const found = hideoutsFrom(read, ORIGIN, AT_CAMP, 3);
    expect(found.length).toBeGreaterThan(0);
    for (const hideout of found) {
      expect(hideout.x, `${hideout.x},${hideout.y},${hideout.z}`).toBeGreaterThanOrEqual(7);
      expect(seenFromSpawner(read, ORIGIN, hideout)).toBe(false);
      expect(hideout.steps).toBeGreaterThan(0);
      expect(hideout.steps).toBeLessThanOrEqual(40);
    }
    expect(found.map(hideout => hideout.steps)).toEqual([...found.map(hideout => hideout.steps)].sort((a, b) => a - b));
    const words = hideoutWords(found);
    expect(words).toContain('隠れ場所');
    expect(words).toMatch(/\(\d+, 56, -?\d+\) \d+歩/u);
  });

  it('the way round the wall is walked (steps count the cells), and a wall too far to walk round within the limit gives none', () => {
    const read = flatGround(wallOf(6, -30, 30));
    expect(hideoutsFrom(read, ORIGIN, AT_CAMP, 3, 16)).toEqual([]);
    const near = flatGround(wallOf(6, -3, 3));
    const found = hideoutsFrom(near, ORIGIN, AT_CAMP, 1);
    expect(found.length).toBe(1);
  });

  it('a fence, a stair or a slab does not hide: a line passes beside the post or over the step', () => {
    for (const name of ['nether_brick_fence', 'nether_brick_stairs', 'nether_brick_slab', 'iron_bars']) {
      const read = flatGround(wallOf(6, -6, 6, name));
      expect(hideoutsFrom(read, ORIGIN, AT_CAMP), name).toEqual([]);
    }
  });

  it('a footing in or beside fire is not offered', () => {
    const read = flatGround(wallOf(6, -6, 6));
    const best = hideoutsFrom(read, ORIGIN, AT_CAMP, 1)[0];
    const burning = flatGround({ ...wallOf(6, -6, 6), [`${best.x},${best.y},${best.z}`]: 'fire' });
    for (const hideout of hideoutsFrom(burning, ORIGIN, AT_CAMP, 6)) {
      expect(Math.abs(hideout.x - best.x) <= 1 && Math.abs(hideout.z - best.z) <= 1 && hideout.y === best.y).toBe(false);
    }
  });

  it('a blaze\'s spot in rock is no place a shot comes from: a closed box round the spawner with one slit sees only along the slit', () => {
    // The spawner in a closed room, five wide (the cells x -2..2, z -2..2 at y 56..58 open, rock round it), with a corridor going east from (3, 56, 0): a cell in the corridor's side branch is not seen.
    const cells: Record<string, string> = {};
    for (let x = -6; x <= 14; x++) for (let z = -6; z <= 6; z++) for (let y = 56; y <= 60; y++) cells[`${x},${y},${z}`] = 'netherrack';
    for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) for (let y = 56; y <= 58; y++) cells[`${x},${y},${z}`] = 'air';
    cells['0,56,0'] = 'spawner';
    for (let x = 3; x <= 10; x++) for (let y = 56; y <= 57; y++) cells[`${x},${y},0`] = 'air';
    for (let z = 1; z <= 4; z++) for (let y = 56; y <= 57; y++) cells[`10,${y},${z}`] = 'air';
    const read = flatGround(cells);
    expect(seenFromSpawner(read, ORIGIN, { x: 2, y: 56, z: 1 })).toBe(true);
    expect(seenFromSpawner(read, ORIGIN, { x: 10, y: 56, z: 4 })).toBe(false);
    const found = hideoutsFrom(read, ORIGIN, { x: 2, y: 56, z: 1 }, 3);
    expect(found.length).toBeGreaterThan(0);
    for (const hideout of found) expect(seenFromSpawner(read, ORIGIN, hideout)).toBe(false);
  });

  it('on the real ground of the lab\'s fortress: the camp cell is seen, and no footing offered is', () => {
    const read = ground();
    const camp = campSite(read, SPAWNER, 4).cells[0];
    expect(seenFromSpawner(read, SPAWNER, camp)).toBe(true);
    for (const hideout of hideoutsFrom(read, SPAWNER, camp, 6)) expect(seenFromSpawner(read, SPAWNER, hideout)).toBe(false);
  });

  it('unloaded ground gives none (and does not throw)', () => {
    expect(hideoutsFrom(() => null, ORIGIN, AT_CAMP)).toEqual([]);
  });
});

describe('the fixture itself', () => {
  it('is six layers of seventeen rows of seventeen cells (a short row would be read as netherrack)', () => {
    expect(Object.keys(LAYERS).length).toBe(6);
    for (const [y, rows] of Object.entries(LAYERS)) {
      expect(rows.length, `y ${y}`).toBe(17);
      for (const row of rows) expect(row.length, `y ${y} ${row}`).toBe(17);
    }
    expect(ground()(SPAWNER.x, SPAWNER.y, SPAWNER.z)?.name).toBe('spawner');
  });
});
