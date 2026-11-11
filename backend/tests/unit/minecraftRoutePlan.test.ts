import { describe, expect, it } from 'vitest';
import { planRoute, summarizeRoute, DEFAULT_CEILING } from '../../src/services/minebot/utils/routePlan.js';
import type { BlockReader, MapBlock } from '../../src/services/minebot/utils/localMap.js';

// Run 7 (Lai): the route a body takes to a cell with walking, level cuts, stairs, shafts and laid blocks only; water and lava avoided; a way that is there is walked.
// The world is a rule from (x, y, z) to a block, as in minecraftRockTravel.test.ts; nothing here touches a server.
const STONE: MapBlock = { name: 'stone', solid: true }, AIR: MapBlock = { name: 'air', solid: false };
const WATER: MapBlock = { name: 'water', solid: false, level: 0 }, LAVA: MapBlock = { name: 'lava', solid: false, level: 0 };
const DIRT: MapBlock = { name: 'dirt', solid: true }, GRAVEL: MapBlock = { name: 'gravel', solid: true }, ORE: MapBlock = { name: 'lapis_ore', solid: true };
const BEDROCK: MapBlock = { name: 'bedrock', solid: true };
const world = (rule: (x: number, y: number, z: number) => MapBlock): BlockReader => (x, y, z) => rule(x, y, z);
/** Stone under y 64, air over it. */
const flat = (y: number) => (y < 64 ? STONE : AIR);
const at = (x: number, y: number, z: number) => ({ x, y, z });

describe('planRoute: a way that is there is walked', () => {
  it('flat ground: nothing dug, nothing laid, a straight run of steps', () => {
    const plan = planRoute(world((x, y, z) => flat(y)), at(0, 64, 0), [at(12, 64, 0)]);
    expect(plan.status).toBe('success');
    expect(plan.tier).toBe('walk');
    expect(plan.totals).toMatchObject({ steps: 12, dig: 0, place: 0 });
    expect(plan.steps[plan.steps.length - 1].to).toEqual(at(12, 64, 0));
  });

  it('a hill the way round is three times the line or less: walked round, not cut', () => {
    // A wall of stone x=5, z -3..3, 4 high: round it is 4 more blocks each way.
    const read = world((x, y, z) => (x === 5 && z >= -3 && z <= 3 && y >= 64 && y <= 67 ? STONE : flat(y)));
    const plan = planRoute(read, at(0, 64, 0), [at(10, 64, 0)], { placeBlocks: 20 });
    expect(plan.status).toBe('success');
    expect(plan.totals.dig).toBe(0);
    expect(plan.totals.place).toBe(0);
  });

  it('the way round is much longer than the line: the wall is cut', () => {
    // A long wall: round it is far more than three times the line plus 20 s.
    const read = world((x, y, z) => (x === 5 && z >= -60 && z <= 60 && y >= 64 && y <= 67 ? STONE : flat(y)));
    const plan = planRoute(read, at(0, 64, 0), [at(10, 64, 0)]);
    expect(plan.status).toBe('success');
    expect(plan.totals.dig).toBe(2);
    expect(plan.steps.some(step => step.kind === 'dig_level')).toBe(true);
    expect(plan.digsByName).toEqual({ stone: 2 });
  });

  it('is the same on the same input', () => {
    const read = world((x, y, z) => (x === 5 && z >= -60 && z <= 60 && y >= 64 && y <= 67 ? STONE : flat(y)));
    const a = planRoute(read, at(0, 64, 0), [at(10, 64, 0)]);
    const b = planRoute(read, at(0, 64, 0), [at(10, 64, 0)]);
    expect(b.steps).toEqual(a.steps);
  });
});

