import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Vec3 } from 'vec3';
import {
  describeSeenReach, emptyPlaceMemory, forgetPlaces, markSeen, MAX_PLACES, parsePlaceMemory, placesDigest, recallPlaces, rememberPlace, seenReach,
} from '../../src/modules/minecraftLearning/places.js';
import { installPlaceMemory } from '../../src/services/minebot/utils/placeMemory.js';

const overworld = 'overworld';

describe('places seen are kept in mind after they are out of sight (paid run L74 looked for the same water seven times)', () => {
  it('takes sightings of one pool as one place and a pool further off as another', () => {
    const state = emptyPlaceMemory();
    rememberPlace(state, { kind: 'water', dimension: overworld, position: { x: 10, y: 62, z: 10 }, count: 12 }, 1000);
    rememberPlace(state, { kind: 'water', dimension: overworld, position: { x: 20, y: 62, z: 14 }, count: 30 }, 2000);
    rememberPlace(state, { kind: 'water', dimension: overworld, position: { x: 90, y: 62, z: 10 } }, 3000);
    expect(state.places).toHaveLength(2);
    expect(state.places[0]).toMatchObject({ position: { x: 10, y: 62, z: 10 }, count: 30, firstSeenAt: 1000, lastSeenAt: 2000 });
  });

  it('keeps a furnace where it stands: two of them two blocks apart are two places', () => {
    const state = emptyPlaceMemory();
    rememberPlace(state, { kind: 'furnace', dimension: overworld, position: { x: 0, y: 64, z: 0 } }, 1);
    rememberPlace(state, { kind: 'furnace', dimension: overworld, position: { x: 2, y: 64, z: 0 } }, 2);
    expect(state.places).toHaveLength(2);
  });

  it('recalls nearest first, by kind or part of one, in the dimension the body is in', () => {
    const state = emptyPlaceMemory();
    rememberPlace(state, { kind: 'diamond_ore', dimension: overworld, position: { x: 100, y: -50, z: 0 }, count: 3 }, 1);
    rememberPlace(state, { kind: 'iron_ore', dimension: overworld, position: { x: 10, y: 20, z: 0 } }, 1);
    rememberPlace(state, { kind: 'lava', dimension: overworld, position: { x: 0, y: 60, z: -40 } }, 1);
    rememberPlace(state, { kind: 'lava', dimension: 'the_nether', position: { x: 1, y: 60, z: 1 } }, 1);
    const from = { x: 0, y: 64, z: 0 };
    expect(recallPlaces(state, { from, dimension: overworld, kind: 'ore' }).map(place => place.kind)).toEqual(['iron_ore', 'diamond_ore']);
    expect(recallPlaces(state, { from, dimension: overworld, kind: 'lava' })).toMatchObject([{ distance: 40, direction: '北' }]);
    expect(recallPlaces(state, { from, dimension: overworld })).toHaveLength(3);
  });

  it('gives the nearest of each kind as one short line, and keeps the kinds it knows fewest of when lines run out', () => {
    const state = emptyPlaceMemory();
    rememberPlace(state, { kind: 'water', dimension: overworld, position: { x: 30, y: 62, z: 0 }, count: 5 }, 1);
    rememberPlace(state, { kind: 'water', dimension: overworld, position: { x: 300, y: 62, z: 0 } }, 1);
    rememberPlace(state, { kind: 'village', dimension: overworld, position: { x: 0, y: 70, z: 120 }, note: 'bell×1' }, 1);
    expect(placesDigest(state, { x: 0, y: 62, z: 0 }, overworld)).toEqual({ water: '30m 東 (30,62,0) ×5', village: '120m 南 (0,70,120) bell×1' });
    // One line only: the one village, not the nearer of two pools.
    expect(Object.keys(placesDigest(state, { x: 0, y: 62, z: 0 }, overworld, 1))).toEqual(['village']);
  });

  it('drops what is looked at again and found gone, and bounds what it holds', () => {
    const state = emptyPlaceMemory();
    rememberPlace(state, { kind: 'coal_ore', dimension: overworld, position: { x: 1, y: 10, z: 1 } }, 1);
    rememberPlace(state, { kind: 'village', dimension: overworld, position: { x: 500, y: 70, z: 0 } }, 2);
    expect(forgetPlaces(state, place => place.kind === 'coal_ore')).toBe(1);
    for (let index = 0; index < MAX_PLACES + 20; index++) rememberPlace(state, { kind: 'iron_ore', dimension: overworld, position: { x: index * 20, y: 0, z: 0 } }, 10 + index);
    expect(state.places).toHaveLength(MAX_PLACES);
    // The crowded kind gives way, oldest first; the one village stays.
    expect(state.places.some(place => place.kind === 'village')).toBe(true);
    expect(state.places.some(place => place.kind === 'iron_ore' && place.position.x === 0)).toBe(false);
  });

  it('reads back only what it wrote', () => {
    expect(parsePlaceMemory(null).places).toEqual([]);
    expect(parsePlaceMemory({ version: 2, places: [] }).places).toEqual([]);
    const state = emptyPlaceMemory();
    rememberPlace(state, { kind: 'lava', dimension: overworld, position: { x: 1, y: 2, z: 3 } }, 5);
    expect(parsePlaceMemory(JSON.parse(JSON.stringify({ ...state, places: [...state.places, { kind: 'broken' }] }))).places).toHaveLength(1);
  });
});

