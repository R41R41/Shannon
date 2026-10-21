import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import { noteBiome, emptyPlaceMemory } from '../../src/modules/minecraftLearning/places.js';
import { overWater, surfaceKind, treeHeading, treesInSight, treeWeight, woodLine } from '../../src/services/minebot/utils/treeSearch.js';
import ExploreForStructure from '../../src/services/minebot/instantSkills/exploreForStructure.js';

// Run 24, the world with no tree within 128 m of the start: the first order asked for logs and the body had no way to look for any
// (explore-for-structure knew villages, beds and animals); it looked for a village for 419 s, over desert and into the sea, with a shipwreck
// 149 m off that nobody called wood.
//   - explore-for-structure looks for trees: the way is the nearest biome that grows them, the sea is not walked onto, logs in sight stop it;
//   - the map the mind plans from starts with a line about wood: the trees in sight, or that there are none, and the wood of a shipwreck.

const require = createRequire(import.meta.url);
const registry = require('prismarine-registry')('1.21.11');
const logState = registry.blocksByName.oak_log.minStateId as number;

/** A column of the chunk at (chunkX, chunkZ) with oak logs at the given cells (x, y, z in the world). */
function columnsWithLogs(logs: Array<[number, number, number]>) {
  const byChunk = new Map<string, { chunkX: number; chunkZ: number; cells: Map<number, Map<number, number>> }>();
  for (const [x, y, z] of logs) {
    const chunkX = Math.floor(x / 16), chunkZ = Math.floor(z / 16);
    const key = `${chunkX},${chunkZ}`;
    const entry = byChunk.get(key) ?? { chunkX, chunkZ, cells: new Map() };
    byChunk.set(key, entry);
    const section = Math.floor((y + 64) / 16);
    const cell = ((y + 64) % 16) * 256 + (z - chunkZ * 16) * 16 + (x - chunkX * 16);
    (entry.cells.get(section) ?? entry.cells.set(section, new Map()).get(section)!).set(cell, logState);
  }
  return [...byChunk.values()].map(({ chunkX, chunkZ, cells }) => ({ chunkX, chunkZ, column: { minY: -64,
    sections: new Array(24).fill(null).map((_, index) => cells.has(index) ? { data: { palette: [0, logState], get: (cell: number) => cells.get(index)!.get(cell) ?? 0 } } : null) } }));
}

const bodyAt = (extra: Record<string, unknown> = {}) => ({
  entity: { position: new Vec3(0.5, 64, 0.5), yaw: 0 }, entities: {}, registry, game: { dimension: 'overworld' }, world: { getColumns: () => [] as any[] }, ...extra }) as any;

