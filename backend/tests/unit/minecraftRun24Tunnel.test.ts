import { describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import pathfinder from 'mineflayer-pathfinder';

// Run 24 (2026-10-21, the Minebot run that reached the Nether at 1,435 s): fixes of the tunnel walks.
//   - the cells the body walks through rock are kept for the way back whoever dug them (stair-mine, mine-block...), not by the tunnel walk alone;
//   - a goal with no height (a sheep to within six blocks) is walked to the ground of its column by the rock walk;
//   - gravel over a cell that is dug is dug out as it falls, not a reason to stop; a trail goes on after a step down.

const sim = vi.hoisted(() => ({ tick: (_ms: number) => {}, dig: async (_position: { x: number; y: number; z: number }) => {} }));
vi.mock('../../src/services/minebot/execution/observedWait.js', async (original) => ({
  ...(await original() as object), actionDelay: vi.fn(async (_bot: unknown, ms: number) => { sim.tick(ms); }),
}));
vi.mock('../../src/services/minebot/utils/digBlockVerified.js', () => ({ digBlockVerified: vi.fn(async (_bot: unknown, block: any) => sim.dig(block.position)) }));
vi.mock('../../src/services/minebot/utils/toolChoice.js', () => ({ chooseTool: () => null }));
// buildMovements needs a real bot's version and registry; the profile it was asked for is what matters here.
vi.mock('../../src/services/minebot/utils/setMovements.js', () => ({ buildMovements: (_bot: unknown, ...profile: unknown[]) => ({ profile }) }));

const { goals } = pathfinder;
const { TrailRecorder, trailCellsOpen } = await import('../../src/services/minebot/utils/trailRecorder.js');
const { trailOf } = await import('../../src/services/minebot/utils/stairLine.js');
const { chooseRockTravel, standingHeightAt } = await import('../../src/services/minebot/utils/rockTravel.js');
const { walkCells, stopKey } = await import('../../src/services/minebot/utils/tunnelWalk.js');

type Rule = (x: number, y: number, z: number) => string | null;
const SOLID_NOT = new Set(['air', 'water', 'lava', 'cave_air']);
const key = (x: number, y: number, z: number) => `${x},${y},${z}`;

/** A world from a rule that can be changed: `set` overrides a cell, the rule gives the rest (null: not loaded). */
function liveWorld(rule: Rule, at = new Vec3(0.5, 90, 0.5)) {
  const set = new Map<string, string>();
  const name = (x: number, y: number, z: number) => set.get(key(x, y, z)) ?? rule(x, y, z);
  const blockAt = (p: Vec3) => {
    const q = p.floored();
    const n = name(q.x, q.y, q.z);
    return n === null ? null : {
      name: n, position: q, diggable: n !== 'bedrock', boundingBox: SOLID_NOT.has(n) ? 'empty' : 'block',
      harvestTools: undefined, digTime: () => 400,
    };
  };
  const controls: Record<string, boolean> = {};
  const bot: any = {
    entity: { position: at, onGround: true, effects: {}, yaw: 0 },
    inventory: { items: () => [{ type: 7, name: 'iron_pickaxe', slot: 36, maxDurability: 250, durabilityUsed: 0 }] },
    heldItem: { type: 7, slot: 36, name: 'iron_pickaxe' },
    blockAt, equip: vi.fn(async () => {}),
    look: vi.fn(async (yaw: number) => { bot.entity.yaw = yaw; }),
    setControlState: (control: string, state: boolean) => { controls[control] = state; },
  };
  const solid = (x: number, y: number, z: number) => { const n = name(x, y, z); return n !== null && !SOLID_NOT.has(n); };
  const empty = (x: number, y: number, z: number) => { const n = name(x, y, z); return n !== null && SOLID_NOT.has(n); };
  /** Gravel and sand come down until something holds them. */
  const settle = (x: number, z: number, from: number) => {
    for (let y = from; y < from + 12; y++) {
      const n = name(x, y, z);
      if (n !== 'gravel') continue;
      let to = y;
      while (empty(x, to - 1, z)) to--;
      if (to !== y) { set.set(key(x, y, z), 'air'); set.set(key(x, to, z), 'gravel'); }
    }
  };
  sim.dig = async (p) => { set.set(key(p.x, p.y, p.z), 'air'); settle(p.x, p.z, p.y); };
  /** The body walks at four blocks a second along its look, climbs one block when it jumps, and falls to the ground. */
  sim.tick = (ms: number) => {
    for (let t = 0; t < ms / 50; t++) {
      const p = bot.entity.position;
      let nx = p.x, nz = p.z;
      if (controls.forward) { nx += -Math.sin(bot.entity.yaw) * 0.2; nz += -Math.cos(bot.entity.yaw) * 0.2; }
      const cx = Math.floor(nx), cz = Math.floor(nz), fy = Math.floor(p.y);
      let landed: number | null = null;
      for (let y = fy + (controls.jump ? 1 : 0); y >= fy - 3; y--) {
        if (empty(cx, y, cz) && empty(cx, y + 1, cz) && solid(cx, y - 1, cz)) { landed = y; break; }
      }
      if (landed !== null) bot.entity.position = new Vec3(nx, landed, nz);
      bot.entity.onGround = true;
    }
  };
  return { bot, set, name };
}

/** Open air over a stone floor (y 89). */
const hall = (extra: Rule = () => null): Rule => (x, y, z) => extra(x, y, z) ?? (y <= 89 ? 'stone' : 'air');
const steps = (...cells: Array<[number, number, number]>) => cells.map(([x, y, z]) => new Vec3(x, y, z));

describe('the way back is kept whatever dug the way there (run 24: 42 blocks cut again for 15 m, 46.7 s; by the trail 5 s)', () => {
  /** A tunnel 1x2 along x from 0 to 6 at y 90, in rock. */
  const tunnel: Rule = (x, y, z) => (z === 0 && x >= 0 && x <= 6 && (y === 90 || y === 91) ? 'air' : y <= 89 || y >= 92 || z !== 0 || x < 0 || x > 6 ? 'stone' : 'stone');

  it('a walk down a tunnel by any means writes its cells to the trail, and the trail leads back', () => {
    const { bot } = liveWorld(tunnel);
    const recorder = new TrailRecorder(bot);
    for (let x = 0; x <= 6; x++) { bot.entity.position = new Vec3(x + 0.5, 90, 0.5); recorder.observe(); }
    const back = trailOf(bot).route(new Vec3(6, 90, 0), cell => cell.x === 0);
    expect(back).not.toBeNull();
    expect(back).toHaveLength(6);
    expect(back!.at(-1)).toMatchObject({ x: 0, y: 90, z: 0 });
  });

  it('the way back is chosen as the trail, digging nothing, for a body that was only walked (no tunnel walk)', () => {
    const { bot } = liveWorld(tunnel);
    const recorder = new TrailRecorder(bot);
    for (let x = 0; x <= 6; x++) { bot.entity.position = new Vec3(x + 0.5, 90, 0.5); recorder.observe(); }
    const out = chooseRockTravel(bot, new goals.GoalNear(0, 90, 0, 1) as any);
    expect(out).toMatchObject({ mode: 'cells', source: 'trail', digs: 0 });
  });

  it('a walk over open ground leaves nothing (the memory is for tunnels, stairs and shafts)', () => {
    const { bot } = liveWorld(hall());
    const recorder = new TrailRecorder(bot);
    for (let x = 0; x <= 20; x++) { bot.entity.position = new Vec3(x + 0.5, 90, 0.5); recorder.observe(); }
    expect(trailOf(bot).size).toBe(0);
  });

  it('a jump is not a place stood in, and a teleport is not a step', () => {
    const { bot } = liveWorld(tunnel);
    const recorder = new TrailRecorder(bot);
    bot.entity.position = new Vec3(0.5, 90, 0.5); recorder.observe();
    bot.entity.onGround = false; bot.entity.position = new Vec3(1.5, 91, 0.5);
    expect(recorder.observe()).toBe(false);
    bot.entity.onGround = true; bot.entity.position = new Vec3(5.5, 90, 0.5);
    expect(recorder.observe()).toBe(false);
  });

  it('is walked only while its cells are open: a liquid in one, or the way filled in, and the trail is not taken', () => {
    const { bot, set } = liveWorld(tunnel);
    const cells = steps([1, 90, 0], [2, 90, 0], [3, 90, 0]);
    expect(trailCellsOpen(bot, cells)).toBe(true);
    set.set('2,90,0', 'lava');
    expect(trailCellsOpen(bot, cells)).toBe(false);
    set.set('2,90,0', 'air');
    for (const x of [1, 2, 3]) { set.set(key(x, 90, 0), 'stone'); set.set(key(x, 91, 0), 'stone'); }
    expect(trailCellsOpen(bot, cells)).toBe(false);
  });
});

describe('a goal with no height is walked to the ground of its column (run 24: 36 m to a sheep went the old legs, 24 s)', () => {
  const noPath = { getPathFromTo: () => ({ next: () => ({ value: { result: { status: 'noPath', path: [] } } }) }), movements: undefined };

  it('finds where a body stands in a column, nearest to its own level, and none in water or solid rock', () => {
    const { bot } = liveWorld(hall());
    expect(standingHeightAt(bot, 5, 5, 90)).toBe(90);
    const hill = liveWorld((x, y) => (y <= 93 ? 'stone' : 'air'));
    expect(standingHeightAt(hill.bot, 2, 2, 90)).toBe(94);
    expect(standingHeightAt(liveWorld(() => 'stone').bot, 2, 2, 90)).toBeNull();
    expect(standingHeightAt(liveWorld((x, y) => (y <= 89 ? 'stone' : y <= 91 ? 'water' : 'air')).bot, 2, 2, 90)).toBeNull();
    expect(standingHeightAt(liveWorld(() => null).bot, 2, 2, 90)).toBeNull();
  });

  it('chooses the rock walk for an XZ goal behind a wall, as it does for a goal with a height', () => {
    const wall: Rule = hall((x, y) => (x >= 3 && x <= 4 && y <= 92 && y >= 90 ? 'stone' : null));
    const world = liveWorld(wall);
    world.bot.pathfinder = noPath;
    const choice = chooseRockTravel(world.bot, new goals.GoalNearXZ(8, 0, 1) as any);
    expect(choice.mode).toBe('cells');
    if (choice.mode !== 'cells') return;
    expect(choice.source).toBe('tunnel');
    expect(choice.cells.at(-1)).toMatchObject({ x: 8, y: 90, z: 0 });
  });

  it('but a column that is not loaded or has no ground is left to the route search as before', () => {
    const { bot } = liveWorld(() => 'stone');
    expect(chooseRockTravel(bot, new goals.GoalNearXZ(24, 0, 2) as any)).toMatchObject({ mode: 'default', why: 'no_height' });
  });
});

describe('the tunnel walk goes through gravel and goes on after a step down (run 24)', () => {
  it('gravel over a cell that is dug comes down and is dug out again: the walk is not stopped at falling_above', async () => {
    // a wall at x 2 (feet and head), gravel on top of it
    const { bot, name } = liveWorld(hall((x, y, z) => (x === 2 && z === 0 && (y === 90 || y === 91) ? 'stone' : x === 2 && z === 0 && y >= 92 && y <= 93 ? 'gravel' : null)));
    const outcome = await walkCells(bot, steps([1, 90, 0], [2, 90, 0], [3, 90, 0]), { isEnd: feet => feet.x === 3, deadline: Date.now() + 60_000 });
    expect(outcome).toMatchObject({ stopped: 'reached' });
    expect(Math.floor(bot.entity.position.x)).toBe(3);
    expect(name(2, 90, 0)).toBe('air');
    expect(name(2, 91, 0)).toBe('air');
  });

  it('a stop says which cell it could not pass, and a stop is the same stop when the cell and the reason are the same', async () => {
    const { bot } = liveWorld(hall((x, y, z) => (x === 2 && z === 1 && y === 90 ? 'water' : x === 2 && z === 0 && (y === 90 || y === 91) ? 'stone' : null)));
    const outcome = await walkCells(bot, steps([1, 90, 0], [2, 90, 0], [3, 90, 0]), { isEnd: feet => feet.x === 3, deadline: Date.now() + 60_000 });
    expect(outcome.stopped).toBe('blocked');
    expect(outcome.reason).toMatch(/^liquid_beside:water/);
    expect(outcome.at).toMatchObject({ x: 2, y: 90, z: 0 });
    const again = { ...outcome, steps: 9 };
    expect(stopKey(again, new Vec3(1, 90, 0))).toBe(stopKey(outcome, new Vec3(1, 90, 0)));
    expect(stopKey({ ...outcome, reason: 'lava_beside:lava(2,90,0)' }, new Vec3(1, 90, 0))).not.toBe(stopKey(outcome, new Vec3(1, 90, 0)));
  });

  /** A level run along x at y 90 with the floor missing at x 3 (the ground is a block lower there). */
  const ledge = hall((x, y, z) => (z === 0 && x === 3 && y === 89 ? 'air' : null));
  const run = steps([1, 90, 0], [2, 90, 0], [3, 90, 0], [4, 90, 0], [5, 90, 0]);

  it('a tunnel cut now is planned again after a step down it did not plan', async () => {
    const { bot } = liveWorld(ledge);
    const outcome = await walkCells(bot, run, { isEnd: feet => feet.x === 5, deadline: Date.now() + 60_000 });
    expect(outcome).toMatchObject({ stopped: 'off_line', reason: 'drop' });
    expect(Math.floor(bot.entity.position.y)).toBe(89);
  });

  it('a trail goes on from where the body landed, up the step to the next cell of it', async () => {
    const { bot } = liveWorld(ledge);
    const outcome = await walkCells(bot, run, { isEnd: feet => feet.x === 5, deadline: Date.now() + 60_000, onDrop: 'continue' });
    expect(outcome.stopped).toBe('reached');
    expect(Math.floor(bot.entity.position.x)).toBe(5);
    expect(Math.floor(bot.entity.position.y)).toBe(90);
  });
});
