import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import { makeSim, type Ground, type Sim, type Stack } from '../helpers/physicsBody.js';
import { digRuleOf, go, goMilliseconds, goProblem, hazardAtFeet, placeNamesOf, type GoArgs } from '../../src/services/minebot/utils/primitives/go.js';
import { StepStopped, type StepContext, type StepOutcome } from '../../src/services/minebot/utils/primitives/common.js';
import { feetCell } from '../../src/services/minebot/utils/localMap.js';

// The hand `go` against the real client physics (prismarine-physics) and the real route search and executor (mineflayer-pathfinder, unpatched as
// the test tree has it), in small worlds (tests/helpers/physicsBody): the body is moved 50 ms of physics for every 50 ms of fake time; digging and
// laying take a few ticks and change the world as a server would. A world is a function from a cell to a block name (null: not loaded); the
// feet stand at y=64 on stone below it. No server and no API.
beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] }); });
afterEach(() => { vi.useRealTimers(); });

const FLOOR = 64;
const R = 40;
/** Open ground in a square of 40 blocks round the start (nothing is loaded beyond): stone under y=64, air over it. */
const flat: Ground = (x, y, z) => (Math.abs(x) > R || Math.abs(z) > R ? null : y < FLOOR ? 'stone' : 'air');
type Layer = (x: number, y: number, z: number) => string | null | undefined;
const over = (base: Ground, ...layers: Layer[]): Ground => (x, y, z) => {
  for (const layer of layers) { const name = layer(x, y, z); if (name !== undefined) return name; }
  return base(x, y, z);
};
/** A box of one block name, the corners included. */
const box = (name: string, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): Layer => (x, y, z) =>
  (x >= x0 && x <= x1 && y >= y0 && y <= y1 && z >= z0 && z <= z1 ? name : undefined);
const ctxOf = (sim: Sim, controller = new AbortController()): StepContext => ({
  bot: sim.bot, stop: controller.signal, deadline: Date.now() + 600_000, facing: 'north', base: { x: 0, y: FLOOR, z: 0 },
});
/** Runs the physics and the fake clock until the promise is settled (or `maxMs` of fake time has gone). */
async function drive<T>(sim: Sim, promise: Promise<T>, each?: (elapsedMs: number) => void, maxMs = 240_000): Promise<T> {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  for (let elapsed = 0; elapsed < maxMs && !settled; elapsed += 50) { sim.tick(); each?.(elapsed); await vi.advanceTimersByTimeAsync(50); }
  return promise;
}
const goal = (x: number, y: number, z: number) => ({ x, y, z });
const run = (sim: Sim, args: Omit<GoArgs, 'goals'> & { goals?: GoArgs['goals'] }, to = goal(8, FLOOR, 0), controller?: AbortController) =>
  go(ctxOf(sim, controller), { goals: [to], ...args });
const stacks = (...list: Stack[]) => list;
const PICK: Stack = { name: 'stone_pickaxe', count: 1 };
const COBBLE = (count: number): Stack => ({ name: 'cobblestone', count });
const counts = (outcome: StepOutcome) => {
  const found = /道 (\d+) 歩・掘 (\d+)・置 (\d+)・引き直し (\d+) 回/u.exec(outcome.text);
  return found ? { steps: Number(found[1]), dug: Number(found[2]), placed: Number(found[3]), redraws: Number(found[4]) } : null;
};
const LINE = /^go (?:着いた|止まった [a-z_]+: .+?) \(-?\d+,-?\d+,-?\d+\) 道 \d+ 歩・掘 \d+・置 \d+・引き直し \d+ 回/u;

