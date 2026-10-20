import { describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import pathfinder from 'mineflayer-pathfinder';
import { planStairLine, TunnelTrail } from '../../src/services/minebot/utils/stairLine.js';
import { digRefusal, estimateCells, estimateStep, floorDrop, isStep, stepNeeds } from '../../src/services/minebot/utils/tunnelWalk.js';
import { chooseRockTravel } from '../../src/services/minebot/utils/rockTravel.js';
import { walkOnlyProfile, travelProfile } from '../../src/services/minebot/utils/travelProfile.js';
import { trailOf } from '../../src/services/minebot/utils/stairLine.js';

// buildMovements needs a real bot's version and registry; the profile it was asked for is what matters here.
vi.mock('../../src/services/minebot/utils/setMovements.js', () => ({ buildMovements: (_bot: unknown, ...profile: unknown[]) => ({ profile }) }));

const { goals } = pathfinder;

type Rule = (x: number, y: number, z: number) => string | null;

/** A world from a rule: the block name at a cell, null for an unloaded cell. */
function world(rule: Rule, at = new Vec3(0.5, 90, 0.5), navigator?: unknown): any {
  const block = (name: string, x: number, y: number, z: number) => ({
    name, position: new Vec3(x, y, z), diggable: name !== 'bedrock',
    boundingBox: ['air', 'water', 'lava', 'cave_air'].includes(name) ? 'empty' : 'block',
    harvestTools: ['air', 'water', 'lava'].includes(name) ? null : { 7: true },
    digTime: (type: number | null) => (type === null ? 7500 : 400),
  });
  return {
    entity: { position: at, onGround: true, effects: {} },
    inventory: { items: () => [{ type: 7, name: 'iron_pickaxe', slot: 36, maxDurability: 250, durabilityUsed: 0 }] },
    blockAt: (p: Vec3) => { const name = rule(p.x, p.y, p.z); return name === null ? null : block(name, p.x, p.y, p.z); },
    pathfinder: navigator,
  };
}

/** Solid everywhere except a pocket of air at the body's cell (feet and head). */
const rock: Rule = (x, y, z) => (x === 0 && z === 0 && (y === 90 || y === 91) ? 'air' : 'stone');

describe('the shape of a tunnel (utils/stairLine)', () => {
  it('is straight along an axis and a 1:1 stair when the height equals the way along', () => {
    const level = planStairLine(new Vec3(0, 70, 0), { x: 5, y: 70, z: 0 });
    expect(level.cells.map(c => [c.x, c.y, c.z])).toEqual([[1, 70, 0], [2, 70, 0], [3, 70, 0], [4, 70, 0], [5, 70, 0]]);
    const stair = planStairLine(new Vec3(0, 70, 0), { x: 0, y: 66, z: 4 });
    expect(stair.cells.map(c => c.y)).toEqual([69, 68, 67, 66]);
    expect(stair.cells.every(c => c.x === 0)).toBe(true);
    expect(stair.shortBy).toBe(0);
  });

  it('every cell is one legal step from the one before (a level at most, one cell along x or z), for any ends', () => {
    for (const to of [{ x: 37, y: 58, z: -12 }, { x: -20, y: 97, z: 30 }, { x: 3, y: 90, z: 3 }, { x: -9, y: 60, z: 0 }]) {
      const plan = planStairLine(new Vec3(0, 93, 0), to);
      let from = new Vec3(0, 93, 0);
      for (const cell of plan.cells) { expect(isStep(from, cell)).toBe(true); from = cell; }
      expect(from.x).toBe(to.x);
      expect(from.z).toBe(to.z);
      // the plan ends at the height asked unless the way along was shorter than the height
      expect(from.y).toBe(plan.shortBy === 0 ? to.y : to.y + Math.sign(93 - to.y) * plan.shortBy);
    }
  });

  it('a diagonal alternates x and z, and the levels are spread along the way', () => {
    const plan = planStairLine(new Vec3(0, 93, 0), { x: 10, y: 88, z: 10 });
    const xs = plan.cells.map(c => c.x), zs = plan.cells.map(c => c.z);
    // no run of more than two steps along one axis
    let run = 1, longest = 1;
    for (let i = 1; i < plan.cells.length; i++) {
      const sameAxis = (xs[i] !== xs[i - 1]) === (xs[i - 1] !== (xs[i - 2] ?? xs[i - 1] - 1));
      run = sameAxis ? run + 1 : 1; longest = Math.max(longest, run);
    }
    expect(longest).toBeLessThanOrEqual(3);
    expect(plan.cells.at(-1)).toMatchObject({ x: 10, y: 88, z: 10 });
    expect(zs.at(-1)).toBe(10);
    expect(plan.shortBy).toBe(0);
  });

  it('says how many levels are left when the height asked is more than the way along', () => {
    const plan = planStairLine(new Vec3(0, 93, 0), { x: 4, y: 60, z: 0 });
    expect(plan.cells).toHaveLength(4);
    expect(plan.shortBy).toBe(33 - 4);
    expect(planStairLine(new Vec3(0, 93, 0), { x: 0, y: 60, z: 0 })).toMatchObject({ cells: [], shortBy: 33 });
  });
});

describe('the memory of the tunnels cut (TunnelTrail)', () => {
  it('leads back the way the body came, in reverse, from the cell it stands in', () => {
    const trail = new TunnelTrail();
    const plan = planStairLine(new Vec3(0, 93, 0), { x: 12, y: 85, z: 4 });
    let from = new Vec3(0, 93, 0);
    for (const cell of plan.cells) { trail.add(from, cell); from = cell; }
    const home = trail.route(from, cell => cell.x === 0 && cell.z === 0);
    expect(home).not.toBeNull();
    expect(home!.at(-1)).toMatchObject({ x: 0, y: 93, z: 0 });
    expect(home).toHaveLength(plan.cells.length);
    // every cell of the way back is a cell of the way there
    const there = new Set([...plan.cells.map(c => `${c.x},${c.y},${c.z}`), '0,93,0']);
    expect(home!.every(c => there.has(`${c.x},${c.y},${c.z}`))).toBe(true);
    // and every step of it is legal
    let at = from;
    for (const cell of home!) { expect(isStep(at, cell)).toBe(true); at = cell; }
  });

  it('knows nothing of a body that is not on the trail, and forgets the oldest cells past its bound', () => {
    const trail = new TunnelTrail();
    trail.add(new Vec3(0, 0, 0), new Vec3(1, 0, 0));
    expect(trail.route(new Vec3(40, 0, 40), () => true)).toBeNull();
    for (let i = 0; i < 4000; i++) trail.add(new Vec3(i, 10, 0), new Vec3(i + 1, 10, 0));
    expect(trail.size).toBeLessThan(4001);
    expect(trail.route(new Vec3(3999, 10, 0), cell => cell.x === 3990)).not.toBeNull();
  });
});

describe('what a step needs and costs (utils/tunnelWalk)', () => {
  it('a stair step down opens three cells, a step up three, a level step two', () => {
    const cells = (from: [number, number, number], to: [number, number, number]) => stepNeeds(new Vec3(...from), new Vec3(...to)).clear.map(c => `${c.x},${c.y},${c.z}`);
    expect(cells([0, 70, 0], [1, 69, 0])).toEqual(['1,71,0', '1,70,0', '1,69,0']);
    expect(cells([0, 70, 0], [1, 70, 0])).toEqual(['1,70,0', '1,71,0']);
    expect(cells([0, 70, 0], [1, 71, 0])).toEqual(['0,72,0', '1,71,0', '1,72,0']);
    expect(stepNeeds(new Vec3(0, 70, 0), new Vec3(1, 69, 0)).floor).toMatchObject({ x: 1, y: 68, z: 0 });
    expect(stepNeeds(new Vec3(0, 70, 0), new Vec3(1, 71, 0)).floor).toMatchObject({ x: 1, y: 70, z: 0 });
  });

  it('prices a stair through stone at the tool time of its three blocks, and an open step as a plain move', () => {
    const bot = world(rock);
    const down = estimateStep(bot, new Vec3(0, 90, 0), new Vec3(1, 89, 0));
    expect(down).toMatchObject({ digs: 3, extraDrop: 0 });
    expect(down!.ms).toBeCloseTo(450 + 3 * (400 + 250), -1);
    const open = world(() => 'air');
    expect(estimateStep(open, new Vec3(0, 90, 0), new Vec3(1, 90, 0))).toBeNull();   // no floor to stand on
    const floored = world((x, y) => (y < 90 ? 'stone' : 'air'));
    expect(estimateStep(floored, new Vec3(0, 90, 0), new Vec3(1, 90, 0))).toMatchObject({ digs: 0, ms: 450 });
  });

  it('will not cut by hand where the block drops nothing without a pickaxe', () => {
    const bot = world(rock);
    bot.inventory.items = () => [];
    expect(estimateStep(bot, new Vec3(0, 90, 0), new Vec3(1, 90, 0))).toBeNull();
  });

  it('refuses a cell with water or a falling block over it, lava anywhere beside it, an unloaded neighbour and bedrock', () => {
    const cell = new Vec3(5, 80, 5);
    const only = (special: Rule): Rule => (x, y, z) => special(x, y, z) ?? 'stone';
    expect(digRefusal(world(() => 'stone'), cell, [])).toBeNull();
    expect(digRefusal(world(only((x, y, z) => (x === 6 && y === 80 && z === 5 ? 'water' : null))), cell, [])).toMatch(/^liquid_beside/);
    expect(digRefusal(world(only((x, y, z) => (x === 5 && y === 81 && z === 5 ? 'gravel' : null))), cell, [])).toMatch(/^falling_above/);
    expect(digRefusal(world(only((x, y, z) => (x === 5 && y === 79 && z === 5 ? 'lava' : null))), cell, [])).toMatch(/^lava_beside/);
    expect(digRefusal(world((x) => (x === 4 ? null : 'stone')), cell, [])).toBe('unloaded');
    expect(digRefusal(world(() => 'bedrock'), cell, [])).toMatch(/^undiggable/);
    // an open cell is only asked about lava beside it and being liquid itself
    expect(digRefusal(world((x, y, z) => (x === 5 && y === 80 && z === 5 ? 'air' : x === 6 ? 'water' : 'stone')), cell, [])).toBeNull();
    expect(digRefusal(world((x, y, z) => (x === 5 && y === 80 && z === 5 ? 'water' : 'stone')), cell, [])).toMatch(/^liquid/);
  });

  it('steps down onto a floor one or two blocks lower, never onto liquid or further down', () => {
    expect(floorDrop(world((x, y) => (y <= 79 ? 'stone' : 'air')), { x: 0, y: 81, z: 0 }, true)).toBe(2);
    expect(floorDrop(world((x, y) => (y <= 80 ? 'stone' : 'air')), { x: 0, y: 81, z: 0 }, true)).toBe(1);
    expect(floorDrop(world((x, y) => (y <= 70 ? 'stone' : 'air')), { x: 0, y: 81, z: 0 }, true)).toBeNull();
    expect(floorDrop(world((x, y) => (y <= 80 ? 'stone' : 'air')), { x: 0, y: 81, z: 0 }, false)).toBeNull();
    expect(floorDrop(world((x, y) => (y <= 80 ? 'lava' : 'air')), { x: 0, y: 81, z: 0 }, true)).toBeNull();
    expect(floorDrop(world(() => 'stone'), { x: 0, y: 81, z: 0 }, true)).toBe(0);
  });

  it('prices a whole plan up to the first step that cannot be taken', () => {
    const bot = world((x, y, z) => (x === 0 && z === 0 && (y === 90 || y === 91) ? 'air' : x > 6 && y < 91 && y > 84 ? 'lava' : 'stone'));
    const plan = planStairLine(new Vec3(0, 90, 0), { x: 10, y: 90, z: 0 });
    const estimate = estimateCells(bot, new Vec3(0, 90, 0), plan.cells);
    expect(estimate.feasible).toBe(true);
    expect(estimate.stoppedAt).toBeLessThan(plan.cells.length);
    expect(estimate.digs).toBe(estimate.steps * 2);
  });
});

describe('how a far walk through rock is made (utils/rockTravel)', () => {
  const navigatorOf = (status: string, moves: number) => ({
    getPathFromTo: () => ({ next: () => ({ value: { result: { status, path: new Array(moves).fill({}) } } }) }),
    movements: undefined,
  });
  const goal = new goals.GoalNear(24, 66, 0, 2);

  it('cuts a stair when the line is rock and there is no walk on the ground', () => {
    const bot = world(rock, new Vec3(0.5, 90, 0.5), navigatorOf('noPath', 0));
    const choice = chooseRockTravel(bot, goal as any);
    expect(choice.mode).toBe('cells');
    if (choice.mode === 'cells') { expect(choice.source).toBe('tunnel'); expect(choice.cells.length).toBeGreaterThan(20); expect(choice.digs).toBeGreaterThan(30); }
  });

  it('walks on the ground, neither digging nor laying, when it is about as quick (and takes the dearer tunnel never)', () => {
    const bot = world(rock, new Vec3(0.5, 90, 0.5), navigatorOf('success', 60));
    const choice = chooseRockTravel(bot, goal as any);
    expect(choice.mode).toBe('walk');
    const profile = (choice as any).movements.profile;
    expect(profile).toEqual([...walkOnlyProfile(false)]);
    expect(profile[4]).toBe(false);    // canDig
    expect(profile[11]).toBe(false);   // canPlace
    expect(travelProfile(false)[4]).toBe(true);
  });

  it('leaves open ground, short walks, goals without a height and a body in water to the route search', () => {
    const open = world(() => 'air', new Vec3(0.5, 90, 0.5), navigatorOf('success', 40));
    expect(chooseRockTravel(open, goal as any)).toMatchObject({ mode: 'default', why: 'open_ground' });
    const bot = world(rock, new Vec3(0.5, 90, 0.5), navigatorOf('noPath', 0));
    expect(chooseRockTravel(bot, new goals.GoalNear(5, 88, 0, 2) as any)).toMatchObject({ mode: 'default', why: 'near' });
    expect(chooseRockTravel(bot, new goals.GoalNearXZ(24, 0, 2) as any)).toMatchObject({ mode: 'default', why: 'no_height' });
    bot.entity.isInWater = true;
    expect(chooseRockTravel(bot, goal as any)).toMatchObject({ mode: 'default', why: 'in_water' });
    bot.entity.isInWater = false;
    expect(chooseRockTravel(bot, goal as any, { MINEBOT_ROCK_TRAVEL: 'off' } as any)).toMatchObject({ mode: 'default', why: 'off' });
  });

  it('goes back along the tunnel it cut, digging nothing', () => {
    const bot = world(rock, new Vec3(0.5, 90, 0.5), navigatorOf('noPath', 0));
    const out = chooseRockTravel(bot, goal as any);
    expect(out.mode).toBe('cells');
    if (out.mode !== 'cells') return;
    const trail = trailOf(bot);
    let from = new Vec3(0, 90, 0);
    for (const cell of out.cells) { trail.add(from, cell); from = cell; }
    bot.entity.position = new Vec3(from.x + 0.5, from.y, from.z + 0.5);
    const back = chooseRockTravel(bot, new goals.GoalNear(0, 90, 0, 1) as any);
    expect(back).toMatchObject({ mode: 'cells', source: 'trail', digs: 0 });
  });
});
