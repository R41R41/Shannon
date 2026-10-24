import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { describe, expect, it } from 'vitest';
import { mapMarkLines } from '../../src/services/minebot/utils/mapMarks.js';
import { relativeWords, localMapFor } from '../../src/services/minebot/utils/localMap.js';
import { probeAround } from '../../src/services/minebot/utils/probeTools.js';
import { biomeFitsDimension } from '../../src/services/minebot/utils/biomeNames.js';
import { captureWorldObservation, mergeStacks } from '../../src/services/minebot/cognition/worldFrame.js';
import type { BlockReader, MapBlock } from '../../src/services/minebot/utils/localMap.js';

// mb-llmc-cand (2026-10-23): the body's own faults the decision replay rig found in what the head is shown (45 scenes of runs 27-34).
// Each test below failed on the r10 body (7df6d25) and passes on this one.
const require = createRequire(import.meta.url);

function realWorld() {
  try {
    const registry = require('prismarine-registry')('1.20.4');
    const Chunk = require('prismarine-chunk')(registry);
    const World = require('prismarine-world')(registry);
    return { registry, Chunk, World };
  } catch { return null; }
}

/** A Nether of air with the blocks given ([x, y, z, name]); levels of fluid are the source (0). */
function netherWith(blocks: Array<[number, number, number, string]>) {
  const lib = realWorld();
  if (!lib) return null;
  const { registry, Chunk, World } = lib;
  const world = new World(null, null);
  const columns = new Map<string, any>();
  for (const [x, y, z, name] of blocks) {
    const key = `${x >> 4},${z >> 4}`;
    let column = columns.get(key);
    if (!column) { column = new Chunk({ minY: 0, worldHeight: 256 }); columns.set(key, column); }
    column.setBlockStateId(new Vec3(x & 15, y, z & 15), registry.blocksByName[name].defaultState);
  }
  for (const [key, column] of columns) { const [cx, cz] = key.split(',').map(Number); world.sync.setColumn(cx, cz, column); }
  return { registry, world };
}

function netherBody(built: NonNullable<ReturnType<typeof netherWith>>, feet: Vec3) {
  const bot: any = Object.assign(new EventEmitter(), {
    entity: { id: 1, position: feet, yaw: 0, onGround: true }, entities: {}, game: { dimension: 'the_nether' },
    registry: built.registry, world: built.world.sync,
    blockAt: (position: Vec3, extra?: boolean) => built.world.sync.getBlock(position, extra),
  });
  return bot;
}

const cellOf = (v: Vec3) => ({ x: Math.floor(v.x), y: Math.floor(v.y), z: Math.floor(v.z) });
/** Every mark line says its way from `feet` (the way after the `(x,y,z)`), whatever the scan was made from. */
function wrongWays(lines: string[], feet: { x: number; y: number; z: number }): string[] {
  return lines.filter(line => {
    const match = /\((-?\d+),(-?\d+),(-?\d+)\) (\S+?)( |$)/u.exec(line);
    if (!match) return true;
    return match[4] !== relativeWords(feet, { x: Number(match[1]), y: Number(match[2]), z: Number(match[3]) });
  });
}

// The scene of inspection s07: feet (224,58,72), the fortress at (226,58,72), a lava source (221,53,69), a spawner far east.
const built = netherWith([[226, 58, 72, 'nether_bricks'], [221, 53, 69, 'lava'], [311, 70, 72, 'spawner'], [219, 58, 80, 'nether_portal']]);

