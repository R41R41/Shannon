import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';
import { emptyPlaceMemory, mapSummary, placesDigest, rememberPlace } from '../../src/modules/minecraftLearning/places.js';
import { installPlaceMemory, newCaveCache, readColumn, wantedStates } from '../../src/services/minebot/utils/placeMemory.js';

const registry = minecraftData('1.21.11');

/** A real 1.21.11 column (chunk 0,0) of stone up to y 63, with what each test carves out of it. */
async function stoneColumn(carve: (set: (x: number, y: number, z: number, name: string) => void) => void) {
  const Chunk = (await import('prismarine-chunk')).default('1.21.11') as any;
  const chunk = new Chunk({ minY: -64, worldHeight: 384 });
  const set = (x: number, y: number, z: number, name: string) => chunk.setBlockStateId(new Vec3(x, y, z), registry.blocksByName[name].defaultState);
  for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) for (let y = 0; y <= 63; y++) set(x, y, z, y === 63 ? 'grass_block' : 'stone');
  carve(set);
  return chunk;
}
const bodyOn = (chunk: any) => Object.assign(new EventEmitter(), { entity: { position: new Vec3(8, 64, 8) }, registry, game: { dimension: 'overworld' },
  world: { getColumns: () => [{ chunkX: 0, chunkZ: 0, column: chunk }], getColumn: (x: number, z: number) => x === 0 && z === 0 ? chunk : undefined } }) as any;

describe('cave entrances: a way down from the surface that is walked, not dug (owner, 2026-10-20: the map\'s shortcuts to iron and diamonds)', () => {
  // A pit four deep at (3, 60..63, 8), a tunnel two high from it going east and down, then south and down to y 44.
  const tunnel = (set: (x: number, y: number, z: number, name: string) => void) => {
    for (let y = 60; y <= 63; y++) set(3, y, 8, 'air');
    for (let i = 0; i <= 10; i++) { set(4 + i, 60 - i, 8, 'air'); set(4 + i, 61 - i, 8, 'air'); }
    for (let j = 1; j <= 6; j++) { set(14, 50 - j, 8 + j, 'air'); set(14, 51 - j, 8 + j, 'air'); }
  };
  // A pit three deep beside a nook under the grass: open under ground, but it goes nowhere.
  const nook = (set: (x: number, y: number, z: number, name: string) => void) => {
    for (let y = 61; y <= 63; y++) set(9, y, 2, 'air');
    set(10, 61, 2, 'air'); set(10, 62, 2, 'air');
  };

  it('notes the mouth of a hollow that goes 12 blocks or more down, with the bottom it was followed to, and not a nook', async () => {
    const bot = bodyOn(await stoneColumn(set => { tunnel(set); nook(set); }));
    installPlaceMemory(bot);
    bot.placeMemory.work(5000);
    const entrances = bot.placeMemory.state.places.filter((place: any) => place.kind === 'cave_entrance');
    expect(entrances).toHaveLength(1);
    // The mouth is where the tunnel's highest open cell meets the pit (its top block, y 61).
    expect(entrances[0].position).toEqual({ x: 3, y: 61, z: 8 });
    expect(entrances[0].note).toBe('底 (14,44,14)');
    const map: string = bot.placeMemory.map();
    expect(map).toMatch(/洞窟の入口 1か所（地表から歩いて地下へ下りられる。鉄・ダイヤへの近道）: \d+m \S+ \(3,61,8\) → 底 \(14,44,14\)$/m);
  });

  it('never follows a hollow out under the sky again: a trench open to the sky is not an entrance however deep', async () => {
    // A trench 20 deep, open all the way up: no cell of it is under ground.
    const bot = bodyOn(await stoneColumn(set => { for (let x = 2; x <= 12; x++) for (let y = 40; y <= 63; y++) set(x, y, 5, 'air'); }));
    installPlaceMemory(bot);
    bot.placeMemory.work(5000);
    expect(bot.placeMemory.state.places.filter((place: any) => place.kind === 'cave_entrance')).toHaveLength(0);
  });

  it('a cave already followed from another mouth is not followed again: the mouth takes its known bottom', async () => {
    const chunk = await stoneColumn(tunnel);
    const caves = newCaveCache();
    const bot = bodyOn(chunk);
    const entry = { chunkX: 0, chunkZ: 0, column: chunk };
    const entrances = (sightings: Array<{ kind: string }>) => sightings.filter(sighting => sighting.kind === 'cave_entrance');
    const first = entrances(readColumn(bot, wantedStates(bot), entry, 'overworld', caves));
    expect(first).toHaveLength(1);
    // The tunnel walled off below its first two blocks: followed again it would go nowhere, but the kept cave answers.
    chunk.setBlockStateId(new Vec3(6, 58, 8), registry.blocksByName.stone.defaultState);
    chunk.setBlockStateId(new Vec3(6, 59, 8), registry.blocksByName.stone.defaultState);
    expect(entrances(readColumn(bot, wantedStates(bot), entry, 'overworld', caves))).toEqual(first);
    expect(entrances(readColumn(bot, wantedStates(bot), entry, 'overworld', newCaveCache()))).toHaveLength(0);
  });

  it('reads a column a slice at a time: one step of a tick takes a quarter of a section, not all of it', async () => {
    // With a hollow at y 10 (a section under y 40 with air in it is read cell by cell, for a cave).
    const bot = bodyOn(await stoneColumn(set => { tunnel(set); set(5, 10, 5, 'air'); }));
    installPlaceMemory(bot);
    bot.placeMemory.work(0.000_001);
    expect(bot.placeMemory.stats.stepBuckets.reduce((sum: number, count: number) => sum + count, 0)).toBe(1);
    expect(bot.placeMemory.stats.columnsRead).toBe(0);
    bot.placeMemory.work(5000);
    expect(bot.placeMemory.stats.columnsRead).toBe(1);
    // The section of the hollow in four quarters, the ground in four steps of four rows, the mouths, and the tunnel followed down.
    expect(bot.placeMemory.stats.stepBuckets.reduce((sum: number, count: number) => sum + count, 0)).toBeGreaterThanOrEqual(10);
    expect(bot.placeMemory.stats.maxColumnMs).toBeGreaterThan(0);
  });
});

