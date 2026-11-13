import { afterEach, describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import { EndermanCamp, endermanCampObservation } from '../../src/services/minebot/utils/huntEndermanCamp.js';
import { ENDERMAN_EYE, roofInteriorStep } from '../../src/services/minebot/utils/huntEnderman.js';
import { bodyReader } from '../../src/services/minebot/utils/localMap.js';
import type { StepContext } from '../../src/services/minebot/utils/primitives/common.js';
import { CAMP_RANGE, SPAWNER_RANGE, campSite, campWords, exposureFromSpawner, hideoutWords, hideoutsFrom, seenFromSpawner, type CampReader } from '../../src/services/minebot/utils/huntCamp.js';
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
    // nearest first, but for one beyond the spawner's range that may lead (below)
    const rest = found.filter(hideout => hideout.away <= SPAWNER_RANGE).map(hideout => hideout.steps);
    expect(rest).toEqual([...rest].sort((a, b) => a - b));
    const words = hideoutWords(found);
    expect(words).toContain('隠れ場所');
    expect(words).toMatch(/\(\d+, 56, -?\d+\) \d+歩/u);
  });

  it('a hideout beyond the spawner\'s 16 m (where a rest lets no blaze be added) goes first when its walk is at most ten steps longer, and the distance is said', () => {
    const read = flatGround(wallOf(6, -6, 6));
    const found = hideoutsFrom(read, ORIGIN, AT_CAMP, 3);
    const nearestSteps = Math.min(...hideoutsFrom(read, ORIGIN, AT_CAMP, 24).map(hideout => hideout.steps));
    expect(found[0].away).toBeGreaterThan(SPAWNER_RANGE);
    expect(found[0].steps).toBeLessThanOrEqual(nearestSteps + 10);
    expect(found.slice(1).every(hideout => hideout.steps >= nearestSteps)).toBe(true);
    expect(hideoutWords(found)).toMatch(/湧き場から\d+m（湧き場の範囲の外）/u);
    // a wall whose shadow is short (the footing behind it is within 16 m of the spawner only): the nearest, with no such mark
    const near = hideoutsFrom(flatGround(wallOf(6, -2, 2, 'nether_bricks', 57)), ORIGIN, AT_CAMP, 3);
    for (const hideout of near) expect(hideout.away).toBeGreaterThan(0);
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
      // (in or beside it: the cell and its four neighbours)
      expect(Math.abs(hideout.x - best.x) + Math.abs(hideout.z - best.z) <= 1 && hideout.y === best.y).toBe(false);
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

  it('the exposure is the share of the hover places that see the cell: 1 in the open beside the spawner, 0 behind the wall, between at the wall\'s end', () => {
    const open = flatGround();
    expect(exposureFromSpawner(open, ORIGIN, AT_CAMP)).toBeGreaterThan(0.9);
    const read = flatGround(wallOf(6, -6, 6));
    expect(exposureFromSpawner(read, ORIGIN, { x: 8, y: 56, z: 0 })).toBe(0);
    const edge = exposureFromSpawner(read, ORIGIN, { x: 7, y: 56, z: 9 });
    expect(edge).toBeGreaterThan(0);
    expect(edge).toBeLessThan(1);
    expect(seenFromSpawner(read, ORIGIN, { x: 7, y: 56, z: 9 })).toBe(true);
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

describe('hideoutsFrom: a fire beside the way does not shut it', () => {
  it('the footings behind the wall are still found when the way round its end passes beside fire (go puts fire out), but none in or beside the fire is offered', () => {
    const cells = { ...wallOf(6, -6, 6), '3,56,-7': 'fire', '4,56,-7': 'fire' };
    const read = flatGround(cells);
    const found = hideoutsFrom(read, ORIGIN, AT_CAMP, 3);
    expect(found.length).toBeGreaterThan(0);
    for (const hideout of found) {
      expect(hideout.x).toBeGreaterThanOrEqual(7);
      for (const [fx, fz] of [[3, -7], [4, -7]]) expect(Math.abs(hideout.x - fx) + Math.abs(hideout.z - fz) <= 1 && hideout.y === 56).toBe(false);
    }
  });
});

describe('EndermanCamp: bounded recovery inside the existing roof, for the same target only', () => {
  afterEach(() => { vi.useRealTimers(); });

  function campField(options: { maxX?: number; blocks?: Record<string, string> } = {}) {
    vi.useFakeTimers(); vi.setSystemTime(100_000);
    const blocks = { ...options.blocks }, controls: Record<string, boolean> = {};
    const maxX = options.maxX ?? 2;
    const bot = {
      entity: { id: 1, position: new Vec3(0.5, 0, 0.5), yaw: 0, onGround: true },
      entities: {} as Record<number, { id: number; name: string; position: Vec3; height?: number; width?: number }>,
      inventory: { slots: [] as unknown[], items: () => [{ name: 'cobblestone', count: 64 }] },
      gazeGuard: { enabled: true },
      blockAt: (p: Vec3): { name: string; position: Vec3; boundingBox: string } | null => {
        const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z), k = `${x},${y},${z}`;
        const name = blocks[k] ?? (y < 0 || (Math.abs(x) >= 6 && y === 0) ? 'stone'
          : y === 2 && x >= -1 && x <= maxX && Math.abs(z) <= 1 ? 'cobblestone' : 'air');
        return { name, position: new Vec3(x, y, z), boundingBox: ['air', 'lava', 'fire'].includes(name) ? 'empty' : 'block' };
      },
      setControlState: vi.fn((name: string, on: boolean) => { controls[name] = on; }),
      lookAt: vi.fn((p: Vec3): Promise<void> => { bot.entity.yaw = Math.atan2(-(p.x - bot.entity.position.x), -(p.z - bot.entity.position.z)); return Promise.resolve(); }),
      placeBlock: vi.fn(), dig: vi.fn(), attack: vi.fn(),
    };
    const target = { id: 200, name: 'enderman', position: new Vec3(10.5, 1, 0.5), height: 2.9, width: 0.6 };
    bot.entities[target.id] = target;
    const stop = new AbortController();
    const ctx: StepContext = { bot, stop: stop.signal, deadline: 130_000, facing: 'north', base: { x: 0, y: 0, z: 0 } };
    const camp = new EndermanCamp(ctx, target);
    return { bot, target, controls, stop, camp, blocks };
  }

  it('recovers one cell inside an extended roof, retains #200, and fights with hidden eyes once angry', async () => {
    const f = campField();
    expect(f.camp.check()).toBeNull();
    expect((await f.camp.advance(f.target, 100_000, 9, false)).kind).toBe('wait');
    const record = endermanCampObservation(f.bot)!;
    expect(record.afterBuild?.position).toEqual({ x: 0.5, y: 0, z: 0.5 });
    expect(record.afterBuild?.eyes.clear).toBe(false);
    expect(record.recovery).toHaveLength(1);
    expect(record.recovery[0].to).toEqual({ x: 1, y: 0, z: 0 });
    expect(f.controls.forward).toBe(true);
    f.bot.entity.position = new Vec3(1.5, 0, 0.5);
    await f.camp.advance(f.target, 100_500, 9, false);
    expect(record.recovery[0].result).toBe('arrived');
    expect(record.latest?.eyes.clear).toBe(true);
    expect(f.controls.forward).toBe(false);
    f.target.position = new Vec3(3.5, 0, 0.5);
    expect((await f.camp.advance(f.target, 100_550, 2, true)).kind).toBe('fight');
    expect(record.latest?.eyes.clear).toBe(false);
    expect(record.latest?.feet.clear).toBe(true);
    expect(record.targetId).toBe(200);
    expect(f.bot.gazeGuard.enabled).toBe(true);
    expect(f.bot.placeBlock).not.toHaveBeenCalled();
    expect(f.bot.dig).not.toHaveBeenCalled();
    f.camp.release();
  });

  it.each(['feet', 'approach'] as const)('records a blocked %s but provokes #200 when its eyes are clear', async part => {
    const f = campField({ blocks: part === 'feet' ? { '6,1,0': 'stone' } : {} });
    f.target.position = new Vec3(14.5, 1, 0.5);
    if (part === 'approach') {
      const read = f.bot.blockAt;
      // No known floor crosses this strip, while both sight lines remain loaded and open.
      f.bot.blockAt = (p: Vec3) => p.x === 8 && p.y <= 0 ? null : read(p);
    }
    expect((await f.camp.advance(f.target, 100_000, 14, false)).kind).toBe('wait');
    const record = endermanCampObservation(f.bot)!;
    expect(record.afterBuild?.eyes.clear).toBe(true);
    expect(record.afterBuild?.[part].clear).toBe(false);
    expect(record.recovery).toHaveLength(0);
    expect(f.bot.lookAt).toHaveBeenCalledWith(f.target.position.offset(0, ENDERMAN_EYE, 0), true);
    expect(f.bot.gazeGuard.enabled).toBe(false);
    expect((await f.camp.advance(f.target, 100_300, 14, true)).kind).toBe('fight');
    expect(record.latest?.[part].clear).toBe(false);
    expect(record.targetId).toBe(200);
    f.camp.release();
    expect(f.bot.gazeGuard.enabled).toBe(true);
  });

  it('recovers to a clear eye ray even when the feet and walking route remain blocked', async () => {
    const f = campField({ blocks: { '6,1,0': 'stone' } });
    const read = f.bot.blockAt;
    f.bot.blockAt = (p: Vec3) => p.x === 8 && p.y <= 0 ? null : read(p);
    await f.camp.advance(f.target, 100_000, 9, false);
    const record = endermanCampObservation(f.bot)!;
    expect(record.recovery).toHaveLength(1);
    f.bot.entity.position = new Vec3(1.5, 0, 0.5);
    expect((await f.camp.advance(f.target, 100_500, 9, false)).kind).toBe('wait');
    expect(record.recovery[0].result).toBe('arrived');
    expect(record.latest?.eyes.clear).toBe(true);
    expect(record.latest?.feet.clear).toBe(false);
    expect(record.latest?.approach.clear).toBe(false);
    expect(f.bot.gazeGuard.enabled).toBe(false);
    f.camp.release();
  });

  it('leaves prolonged lower-body obstruction after anger to the existing fight loop', async () => {
    const f = campField({ blocks: { '1,1,0': 'stone' } });
    f.target.position = new Vec3(2.5, 0, 0.5);
    expect((await f.camp.advance(f.target, 100_000, 2, true)).kind).toBe('fight');
    expect((await f.camp.advance(f.target, 108_001, 2, true)).kind).toBe('fight');
    expect(endermanCampObservation(f.bot)?.latest?.feet.clear).toBe(false);
    expect(endermanCampObservation(f.bot)?.recovery).toHaveLength(0);
    f.camp.release();
  });

  it('does not step onto the edge of a bare 3x3 roof, and returns not_visible with the cobblestone blocker', async () => {
    const f = campField({ maxX: 1, blocks: { '1,1,0': 'cobblestone' } });
    const read = bodyReader(f.bot), anchor = { x: 0, y: 0, z: 0 };
    for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) expect(roofInteriorStep(read, anchor, anchor, { x, y: 0, z })).toBe(false);
    await f.camp.advance(f.target, 100_000, 9, false);
    const step = await f.camp.advance(f.target, 108_001, 9, false);
    expect(step.kind).toBe('stop');
    if (step.kind === 'stop') { expect(step.outcome.code).toBe('enderman_not_visible'); expect(step.outcome.text).toContain('(1,1,0) cobblestone'); }
    expect(endermanCampObservation(f.bot)?.recovery).toEqual([]);
    expect(f.bot.entity.position).toEqual(new Vec3(0.5, 0, 0.5));
    expect(f.controls.forward).not.toBe(true);
  });

  it('a stem occluding the eye ray cannot authorize movement around it', async () => {
    const f = campField({ blocks: { '1,1,0': 'warped_stem' } });
    await f.camp.advance(f.target, 100_000, 9, false);
    const step = await f.camp.advance(f.target, 108_001, 9, false);
    expect(step.kind).toBe('stop');
    if (step.kind === 'stop') expect(step.outcome.text).toContain('warped_stem');
    expect(endermanCampObservation(f.bot)?.recovery).toHaveLength(0);
  });

  it.each(['lava', 'fire', 'unloaded', 'pit', 'occupied'])('refuses an adjacent cell with %s', async hazard => {
    const f = campField();
    if (hazard === 'occupied') f.bot.entities[201] = { id: 201, name: 'enderman', position: new Vec3(1.5, 0, 0.5) };
    else if (hazard === 'pit') f.blocks['2,-1,0'] = 'air';
    else if (hazard === 'unloaded') {
      const read = f.bot.blockAt;
      // The native block reader may return null for an unloaded cell.
      f.bot.blockAt = (p: Vec3) => p.x === 2 && p.y === -1 && p.z === 0 ? null : read(p);
    } else f.blocks['2,0,0'] = hazard;
    await f.camp.advance(f.target, 100_000, 9, false);
    expect(endermanCampObservation(f.bot)?.recovery).toHaveLength(0);
    expect(f.controls.forward).not.toBe(true);
  });

  it('stops a stalled step at 1.8 seconds, releases movement and keeps the original blocker', async () => {
    const f = campField();
    await f.camp.advance(f.target, 100_000, 9, false);
    const step = await f.camp.advance(f.target, 101_800, 9, false);
    expect(step.kind).toBe('stop');
    if (step.kind === 'stop') { expect(step.outcome.reason).toBe('not_visible'); expect(step.outcome.text).toContain('cobblestone'); }
    expect(f.controls.forward).toBe(false); expect(f.controls.sneak).toBe(false);
    expect(endermanCampObservation(f.bot)?.recovery[0].result).toBe('stopped');
  });

  it('rechecks the standing roof during movement and stops if the destination loses its cover', async () => {
    const f = campField();
    await f.camp.advance(f.target, 100_000, 9, false);
    f.blocks['2,2,0'] = 'air';
    expect((await f.camp.advance(f.target, 100_050, 9, false)).kind).toBe('stop');
    expect(f.controls.forward).toBe(false);
    expect(f.controls.sneak).toBe(false);
    expect(f.bot.entity.position).toEqual(new Vec3(0.5, 0, 0.5));
    expect(f.bot.placeBlock).not.toHaveBeenCalled();
  });

  it('permits at most two steps for #200 even when it alternates sides, and never restarts the blind budget', async () => {
    const f = campField();
    await f.camp.advance(f.target, 100_000, 9, false);
    f.bot.entity.position = new Vec3(1.5, 0, 0.5);
    await f.camp.advance(f.target, 100_400, 9, false);
    f.target.position = new Vec3(-9.5, 1, 0.5);
    await f.camp.advance(f.target, 100_500, 9, false);
    f.bot.entity.position = new Vec3(0.5, 0, 0.5);
    await f.camp.advance(f.target, 100_900, 9, false);
    f.target.position = new Vec3(10.5, 1, 0.5);
    await f.camp.advance(f.target, 101_000, 9, false);
    expect(endermanCampObservation(f.bot)?.recovery).toHaveLength(2);
    const step = await f.camp.advance(f.target, 109_001, 9, false);
    expect(step.kind).toBe('stop');
    expect(endermanCampObservation(f.bot)?.recovery).toHaveLength(2);
    expect(f.controls.forward).toBe(false);
  });

  it('bounds both recovery steps together to three seconds', async () => {
    const f = campField();
    await f.camp.advance(f.target, 100_000, 9, false);
    f.bot.entity.position = new Vec3(1.5, 0, 0.5);
    await f.camp.advance(f.target, 101_700, 9, false);
    f.target.position = new Vec3(-9.5, 1, 0.5);
    await f.camp.advance(f.target, 101_750, 9, false);
    expect(endermanCampObservation(f.bot)?.recovery).toHaveLength(2);
    expect((await f.camp.advance(f.target, 103_000, 9, false)).kind).toBe('stop');
    expect(f.controls.forward).toBe(false);
  });

  it('does not replace a lost target with a different live ID during recovery', async () => {
    const f = campField();
    await f.camp.advance(f.target, 100_000, 9, false);
    const step = await f.camp.advance({ ...f.target, id: 201 }, 100_050, 9, false);
    expect(step.kind).toBe('stop');
    if (step.kind === 'stop') expect(step.outcome.code).toBe('target_lost');
    expect(endermanCampObservation(f.bot)?.targetId).toBe(200);
    expect(f.controls.forward).toBe(false);
    expect(f.bot.attack).not.toHaveBeenCalled();
  });

  it('cancellation and release stop a pending step and restore the gaze guard', async () => {
    const f = campField();
    await f.camp.advance(f.target, 100_000, 9, false);
    f.stop.abort('test');
    expect((await f.camp.advance(f.target, 100_050, 9, false)).kind).toBe('stop');
    f.camp.release();
    expect(f.controls.forward).toBe(false); expect(f.controls.sneak).toBe(false);
    expect(f.bot.gazeGuard.enabled).toBe(true);
  });
});

describe('campSite: a roof over the head (round 9: the open top let five blazes shoot down into the camp)', () => {
  it('every cell says whether the cell over its head is a block, and a roofed cell is ranked before an open one of the same pits', () => {
    const site = campSite(ground(), SPAWNER, 40);
    for (const cell of site.cells) expect(typeof cell.roofed).toBe('boolean');
    const firstOpen = site.cells.findIndex(cell => !cell.roofed), lastRoofedSamePits = (pits: number) => Math.max(...site.cells.map((cell, index) => (cell.roofed && cell.pits === pits ? index : -1)));
    if (firstOpen >= 0) expect(lastRoofedSamePits(site.cells[firstOpen].pits)).toBeLessThan(site.cells.findIndex((cell, index) => index >= firstOpen && !cell.roofed && cell.pits === site.cells[firstOpen].pits) + 1);
    expect(campWords(site)).toContain('上が覆われた野営マス');
  });
  it('a block laid over a cell roofs it', () => {
    const base = campSite(ground(), SPAWNER, 40).cells.find(cell => !cell.roofed);
    if (!base) return;
    const roofed = campSite(ground({ [`${base.x},${base.y + 2},${base.z}`]: 'cobblestone' }), SPAWNER, 40).cells.find(cell => cell.x === base.x && cell.y === base.y && cell.z === base.z);
    expect(roofed?.roofed).toBe(true);
  });
});