describe('planRoute: the shapes', () => {
  /** Solid rock from y 40 up to y 63 everywhere but the open air over 64; the feet at 64 and the goal below. */
  const rock = world((x, y, z) => (y <= 63 ? STONE : AIR));

  it('a goal 24 down and straight below is a shaft (one block a level) when the pack can climb back, a stair (three a level) when it cannot', () => {
    const shaft = planRoute(rock, at(0, 64, 0), [at(0, 40, 0)], { placeBlocks: 40 });
    expect(shaft.status).toBe('success');
    expect(shaft.totals.dig).toBe(24);
    expect(shaft.steps.filter(step => step.kind === 'shaft')).toHaveLength(24);
    const stair = planRoute(rock, at(0, 64, 0), [at(0, 40, 0)], { placeBlocks: 0 });
    expect(stair.status).toBe('success');
    expect(stair.steps.every(step => step.kind !== 'shaft')).toBe(true);
    expect(stair.totals.dig).toBeGreaterThan(shaft.totals.dig);
  });

  it('a stair down 1:1 digs three blocks a level', () => {
    // 6 levels down and 6 along: a stair at 1:1 is 6 steps of 3 blocks.
    const plan = planRoute(rock, at(0, 64, 0), [at(6, 58, 0)], { placeBlocks: 0 });
    expect(plan.status).toBe('success');
    expect(plan.totals.dig).toBeGreaterThanOrEqual(15);
    expect(plan.totals.dig).toBeLessThanOrEqual(24);
    expect(plan.steps.filter(step => step.kind === 'dig_down').length).toBeGreaterThanOrEqual(5);
  });

  it('a bridge is laid over a gap only when the pack holds a block', () => {
    // The gap is deeper than the box reads (no way under it), so only a bridge crosses it.
    const read = world((x, y) => (x >= 3 && x <= 5 ? (y <= 0 ? STONE : AIR) : flat(y)));
    const none = planRoute(read, at(0, 64, 0), [at(9, 64, 0)], { placeBlocks: 0, ms: 3000 });
    expect(none.status).toBe('none');
    const laid = planRoute(read, at(0, 64, 0), [at(9, 64, 0)], { placeBlocks: 10 });
    expect(laid.status).toBe('success');
    expect(laid.totals.place).toBe(3);
    expect(laid.steps.filter(step => step.kind === 'bridge')).toHaveLength(3);
  });

  it('a step up too high to jump is a laid step or a stair cut, by what the pack holds', () => {
    const read = world((x, y) => (x >= 4 ? (y < 66 ? STONE : AIR) : flat(y)));
    const laid = planRoute(read, at(0, 64, 0), [at(8, 66, 0)], { placeBlocks: 10 });
    expect(laid.status).toBe('success');
    expect(laid.steps.some(step => step.kind === 'scaffold' || step.kind === 'dig_up' || step.kind === 'dig_level')).toBe(true);
  });
});

