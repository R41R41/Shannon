import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { describe, expect, it, vi } from 'vitest';
import { ESCAPE_SKILLS, fleeHeadingPlan, fleeHeadingSafe, fleeKeys, runLowHealthFlee, type FloorBody } from '../../src/services/minebot/utils/floorReflexes.js';
import { ensureReflexLedger } from '../../src/services/minebot/utils/reflexLedger.js';

// P8 sixth review (re-review of 16f57b8): M1 (the block a jump lands on), M2 (steps of two blocks), L1 (water), L2 (the cells a jump reaches),
// L3 (the back of a stair), and the cells a run touches beside its line. The physics (prismarine-physics) side is minecraftFleePhysics.test.ts.

// ---- terrain -------------------------------------------------------------------------------------------------------------------------
type Block = { name: string; boundingBox: string; shapes?: number[][] };
const AIR: Block = { name: 'air', boundingBox: 'empty' };
const WATER: Block = { name: 'water', boundingBox: 'empty' };
const full = (name: string): Block => ({ name, boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] });
const stone = full('stone');
/** Solid up to `height(x, z)` (inclusive), air above; `patch` for single cells. Cells are read by floor, as mineflayer does. */
const heights = (height: (x: number, z: number) => number, patch?: (x: number, y: number, z: number) => Block | undefined) => (position: Vec3): Block => {
  const x = Math.floor(position.x), y = Math.floor(position.y), z = Math.floor(position.z);
  return patch?.(x, y, z) ?? (y <= height(x, z) ? stone : AIR);
};
const flat = (patch?: (x: number, y: number, z: number) => Block | undefined) => heights(() => 64, patch);

function fixture(blockAt: (position: Vec3) => Block, patch: Record<string, unknown> = {}, at = new Vec3(0.5, 65, 0.5)) {
  const calls: Array<[string, unknown]> = [];
  const bot: any = Object.assign(new EventEmitter(), { entity: { id: 1, name: 'player', position: at, yaw: 0, pitch: 0, onGround: true },
    health: 5, food: 20, game: { dimension: 'overworld' }, entities: { 2: { id: 2, name: 'zombie', position: new Vec3(at.x + 2, at.y, at.z) } } as Record<string, any>,
    inventory: { items: () => [] as any[], slots: new Array(46).fill(null) }, controlState: {} as Record<string, boolean>, executingSkill: false, interruptExecution: false,
    clearControlStates: vi.fn(), setControlState: vi.fn((key: string, value: boolean) => { calls.push([key, value]); }), look: vi.fn(async () => {}),
    equip: vi.fn(async () => {}), consume: vi.fn(async () => {}), blockAt, ...patch });
  return { bot: bot as FloorBody & any, calls, ledger: ensureReflexLedger(bot) };
}
const facing = (yaw: number) => ({ x: -Math.sin(yaw), z: -Math.cos(yaw) });
const WEST = Math.PI / 2; // facing -x: away from a threat at +x
const NORTH_WEST_THREAT = new Vec3(2.5, 65, 0.5);
const safeWest = (bot: any) => fleeHeadingSafe(bot, bot.entity.position, WEST);
/** The plan from a threat at +x; it never runs west into what was refused. */
const planFrom = (bot: any) => fleeHeadingPlan(bot, new Vec3(bot.entity.position.x + 2, bot.entity.position.y, bot.entity.position.z));

