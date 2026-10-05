import { describe, expect, it } from 'vitest';
import { Vec3 } from 'vec3';
import { dropBurnsIn, lavaBesideOrOver } from '../../src/services/minebot/utils/dropFate.js';

const solid = { name: 'stone', boundingBox: 'block' };
const air = { name: 'air', boundingBox: 'empty' };
const lava = { name: 'lava', boundingBox: 'empty' };
const water = { name: 'water', boundingBox: 'empty', type: 34, metadata: 0, getProperties: () => ({}) };
/** Stone everywhere except the cells named. */
const world = (cells: Record<string, any>) => ({ blockAt: (p: Vec3) => cells[`${p.x},${p.y},${p.z}`] ?? solid });

describe('where a block\'s drop ends up decides whether it is worth breaking (lab: ten obsidian mined over a lava lake three deep gave none)', () => {
  const target = new Vec3(8, 99, 5);

  it('burns in lava directly under the block, which a dig judged safe for the body says nothing of', () => {
    expect(dropBurnsIn(world({ '8,98,5': lava }), target)).toMatchObject({ x: 8, y: 98, z: 5 });
  });

  it('falls through open cells to the lava further down', () => {
    expect(dropBurnsIn(world({ '8,98,5': air, '8,97,5': air, '8,96,5': lava }), target)).toMatchObject({ y: 96 });
  });

  it('is held by a floor, and by water over the lava', () => {
    expect(dropBurnsIn(world({}), target)).toBeNull();
    expect(dropBurnsIn(world({ '8,98,5': air, '8,97,5': solid, '8,96,5': lava }), target)).toBeNull();
    expect(dropBurnsIn(world({ '8,98,5': water, '8,97,5': lava }), target)).toBeNull();
  });

  it('burns where lava beside or over the block runs into the opening', () => {
    expect(dropBurnsIn(world({ '9,99,5': lava }), target)).toMatchObject({ x: 9, y: 99 });
    expect(dropBurnsIn(world({ '8,100,5': lava }), target)).toMatchObject({ y: 100 });
    expect(lavaBesideOrOver(world({ '8,99,4': lava }), target)).toMatchObject({ z: 4 });
    // Lava under the block is not lava that runs in: water over the block does not have to reach it first.
    expect(lavaBesideOrOver(world({ '8,98,5': lava }), target)).toBeNull();
  });

  it('knows nothing of cells the world has not loaded, and says nothing', () => {
    expect(dropBurnsIn({ blockAt: () => null }, target)).toBeNull();
    expect(dropBurnsIn({ blockAt: () => { throw new Error('unloaded'); } }, target)).toBeNull();
  });
});

import { firstSolidBetween, liquidAimPoints } from '../../src/services/minebot/utils/liquidAim.js';

describe('a bucket is aimed at a point of the source the eyes can see (paid run L77 could not take back the water it had poured)', () => {
  // The body stands on a block it placed, its head in a pocket dug into the ceiling (y=-18); the tunnel beyond
  // is two high (y=-20 and y=-19) under a ceiling at y=-18. The water is two cells along, at the tunnel's floor level.
  const open = new Set(['57,-19,54', '57,-18,54', '57,-17,54', '57,-20,55', '57,-19,55', '57,-20,56', '57,-19,56']);
  const bot = { entity: { position: new Vec3(57.5, -19, 54.4) },
    blockAt: (p: Vec3) => open.has(`${p.x},${p.y},${p.z}`) ? { name: 'air', boundingBox: 'empty' } : { name: 'deepslate', boundingBox: 'block' } };
  const water = new Vec3(57, -20, 56);

  it('finds the ceiling\'s edge on the line to the top of the source, which samples along the line step over', () => {
    const eyes = bot.entity.position.offset(0, 1.62, 0);
    expect(firstSolidBetween(bot, eyes, water.offset(0.5, 0.9, 0.5), water)).toMatchObject({ name: 'deepslate', at: { x: 57, y: -18, z: 55 } });
    expect(firstSolidBetween(bot, eyes, water.offset(0.5, 0.1, 0.5), water)).toBeNull();
  });

  it('offers only points with a clear line, lowest in the cell when the surface is hidden', () => {
    const { points } = liquidAimPoints(bot, water);
    expect(points.length).toBeGreaterThan(0);
    for (const point of points) expect(point.y).toBeLessThan(-19.5);
    // Nothing in the way on open ground: the surface comes first.
    const outside = { entity: { position: new Vec3(57.5, -19, 54.4) }, blockAt: () => ({ name: 'air', boundingBox: 'empty' }) };
    expect(liquidAimPoints(outside, water).points[0]).toMatchObject({ y: -19.1 });
    // Too far for the hand: said so.
    const far = { entity: { position: new Vec3(57.5, -19, 48) }, blockAt: () => ({ name: 'air', boundingBox: 'empty' }) };
    expect(liquidAimPoints(far, water)).toMatchObject({ points: [], reason: expect.stringContaining('届くのは') });
  });
});