describe('go: the way round', () => {
  it('walks round a cliff, digging and laying nothing, in one hand', async () => {
    // A wall of stone across x=3..5, from z=-6 to z=2, 8 high; the way round is at z>=3.
    const sim = makeSim(over(flat, box('stone', 3, 5, FLOOR, FLOOR + 7, -6, 2)));
    let maxZ = 0;
    const outcome = await drive(sim, run(sim, {}, goal(9, FLOOR, 0)), () => { maxZ = Math.max(maxZ, sim.bot.entity.position.z); });
    expect(outcome.ok).toBe(true);
    expect(outcome.text).toMatch(/^go 着いた \(9,64,0\) 道 \d+ 歩・掘 0・置 0・引き直し \d+ 回$/u);
    expect(counts(outcome)!.steps).toBeGreaterThanOrEqual(10);
    expect(maxZ).toBeGreaterThan(3);
    expect(sim.bot.dugBlocks).toEqual([]);
    expect(sim.bot.placedBlocks).toEqual([]);
    expect(Math.floor(sim.bot.entity.position.x)).toBe(9);
  });

  it('goes to the nearest of several places, by the way found', async () => {
    const sim = makeSim(flat);
    const outcome = await drive(sim, run(sim, { goals: [goal(30, FLOOR, 0), goal(6, FLOOR, 2), goal(-20, FLOOR, 0)] }));
    expect(outcome.ok).toBe(true);
    expect(outcome.text).toContain('(6,64,2)');
    expect(Math.floor(sim.bot.entity.position.x)).toBe(6);
  });

  it('counts a place as reached within range, and a body already there as arrived without a step', async () => {
    const sim = makeSim(flat);
    const near = await drive(sim, run(sim, { range: 3 }, goal(10, FLOOR, 0)));
    expect(near.ok).toBe(true);
    expect(Math.hypot(sim.bot.entity.position.x - 10.5, sim.bot.entity.position.z - 0.5)).toBeLessThanOrEqual(3.2);
    expect(Math.hypot(sim.bot.entity.position.x - 10.5, sim.bot.entity.position.z - 0.5)).toBeGreaterThan(1);
    const here = feetCell(sim.bot)!;
    const again = await drive(sim, run(sim, {}, goal(here.x, here.y, here.z)));
    expect(again.text).toMatch(/^go 着いた .* 道 0 歩・掘 0・置 0・引き直し 0 回$/u);
  });
});

describe('go: across a gap (canPlace)', () => {
  // A canyon three wide across the whole ground: no floor from y=58 to 63 at x=2..4.
  const canyon = over(flat, box('air', 2, 4, 58, FLOOR - 1, -R - 1, R + 1));

  it('bridges it with the blocks it may lay and holds, and never falls in', async () => {
    const sim = makeSim(canyon, { items: stacks(COBBLE(8)) });
    let lowest = 99;
    const outcome = await drive(sim, run(sim, { canPlace: ['cobblestone'] }), () => { lowest = Math.min(lowest, sim.bot.entity.position.y); });
    expect(outcome.ok).toBe(true);
    const done = counts(outcome)!;
    expect(done.placed).toBeGreaterThanOrEqual(3);
    expect(done.placed).toBeLessThanOrEqual(6);
    expect(done.dug).toBe(0);
    expect(sim.bot.placedBlocks.every((line: string) => line.startsWith('cobblestone@'))).toBe(true);
    expect(lowest).toBeGreaterThan(63.5);
    expect(Math.floor(sim.bot.entity.position.x)).toBe(8);
  });

  it('does not lay what it was not told to lay: nothing allowed, no way, and the line says what would open it', async () => {
    const sim = makeSim(canyon, { items: stacks(COBBLE(8)) });
    const outcome = await drive(sim, run(sim, {}));
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('dead_end');
    expect(outcome.text).toMatch(LINE);
    expect(outcome.text).toContain('go 止まった dead_end:');
    expect(outcome.text).toContain('canPlace');
    expect(sim.bot.placedBlocks).toEqual([]);
  });

  it('says no_blocks when the block is allowed and not held, and when only blocks that fall are allowed', async () => {
    const empty = makeSim(canyon);
    const none = await drive(empty, run(empty, { canPlace: ['cobblestone'] }));
    expect(none.reason).toBe('no_blocks');
    expect(none.text).toContain('go 止まった no_blocks:');
    expect(none.text).toContain('cobblestone');
    const sandy = makeSim(canyon, { items: stacks({ name: 'sand', count: 16 }) });
    const sand = await drive(sandy, run(sandy, { canPlace: ['sand'] }));
    expect(sand.reason).toBe('no_blocks');
    expect(sand.text).toContain('置かない sand');
    expect(sandy.bot.placedBlocks).toEqual([]);
  });

  it('stops at its limit of blocks before it lays one (limit_place)', async () => {
    const sim = makeSim(canyon, { items: stacks(COBBLE(8)) });
    const outcome = await drive(sim, run(sim, { canPlace: ['cobblestone'], maxPlace: 2 }));
    expect(outcome.reason).toBe('limit_place');
    expect(outcome.text).toContain('go 止まった limit_place:');
    expect(counts(outcome)!.placed).toBeLessThanOrEqual(2);
    expect(sim.bot.placedBlocks.length).toBeLessThanOrEqual(2);
  });
});