// ---- M1, L2 --------------------------------------------------------------------------------------------------------------------------
describe('M1: a jump up lands ON a block, and the block it lands on must not hurt', () => {
  /** A one-block step west onto a single tile of `name` (x = -1), and stone beyond it at the same height: the block it lands on is the only thing to see. */
  const stepOf = (name: string) => fixture(flat((x, y) => (x === -1 && y === 65 ? full(name) : x <= -2 && y === 65 ? stone : undefined))).bot;
  const HURTS = ['magma_block', 'campfire', 'soul_campfire', 'cactus', 'sweet_berry_bush', 'powder_snow', 'wither_rose', 'pointed_dripstone', 'fire', 'soul_fire', 'lava',
    'cobweb', 'nether_portal', 'end_portal', 'tripwire', 'stone_pressure_plate'];
  it.each(HURTS)('a one-block step onto a tile of %s is not jumped onto', name => {
    const bot = stepOf(name);
    expect(safeWest(bot), name).toBe(false);
    const plan = planFrom(bot);
    // Another way (or none): never west onto it, and never with a jump toward it.
    if (plan !== null) { expect(facing(plan.yaw).x, name).toBeGreaterThan(-0.8); expect(plan.jump, name).toBe(false); }
  });
  it.each(['stone', 'dirt', 'ice', 'glass', 'oak_planks', 'soul_sand', 'honey_block', 'slime_block', 'bedrock'])('a one-block step onto a tile of %s is still jumped onto', name => {
    const bot = stepOf(name);
    expect(safeWest(bot), name).toBe(true);
    const plan = planFrom(bot);
    expect(plan?.jump, name).toBe(true); expect(facing(plan!.yaw).x, name).toBeCloseTo(-1, 6);
  });
  it('a single magma tile in a stone plateau (the one block to climb is the magma), and one two cells ahead, are not run onto', () => {
    expect(safeWest(fixture(flat((x, y) => (x === -1 && y === 65 ? full('magma_block') : x <= -2 && y === 65 ? stone : undefined))).bot)).toBe(false);
    expect(safeWest(fixture(flat((x, y) => (x === -2 && y === 65 ? full('magma_block') : x <= -3 && y === 65 ? stone : x === -1 && y === 65 ? stone : undefined))).bot)).toBe(false);
  });
  it('fire on the block it climbs onto, and lava, fire, a web or powder snow in the cells its head passes after the jump (L2), are refused; a free column is not', () => {
    const step = (patch: (x: number, y: number) => Block | undefined) => fixture(flat((x, y) => (x <= -1 && y === 65 ? stone : x === -1 ? patch(x, y) : undefined))).bot;
    expect(safeWest(step(() => undefined))).toBe(true);
    for (const name of ['fire', 'soul_fire', 'lava', 'cobweb', 'powder_snow', 'sweet_berry_bush']) {
      for (const y of [66, 67]) expect(safeWest(step((_x, cy) => (cy === y ? { name, boundingBox: 'empty' } : undefined))), `${name} at y ${y}`).toBe(false);
    }
  });
  it('the run does not press jump toward a refused step', async () => {
    const { bot, calls } = fixture(flat((x, y) => (x <= -1 && y === 65 ? full('magma_block') : undefined)));
    const runner = bot as FloorBody & any;
    await runLowHealthFlee(runner, { ...runner } as any, 1);
    expect(calls.some(([key, value]) => key === 'jump' && value === true)).toBe(false);
  });
});

// ---- M2 ------------------------------------------------------------------------------------------------------------------------------
describe('M2: a drop is judged from the highest floor of the two blocks before it, so steps of two blocks are refused and slopes are not', () => {
  const at = new Vec3(0.5, 65, 0.5);
  const down = (height: (x: number) => number) => fixture(heights(x => (x >= 0 ? 64 : height(x))), {}, at).bot;
  it('one block per block (1:1) and a block and a half (1.5:1) are run; two (2:1) and three (3:1) per block are refused', () => {
    expect(safeWest(down(x => 64 + x))).toBe(true);
    expect(safeWest(down(x => 64 + Math.ceil(1.5 * x)))).toBe(true);
    expect(safeWest(down(x => 64 + 2 * x))).toBe(false);
    expect(safeWest(down(x => 64 + 3 * x))).toBe(false);
  });
  it('terraces of two or three blocks, one cell wide, are refused as steeply as the slopes (open-loop they fell six and twelve)', () => {
    expect(safeWest(down(x => 64 + 2 * x))).toBe(false);
    expect(safeWest(down(x => 64 - 3 * Math.min(-x, 3)))).toBe(false);
    // A flat stretch of two in between lets the body land first.
    expect(safeWest(down(x => (x >= -2 ? 62 : x >= -4 ? 60 : 58)))).toBe(true);
  });
  it('a drop of three is run, one of four is not, and two of three one after the other are not (6 in the two cells), with a flat stretch of 3 between them they are', () => {
    expect(safeWest(down(x => 61))).toBe(true);
    expect(safeWest(down(x => 60))).toBe(false);
    expect(safeWest(down(x => (x >= -1 ? 61 : 58)))).toBe(false);
    expect(safeWest(down(x => (x >= -3 ? 61 : 58)))).toBe(true);
  });
  it('the climb of a jump is judged from the top of its arc: a step up of one block whose plateau ends in a drop of three is refused, a plain drop of three is run, a long plateau is run', () => {
    const plateau = (end: number | null, drop: number) => fixture(heights(x => (x >= 0 ? 64 : end !== null && x < end ? 65 - drop : 65)), {}, at).bot;
    expect(safeWest(plateau(null, 0))).toBe(true);           // the step and then level ground
    expect(safeWest(plateau(-3, 3))).toBe(false);            // up one, level for two cells, then down three: the flight can end there
    expect(safeWest(plateau(-3, 2))).toBe(true);
    expect(safeWest(down(x => 61))).toBe(true);              // no jump: a drop of three
  });
  it('a slope of one block per block going up and then down (a hill) is still run over', () => {
    expect(safeWest(down(x => (x === -1 ? 65 : x === -2 ? 66 : x === -3 ? 65 : x === -4 ? 64 : 63)))).toBe(true);
  });
});