describe('the map says the caves by their depth, and the armorer\'s chest as a smith\'s', () => {
  it('lists the nearest large hollows and the nearest at the diamonds\' depth, each with what its depth is good for', () => {
    const state = emptyPlaceMemory();
    rememberPlace(state, { kind: 'cave', dimension: 'overworld', position: { x: 20, y: 10, z: 0 }, count: 2500 }, 1);
    rememberPlace(state, { kind: 'cave', dimension: 'overworld', position: { x: 60, y: -20, z: 0 }, count: 500 }, 1);
    rememberPlace(state, { kind: 'cave', dimension: 'overworld', position: { x: 90, y: -55, z: 0 }, count: 900 }, 1);
    const map = mapSummary(state, { x: 0, y: 70, z: 0 }, 'overworld');
    expect(map).toContain('洞窟 3か所（うち大きな空洞1）: 63m 東 (20,10,0) 約2500マス（大きな空洞・鉄の多い深さ）、154m 東 (90,-55,0) 約900マス（ダイヤの深さ） ほか1');
  });
  it('an armorer\'s chest beside its blast furnace is a smith\'s chest of the village', () => {
    const state = emptyPlaceMemory();
    rememberPlace(state, { kind: 'village', dimension: 'overworld', position: { x: 100, y: 70, z: 0 } }, 1);
    rememberPlace(state, { kind: 'blast_furnace', dimension: 'overworld', position: { x: 110, y: 70, z: 5 } }, 1);
    rememberPlace(state, { kind: 'chest', dimension: 'overworld', position: { x: 111, y: 70, z: 6 } }, 1);
    expect(mapSummary(state, { x: 0, y: 70, z: 0 }, 'overworld')).toContain('村: 100m 東 (100,70,0)（鍛冶屋の箱 (111,70,6): 鉄・黒曜石が入ることがある）');
  });
  it('an igloo\'s basement (a bed, a brewing stand, a villager) is not said as a village; a village with its bell is', () => {
    const state = emptyPlaceMemory();
    rememberPlace(state, { kind: 'igloo', dimension: 'overworld', position: { x: 40, y: 95, z: 0 }, count: 8 }, 1);
    rememberPlace(state, { kind: 'village', dimension: 'overworld', position: { x: 43, y: 95, z: 1 }, note: 'ベッド1台、brewing_stand×1、村人1人' }, 1);
    expect(mapSummary(state, { x: 0, y: 95, z: 0 }, 'overworld')).toMatch(/^構造物: イグルー: 40m 東 \(40,95,0\)$/m);
    rememberPlace(state, { kind: 'village', dimension: 'overworld', position: { x: 300, y: 70, z: 0 }, note: 'bell×1、村人7人' }, 1);
    expect(mapSummary(state, { x: 0, y: 95, z: 0 }, 'overworld')).toContain('構造物: 村: 301m 東 (300,70,0)／イグルー: 40m 東 (40,95,0)');
  });
  it('an igloo says its basement chest far under the floor, and a shipwreck all its chests (lab world 20261020)', () => {
    const state = emptyPlaceMemory();
    rememberPlace(state, { kind: 'igloo', dimension: 'overworld', position: { x: 1554, y: 95, z: -2877 }, count: 8 }, 1);
    rememberPlace(state, { kind: 'chest', dimension: 'overworld', position: { x: 1553, y: 65, z: -2876 } }, 1);
    rememberPlace(state, { kind: 'shipwreck', dimension: 'overworld', position: { x: 615, y: 37, z: 1086 }, count: 2 }, 1);
    for (const [x, y, z] of [[615, 37, 1086], [605, 37, 1087], [621, 39, 1085]]) rememberPlace(state, { kind: 'chest', dimension: 'overworld', position: { x, y, z } }, 1);
    const near = (x: number, z: number) => mapSummary(state, { x, y: 70, z }, 'overworld');
    expect(near(1550, -2870)).toContain('イグルー: 26m 北東 (1554,95,-2877)（箱 (1553,65,-2876): 地下室（床の下の梯子））');
    // The chests nearest the body first.
    expect(near(600, 1080)).toMatch(/難破船: \d+m \S+ \(615,37,1086\)（箱 \(605,37,1087\)・\(615,37,1086\)・\(621,39,1085\)）/);
  });
  it('the digest says what an entrance is for', () => {
    const state = emptyPlaceMemory();
    rememberPlace(state, { kind: 'cave_entrance', dimension: 'overworld', position: { x: 30, y: 64, z: 0 }, count: 800, note: '底 (40,20,5)' }, 1);
    expect(placesDigest(state, { x: 0, y: 64, z: 0 }, 'overworld').cave_entrance).toBe('30m 東 (30,64,0) ×800 底 (40,20,5) 歩いて地下へ下りられる洞窟の入口');
  });
});