describe('trees in sight, and which way to look', () => {
  it('counts the logs among the chunks sent and names the nearest', () => {
    const bot = bodyAt({ world: { getColumns: () => columnsWithLogs([[40, 70, 3], [41, 70, 3], [90, 66, -20]]) } });
    const seen = treesInSight(bot);
    expect(seen.count).toBe(3);
    expect(seen.nearest?.position).toEqual(new Vec3(40, 70, 3));
    expect(treesInSight(bodyAt()).count).toBe(0);
    expect(treesInSight(bodyAt({ world: { getColumns: () => columnsWithLogs([[200, 70, 3]]) } })).nearest).toBeNull();     // beyond 128 m
  });

  it('weights the biomes that grow trees', () => {
    expect(treeWeight('forest')).toBe(3);
    expect(treeWeight('taiga')).toBe(3);
    expect(treeWeight('savanna')).toBe(1);
    expect(treeWeight('desert')).toBe(0);
    expect(treeWeight('warm_ocean')).toBe(0);
  });

  it('goes towards the nearest wood in the memory of the biomes, not towards the sea or the sand', () => {
    const state = emptyPlaceMemory();
    // here is desert; a river to the east, warm ocean to the south west, a forest to the north 90 m, badlands to the west
    for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) noteBiome(state, 'overworld', x, z, 'desert');
    for (let z = -2; z <= 2; z++) noteBiome(state, 'overworld', 4, z, 'river');
    for (let x = -8; x <= -4; x++) for (let z = 4; z <= 6; z++) noteBiome(state, 'overworld', x, z, 'warm_ocean');
    noteBiome(state, 'overworld', 0, -6, 'forest');
    noteBiome(state, 'overworld', -9, 0, 'badlands');
    const bot = bodyAt({ placeMemory: { state } });
    const { heading, why } = treeHeading(bot);
    expect(heading.name).toBe('north');
    expect(why).toContain('forest');
    // with no wood in the memory, away from the water
    const barren = emptyPlaceMemory();
    for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) noteBiome(barren, 'overworld', x, z, 'desert');
    for (let z = -3; z <= 3; z++) noteBiome(barren, 'overworld', 5, z, 'ocean');
    const dry = treeHeading(bodyAt({ placeMemory: { state: barren } }));
    expect(dry.heading.name).not.toBe('east');
    expect(dry.why).toContain('海から遠い');
    // and with no memory at all, the way the body faces
    expect(treeHeading(bodyAt()).heading.name).toBe('north');
  });

  it('does not walk out over the sea: a leg that is mostly water is seen as one', () => {
    const sea = (x: number) => x > 20;
    const blockAt = (p: Vec3) => (p.y <= 62 ? { name: sea(p.x) ? 'water' : 'stone', boundingBox: sea(p.x) ? 'empty' : 'block' } : { name: 'air', boundingBox: 'empty' });
    const bot = { blockAt };
    expect(surfaceKind(bot, 30, 0, 64)).toBe('water');
    expect(surfaceKind(bot, 5, 0, 64)).toBe('land');
    expect(surfaceKind({ blockAt: () => null }, 5, 0, 64)).toBe('unknown');
    const east = { dx: 1, dz: 0 }, north = { dx: 0, dz: -1 };
    expect(overWater(bot, { x: 10, y: 64, z: 0 }, east, 48)).toBe(true);
    expect(overWater(bot, { x: 10, y: 64, z: 0 }, north, 48)).toBe(false);
    // unloaded ground is no evidence of water
    expect(overWater({ blockAt: () => null }, { x: 10, y: 64, z: 0 }, east, 48)).toBe(false);
  });
});

describe('explore-for-structure looks for trees (run 24: 419 s looking for a village in a world with no tree)', () => {
  function explorer(extra: Record<string, unknown> = {}) {
    const bot = bodyAt(extra);
    const skill: any = new ExploreForStructure(bot);
    const moves: Array<[number, number]> = [];
    skill.callSkill = vi.fn(async (_name: string, x: number, _y: number, z: number) => { moves.push([x, z]); bot.entity.position = new Vec3(x + 0.5, 64, z + 0.5); return { success: true }; });
    return { skill, bot, moves };
  }
  const forestNorth = () => { const state = emptyPlaceMemory(); noteBiome(state, 'overworld', 0, -6, 'forest'); noteBiome(state, 'overworld', 0, 0, 'desert'); return { state }; };

  it('takes the way of the nearest wood, a leg at a time, and stops when a log comes into sight', async () => {
    let step = 0;
    const logs = [[0, 70, -140]] as Array<[number, number, number]>;
    const { skill, bot, moves } = explorer({ placeMemory: forestNorth() });
    bot.world.getColumns = () => (step >= 2 ? columnsWithLogs(logs) : []);
    skill.callSkill = vi.fn(async (_n: string, x: number, _y: number, z: number) => { moves.push([x, z]); step++; bot.entity.position = new Vec3(x + 0.5, 64, z + 0.5); return { success: true }; });
    const result = await skill.runImpl('tree', undefined, 240);
    expect(result.success).toBe(true);
    expect(result.result).toContain('木（oak_log）が見えます');
    expect(result.result).toContain('座標(0, 70, -140)');
    expect(moves).toHaveLength(2);
    expect(moves.every(([x, z], index) => Math.abs(x) <= 3 && z < (index ? moves[index - 1][1] : 0))).toBe(true);   // north, and on
  });

  it('answers at once when logs are in sight already, and for the other words for it', async () => {
    const { skill } = explorer({ world: { getColumns: () => columnsWithLogs([[30, 66, 2]]) } });
    for (const word of ['tree', 'logs', '原木', 'Wood']) {
      const result = await skill.runImpl(word);
      expect(result.success).toBe(true);
      expect(result.result).toContain('座標(30, 66, 2)');
    }
    expect(skill.callSkill).not.toHaveBeenCalled();
  });

  it('turns from the sea to a dry side instead of walking out onto it', async () => {
    const sea = (x: number) => x > 6;
    const { skill, bot, moves } = explorer({ placeMemory: forestNorth() });
    bot.blockAt = (p: Vec3) => (p.y <= 62 ? { name: sea(p.x) ? 'water' : 'stone', boundingBox: sea(p.x) ? 'empty' : 'block' } : { name: 'air', boundingBox: 'empty' });
    const result = await skill.runImpl('tree', 'east', 48);
    expect(result.success).toBe(false);
    expect(moves.length).toBeGreaterThan(0);
    // east is open sea: the leg went north or south instead, x did not move out to sea
    expect(moves[0][0]).toBeLessThanOrEqual(6);
  });

  it('says the wood of a shipwreck and that no tree was found, with the way tried', async () => {
    const recall = vi.fn((kind?: string) => (kind === 'shipwreck' ? [{ distance: 149, direction: '南', position: { x: 47, y: 55, z: 99 } }] : []));
    const { skill } = explorer({ placeMemory: { ...forestNorth(), recall } });
    const result = await skill.runImpl('tree', 'north', 48);
    expect(result).toMatchObject({ success: false, failureType: 'target_not_found' });
    expect(result.result).toContain('難破船');
    expect(result.result).toContain('(47,55,99)');
    expect(await skill.runImpl('tree', 'sideways')).toMatchObject({ success: false, failureType: 'invalid_input' });
  });

  it('is not for the Nether', async () => {
    const { skill } = explorer({ game: { dimension: 'the_nether' } });
    expect(await skill.runImpl('tree')).toMatchObject({ success: false, failureType: 'invalid_input' });
  });
});

