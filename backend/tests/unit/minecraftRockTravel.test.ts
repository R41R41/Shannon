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

  it('a diagonal is two straight runs, one axis after the other (Rai, run 23: no diagonal staircase of alternating steps), the levels spread along them', () => {
    const plan = planStairLine(new Vec3(0, 93, 0), { x: 10, y: 88, z: 6 });
    const axes = plan.cells.map((cell, i) => { const before = plan.cells[i - 1] ?? new Vec3(0, 93, 0); return cell.x !== before.x ? 'x' : 'z'; });
    // one turn at most: the longer run first (x: 10), then the other (z: 6)
    expect(axes.filter((axis, i) => i > 0 && axis !== axes[i - 1])).toHaveLength(1);
    expect(axes.slice(0, 10).every(axis => axis === 'x')).toBe(true);
    expect(plan.cells.at(-1)).toMatchObject({ x: 10, y: 88, z: 6 });
    expect(plan.cells).toHaveLength(16);
    expect(plan.shortBy).toBe(0);
    // the other order: the shorter run first
    const short = planStairLine(new Vec3(0, 93, 0), { x: 10, y: 88, z: 6 }, 'short');
    expect(short.cells.slice(0, 6).every(cell => cell.x === 0)).toBe(true);
    expect(short.cells.at(-1)).toMatchObject({ x: 10, y: 88, z: 6 });
    // a named axis first
    expect(planStairLine(new Vec3(0, 70, 0), { x: 3, y: 70, z: 3 }, 'zx').cells.slice(0, 3).every(cell => cell.x === 0)).toBe(true);
  });

  it('takes the levels over the stair straight: a shaft first going down, a pillar last going up (run 21: 32 m down in 19 m, 40 m up in 9 m)', () => {
    const down = planStairLine(new Vec3(0, 93, 0), { x: 4, y: 60, z: 0 });
    expect(down.cells).toHaveLength(33);
    expect(down.shortBy).toBe(0);
    // 29 levels straight down in the first column, then 4 stair steps down
    expect(down.cells.slice(0, 29).every(c => c.x === 0 && c.z === 0)).toBe(true);
    expect(down.cells.slice(29).map(c => c.x)).toEqual([1, 2, 3, 4]);
    expect(down.cells.at(-1)).toMatchObject({ x: 4, y: 60, z: 0 });
    const up = planStairLine(new Vec3(0, 57, 0), { x: 9, y: 97, z: 0 });
    expect(up.cells.slice(0, 9).map(c => c.x)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(up.cells.slice(9).every(c => c.x === 9)).toBe(true);
    expect(up.cells.at(-1)).toMatchObject({ x: 9, y: 97, z: 0 });
    let from = new Vec3(0, 93, 0);
    for (const cell of down.cells) { expect(isStep(from, cell)).toBe(true); from = cell; }
    // straight down or up with no way along at all
    expect(planStairLine(new Vec3(0, 93, 0), { x: 0, y: 60, z: 0 }).cells).toHaveLength(33);
    // past MAX_VERTICAL the rest is said
    expect(planStairLine(new Vec3(0, 200, 0), { x: 0, y: 0, z: 0 })).toMatchObject({ shortBy: 130 });
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
    // straight down opens the floor cell; straight up opens the cell over the head
    expect(cells([0, 70, 0], [0, 69, 0])).toEqual(['0,69,0']);
    expect(cells([0, 70, 0], [0, 71, 0])).toEqual(['0,72,0']);
    expect(isStep(new Vec3(0, 70, 0), new Vec3(0, 69, 0))).toBe(true);
    expect(isStep(new Vec3(0, 70, 0), new Vec3(0, 68, 0))).toBe(false);
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

  it('walks open ground that can be walked, and leaves a body all but there, goals without a height and a body in water to the route search', () => {
    const open = world(() => 'air', new Vec3(0.5, 90, 0.5), navigatorOf('success', 40));
    expect(chooseRockTravel(open, goal as any)).toMatchObject({ mode: 'walk' });
    // open ground the short think could not settle is left to the route search
    const unsettled = world(() => 'air', new Vec3(0.5, 90, 0.5), navigatorOf('timeout', 0));
    expect(chooseRockTravel(unsettled, goal as any)).toMatchObject({ mode: 'default', why: 'open_ground' });
    const bot = world(rock, new Vec3(0.5, 90, 0.5), navigatorOf('noPath', 0));
    expect(chooseRockTravel(bot, new goals.GoalNear(1, 90, 0, 0) as any)).toMatchObject({ mode: 'default', why: 'near' });
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
    // the tunnel is cut: its cells are open (the trail is walked only while they are, run 24)
    const open = new Set(out.cells.flatMap(c => [`${c.x},${c.y},${c.z}`, `${c.x},${c.y + 1},${c.z}`]));
    const cut = world((x, y, z) => (open.has(`${x},${y},${z}`) ? 'air' : rock(x, y, z)), new Vec3(0.5, 90, 0.5), navigatorOf('noPath', 0));
    const trail = trailOf(cut);
    let from = new Vec3(0, 90, 0);
    for (const cell of out.cells) { trail.add(from, cell); from = cell; }
    cut.entity.position = new Vec3(from.x + 0.5, from.y, from.z + 0.5);
    const back = chooseRockTravel(cut, new goals.GoalNear(0, 90, 0, 1) as any);
    expect(back).toMatchObject({ mode: 'cells', source: 'trail', digs: 0 });
  });
});

describe('a walk that needs digging is a combination of straight runs, shafts and stairs, and goes round what is in the way (run 23)', () => {
  const noPath = { getPathFromTo: () => ({ next: () => ({ value: { result: { status: 'noPath', path: [] } } }) }), movements: undefined };
  const at = (cells: Vec3[]) => cells.map(c => `${c.x},${c.y},${c.z}`);
  /** The axis of each horizontal step of a tunnel (vertical-only steps are not counted). */
  const axesOf = (cells: Vec3[], start: Vec3) => {
    const out: string[] = [];
    let before = start;
    for (const cell of cells) { if (cell.x !== before.x) out.push('x'); else if (cell.z !== before.z) out.push('z'); before = cell; }
    return out;
  };
  const turns = (axes: string[]) => axes.filter((axis, i) => i > 0 && axis !== axes[i - 1]).length;
  /** Open air over a stone floor (y 89), with `solid` and `special` cells on top of it. */
  const hall = (solid: (x: number, y: number, z: number) => boolean, special: Rule = () => null): Rule =>
    (x, y, z) => special(x, y, z) ?? (y <= 89 ? 'stone' : solid(x, y, z) ? 'stone' : 'air');
  const feet = new Vec3(0, 90, 0);
  const start = new Vec3(0.5, 90, 0.5);

  it('a short walk through a wall that no ground leads round is cut straight through it, not left to the route search', () => {
    // a wall two blocks thick across the hall at x 3-4; the goal is 8 m on, behind it
    const bot = world(hall(x => x === 3 || x === 4), undefined, noPath);
    const choice = chooseRockTravel(bot, new goals.GoalNear(8, 90, 0, 0) as any);
    expect(choice.mode).toBe('cells');
    if (choice.mode !== 'cells') return;
    expect(choice.source).toBe('tunnel');
    expect(choice.cells).toHaveLength(8);
    expect(choice.cells.every(c => c.y === 90 && c.z === 0)).toBe(true);
    expect(choice.digs).toBe(4);            // two blocks of wall, feet and head: four, not a diagonal's worth
  });

  it('a diagonal goal is one run along x and one along z (a single turn), never a zigzag', () => {
    const bot = world(hall(() => true, (x, y, z) => (x === 0 && z === 0 && (y === 90 || y === 91) ? 'air' : null)), undefined, noPath);
    const choice = chooseRockTravel(bot, new goals.GoalNear(9, 90, 5, 0) as any);
    expect(choice.mode).toBe('cells');
    if (choice.mode !== 'cells') return;
    const axes = axesOf(choice.cells, feet);
    expect(axes).toHaveLength(14);
    expect(turns(axes)).toBe(1);
    expect(choice.cells.at(-1)).toMatchObject({ x: 9, y: 90, z: 5 });
  });

  it('goes round a furnace at the first step (run 23: protected:furnace stopped the whole tunnel walk at step 0, and the route search took 41 s for 15 m)', () => {
    const solid = (x: number, y: number, z: number) => x >= 1 && x <= 6 && y <= 92 && Math.abs(z) <= 3;
    const rule = hall(solid, (x, y, z) => (x === 1 && y === 90 && z === 0 ? 'furnace' : null));
    const bot = world(rule, undefined, noPath);
    const straight = planStairLine(feet, { x: 9, y: 90, z: 0 });
    expect(estimateCells(bot, feet, straight.cells).stoppedAt).toBe(0);
    const choice = chooseRockTravel(bot, new goals.GoalNear(9, 90, 0, 0) as any);
    expect(choice.mode).toBe('cells');
    if (choice.mode !== 'cells') return;
    expect(at(choice.cells)).not.toContain('1,90,0');
    expect(choice.cells.at(-1)).toMatchObject({ x: 9, y: 90, z: 0 });
    let from = feet;
    for (const cell of choice.cells) { expect(isStep(from, cell)).toBe(true); from = cell; }
    // a jog to the side, a run parallel to the straight one, back: at most three turns, and the plan can be cut all the way
    expect(turns(axesOf(choice.cells, feet))).toBeLessThanOrEqual(3);
    expect(estimateCells(bot, feet, choice.cells).stoppedAt).toBe(choice.cells.length);
  });

  it('goes round water beside the line, two cells out (liquid_beside refused the run at its first steps)', () => {
    const solid = (x: number, y: number, z: number) => x >= 1 && x <= 6 && y <= 92 && Math.abs(z) <= 3;
    const rule = hall(solid, (x, y, z) => (x === 3 && y === 90 && z === 1 ? 'water' : null));
    const bot = world(rule, undefined, noPath);
    const choice = chooseRockTravel(bot, new goals.GoalNear(9, 90, 0, 0) as any);
    expect(choice.mode).toBe('cells');
    if (choice.mode !== 'cells') return;
    // no cell dug beside the water
    expect(choice.cells.some(c => c.y === 90 && Math.abs(c.x - 3) + Math.abs(c.z - 1) <= 1 && !(c.x === 3 && c.z === 1))).toBe(false);
    expect(choice.cells.at(-1)).toMatchObject({ x: 9, y: 90, z: 0 });
    expect(estimateCells(bot, feet, choice.cells).stoppedAt).toBe(choice.cells.length);
  });

  it('goes round an obstacle in the middle of a run by a jog just before it, and comes back to the goal', () => {
    const solid = (x: number, y: number, z: number) => x >= 1 && x <= 12 && y <= 92 && Math.abs(z) <= 4;
    const rule = hall(solid, (x, y, z) => (x === 7 && y === 90 && z === 0 ? 'furnace' : null));
    const bot = world(rule, undefined, noPath);
    const choice = chooseRockTravel(bot, new goals.GoalNear(13, 90, 0, 0) as any);
    expect(choice.mode).toBe('cells');
    if (choice.mode !== 'cells') return;
    expect(at(choice.cells)).not.toContain('7,90,0');
    expect(choice.cells.at(-1)).toMatchObject({ x: 13, y: 90, z: 0 });
    expect(turns(axesOf(choice.cells, feet))).toBeLessThanOrEqual(3);
    // the plan is cut all the way, with no more cells than the straight run and its two jogs
    expect(estimateCells(bot, feet, choice.cells).stoppedAt).toBe(choice.cells.length);
    expect(choice.cells.length).toBeLessThanOrEqual(13 + 2);
  });

  it('a stair down is a shaft first and a straight run, and no cell of it is a diagonal step', () => {
    const bot = world(hall(() => true, (x, y, z) => (x === 0 && z === 0 && (y === 90 || y === 91) ? 'air' : y < 90 ? 'stone' : null)), undefined, noPath);
    const choice = chooseRockTravel(bot, new goals.GoalNear(4, 82, 3, 0) as any);
    expect(choice.mode).toBe('cells');
    if (choice.mode !== 'cells') return;
    let from = feet;
    for (const cell of choice.cells) { expect(isStep(from, cell)).toBe(true); from = cell; }
    expect(turns(axesOf(choice.cells, feet))).toBeLessThanOrEqual(1);
  });

  it('open ground the search found no way over is dug through even when little of the line is rock', () => {
    const bot = world(hall(x => x === 2), undefined, noPath);
    expect(chooseRockTravel(bot, new goals.GoalNear(12, 90, 0, 0) as any)).toMatchObject({ mode: 'cells', source: 'tunnel' });
  });

  it('but a far goal the search could find no way to (ground not loaded that far) is left to the route search and its legs, not dug in a line across the open', () => {
    const bot = world(hall(() => false), undefined, noPath);
    expect(chooseRockTravel(bot, new goals.GoalNear(120, 90, 0, 0) as any)).toMatchObject({ mode: 'default', why: 'open_ground' });
  });
});