describe('go: through a wall (canDig)', () => {
  // A wall of stone three thick across the whole ground, 7 high: x=3..5.
  const wall = over(flat, box('stone', 3, 5, FLOOR, FLOOR + 6, -R - 1, R + 1));

  it('digs through it with what it may dig and a tool that breaks it, only the cells of the way', async () => {
    const sim = makeSim(wall, { items: stacks(PICK) });
    const outcome = await drive(sim, run(sim, { canDig: ['stone'] }));
    expect(outcome.ok).toBe(true);
    const done = counts(outcome)!;
    expect(done.dug).toBeGreaterThanOrEqual(5);
    expect(done.dug).toBeLessThanOrEqual(8);
    expect(sim.bot.dugBlocks.length).toBe(done.dug);
    expect(sim.bot.dugBlocks.every((line: string) => line.startsWith('stone@'))).toBe(true);
    expect(sim.world.nameAt(4, FLOOR, 8)).toBe('stone');   // the wall away from the way stands
    expect(sim.world.nameAt(4, FLOOR + 5, 0)).toBe('stone');
    expect(Math.floor(sim.bot.entity.position.x)).toBe(8);
  });

  it('digs nothing it was not told to: no canDig, or other kinds only, and says what would open the way', async () => {
    for (const canDig of [undefined, ['dirt', 'sand']]) {
      const sim = makeSim(wall, { items: stacks(PICK) });
      const outcome = await drive(sim, run(sim, canDig ? { canDig } : {}));
      expect(outcome.ok).toBe(false);
      expect(outcome.reason).toBe('dead_end');
      expect(outcome.text).toContain('canDig に stone');
      expect(sim.bot.dugBlocks).toEqual([]);
    }
  });

  it('never digs what is never dug, whatever it is told (obsidian, a chest); an ore only when named by its id (run 48), never inside a category word', async () => {
    // A small world (12 round, nothing under y=56) so that the search over everything it might dig is short.
    const small: Ground = (x, y, z) => (Math.abs(x) > 12 || Math.abs(z) > 12 || y < 56 ? null : x >= 3 && x <= 5 && y <= FLOOR + 6 ? 'obsidian' : y < FLOOR ? 'stone' : 'air');
    const sim = makeSim(small, { items: stacks({ name: 'diamond_pickaxe', count: 1 }) });
    // The search is let run to its end (searchMs): over everything it may dig it is a few seconds, and a search cut by its time is
    // search_timeout (run 41), not this test's dead end.
    const outcome = await drive(sim, run(sim, { canDig: ['obsidian', 'stone', 'diamond_ore', 'chest'], searchMs: 600_000 }));
    expect(outcome.reason).toBe('dead_end');
    expect(outcome.text).toContain('go 止まった dead_end:');
    expect(sim.bot.dugBlocks).toEqual([]);
    const rule = digRuleOf(sim.bot.registry, ['obsidian', 'stone', 'diamond_ore', 'chest', 'iron_door', 'white_bed', 'bedrock', 'water', 'nonsense_block']);
    expect([...rule.names]).not.toContain('obsidian');
    expect([...rule.names]).toContain('diamond_ore');   // run 48 (hold 1): named by its id, so the planner asked for it
    expect([...digRuleOf(sim.bot.registry, ['stone', 'dirt', 'sand', 'wood']).names].filter(name => /_ore$|^ancient_debris$/u.test(name))).toEqual([]);
    expect([...rule.names]).not.toContain('chest');
    expect([...rule.names]).not.toContain('iron_door');
    expect([...rule.names]).not.toContain('white_bed');
    expect([...rule.names]).not.toContain('bedrock');
    expect([...rule.names]).not.toContain('water');
    expect(rule.names.has('cobbled_deepslate')).toBe(true);
    expect(rule.ignored).toContain('nonsense_block');
  });

  it('says no_tool when the kind may be dug and the tool that breaks it is not held', async () => {
    const sim = makeSim(wall);
    // The explanation draws the way again with each rule lifted; its search is given no time limit of its own (the faked clock runs on while it searches, so a slow
    // machine would run a 2.5 s search out and the line would say dead_end).
    const outcome = await drive(sim, run(sim, { canDig: ['stone'], seconds: 120, searchMs: 600_000 }));
    expect(outcome.reason).toBe('no_tool');
    expect(outcome.text).toContain('go 止まった no_tool:');
    expect(sim.bot.dugBlocks).toEqual([]);
  });

  it('stops at its limit of digs before it digs (limit_dig)', async () => {
    const sim = makeSim(wall, { items: stacks(PICK) });
    const outcome = await drive(sim, run(sim, { canDig: ['stone'], maxDig: 3 }));
    expect(outcome.reason).toBe('limit_dig');
    expect(outcome.text).toContain('go 止まった limit_dig:');
    expect(sim.bot.dugBlocks.length).toBeLessThanOrEqual(3);
  });
});