describe('the line about wood at the top of the map the route is planned from (run 24: the shipwreck was in the map as a ship, not as wood)', () => {
  it('says there is no tree in sight, where to look, and the shipwreck and the village as wood', () => {
    const recall = (kind?: string) => (kind === 'shipwreck' ? [{ distance: 149, direction: '南', position: { x: 47, y: 55, z: 99 } }]
      : kind === 'village' ? [{ distance: 230, direction: '東', position: { x: 230, y: 70, z: 0 } }] : []);
    const line = woodLine(bodyAt({ placeMemory: { ...(() => { const state = emptyPlaceMemory(); noteBiome(state, 'overworld', 0, -6, 'forest'); return { state }; })(), recall } }), 1000);
    expect(line.startsWith('木: ')).toBe(true);
    expect(line).toContain('1本も見えません');
    expect(line).toContain('structureType=tree');
    expect(line).toContain('難破船（船体は原木・板材');
    expect(line).toContain('(47,55,99)');
    expect(line).toContain('村（家は板材・原木）');
  });

  it('says the trees in sight, and names planks of a building', () => {
    const planks = registry.blocksByName.oak_planks.minStateId as number;
    const columns = [...columnsWithLogs([[40, 70, 3], [41, 70, 3]]), { chunkX: 0, chunkZ: -3, column: { minY: -64, sections: new Array(24).fill(null).map((_, index) => index === 8 ? { data: { palette: [0, planks], get: (cell: number) => (cell === 5 ? planks : 0) } } : null) } }];
    const line = woodLine(bodyAt({ world: { getColumns: () => columns } }), 2000);
    expect(line).toMatch(/^木: 40m 東 \(40,70,3\) oak_log×2（128m以内に原木2本見える）/);
    expect(line).toContain('板材の建物');
  });

  it('says nothing for a body that cannot read the chunks, or in the Nether', () => {
    expect(woodLine({ entity: { position: new Vec3(0, 64, 0) }, registry, game: { dimension: 'overworld' } } as any, 3000)).toBe('');
    expect(woodLine(bodyAt({ game: { dimension: 'the_nether' } }), 4000)).toBe('');
  });

  it('is read again after a few seconds, not at every look', () => {
    const bot = bodyAt();
    const first = woodLine(bot, 10_000);
    bot.world.getColumns = () => columnsWithLogs([[30, 66, 2]]);
    expect(woodLine(bot, 12_000)).toBe(first);
    expect(woodLine(bot, 30_000)).toContain('oak_log×1');
  });
});