describe('the ground already seen is kept, so that "which way have I not been" has an answer', () => {
  it('measures, in each direction, how far what it has seen reaches from where it stands', () => {
    const state = emptyPlaceMemory();
    // Seen: a strip six chunks long to the east of the origin chunk, one chunk wide.
    for (let chunkX = 0; chunkX <= 6; chunkX++) expect(markSeen(state, overworld, chunkX, 0)).toBe(true);
    expect(markSeen(state, overworld, 3, 0)).toBe(false);
    const reach = seenReach(state, { x: 8, y: 64, z: 8 }, overworld, 160);
    expect(reach['東']).toBe(112);   // the first column not seen lies seven chunks east
    expect(reach['西']).toBe(16);
    expect(reach['北']).toBe(16);
    // Seen all the way out: said as such, and listed after the directions with new ground near.
    for (let chunkX = 7; chunkX <= 12; chunkX++) markSeen(state, overworld, chunkX, 0);
    const all = seenReach(state, { x: 8, y: 64, z: 8 }, overworld, 160);
    expect(all['東']).toBeNull();
    const line = describeSeenReach(all, 160);
    expect(line.indexOf('北は16m先から未見')).toBeGreaterThanOrEqual(0);
    expect(line.endsWith('東は160m先まで見た')).toBe(true);
    // Another dimension has seen nothing of this.
    expect(seenReach(state, { x: 8, y: 64, z: 8 }, 'the_nether', 160)['東']).toBe(16);
  });

  it('survives being written and read back', () => {
    const state = emptyPlaceMemory();
    markSeen(state, overworld, -3, 5);
    const back = parsePlaceMemory(JSON.parse(JSON.stringify({ ...state, seen: { overworld: [...state.seen!.overworld, 'not a column', 7] } })));
    expect(back.seen).toEqual({ overworld: ['-3,5'] });
    expect(markSeen(back, overworld, -3, 5)).toBe(false);
  });
});