// ---- the cells the line crosses and the body beside it --------------------------------------------------------------------------------
describe('every cell the heading crosses is read, and so are the ones beside it that the body\'s width reaches', () => {
  const lava: Block = { name: 'lava', boundingBox: 'empty' };
  it('a diagonal heading does not step over a cell with lava or magma in it', () => {
    // Heading 45 degrees (toward -x, -z) from the middle of a cell: the line crosses (-1,0)/(0,-1) before it reaches (-1,-1).
    const bot = fixture(flat((x, y, z) => (x === -2 && z === -1 && y === 64 ? full('magma_block') : x === -1 && z === -1 && y === 65 ? lava : undefined))).bot;
    expect(fleeHeadingSafe(bot, bot.entity.position, Math.PI / 4)).toBe(false);
  });
  it('lava one cell beside the line is refused when the body would brush it, and not when the line keeps 0.4 blocks of it', () => {
    const beside = (z: number) => fixture(flat((x, y, cz) => (cz === -1 && x <= -2 && y === 64 ? lava : undefined)), {}, new Vec3(0.5, 65, z)).bot;
    // Running west along z = 0.5 with lava at z cell -1 (z < 0): the body (z from 0.2 to 0.8) stays off it; at z = 0.2 it brushes it.
    expect(safeWest(beside(0.5))).toBe(true);
    expect(safeWest(beside(0.2))).toBe(false);
  });
});

// ---- L3 ------------------------------------------------------------------------------------------------------------------------------
describe('L3: the back of a stair is a block to jump, its front is a step', () => {
  const stairs = (shapes: number[][], extra?: (x: number, y: number) => Block | undefined) =>
    fixture(flat((x, y) => (x === -1 && y === 65 ? { name: 'oak_stairs', boundingBox: 'block', shapes } : extra?.(x, y)))).bot;
  const FRONT = [[0, 0, 0, 1, 0.5, 1], [0, 0.5, 0, 0.5, 1, 1]];  // the high half is on the far side from a body coming from +x
  const BACK = [[0, 0, 0, 1, 0.5, 1], [0.5, 0.5, 0, 1, 1, 1]];   // the high half is on the near side
  const SIDE = [[0, 0, 0, 1, 0.5, 1], [0, 0.5, 0, 1, 1, 0.5]];    // the high half runs along the heading
  const OVERHANG = [[0, 0.5, 0, 1, 1, 1], [0, 0, 0, 0.5, 0.5, 1]]; // an upside-down stair
  it('from the front it is walked up (no jump); from the back, or along the high half, it is jumped (and safe)', () => {
    const front = stairs(FRONT);
    expect(safeWest(front)).toBe(true); expect(planFrom(front)?.jump).toBe(false);
    for (const [label, shapes] of [['back', BACK], ['side', SIDE]] as const) {
      const bot = stairs(shapes);
      expect(safeWest(bot), label).toBe(true);
      const plan = planFrom(bot);
      expect(plan?.jump, label).toBe(true); expect(facing(plan!.yaw).x, label).toBeCloseTo(-1, 6);
    }
  });
  it('the back of a stair with a block over it (no room to rise), or an overhanging upside-down stair, is a wall', () => {
    expect(safeWest(stairs(BACK, (x, y) => (x === -1 && y === 67 ? stone : undefined)))).toBe(false);
    expect(safeWest(stairs(OVERHANG))).toBe(false);
  });
  it('a stair without shapes keeps being read by its low step (no jump), as before', () => {
    const bot = fixture(flat((x, y) => (x === -1 && y === 65 ? { name: 'oak_stairs', boundingBox: 'block' } : undefined))).bot;
    expect(safeWest(bot)).toBe(true); expect(planFrom(bot)?.jump).toBe(false);
  });
});