describe('go: up and down', () => {
  it('climbs a cliff with a pillar, a block laid at the top of each jump', async () => {
    // Stone up to y=68 for x>=3, across the whole ground: the top is at y=69 (5 higher than the start).
    const cliff = over(flat, box('stone', 3, R, FLOOR, FLOOR + 4, -R - 1, R + 1));
    const sim = makeSim(cliff, { items: stacks(COBBLE(12)) });
    const outcome = await drive(sim, run(sim, { canPlace: ['cobblestone'] }, goal(6, FLOOR + 5, 0)));
    expect(outcome.ok).toBe(true);
    const done = counts(outcome)!;
    expect(done.placed).toBeGreaterThanOrEqual(5);
    expect(done.placed).toBeLessThanOrEqual(8);
    expect(done.dug).toBe(0);
    expect(Math.floor(sim.bot.entity.position.y)).toBe(FLOOR + 5);
    expect(Math.floor(sim.bot.entity.position.x)).toBe(6);
    expect(sim.world.nameAt(4, FLOOR + 2, 0)).toBe('stone');   // the cliff is as it was
  });

  it('says no_blocks at the foot of a cliff with nothing to pillar with', async () => {
    const cliff = over(flat, box('stone', 3, R, FLOOR, FLOOR + 4, -R - 1, R + 1));
    const sim = makeSim(cliff);
    const outcome = await drive(sim, run(sim, { canPlace: ['cobblestone'] }, goal(6, FLOOR + 5, 0)));
    expect(outcome.reason).toBe('no_blocks');
    expect(sim.bot.placedBlocks).toEqual([]);
  });

  it('digs a shaft down to a cave, within the fall it may take', async () => {
    // Stone everywhere under the ground but for a cave 2 high at y=57..58 under x,z = 0..2: seven below the feet.
    const cave = over(flat, box('air', 0, 2, 57, 58, 0, 2));
    const sim = makeSim(cave, { items: stacks(PICK) });
    const outcome = await drive(sim, run(sim, { canDig: ['stone'] }, goal(1, 57, 1)));
    expect(outcome.ok).toBe(true);
    const done = counts(outcome)!;
    expect(done.dug).toBeGreaterThanOrEqual(5);
    expect(done.dug).toBeLessThanOrEqual(9);
    expect(Math.floor(sim.bot.entity.position.y)).toBe(57);
    const shut = makeSim(cave, { items: stacks(PICK) });
    const none = await drive(shut, run(shut, {}, goal(1, 57, 1)));
    expect(none.reason).toBe('dead_end');
    expect(shut.bot.dugBlocks).toEqual([]);
  });

  it('does not drop further than it may: a platform six high, a fall of three refused, of seven taken', async () => {
    const platform = over(flat, box('stone', -R, 2, FLOOR, FLOOR + 5, -R - 1, R + 1));
    const start: [number, number, number] = [0.5, FLOOR + 6, 0.5];
    const careful = makeSim(platform, { start });
    const refused = await drive(careful, run(careful, { maxDrop: 3 }, goal(6, FLOOR, 0)));
    expect(refused.reason).toBe('dead_end');
    const bold = makeSim(platform, { start });
    const taken = await drive(bold, run(bold, { maxDrop: 7 }, goal(6, FLOOR, 0)));
    expect(taken.ok).toBe(true);
    expect(Math.floor(bold.bot.entity.position.y)).toBe(FLOOR);
  });
});