// A world of one chunk column (chunk 0,0), one section tall from y=0: stone, with what each test puts in it.
const STATES = { air: 0, stone: 1, water: 80, flowingWater: 81, lava: 96, diamond: 200, deepDiamond: 201, furnace: 300, spawner: 400 };
const registry = { blocksByName: {
  air: { minStateId: 0, maxStateId: 0 }, stone: { minStateId: 1, maxStateId: 1 }, water: { minStateId: 80, maxStateId: 95 },
  lava: { minStateId: 96, maxStateId: 111 }, diamond_ore: { minStateId: 200, maxStateId: 200 },
  deepslate_diamond_ore: { minStateId: 201, maxStateId: 201 }, furnace: { minStateId: 300, maxStateId: 307 },
  spawner: { minStateId: 400, maxStateId: 400 },
} };
function world(cells: Record<string, number>, blockEntities: Record<string, unknown> = {}) {
  const stateOf = (x: number, y: number, z: number) => cells[`${x},${y},${z}`] ?? STATES.stone;
  const data = { get palette() { return [...new Set([STATES.stone, ...Object.values(cells)])]; },
    get: (cell: number) => stateOf(cell & 15, cell >> 8, (cell >> 4) & 15) };
  const column = { minY: 0, sections: [{ data }], getBlockStateId: (p: Vec3) => p.y < 0 || p.y > 15 ? STATES.air : stateOf(p.x, p.y, p.z),
    getBlockEntity: (p: Vec3) => blockEntities[`${p.x},${p.y},${p.z}`] };
  const bot: any = new EventEmitter();
  Object.assign(bot, { registry, game: { dimension: overworld }, entity: { position: new Vec3(8, 5, 8) },
    world: { getColumns: () => [{ chunkX: 0, chunkZ: 0, column }], getColumn: (x: number, z: number) => x === 0 && z === 0 ? column : null,
      getBlockStateId: (p: Vec3) => p.x < 0 || p.x > 15 || p.z < 0 || p.z > 15 || p.y < 0 || p.y > 15 ? STATES.stone : stateOf(p.x, p.y, p.z) } });
  return { bot, cells };
}
const ticks = (bot: EventEmitter, count: number) => { for (let index = 0; index < count; index++) bot.emit('physicsTick'); };