describe.skipIf(!built)('the marks beside the map are told from the feet of the call, not of the scan', () => {
  it('scanned from three cells west, then asked from (224,58,72): every way is from (224,58,72) (r10: 東5, from the cell left)', () => {
    const bot = netherBody(built!, new Vec3(221.5, 58, 72.5));
    const first = mapMarkLines(bot, 1_000, true);
    expect(first.join('\n')).toContain('N ネザー要塞 (226,58,72) 東5');
    // The body walks three cells east inside the 3 s / 4 blocks the scan is kept for.
    bot.entity.position = new Vec3(224.5, 58, 72.5);
    const lines = mapMarkLines(bot, 1_800);
    expect(lines.join('\n')).toContain('N ネザー要塞 (226,58,72) 東2 レンガ×1');
    expect(lines.join('\n')).toContain('S スポナー (311,70,72) 東87・上12');
    expect(lines.join('\n')).toContain('L 溶岩源 (221,53,69) 西3・北3・下5');
    expect(wrongWays(lines, cellOf(bot.entity.position))).toEqual([]);
  });

  it('the order is nearest first from where the body is now, and is not kept from the scan', () => {
    // Two spawners (one order class): from x 221 the one at 219 is nearer, from x 224 the one at 225 is.
    const lib = netherWith([[219, 58, 72, 'spawner'], [225, 58, 72, 'spawner']]);
    const bot = netherBody(lib!, new Vec3(221.5, 58, 72.5));
    const xs = (lines: string[]) => lines.map(line => /\((\d+),/u.exec(line)![1]);
    expect(xs(mapMarkLines(bot, 1_000, true))).toEqual(['219', '225']);
    bot.entity.position = new Vec3(224.5, 58, 72.5);
    expect(xs(mapMarkLines(bot, 1_500))).toEqual(['225', '219']);
  });

  it('a furnace\'s seconds left are of the moment of the call', () => {
    const lib = netherWith([[226, 58, 72, 'furnace']]);
    const bot = netherBody(lib!, new Vec3(224.5, 58, 72.5));
    bot.activeFurnaces = [{ pos: { x: 226, y: 58, z: 72 }, item: 'iron_ore', count: 8, readyAt: 100_000, startedAt: 0 }];
    expect(mapMarkLines(bot, 90_000, true).join('\n')).toContain('iron_ore×8 焼き上がり 10秒後');
    expect(mapMarkLines(bot, 92_000).join('\n')).toContain('iron_ore×8 焼き上がり 8秒後');
  });
});

describe('the local map is drawn at once when the feet are on another cell', () => {
  it('`@` is where `position` is, not where it was up to 0.5 s ago', () => {
    const mobs: Record<string, any> = {};
    const bot: any = Object.assign(new EventEmitter(), {
      entity: { position: new Vec3(0.5, 64, 0.5), yaw: 0, onGround: true }, entities: mobs, game: { dimension: 'overworld' },
      blockAt: (p: Vec3) => Math.floor(p.y) < 64 ? { name: 'stone', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' },
    });
    const here = localMapFor(bot, { now: 10_000 })!;
    bot.entity.position = new Vec3(3.5, 64, 0.5);
    const moved = localMapFor(bot, { now: 10_100 })!;
    expect(moved).not.toBe(here);
    // The same cell inside 500 ms is still the drawing kept.
    expect(localMapFor(bot, { now: 10_200 })).toBe(moved);
  });
});

describe('the inventory, one line a kind in the LLM-centric mode', () => {
  const items = [
    { name: 'cobbled_deepslate', count: 53 }, { name: 'cobbled_deepslate', count: 30 }, { name: 'bread', count: 3 },
    { name: 'iron_pickaxe', count: 1, maxDurability: 250, durabilityUsed: 20 }, { name: 'iron_pickaxe', count: 1, maxDurability: 250, durabilityUsed: 100 },
    { name: 'cobblestone', count: 64 }, { name: 'cobblestone', count: 64 }, { name: 'cobblestone', count: 12 },
    { name: 'splash_potion', count: 1, components: [{ type: 'potion_contents', data: { potionId: 'minecraft:strong_healing' } }] },
    { name: 'splash_potion', count: 1, components: [{ type: 'potion_contents', data: { potionId: 'minecraft:fire_resistance' } }] },
    { name: 'splash_potion', count: 2, components: [{ type: 'potion_contents', data: { potionId: 'minecraft:fire_resistance' } }] },
  ];
  const bot = () => ({ blockAt: () => null, entity: { position: new Vec3(0.5, 64, 0.5) }, inventory: { items: () => items }, game: { dimension: 'overworld' } });

  it('cobbled_deepslate ×53 and ×30 are one line ×83; tools with different wear and potions of different kinds stay apart, each saying what it is', () => {
    const inventory = captureWorldObservation(bot()).inventory;
    expect(inventory.filter(item => item.name === 'cobbled_deepslate')).toEqual([{ name: 'cobbled_deepslate', count: 83 }]);
    expect(inventory.filter(item => item.name === 'cobblestone')).toEqual([{ name: 'cobblestone', count: 140 }]);
    expect(inventory.filter(item => item.name === 'iron_pickaxe')).toEqual([
      { name: 'iron_pickaxe', count: 1, durability: { left: 230, max: 250 } }, { name: 'iron_pickaxe', count: 1, durability: { left: 150, max: 250 } }]);
    const potions = inventory.filter(item => item.name === 'splash_potion');
    expect(potions.map(item => (item as { contents?: string }).contents)).toEqual(['strong_healing', 'fire_resistance', 'fire_resistance']);
    expect(new Set(inventory.map(item => item.name)).size).toBe(5);
  });

  it('mergeStacks keeps the order of the first slot of a kind', () => {
    expect(mergeStacks([{ name: 'a', count: 1 }, { name: 'b', count: 2 }, { name: 'a', count: 4 }])).toEqual([{ name: 'a', count: 5 }, { name: 'b', count: 2 }]);
  });
});

describe('the biome is one the dimension has', () => {
  const body = (dimension: string, id: number, fallback?: string) => ({
    entity: { position: new Vec3(10.5, 64, 10.5) }, game: { dimension }, registry: { biomes: { 0: { name: 'badlands' }, 8: { name: 'nether_wastes' }, 1: { name: 'plains' } } },
    world: { getBiome: () => id }, environmentState: { biome: fallback },
  });
  it('the Nether read as badlands (the id 0 of a section the server did not send) says no biome, not badlands', () => {
    expect(captureWorldObservation(body('the_nether', 0)).biome).toBeNull();
    expect(captureWorldObservation(body('the_nether', 8)).biome).toBe('nether_wastes');
  });
  it('the fallback of auto-update-state is judged by the dimension too', () => {
    const bot: any = body('the_nether', 0, 'badlands');
    delete bot.world;
    expect(captureWorldObservation(bot).biome).toBeNull();
    expect(captureWorldObservation({ ...bot, environmentState: { biome: 'soul_sand_valley' } }).biome).toBe('soul_sand_valley');
  });
  it('the overworld keeps badlands and plains; nether_wastes is not an overworld biome', () => {
    expect(captureWorldObservation(body('overworld', 0)).biome).toBe('badlands');
    expect(captureWorldObservation(body('overworld', 1)).biome).toBe('plains');
    expect(biomeFitsDimension('overworld', 'nether_wastes')).toBe(false);
    expect(biomeFitsDimension('the_end', 'end_highlands')).toBe(true);
    expect(biomeFitsDimension('the_end', 'plains')).toBe(false);
    expect(biomeFitsDimension('minecraft:the_nether', 'basalt_deltas')).toBe(true);
    expect(biomeFitsDimension('overworld', null)).toBe(false);
  });
});

describe('around: the nearest water has its count', () => {
  const STONE: MapBlock = { name: 'stone', solid: true }, AIR: MapBlock = { name: 'air', solid: false }, WATER: MapBlock = { name: 'water', solid: false, level: 0 };
  // The scene of inspection s44: water at (180,52,205), the feet at (180,49,202); no lava, no fire.
  const read: BlockReader = (x, y, z) => x === 180 && y === 52 && z === 205 ? WATER : y < 49 ? STONE : AIR;
  it('says （1 マス）, never undefined', () => {
    const answer = probeAround(read, { x: 180.5, y: 49, z: 202.5 }, [], 8);
    expect(answer.text).not.toContain('undefined');
    expect(answer.text).toContain('水 (180,52,205) 南 3m・上 3（1 マス）');
  });
});
