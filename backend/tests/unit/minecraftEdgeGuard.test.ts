import { describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';
import blockLoader from 'prismarine-block';
import physicsPkg from 'prismarine-physics';

vi.mock('../../src/services/minebot/execution/ActionExecution.js', () => ({ activeActionCapabilities: () => ['flee-from'] }));

const { edgeRisk, installEdgeGuard, judgeAppliedTick, fallIsDangerous, refusedCellCost, REFUSED_CELL_COST, stepOffDrop } = await import('../../src/services/minebot/utils/edgeGuard.js');
const { describeRecentMotion } = await import('../../src/services/minebot/utils/motionRecorder.js');

const VERSION = '1.21.11';
const mcData = minecraftData(VERSION);
const Block = (blockLoader as any)(VERSION);
const { Physics, PlayerState } = physicsPkg as any;

/** A world of columns: `surface(x, z)` is the top solid block, `fluid` fills above it. */
function columnWorld(surface: (x: number, z: number) => number, fluid?: (x: number, z: number) => { name: 'water' | 'lava'; top: number } | null) {
  const getBlock = (pos: Vec3) => {
    const x = Math.floor(pos.x), y = Math.floor(pos.y), z = Math.floor(pos.z);
    const liquid = fluid?.(x, z);
    const name = y <= surface(x, z) ? 'stone' : liquid && y <= liquid.top ? liquid.name : 'air';
    const block = new Block(mcData.blocksByName[name].id, 0, 0);
    block.position = new Vec3(x, y, z);
    return block;
  };
  return { getBlock, blockAt: (pos: Vec3) => getBlock(pos) };
}

/**
 * A bot on real client physics, ticked the way mineflayer does: simulate, then
 * apply. The mover presses its keys from its own timer right before each tick,
 * after anything the guard released (the bypass a paid-run probe exposed).
 */
function run(world: ReturnType<typeof columnWorld>, start: Vec3, { ticks = 80, guard = true, health = 20, sprint = true, jump = false, yaw = 0, sneak = false } = {}) {
  const physics = Physics(mcData, world);
  const control: Record<string, boolean> = { forward: true, back: false, left: false, right: false, jump, sprint, sneak };
  const bot: any = {
    version: VERSION, health, jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0, inventory: { slots: [] },
    entity: { position: start, velocity: new Vec3(0, 0, 0), onGround: true, isInWater: false, isInLava: false, isInWeb: false,
      isCollidedHorizontally: false, isCollidedVertically: false, elytraFlying: false, yaw, pitch: 0, effects: {}, attributes: {} },
    physics, registry: mcData, controlState: control,
    pathfinder: { movements: { exclusionAreasStep: [] as any[] }, setMovements(m: any) { this.movements = m; } },
    blockAt: world.blockAt,
    getControlState: (name: string) => control[name],
    setControlState: (name: string, value: boolean) => { control[name] = value; },
  };
  if (guard) installEdgeGuard(bot);
  let lowest = start.y;
  for (let tick = 0; tick < ticks; tick++) {
    control.forward = true; control.sprint = sprint; control.jump = jump; control.sneak = sneak;
    physics.simulatePlayer(new PlayerState(bot, control), world).apply(bot);
    lowest = Math.min(lowest, bot.entity.position.y);
  }
  return { position: bot.entity.position, lowest, stops: bot.edgeGuard?.stops ?? 0, bot };
}

// Plateau at y=71 for z >= 0; beyond the rim (z < 0) a ravine floor at y=39.
const ravine = columnWorld((_x, z) => (z >= 0 ? 71 : 39));

describe('edge guard on real client physics (paid run L10 sprinted off a 32-block ravine rim while fleeing)', () => {
  it('the scenario is lethal without the guard', () => {
    const result = run(ravine, new Vec3(0.5, 72, 4.5), { guard: false });
    expect(result.lowest).toBeLessThan(45);
  });

  it('stops a sprinting bot at the rim, still standing on the plateau', () => {
    const result = run(ravine, new Vec3(0.5, 72, 4.5));
    expect(result.lowest).toBe(72);
    expect(result.stops).toBeGreaterThan(0);
    // Stopped with its centre still over the plateau: at least half the footprint on the ledge.
    expect(result.position.z).toBeGreaterThanOrEqual(0);
    expect(result.position.z).toBeLessThan(0.35);
  });

  it('tells the path planner which rim cells it refused, as a temporary cost (paid run L15 re-ran a rim route for a minute)', () => {
    const { bot } = run(ravine, new Vec3(0.5, 72, 4.5));
    const rim = { position: new Vec3(0, 72, 0) };
    const existing = bot.pathfinder.movements.exclusionAreasStep[0];
    expect(existing(rim)).toBe(REFUSED_CELL_COST);
    expect(existing({ position: new Vec3(0, 72, 3) })).toBe(0);
    const fresh = { exclusionAreasStep: [] as any[] };
    bot.pathfinder.setMovements(fresh);
    expect(fresh.exclusionAreasStep[0](rim)).toBe(REFUSED_CELL_COST);
    expect(refusedCellCost(bot.edgeGuard, rim, Date.now() + 121_000)).toBe(0);
  });

  it('lets a planned step down of a few blocks through', () => {
    const step = columnWorld((_x, z) => (z >= 0 ? 71 : 67));
    const result = run(step, new Vec3(0.5, 72, 4.5));
    expect(result.stops).toBe(0);
    expect(result.position.y).toBe(68);
  });

  it('lets a deep drop into water through, and refuses one onto lava', () => {
    const intoWater = columnWorld((_x, z) => (z >= 0 ? 71 : 39), (_x, z) => (z < 0 ? { name: 'water', top: 42 } : null));
    expect(run(intoWater, new Vec3(0.5, 72, 4.5)).stops).toBe(0);
    const intoLava = columnWorld((_x, z) => (z >= 0 ? 71 : 69), (_x, z) => (z < 0 ? { name: 'lava', top: 70 } : null));
    const lava = run(intoLava, new Vec3(0.5, 72, 4.5));
    expect(lava.stops).toBeGreaterThan(0);
    expect(lava.lowest).toBe(72);
  });

  it('refuses a sprint-jump whose arc comes down in the ravine', () => {
    expect(run(ravine, new Vec3(0.5, 72, 4.5), { jump: true, guard: false }).lowest).toBeLessThan(45);
    const result = run(ravine, new Vec3(0.5, 72, 4.5), { jump: true });
    expect(result.lowest).toBeGreaterThanOrEqual(72);
    expect(result.stops).toBeGreaterThan(0);
  });

  it('holds for any run-up, approach angle and gait (a live probe landed a jump past the rim)', () => {
    // The engine reports ground when an arc's vertical move lands at the old
    // footprint even though the horizontal move then carries it past the rim.
    const falls: string[] = [];
    for (let start = 1.5; start <= 5; start += 0.25) for (const yaw of [0, 0.6, -0.5]) for (const jump of [true, false]) {
      const result = run(ravine, new Vec3(0.5, 72, start), { ticks: 100, jump, yaw });
      if (result.lowest < 72) falls.push(`start=${start} yaw=${yaw} jump=${jump}`);
    }
    expect(falls).toEqual([]);
  });

  it('lets a sprint-jump across a deep one-wide crack land on the far side', () => {
    const crack = columnWorld((_x, z) => (z === 1 ? 30 : 71));
    const result = run(crack, new Vec3(0.5, 72, 3.5), { jump: true, ticks: 14 });
    expect(result.stops).toBe(0);
    expect(result.lowest).toBeGreaterThanOrEqual(72);
    expect(result.position.z).toBeLessThan(1);
  });

  it('does not take a sheet of water with a drop beneath it for a landing (paid run L19 fell through to lava)', () => {
    // Beyond the rim: one layer of water at y=60 hanging over a floor at y=39.
    const hanging = columnWorld((_x, z) => (z >= 0 ? 71 : 39));
    const withSheet = { getBlock: (pos: Vec3) => (Math.floor(pos.z) < 0 && Math.floor(pos.y) === 60
      ? Object.assign(new Block(mcData.blocksByName.water.id, 0, 0), { position: pos.floored() }) : hanging.getBlock(pos)),
      blockAt: (pos: Vec3) => withSheet.getBlock(pos) };
    expect(stepOffDrop(withSheet, 0.5, 72, -0.4)).toBe(20); // from the bottom of the water (60) to the floor top (40)
    const result = run(withSheet as any, new Vec3(0.5, 72, 4.5));
    expect(result.lowest).toBe(72);
    expect(result.stops).toBeGreaterThan(0);
    // Water resting on a floor still breaks the fall.
    const pool = columnWorld((_x, z) => (z >= 0 ? 71 : 39), (_x, z) => (z < 0 ? { name: 'water', top: 40 } : null));
    expect(stepOffDrop(pool, 0.5, 72, -0.4)).toBe(0);
  });

  it('does not walk into a one-wide shaft crossing the path', () => {
    const shaft = columnWorld((_x, z) => (z === 1 ? 50 : 71));
    const result = run(shaft, new Vec3(0.5, 72, 4.5), { sprint: false });
    expect(result.lowest).toBe(72);
    expect(result.stops).toBeGreaterThan(0);
  });
});

describe('edge guard thresholds', () => {
  it('scales the refused drop with health', () => {
    expect(fallIsDangerous(4, 20)).toBe(false);   // one point, the planner's own drop-down bound
    expect(fallIsDangerous(6, 20)).toBe(true);
    expect(fallIsDangerous(5, 2)).toBe(true);     // two points kill a bot at two health
    expect(fallIsDangerous(Infinity, 20)).toBe(true);
  });

  it('counts a footprint still overlapping the rim as supported', () => {
    expect(stepOffDrop(ravine, 0.5, 72, 0.2)).toBe(0);    // hitbox reaches back to z=0.5
    expect(stepOffDrop(ravine, 0.5, 72, -0.4)).toBe(32);
  });

  it('leaves a launch the bot did not make itself (knockback) alone', () => {
    const bot: any = { entity: { position: new Vec3(0.5, 72.4, -0.6), velocity: new Vec3(0, 0.3, -0.4), onGround: false },
      health: 20, blockAt: ravine.blockAt, getControlState: () => false, setControlState: vi.fn() };
    expect(judgeAppliedTick(bot, { position: new Vec3(0.5, 72, -0.2), onGround: true }, () => 32)).toBeNull();
    expect(bot.entity.position.z).toBe(-0.6);
  });

  it('keeps the centre of the body inland of a dangerous edge', () => {
    const bot: any = { entity: { position: new Vec3(0.5, 72, -0.12), velocity: new Vec3(0, -0.08, -0.28), onGround: true },
      health: 20, blockAt: ravine.blockAt, getControlState: (name: string) => name !== 'sneak', setControlState: vi.fn() };
    expect(judgeAppliedTick(bot, { position: new Vec3(0.5, 72, 0.16), onGround: true }, null)).toBe(32);
    expect(bot.entity.position.z).toBeGreaterThanOrEqual(0);
    expect(edgeRisk(ravine, 0.5, 72, bot.entity.position.z, 20)).toBeNull();
  });

  it('lets a diagonal step along a cliff sweep a corner over the drop (paid run L17 timed out at a rim)', () => {
    // Plateau for x <= 0 or z >= 1; the cell (x 1.., z ..0) is a ravine. Walking from (0.5, 0.5)
    // diagonally to (1.5, 1.5) passes the footprint's corner over the ravine cell at (1, 0).
    const corner = columnWorld((x, z) => (x <= 0 || z >= 1 ? 71 : 39));
    const bot: any = { entity: { position: new Vec3(0.9, 72, 0.9), velocity: new Vec3(0.15, -0.08, 0.15), onGround: true },
      health: 20, blockAt: corner.blockAt, getControlState: () => true, setControlState: vi.fn() };
    expect(judgeAppliedTick(bot, { position: new Vec3(0.75, 72, 0.75), onGround: true }, null)).toBeNull();
    expect(bot.entity.position.x).toBe(0.9);
  });

  it('from a footing already at the brink, refuses the step off but not the way back', () => {
    const back: any = { entity: { position: new Vec3(0.5, 72, 0.1), velocity: new Vec3(0, -0.08, 0.2), onGround: true },
      health: 20, blockAt: ravine.blockAt, getControlState: () => true, setControlState: vi.fn() };
    expect(judgeAppliedTick(back, { position: new Vec3(0.5, 72, -0.2), onGround: true }, null)).toBeNull();
    expect(back.entity.position.z).toBe(0.1);
  });

  it('lets a crouched body lean out over the drop to place a block, as far as its footprint stays on the ledge (paid run L50 never began its bridge)', () => {
    // The same step the centre rule refuses above, taken crouched: the path executor backs out over the
    // gap until its centre is above the cell it is about to fill.
    const leaning: any = { entity: { position: new Vec3(0.5, 72, -0.12), velocity: new Vec3(0, -0.08, -0.05), onGround: true },
      health: 20, blockAt: ravine.blockAt, getControlState: (name: string) => name === 'sneak' || name === 'back', setControlState: vi.fn() };
    expect(judgeAppliedTick(leaning, { position: new Vec3(0.5, 72, 0.05), onGround: true }, null)).toBeNull();
    expect(leaning.entity.position.z).toBe(-0.12);
    // Crouching does not excuse a tick that would take the whole footprint off the ledge.
    const off: any = { entity: { position: new Vec3(0.5, 72, -0.45), velocity: new Vec3(0, -0.08, -0.2), onGround: true },
      health: 20, blockAt: ravine.blockAt, getControlState: (name: string) => name === 'sneak' || name === 'back', setControlState: vi.fn() };
    expect(judgeAppliedTick(off, { position: new Vec3(0.5, 72, 0.05), onGround: true }, null)).toBe(32);
    expect(stepOffDrop(ravine, 0.5, 72, off.entity.position.z)).toBe(0);
    // On the real engine a crouched walk at the rim ends leaning out, never falling.
    const walked = run(ravine, new Vec3(0.5, 72, 2.5), { sneak: true, sprint: false, ticks: 200 });
    expect(walked.lowest).toBe(72);
    expect(walked.position.z).toBeLessThan(-0.1);
    expect(walked.position.z).toBeGreaterThanOrEqual(-0.3);
  });

  it('clips a walk-off back to the last supported point of the step', () => {
    const bot: any = { entity: { position: new Vec3(0.5, 72, -0.45), velocity: new Vec3(0, -0.08, -0.28), onGround: true },
      health: 20, blockAt: ravine.blockAt, getControlState: () => true, setControlState: vi.fn() };
    expect(judgeAppliedTick(bot, { position: new Vec3(0.5, 72, -0.17), onGround: true }, null)).toBe(32);
    expect(bot.entity.position.z).toBeGreaterThanOrEqual(-0.3);
    expect(stepOffDrop(ravine, bot.entity.position.x, 72, bot.entity.position.z)).toBe(0);
    expect(bot.entity.velocity.z).toBe(0);
  });
});

describe('a body standing in a stream is held at the rim like one on land (paid run L90: a current carried it over a 24-block ravine edge, no key pressed)', () => {
  // A shallow stream one block deep on the plateau (z >= 0), running to the rim; the ravine beyond.
  const stream = columnWorld((_x, z) => (z >= 0 ? 71 : 39), (_x, z) => (z >= 0 ? { name: 'water', top: 72 } : null));
  it('clips a tick the current carried over the drop while the body stood in the water', () => {
    const bot: any = { entity: { position: new Vec3(0.5, 72, -0.45), velocity: new Vec3(0, -0.02, -0.25), onGround: true, isInWater: true },
      health: 20, blockAt: stream.blockAt, getControlState: () => false, setControlState: vi.fn() };
    expect(judgeAppliedTick(bot, { position: new Vec3(0.5, 72, -0.2), onGround: true }, null)).toBe(32);
    expect(stepOffDrop(stream, bot.entity.position.x, 72, bot.entity.position.z)).toBe(0);
  });
  it('leaves a swimming body (no footing) to the swimming reflexes', () => {
    const bot: any = { entity: { position: new Vec3(0.5, 72.3, -0.45), velocity: new Vec3(0, 0, -0.25), onGround: false, isInWater: true },
      health: 20, blockAt: stream.blockAt, getControlState: () => false, setControlState: vi.fn() };
    expect(judgeAppliedTick(bot, { position: new Vec3(0.5, 72.3, -0.2), onGround: false }, null)).toBeNull();
    expect(bot.entity.position.z).toBe(-0.45);
  });
});

describe('pre-death motion summary for reflection', () => {
  const sample = (at: number, y: number, onGround: boolean, actions: string[], goal: string | null, controls: string[]) =>
    ({ at, x: 0, y, z: 0, vy: 0, onGround, health: 20, controls, goal, actions });

  it('names the fall and the mover that had the controls when the body left the ground', () => {
    const text = describeRecentMotion([
      sample(0, 72, true, [], 'GoalNearXZ', ['forward', 'sprint']),
      sample(250, 70, false, ['flee-from'], 'GoalNearXZ', []),
      sample(1500, 40, false, ['flee-from'], 'GoalNearXZ', []),
    ]);
    expect(text).toContain('約32ブロック降下');
    expect(text).toContain('反射的な移動');
    expect(text).toContain('forward+sprint');
    expect(text).not.toMatch(/x=|z=/);
  });
});

// Level ground at y=64; for z < 0 a sheet of lava one block deep lies on it, at the level of the feet (a lava flow
// beside the path, the edge of a pool: nothing to fall into, and lethal to walk into).
const lavaBeside = columnWorld(() => 64, (_x, z) => (z < 0 ? { name: 'lava', top: 65 } : null));

describe('a step of its own into lava at the level of the feet is taken back (paid run L77b walked into the side of a lava fall in the Nether)', () => {
  it('the scenario puts the body in lava without the guard', () => {
    const result = run(lavaBeside, new Vec3(0.5, 65, 3.5), { guard: false, ticks: 40 });
    expect(result.bot.entity.isInLava).toBe(true);
  });

  it('stops the body on dry ground, and marks the cell for the route planner', () => {
    let touched = false;
    const result = run(lavaBeside, new Vec3(0.5, 65, 3.5), { ticks: 60 });
    touched = result.bot.entity.isInLava === true;
    expect(touched).toBe(false);
    expect(result.stops).toBeGreaterThan(0);
    expect(result.position.z).toBeGreaterThan(0);
    expect(refusedCellCost(result.bot.edgeGuard, { position: { x: 0, y: 65, z: Math.floor(result.position.z) } })).toBe(REFUSED_CELL_COST);
  });

  it('leaves alone a body the lava came to, and one already in it', () => {
    const still: any = { entity: { position: new Vec3(0.5, 65, 0.5), velocity: new Vec3(0, 0, 0), onGround: true, isInLava: true },
      health: 20, blockAt: lavaBeside.blockAt, getControlState: () => false, setControlState: vi.fn() };
    expect(judgeAppliedTick(still, { position: new Vec3(0.5, 65, 0.5), onGround: true, inLava: false }, null)).toBeNull();
    const wading: any = { ...still, getControlState: (name: string) => name === 'forward' };
    expect(judgeAppliedTick(wading, { position: new Vec3(0.5, 65, -1.5), onGround: true, inLava: true }, null)).toBeNull();
  });
});