describe('planRoute: water and lava', () => {
  /** Two rooms (x < 5, x > 5) joined by two corridors (z 0 and z 4), each shut by a plug of three blocks (x 5, y 64-66); bedrock floor, ceiling and wall, so no way under or round. */
  const corridors = (extra: (x: number, y: number, z: number) => MapBlock | null = () => null) => world((x, y, z) => {
    const special = extra(x, y, z);
    if (special) return special;
    if (y <= 63 || y >= 67) return BEDROCK;
    if (x !== 5) return AIR;
    if (z !== 0 && z !== 4) return BEDROCK;
    return STONE;
  });
  const dugSides = (read: BlockReader, plan: ReturnType<typeof planRoute>, name: string) => plan.steps.flatMap(step => step.dig)
    .filter(cell => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => read(cell.x + dx, cell.y, cell.z + dz)?.name === name));

  it('a block with water over it is dug only when sealable, and the dry corridor is taken first', () => {
    const read = corridors((x, y, z) => (x === 5 && z === 0 && y === 66 ? WATER : null));
    const plan = planRoute(read, at(0, 64, 2), [at(10, 64, 2)], { ms: 3000 });
    expect(plan.status).toBe('success');
    expect(plan.steps.flatMap(step => step.dig).every(cell => cell.z !== 0)).toBe(true);
    expect(plan.wet).toHaveLength(0);
  });

  it('water is a wall to walk: a pond is not crossed without waterOk; with it, it is', () => {
    const pond = world((x, y, z) => (Math.abs(z) > 3 && y >= 64 ? BEDROCK : x >= 3 && x <= 6 && y === 63 ? WATER : x >= 3 && x <= 6 && y < 63 ? STONE : y < 64 ? STONE : AIR));
    const dry = planRoute(pond, at(0, 64, 0), [at(10, 64, 0)], { placeBlocks: 0, maxDig: 0, ms: 3000 });
    expect(dry.status).not.toBe('success');
    const wetOk = planRoute(pond, at(0, 64, 0), [at(10, 64, 0)], { waterOk: true });
    expect(wetOk.status).toBe('success');
  });

  it('lava beside a block to be cut makes it a wall: with lava at the side of both plugs there is no way, and no block with lava at its side is dug', () => {
    const half = corridors((x, y, z) => (x === 5 && z === 1 && (y === 64 || y === 65) ? LAVA : null));
    const round = planRoute(half, at(0, 64, 2), [at(10, 64, 2)], { ms: 3000 });
    expect(round.status).toBe('success');
    expect(round.steps.flatMap(step => step.dig).every(cell => cell.z === 4)).toBe(true);
    const both = corridors((x, y, z) => (x === 5 && (z === 1 || z === 3) && (y === 64 || y === 65) ? LAVA : null));
    const shut = planRoute(both, at(0, 64, 2), [at(10, 64, 2)], { ms: 3000 });
    expect(shut.status).toBe('none');
    expect(dugSides(half, round, 'lava')).toHaveLength(0);
  });

  it('water over every way: dug at a high price with a block to seal it; lava over every way: not dug at all', () => {
    const over = (liquid: MapBlock) => corridors((x, y, z) => (x === 5 && (z === 0 || z === 4) && y === 66 ? liquid : null));
    const wet = planRoute(over(WATER), at(0, 64, 2), [at(10, 64, 2)], { placeBlocks: 5, ms: 3000 });
    expect(wet.status).toBe('success');
    expect(wet.wet.length).toBeGreaterThanOrEqual(1);
    const lava = planRoute(over(LAVA), at(0, 64, 2), [at(10, 64, 2)], { placeBlocks: 5, ms: 3000 });
    expect(lava.status).not.toBe('success');
  });

  it('a dug block with water at its side is dug when there is no other way, with one block to seal it', () => {
    const read = corridors((x, y, z) => (x === 5 && (z === 1 || z === 3) && (y === 64 || y === 65) ? WATER : null));
    const plan = planRoute(read, at(0, 64, 2), [at(10, 64, 2)], { placeBlocks: 5, ms: 3000 });
    expect(plan.status).toBe('success');
    expect(plan.wet.length).toBeGreaterThanOrEqual(1);
    expect(plan.totals.place).toBeGreaterThanOrEqual(plan.wet.length);
    expect(summarizeRoute(plan)).toContain('水の隣を掘る所');
  });

  it('a dry corridor is taken over a wet one even when the wet one is nearer', () => {
    const read = corridors((x, y, z) => (x === 5 && z === 1 && (y === 64 || y === 65) ? WATER : null));
    const plan = planRoute(read, at(0, 64, 1), [at(10, 64, 1)], { placeBlocks: 5, ms: 3000 });
    expect(plan.status).toBe('success');
    expect(plan.wet).toHaveLength(0);
  });
});

