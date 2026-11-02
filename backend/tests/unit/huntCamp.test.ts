import { describe, expect, it } from 'vitest';
import { CAMP_RANGE, campSite, campWords } from '../../src/services/minebot/utils/huntCamp.js';
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