// ---- L1 ------------------------------------------------------------------------------------------------------------------------------
describe('L1: in water the jump key is the way onto a bank; in the air the heading is held; a jump waits for the body to run along its heading', () => {
  /** A lake (water up to y 64, its bottom at y 58) for x >= 0 and a bank of stone to y 64 (flush with the surface) or higher for x <= -1. */
  const lake = (bank: number) => (position: Vec3): Block => {
    const x = Math.floor(position.x), y = Math.floor(position.y);
    if (x <= -1) return y <= bank ? stone : AIR;
    return y <= 58 ? stone : y <= 64 ? WATER : AIR;
  };
  const swimmer = (bank: number, patch: Record<string, unknown> = {}) => {
    const { bot } = fixture(lake(bank), {}, new Vec3(0.5, 64.3, 0.5));
    Object.assign(bot.entity, { onGround: false, isInWater: true, ...patch });
    return bot;
  };
  const keys = (bot: any, memory: { heading?: number } = {}) => fleeKeys(bot, [new Vec3(bot.entity.position.x + 2, bot.entity.position.y, bot.entity.position.z)], memory);
  it('swimming toward a bank flush with the water: the plan climbs, and the key is pressed although the body is never on the ground', () => {
    const bot = swimmer(64);
    expect(planFrom(bot)?.jump).toBe(true);
    expect(keys(bot)).toMatchObject({ jump: true }); expect(facing(keys(bot)!.yaw).x).toBeCloseTo(-1, 6);
    // Out of the water, in the air (a ledge step), the same plan does not press it.
    const air = fixture(heights(x => (x <= -1 ? 65 : 64)), {}, new Vec3(0.5, 65, 0.5)).bot;
    air.entity.onGround = false;
    expect(keys(air, {})).toMatchObject({ jump: false });
  });
  it('a bank higher than the water\'s surface is a wall (the body does not go at it), as before', () => {
    const bot = swimmer(65);
    expect(safeWest(bot)).toBe(false);
    const plan = keys(bot);
    if (plan !== null) expect(facing(plan.yaw).x).toBeGreaterThan(-0.8);
  });
  it('the segment presses jump in the water and lets it go on land', async () => {
    const bot = swimmer(64);
    const writes: Array<[string, boolean]> = [];
    bot.setControlState = vi.fn((key: string, value: boolean) => { writes.push([key, value]); });
    await runLowHealthFlee(bot, { ...bot } as any, 1);
    expect(writes.some(([key, value]) => key === 'jump' && value === true)).toBe(true);
    expect([...writes].reverse().find(([key]) => key === 'jump')?.[1]).toBe(false);
  });
  it('in the air the heading of the take-off is held and the jump key is let go (the flight was judged for it), even where the ground below would refuse another', () => {
    // A body in the air at a rim: every heading from here is refused, and the last one is still kept.
    const rim = fixture(heights(x => (x >= 0 ? 64 : 20)), {}, new Vec3(0.5, 66, 0.5)).bot;
    rim.entity.onGround = false;
    const memory = { heading: 1.2 };
    expect(fleeKeys(rim, [new Vec3(2.5, 66, 0.5)], memory)).toEqual({ yaw: 1.2, jump: false });
    // On the ground it plans again: the held heading (toward the drop) is not kept, and the one taken is safe.
    rim.entity.onGround = true;
    const planned = fleeKeys(rim, [new Vec3(2.5, 66, 0.5)], { heading: 1.2 });
    expect(planned).not.toBeNull(); expect(Math.abs(planned!.yaw - 1.2)).toBeGreaterThan(0.3);
    expect(fleeHeadingSafe(rim, rim.entity.position, planned!.yaw)).toBe(true); expect(fleeHeadingSafe(rim, rim.entity.position, 1.2)).toBe(false);
    const level = fixture(flat(), {}, new Vec3(0.5, 65, 0.5)).bot;
    const next = { heading: 1.2 };
    expect(fleeKeys(level, [new Vec3(2.5, 65, 0.5)], next)!.yaw).toBeCloseTo(WEST, 6); expect(next.heading).toBeCloseTo(WEST, 6);
  });
  it('a jump is pressed from a standstill or when the body runs along the heading, not while it runs across it', () => {
    const step = () => fixture(heights(x => (x <= -1 ? 65 : 64)), {}, new Vec3(0.5, 65, 0.5)).bot;
    const withSpeed = (vx: number, vz: number) => { const bot = step(); bot.entity.velocity = new Vec3(vx, 0, vz); return keys(bot); };
    expect(keys(step())).toMatchObject({ jump: true });                      // no velocity known
    expect(withSpeed(0, 0)).toMatchObject({ jump: true });                    // standing
    expect(withSpeed(-0.28, 0)).toMatchObject({ jump: true });                // running west, the way it jumps
    expect(withSpeed(-0.25, 0.1)).toMatchObject({ jump: true });              // 22 degrees off
    expect(withSpeed(0, 0.28)).toMatchObject({ jump: false });                // running across it
    expect(withSpeed(0.28, 0)).toMatchObject({ jump: false });                // running the other way
    expect(withSpeed(-0.2, 0.2)).toMatchObject({ jump: false });              // 45 degrees off
  });
});

// ---- L4 ------------------------------------------------------------------------------------------------------------------------------
describe('L4: the commands that get the body out of danger are all protected', () => {
  it('leave-water, tower-up, climb-down and enter-portal are escape skills, with the API\'s flee and shelters; its fights are not', () => {
    for (const skill of ['flee-from', 'dig-shelter', 'build-around-self', 'leave-water', 'tower-up', 'climb-down', 'enter-portal']) expect(ESCAPE_SKILLS.has(skill), skill).toBe(true);
    for (const skill of ['attack-continuously', 'attack-nearest', 'retreat-attack', 'move-to', 'mine-block']) expect(ESCAPE_SKILLS.has(skill), skill).toBe(false);
  });
});