describe('go: what is never entered', () => {
  it('walks round a pool of lava without ever standing in it or beside it', async () => {
    const pool = over(flat, box('lava', 3, 5, FLOOR, FLOOR, -1, 1));
    const sim = makeSim(pool);
    const hazards = new Set<string>();
    const outcome = await drive(sim, run(sim, {}, goal(9, FLOOR, 0)), () => {
      const feet = feetCell(sim.bot)!;
      const why = hazardAtFeet(sim.bot, feet.x, feet.y, feet.z);
      if (why) hazards.add(`${feet.x},${feet.y},${feet.z} ${why}`);
    });
    expect(outcome.ok).toBe(true);
    expect([...hazards]).toEqual([]);
  });

  it('says lava when the only way is through it, and does not go', async () => {
    // A corridor one wide through solid stone, lava in the middle of it.
    const corridor = over(flat, box('lava', 4, 4, FLOOR, FLOOR, 0, 0), box('air', 0, 8, FLOOR, FLOOR + 1, 0, 0), box('stone', -R, R, FLOOR, FLOOR + 3, -3, 3));
    const sim = makeSim(corridor);
    let maxX = 0;
    const outcome = await drive(sim, run(sim, {}), () => { maxX = Math.max(maxX, sim.bot.entity.position.x); });
    expect(outcome.reason).toBe('lava');
    expect(outcome.text).toContain('go 止まった lava:');
    expect(maxX).toBeLessThan(3.3);
  });

  it('refuses a place that is in lava or beside it (unsafe), and keeps the others of the list', async () => {
    const pool = over(flat, box('lava', 3, 5, FLOOR, FLOOR, -1, 1));
    const sim = makeSim(pool);
    const inside = await drive(sim, run(sim, {}, goal(4, FLOOR, 0)));
    expect(inside.reason).toBe('unsafe');
    expect(inside.text).toContain('go 止まった unsafe:');
    expect(sim.bot.entity.position.x).toBeLessThan(1);
    const beside = await drive(sim, run(sim, {}, goal(2, FLOOR, 0)));
    expect(beside.reason).toBe('unsafe');
    const listed = await drive(sim, run(sim, { goals: [goal(4, FLOOR, 0), goal(8, FLOOR, 3)] }));
    expect(listed.ok).toBe(true);
    expect(listed.text).toContain('(8,64,3)');
  });

  it('keeps out of water unless it is allowed to swim', async () => {
    // A river three wide across the whole ground, its surface level with the ground, four deep.
    const river = over(flat, box('water', 2, 4, FLOOR - 4, FLOOR - 1, -R - 1, R + 1));
    const dry = makeSim(river);
    const refused = await drive(dry, run(dry, {}));
    expect(refused.reason).toBe('dead_end');
    expect(dry.bot.entity.position.x).toBeLessThan(2);
    const wet = makeSim(river);
    const swum = await drive(wet, run(wet, { waterOk: true }));
    expect(swum.ok).toBe(true);
    expect(Math.floor(wet.bot.entity.position.x)).toBe(8);
  });
});

describe('go: what belongs to someone', () => {
  // A wall of planks three thick across a ground 30 round: nowhere in it is further than 40 from a villager standing at its middle.
  const planks: Ground = (x, y, z) => (Math.abs(x) > 30 || Math.abs(z) > 30 ? null : x >= 3 && x <= 5 && y >= FLOOR && y <= FLOOR + 3 ? 'oak_planks' : y < FLOOR ? 'stone' : 'air');

  it('digs planks that are only planks, and leaves them alone beside a villager (a village house)', async () => {
    const lone = makeSim(planks);
    const dug = await drive(lone, run(lone, { canDig: ['wood'] }));
    expect(dug.ok).toBe(true);
    expect(counts(dug)!.dug).toBeGreaterThanOrEqual(5);
    const village = makeSim(planks);
    village.bot.entities[5] = { id: 5, name: 'villager', type: 'passive', position: new Vec3(4.5, FLOOR, 0.5), metadata: [], height: 1.95, width: 0.6 };
    const left = await drive(village, run(village, { canDig: ['wood'] }));
    expect(left.reason).toBe('dead_end');
    expect(village.bot.dugBlocks).toEqual([]);
  });
});