describe('the body notes what comes into view without being asked', () => {
  it('notes water a bucket can reach, ore that shows, and what stands to be used; not what is buried or still flowing', () => {
    const { bot } = world({
      '2,5,2': STATES.water, '2,6,2': STATES.air, '3,5,2': STATES.water, '3,6,2': STATES.air,   // an open pool of two cells
      '2,4,2': STATES.water,                                                                      // under the pool: no air over it
      '9,5,9': STATES.flowingWater, '9,6,9': STATES.air,                                          // running water fills no bucket
      '12,3,12': STATES.deepDiamond, '12,4,12': STATES.air,                                       // shows in a cave
      '5,10,5': STATES.diamond,                                                                   // buried in stone
      '14,8,1': STATES.furnace + 3,
    });
    installPlaceMemory(bot);
    ticks(bot, 3);
    const kinds = Object.fromEntries(bot.placeMemory.state.places.map((place: any) => [place.kind, place]));
    expect(Object.keys(kinds).sort()).toEqual(['diamond_ore', 'furnace', 'water']);
    expect(kinds.water).toMatchObject({ position: { x: 2, y: 5, z: 2 }, count: 2 });
    expect(kinds.diamond_ore.position).toEqual({ x: 12, y: 3, z: 12 });
    expect(bot.placeMemory.digest()).toMatchObject({ furnace: expect.stringContaining('(14,8,1)') });
    expect(bot.placeMemory.stats.columnsRead).toBeGreaterThanOrEqual(1);
    // The column it stands in has been seen; the ones around it have not.
    expect(bot.placeMemory.unseen()).toContain('16m先から未見');
  });

  it('notes what a spawner makes, and says it in the line it has in mind (paid run L77s looked for blazes 97 blocks from two spawners of them it knew only as "spawner")', () => {
    const makes = (id: string) => ({ type: 'compound', value: { SpawnData: { type: 'compound', value: { entity: { type: 'compound', value: { id: { type: 'string', value: id } } } } } } });
    const { bot } = world({ '4,6,4': STATES.spawner, '12,6,12': STATES.spawner }, { '4,6,4': makes('minecraft:blaze') });
    installPlaceMemory(bot);
    ticks(bot, 3);
    const spawners = bot.placeMemory.recall('spawner');
    expect(spawners.map((place: any) => place.note).sort()).toEqual(['blaze', undefined]);   // one the server said nothing of: still a spawner
    expect(bot.placeMemory.digest().spawner).toBe('6m 北西 (4,6,4) blaze');
    // A sentence about a place stays out of the short line.
    bot.placeMemory.remember('fortress', { x: 40, y: 5, z: 8 }, { note: 'nether_bricks（find-structureが検出した座標。当時の版は覚えなかった）' });
    expect(bot.placeMemory.digest().fortress).toBe('32m 東 (40,5,8)');
  });

  it('does not take a column the server has not sent for open air: ore on the edge of a column is not showing for that', () => {
    const { bot } = world({ '15,3,12': STATES.diamond, '0,8,0': STATES.diamond });
    installPlaceMemory(bot);
    ticks(bot, 3);
    expect(bot.placeMemory.recall('diamond')).toHaveLength(0);
  });

  it('forgets the ore it has mined when it reads the column again, and keeps where it died', () => {
    const { bot, cells } = world({ '12,3,12': STATES.diamond, '12,4,12': STATES.air });
    installPlaceMemory(bot);
    ticks(bot, 2);
    expect(bot.placeMemory.recall('diamond')).toHaveLength(1);
    bot.emit('death');
    cells['12,3,12'] = STATES.air;
    bot.emit('chunkColumnLoad', new Vec3(0, 0, 0));
    ticks(bot, 2);
    expect(bot.placeMemory.recall('diamond')).toHaveLength(0);
    expect(bot.placeMemory.recall('death')).toMatchObject([{ position: { x: 8, y: 5, z: 8 } }]);
    expect(bot.placeMemory.stats.forgotten).toBe(1);
  });

  it('writes to disk only once the host names a file for this world, and takes up what the file holds', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'places-'));
    const file = path.join(directory, 'world.json');
    try {
      const first = world({ '14,8,1': STATES.furnace });
      installPlaceMemory(first.bot);
      ticks(first.bot, 2);
      first.bot.placeMemory.flush();
      expect(fs.existsSync(file)).toBe(false);
      first.bot.placeMemory.persistTo(file);
      first.bot.placeMemory.remember('village', { x: 400, y: 70, z: 0 }, { note: 'bell×1' });
      first.bot.placeMemory.flush();
      const second = world({});
      installPlaceMemory(second.bot);
      second.bot.placeMemory.persistTo(file);
      // The village is out of sight of the new session and still known. The furnace's column is read again
      // and shows none (this second world has none), so that one is dropped.
      ticks(second.bot, 2);
      expect(second.bot.placeMemory.recall('village')).toMatchObject([{ note: 'bell×1' }]);
      expect(second.bot.placeMemory.recall('furnace')).toHaveLength(0);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
});

describe('a structure is known by the blocks only it is built of', () => {
  it('notes a Nether fortress once, however many bricks of it are in view', () => {
    const NETHER_BRICKS = 400;
    (registry.blocksByName as any).nether_bricks = { minStateId: NETHER_BRICKS, maxStateId: NETHER_BRICKS };
    const cells: Record<string, number> = {};
    for (let x = 2; x <= 12; x++) for (let z = 4; z <= 6; z++) cells[`${x},9,${z}`] = NETHER_BRICKS;
    const { bot } = world(cells);
    installPlaceMemory(bot);
    ticks(bot, 3);
    const fortress = bot.placeMemory.recall('fortress');
    expect(fortress).toHaveLength(1);
    expect(fortress[0].count).toBe(33);
    delete (registry.blocksByName as any).nether_bricks;
  });
});