import DigBlockAt from '../../src/services/minebot/instantSkills/digBlockAt.js';

describe('a dig is not started with the head under water when the air would run out first (paid run L77: the drowning emergency took the body twice)', () => {
  const obsidian = { name: 'obsidian', boundingBox: 'block', diggable: true, position: new Vec3(59, -21, 57), harvestTools: { 1: true } };
  const pickaxe = { name: 'diamond_pickaxe', type: 1, maxDurability: 1561, durabilityUsed: 0 };
  const body = (oxygen: number, digMs: number, eyesIn: any) => {
    const dig = { calls: 0 };
    const bot: any = { entity: { position: new Vec3(60.5, -22, 57.5), onGround: false, isInWater: true }, oxygenLevel: oxygen, heldItem: pickaxe,
      inventory: { items: () => [pickaxe], emptySlotCount: () => 10 }, entities: {}, equip: async () => {}, digTime: () => digMs, canDigBlock: () => true,
      blockAt: (p: Vec3) => p.equals(obsidian.position) ? obsidian : p.y === -21 && p.x === 60 && p.z === 57 ? eyesIn : { name: 'deepslate', boundingBox: 'block' },
      dig: async () => { dig.calls++; throw new Error('not reached in these cases'); } };
    return { bot, dig };
  };
  const wet = { name: 'water', boundingBox: 'empty', type: 34, metadata: 0, getProperties: () => ({}) };

  it('refuses with the seconds on both sides, and digs nothing', async () => {
    const { bot, dig } = body(12, 47_000, wet);
    const result: any = await new DigBlockAt(bot).runImpl(59, -21, 57);
    expect(result).toMatchObject({ success: false, failureType: 'air_short' });
    expect(result.result).toContain('約47秒');
    expect(result.result).toContain('約9秒分');
    expect(dig.calls).toBe(0);
  });

  it('says nothing of air to a body whose head is out of the water, or with air to spare', async () => {
    for (const { bot } of [body(12, 47_000, { name: 'air', boundingBox: 'empty' }), body(20, 2_000, wet)]) {
      const result: any = await new DigBlockAt(bot).runImpl(59, -21, 57);
      expect(result.failureType).not.toBe('air_short');
    }
  });
});

describe('the block under the feet is not dug out over a fatal fall (paid run L96: dug down through its floor into a cave over lava, fell in and died)', () => {
  const stone = (p: Vec3) => ({ name: 'stone', boundingBox: 'block', diggable: true, position: p, harvestTools: { 1: true } });
  const pickaxe = { name: 'diamond_pickaxe', type: 1, maxDurability: 1561, durabilityUsed: 0 };
  const body = (cave: boolean) => {
    const dig = { calls: 0 };
    const bot: any = { entity: { position: new Vec3(37.5, 52, -94.5), onGround: true, isInWater: false }, health: 20, oxygenLevel: 20, heldItem: pickaxe,
      inventory: { items: () => [pickaxe], emptySlotCount: () => 10 }, entities: {}, equip: async () => {}, digTime: () => 500, canDigBlock: () => true,
      // Stone at y=51 under the feet; beneath it either a cave down to a lava pool at y=46, or more stone.
      blockAt: (at: Vec3) => { const p = at.floored(); return p.y >= 52 ? { name: 'air', boundingBox: 'empty' }
        : p.x === 37 && p.z === -95 && p.y < 51 && p.y > 46 && cave ? { name: 'cave_air', boundingBox: 'empty' }
          : p.x === 37 && p.z === -95 && p.y === 46 && cave ? { name: 'lava', boundingBox: 'empty' } : stone(p); },
      dig: async () => { dig.calls++; throw new Error('not reached in these cases'); } };
    return { bot, dig };
  };

  it('refuses the dig with the fall named, and digs nothing', async () => {
    const { bot, dig } = body(true);
    const result: any = await new DigBlockAt(bot).runImpl(37, 51, -95, false);
    expect(result).toMatchObject({ success: false, failureType: 'unsafe_footing' });
    expect(result.result).toContain('stair-mine');
    expect(dig.calls).toBe(0);
  });

  it('lets a dig through when the block below holds the body up (one step down, as a shelter is dug)', async () => {
    const { bot } = body(false);
    const result: any = await new DigBlockAt(bot).runImpl(37, 51, -95, false);
    expect(result.failureType).not.toBe('unsafe_footing');
  });
});