describe('go: the places that hurt', () => {
  it('knows lava, fire, magma, cactus, berry bushes and wither roses as places not to stand in, and the places beside the first, the magma and the cactus', () => {
    const things = new Map<string, string>([['3,64,0', 'cactus'], ['6,64,0', 'sweet_berry_bush'], ['8,64,0', 'wither_rose'], ['10,64,0', 'fire'], ['12,63,0', 'magma_block'],
      ['14,64,0', 'lava'], ['16,66,0', 'lava'], ['20,64,0', 'magma_block']]);
    const sim = makeSim((x, y, z) => things.get(`${x},${y},${z}`) ?? flat(x, y, z));
    const why = (x: number, y = FLOOR, z = 0) => hazardAtFeet(sim.bot, x, y, z);
    expect(why(3)).toContain('cactus の中');
    expect(why(2)).toContain('cactus の隣');
    expect(why(6)).toContain('sweet_berry_bush');
    expect(why(8)).toContain('wither_rose');
    expect(why(10)).toContain('fire');
    expect(why(12)).toContain('magma_block');
    expect(why(14)).toContain('lava');
    expect(why(13)).toContain('lava の隣');
    expect(why(16)).toContain('頭の上が溶岩');
    expect(why(21)).toContain('magma_block の隣');
    expect(why(30)).toBeNull();
  });
});