describe('planRoute: what may be dug', () => {
  /** One corridor (z 0, two high) in bedrock, shut by a plug at x 5 made of the blocks given (y 64, y 65). */
  const corridor = (low: MapBlock, high: MapBlock) => world((x, y, z) => (y <= 63 || y >= 66 || z !== 0 ? BEDROCK : x === 5 ? (y === 64 ? low : high) : AIR));

  it('an ore and gravel in the way are dug, and the plan says so; bedrock is a wall and is named', () => {
    const plan = planRoute(corridor(ORE, GRAVEL), at(0, 64, 0), [at(9, 64, 0)]);
    expect(plan.status).toBe('success');
    expect(plan.digsByName).toMatchObject({ lapis_ore: 1, gravel: 1 });
    expect(plan.incidental).toEqual({ lapis_ore: 1 });
    expect(summarizeRoute(plan)).toContain('鉱石も掘る');
    const refused = planRoute(corridor(BEDROCK, STONE), at(0, 64, 0), [at(9, 64, 0)], { ms: 3000 });
    expect(refused.status).toBe('none');
    const goalWalled = planRoute(world((x, y) => (x === 9 && y === 64 ? BEDROCK : flat(y))), at(0, 64, 0), [at(9, 64, 0)]);
    expect(goalWalled.status).toBe('none');
    expect(goalWalled.why).toContain('bedrock');
  });

  it('the canDig of the hand narrows it: a name not allowed is a wall', () => {
    const read = corridor(DIRT, DIRT);
    expect(planRoute(read, at(0, 64, 0), [at(9, 64, 0)]).status).toBe('success');
    const narrow = planRoute(read, at(0, 64, 0), [at(9, 64, 0)], { diggable: name => name === 'stone', ms: 3000 });
    expect(narrow.status).toBe('none');
  });
});

describe('planRoute: the ceiling', () => {
  const rock = world((x, y, z) => (y <= 63 ? STONE : AIR));
  it('a way that digs more than the ceiling is not walked: it is told with the needed blocks and the way by shaft', () => {
    const plan = planRoute(rock, at(0, 64, 0), [at(0, 30, 0)], { maxDig: 16, placeBlocks: 0 });
    expect(plan.status).toBe('over');
    expect(plan.over!.needed).toBeGreaterThan(16);
    expect(plan.over!.ceiling).toBe(16);
    expect(summarizeRoute(plan)).toMatch(/掘り \d+/);
    expect(summarizeRoute(plan)).toContain('天井 16 を超える');
  });
  it('the ceiling the hand does not give is a large one, and a short dig is under it', () => {
    expect(DEFAULT_CEILING).toBeGreaterThanOrEqual(60);
    const plan = planRoute(rock, at(0, 64, 0), [at(0, 50, 0)], { placeBlocks: 30 });
    expect(plan.status).toBe('success');
    expect(plan.totals.dig).toBe(14);
  });
});

describe('planRoute: the box and the words', () => {
  it('a goal beyond the box is a partial plan to its edge, with a frontier', () => {
    const plan = planRoute(world((x, y) => flat(y)), at(0, 64, 0), [at(400, 64, 0)], { maxCells: 60_000 });
    expect(plan.status).toBe('partial');
    expect(plan.frontier!.x).toBeGreaterThan(10);
    expect(summarizeRoute(plan)).toContain('着いたら出し直す');
  });

  it('a success is said with its numbers; a none says its one reason', () => {
    const rock = world((x, y, z) => (x === 5 && y >= 64 && y <= 68 && z >= -60 && z <= 60 ? DIRT : flat(y)));
    const text = summarizeRoute(planRoute(rock, at(0, 64, 0), [at(9, 64, 0)]));
    expect(text).toMatch(/^道 \d+ マス（歩 \d+・上り \d+・下り \d+・掘 2〔土 2〕）約 \d+ 秒/u);
    const none = summarizeRoute(planRoute(world((x, y) => (x === 9 && y === 64 ? LAVA : flat(y))), at(0, 64, 0), [at(9, 64, 0)]));
    expect(none).toContain('行けない');
    expect(none).toContain('溶岩');
  });
});

describe('planRoute: its speed', () => {
  it('a 200,000-cell world is planned in a second at the most (the search reads whole cells, not pathfinder nodes)', () => {
    const read = world((x, y, z) => (y <= 63 ? STONE : AIR));
    const began = performance.now();
    const plan = planRoute(read, at(0, 64, 0), [at(60, 64, 40)], { maxCells: 200_000 });
    const ms = performance.now() - began;
    expect(plan.status).toBe('success');
    expect(ms).toBeLessThan(1000);
  });
});