describe('go: its limits and its stops', () => {
  it('stops at its time (limit_time) and says how far it still was', async () => {
    const sim = makeSim(flat);
    const outcome = await drive(sim, run(sim, { seconds: 5 }, goal(38, FLOOR, 38)));
    expect(outcome.reason).toBe('limit_time');
    expect(outcome.text).toContain('go 止まった limit_time:');
    expect(outcome.text).toContain('5 秒');
    expect(sim.bot.entity.position.x).toBeGreaterThan(2);
    expect(sim.bot.entity.position.x).toBeLessThan(38);
  });

  it('walks as far as the ground is loaded toward a place that is not, then says not_loaded', async () => {
    const sim = makeSim(flat);
    const outcome = await drive(sim, run(sim, {}, goal(70, FLOOR, 0)));
    expect(outcome.reason).toBe('not_loaded');
    expect(outcome.text).toContain('go 止まった not_loaded:');
    expect(sim.bot.entity.position.x).toBeGreaterThan(30);
  });

  it('stops walking when the act stops it, and leaves nothing pressed', async () => {
    const sim = makeSim(flat);
    const controller = new AbortController();
    const walking = run(sim, {}, goal(38, FLOOR, 38), controller);
    walking.catch(() => undefined);
    let stoppedAt: number | null = null;
    let error: unknown = null;
    try { await drive(sim, walking, elapsed => { if (elapsed === 1500) { stoppedAt = sim.bot.entity.position.x; controller.abort('cancelled'); } }, 10_000); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(StepStopped);
    expect(stoppedAt).not.toBeNull();
    expect(Object.values(sim.bot.controlState).some(Boolean)).toBe(false);
    const where = sim.bot.entity.position.clone();
    for (let i = 0; i < 40; i++) { sim.tick(); await vi.advanceTimersByTimeAsync(50); }
    expect(sim.bot.entity.position.distanceTo(where)).toBeLessThan(0.6);   // it coasts a little and no more
    expect(sim.bot.pathfinder.goal).toBeNull();
  });
});

describe('go: a body that stands still', () => {
  it('mends it up to five times and then says stuck, with what was tried counted in the line', async () => {
    // A wall of blocks that the map does not know (the physics does): x=3, 2 high, across the whole ground.
    const ghost = (x: number, y: number) => (x === 3 && y >= FLOOR && y <= FLOOR + 1 ? 'stone' : undefined);
    const sim = makeSim(flat, { ghost });
    const outcome = await drive(sim, run(sim, { seconds: 120 }));
    expect(outcome.reason).toBe('stuck');
    expect(outcome.text).toContain('go 止まった stuck:');
    expect(outcome.text).toContain('3秒');
    expect(counts(outcome)!.redraws).toBeGreaterThanOrEqual(5);
    expect(sim.bot.entity.position.x).toBeLessThan(3);
    expect(Object.values(sim.bot.controlState).some(Boolean)).toBe(false);
  });
});

describe('go: a route the executor cannot carry out (run 40: 217 to 436 redraws in 34 to 54 s)', () => {
  it('gives the way up after a few redraws that made no headway, and says stuck at once with the count', async () => {
    // A wall to dig through, and a body whose every dig is refused (as a stale motor port refused it): the executor draws the way again and again.
    const sim = makeSim(over(flat, box('stone', 3, 3, FLOOR, FLOOR + 3, -30, 30)), { items: stacks(PICK) });
    (sim.bot as any).dig = async () => { throw new Error('Motor owner expired'); };
    const began = Date.now();
    const outcome = await drive(sim, run(sim, { canDig: ['stone'], seconds: 120 }));
    const seconds = (Date.now() - began) / 1000;
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('stuck');
    expect(outcome.text).toContain('引き直しても');
    expect(counts(outcome)!.redraws).toBeLessThanOrEqual(30);
    expect(seconds).toBeLessThan(25);
    expect(Object.values(sim.bot.controlState).some(Boolean)).toBe(false);
  });
});

describe('go: the arguments and the estimate', () => {
  it('checks the fields as the head does', () => {
    const ok = { do: 'go', to: goal(1, 2, 3) };
    expect(goProblem(ok)).toBeNull();
    expect(goProblem({ do: 'go' })).toContain('to か goals');
    expect(goProblem({ ...ok, goals: [goal(1, 2, 3), goal(2, 2, 3)] })).toContain('to か goals');
    expect(goProblem({ do: 'go', goals: [goal(1, 2, 3)] })).toContain('goals は 2〜8');
    expect(goProblem({ do: 'go', goals: Array.from({ length: 9 }, (_, i) => goal(i, 0, 0)) })).toContain('goals は 2〜8');
    expect(goProblem({ ...ok, range: 5 })).toContain('range は 0〜4');
    expect(goProblem({ ...ok, seconds: 4 })).toContain('seconds は 5〜120');
    expect(goProblem({ ...ok, seconds: 120, maxDrop: 10, maxDig: 200, maxPlace: 100, range: 4 })).toBeNull();
    expect(goProblem({ ...ok, maxDrop: 11 })).toContain('maxDrop');
    expect(goProblem({ ...ok, maxDig: 1.5 })).toContain('maxDig');
    expect(goProblem({ ...ok, canDig: [] })).toContain('canDig は 1〜12');
    expect(goProblem({ ...ok, canDig: Array.from({ length: 13 }, () => 'stone') })).toContain('canDig は 1〜12');
    expect(goProblem({ ...ok, canPlace: ['Cobble'] })).toContain('canPlace');
    expect(goProblem({ ...ok, canPlace: Array.from({ length: 7 }, () => 'dirt') })).toContain('canPlace は 1〜6');
    expect(goProblem({ ...ok, canDig: ['stone', 'dirt'], canPlace: ['cobblestone'] })).toBeNull();
  });

  it('reads the words stone, dirt, sand and wood, and keeps to the blocks held that stay where they are put', () => {
    const sim = makeSim(flat, { items: stacks(COBBLE(3), { name: 'sand', count: 4 }, { name: 'dirt', count: 2 }) });
    const rule = digRuleOf(sim.bot.registry, ['stone', 'dirt', 'sand', 'wood']);
    for (const name of ['stone', 'cobbled_deepslate', 'netherrack', 'grass_block', 'gravel', 'oak_log', 'oak_planks']) expect(rule.names.has(name)).toBe(true);
    expect(rule.names.has('oak_door')).toBe(false);
    const place = placeNamesOf(sim.bot, ['dirt', 'sand', 'cobblestone', 'netherrack', 'tnt']);
    expect(place.held).toEqual(['dirt', 'cobblestone']);
    expect(place.missing).toEqual(['netherrack']);
    expect(place.refused).toEqual(['sand', 'tnt']);
  });

  it('estimates itself as the contract does: distance over 4 s, dug 0.7 s, laid 0.5 s, at most `seconds`', () => {
    expect(goMilliseconds(40, 0, 0)).toBe(10_000);
    expect(goMilliseconds(40, 10, 4)).toBe(19_000);
    expect(goMilliseconds(400, 0, 0, 45)).toBe(45_000);
  });
});
