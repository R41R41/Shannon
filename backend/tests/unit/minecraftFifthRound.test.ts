import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { describe, expect, it, vi } from 'vitest';
import { activeActionCapabilities, executeAction } from '../../src/services/minebot/execution/ActionExecution.js';
import { floorConfig } from '../../src/services/minebot/utils/floorConfig.js';
import { ESCAPE_SKILLS, fleeHeading, fleeHeadingPlan, fleeHeadingSafe, fleeStart, floorEatChoice, installFloorReflexes, runLowHealthFlee, type FloorBody, type FloorState } from '../../src/services/minebot/utils/floorReflexes.js';
import { ensureReflexLedger } from '../../src/services/minebot/utils/reflexLedger.js';
import { beginEngagement } from '../../src/services/minebot/utils/engagement.js';

// P8 fifth review: M1 (a meal never cuts the API's escape), M2 (steps and slopes), L1 (walled-off enemies), L2 (valuable food), L3 (the avoid set),
// L4 (heading hysteresis), L6 (top-up and the control loop's lease).

// ---- terrain -------------------------------------------------------------------------------------------------------------------------
type Block = { name: string; boundingBox: string; shapes?: number[][] };
const AIR: Block = { name: 'air', boundingBox: 'empty' };
const stone: Block = { name: 'stone', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] };
/** Stone up to `height(x, z)` (inclusive), air above; `patch` for single cells. */
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
const state = (patch: Partial<FloorState> = {}): FloorState => ({ retreat: { engaged: false, ticks: 0, cooldown: 0, engagements: 0 }, busy: null, retryAt: 0, engagements: { eat: 0, armor: 0 }, fleeStarts: [], ...patch });
const settle = (ms = 15) => new Promise(resolve => setTimeout(resolve, ms));
const tick = (bot: EventEmitter) => bot.emit('physicsTick');
const facing = (yaw: number) => ({ x: -Math.sin(yaw), z: -Math.cos(yaw) });
const WEST = Math.PI / 2; // facing -x: away from a threat at +x
const bread = { name: 'bread' };
/** Waits (at most ms) for a condition that is expected to come true; returns whether it did. Fixed sleeps made timer-bound tests flaky under load. */
async function within(ms: number, check: () => boolean): Promise<boolean> {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await settle(3);
  return check();
}
/** Waits until the command is the one running on the body (a fixed sleep let the tick come before the command had begun, or after it had ended, on a loaded machine). */
async function running(bot: object, skill: string): Promise<void> {
  expect(await within(3000, () => activeActionCapabilities(bot).includes(skill)), `${skill} is running`).toBe(true);
}

// ---- M1 ------------------------------------------------------------------------------------------------------------------------------
describe('M1: a meal does not cut the API\'s own escape and shelter commands (default mode), except to save a starving body', () => {
  /** A command running on the body for 150 ms; a tick; the command's outcome and whether the floor ate. */
  async function run(mode: 'default' | 'floor', skill: string, health: number, food: number, zombieX = 7, extra: Record<string, unknown> = {}) {
    const { bot } = fixture(heights(() => 64), { health, food, inventory: { items: () => [bread], slots: new Array(46).fill(null) }, ...extra });
    bot.entities[2].position = new Vec3(zombieX, 65, 0.5);
    installFloorReflexes(bot, floorConfig(mode === 'floor' ? { MINEBOT_FCA_REFLEXES: 'floor' } : {}), { fleeTickMs: 1 });
    const command = executeAction(bot, skill, 5000, () => new Promise(resolve => setTimeout(() => resolve({ success: true, result: 'ok' }), 150)), { priority: 0 });
    await running(bot, skill); tick(bot);
    const result: any = await command;
    const ate = await within(800, () => bot.consume.mock.calls.length > 0);
    return { cut: result.success === false, ate, flees: bot.floorReflexes.engagements.flee ?? 0 };
  }
  it('the reported case: a zombie at 7 m, health 5, food 19: flee-from, dig-shelter and build-around-self all run to the end (default), as in floor', async () => {
    for (const skill of ESCAPE_SKILLS) {
      expect(await run('default', skill, 5, 19), `default ${skill}`).toEqual({ cut: false, ate: false, flees: 0 });
      expect(await run('floor', skill, 5, 19), `floor ${skill}`).toEqual({ cut: false, ate: false, flees: 0 });
    }
  });
  it('health 5 with real hunger (food 10): still no cut of an escape skill in default; any other command is cut for the meal as before', async () => {
    for (const skill of ESCAPE_SKILLS) expect(await run('default', skill, 5, 10), skill).toEqual({ cut: false, ate: false, flees: 0 });
    // (with the enemy out of the flee's range, so that it is the meal that cuts)
    expect(await run('default', 'move-to', 5, 10, 30)).toMatchObject({ cut: true, ate: true });
    expect(await run('default', 'mine-block', 5, 17, 30)).toMatchObject({ cut: true, ate: true });
  });
  it('starving (food 3 or less): the meal cuts even an escape skill, the one documented exception', async () => {
    for (const skill of ESCAPE_SKILLS) expect(await run('default', skill, 20, 3, 30), skill).toMatchObject({ cut: true, ate: true });
    expect(await run('default', 'flee-from', 20, 3, 30)).toMatchObject({ cut: true, ate: true });
    // Food 4: not yet.
    expect(await run('default', 'flee-from', 20, 4, 30)).toMatchObject({ cut: false, ate: false });
  });
  it('`floor` mode is the production floor: it still cuts flee-from at health 5 and food 10', async () => {
    expect(await run('floor', 'flee-from', 5, 10)).toMatchObject({ cut: true, ate: true });
  });
  it('an arrow step-aside does not cut an escape skill in default; a lit creeper\'s retreat still cuts one, except flee-from (run 17)', async () => {
    const arrow = async (mode: 'default' | 'floor') => {
      const { bot } = fixture(heights(() => 64), { health: 20 });
      bot.entities = { 3: { id: 3, name: 'arrow', position: new Vec3(8, 66, 0.5), velocity: new Vec3(-2, 0, 0) } };
      installFloorReflexes(bot, floorConfig(mode === 'floor' ? { MINEBOT_FCA_REFLEXES: 'floor' } : {}));
      const command = executeAction(bot, 'flee-from', 5000, () => new Promise(resolve => setTimeout(() => resolve({ success: true, result: 'ok' }), 200)), { priority: 0 });
      await running(bot, 'flee-from'); tick(bot);
      bot.entities[3].position = new Vec3(6, 66, 0.5); tick(bot);
      const result: any = await command;
      return result.success === false;
    };
    expect(await arrow('default')).toBe(false);
    expect(await arrow('floor')).toBe(true);
    // A fight of the planner's choosing is not cut by an arrow's step aside either (engagement, told under common FCA since run 18);
    // the same fight with no engagement told is (the step aside takes the body).
    // Only a fight against archers (or whatever is hostile): a fight with a zombie still steps out of a skeleton's arrow.
    const fight = async (engaged: boolean | string[]) => {
      const { bot } = fixture(heights(() => 64), { health: 20 });
      bot.entities = { 3: { id: 3, name: 'arrow', position: new Vec3(8, 66, 0.5), velocity: new Vec3(-2, 0, 0) } };
      installFloorReflexes(bot, floorConfig({}));
      const end = engaged ? beginEngagement(bot, engaged === true ? ['skeleton'] : engaged) : () => {};
      const command = executeAction(bot, 'attack-continuously', 5000, () => new Promise(resolve => setTimeout(() => resolve({ success: true, result: 'ok' }), 200)), { priority: 0 });
      await running(bot, 'attack-continuously'); tick(bot);
      bot.entities[3].position = new Vec3(6, 66, 0.5); tick(bot);
      const result: any = await command;
      end();
      return result.success === false;
    };
    expect(await fight(true)).toBe(false);
    expect(await fight(false)).toBe(true);
    expect(await fight(['*'])).toBe(false);
    expect(await fight(['zombie'])).toBe(true);
    expect(await fight(['blaze'])).toBe(true);     // shoots, but not arrows
    expect(await fight(['stray'])).toBe(false);
    const lit: unknown[] = []; lit[16] = 1;
    const creeperNear = (straightRun: boolean) => {
      const { bot } = fixture(heights(() => 64), { health: 20 });
      bot.entities = { 3: { id: 3, name: 'creeper', position: new Vec3(3, 65, 0.5), metadata: lit } };
      installFloorReflexes(bot, floorConfig({}));
      (bot as any).fleeStraightRun = straightRun;
      return bot;
    };
    const cut = async (bot: any, skill: string) => {
      const command = executeAction(bot, skill, 5000, () => new Promise(resolve => setTimeout(() => resolve({ success: true, result: 'ok' }), 200)), { priority: 0 });
      await running(bot, skill); tick(bot);
      return ((await command) as any).success === false;
    };
    // flee-from's straight run away from it is not cut: a one-second step that cuts it off hands the body back standing (run 17).
    expect(await cut(creeperNear(true), 'flee-from')).toBe(false);
    // Its route search afterwards is: stuck there, the step back is the last thing between the body and the blast.
    expect(await cut(creeperNear(false), 'flee-from')).toBe(true);
    // Any other escape (a shelter being dug) is still cut: an explosion is a second away.
    expect(await cut(creeperNear(false), 'dig-shelter')).toBe(true);
  });
  it('health 6 or less at food 18 or 19 is no meal at all (the body regenerates there; run 16 change); at food 17 or less it is critical', () => {
    const idle = (health: number, food: number) => floorEatChoice({ ...fixture(flat()).bot, health, food, entities: {}, inventory: { items: () => [bread], slots: [] } })?.name ?? null;
    expect(idle(5, 19)).toBeNull();
    expect(idle(5, 18)).toBeNull();
    expect(idle(5, 17)).toBe('bread');
    expect(idle(20, 19)).toBeNull();
  });
});

// ---- L1, L2, L6 ----------------------------------------------------------------------------------------------------------------------
describe('eating: a walled-off enemy does not stop a meal (L1), valuable food is not a top-up (L2), the control loop\'s lease holds a top-up back (L6)', () => {
  const eater = (items: Array<{ name: string }>, patch: Record<string, unknown> = {}) => fixture(flat(), { health: 20, food: 10, entities: {}, inventory: { items: () => items, slots: new Array(46).fill(null) }, ...patch }).bot;
  it('L1: an enemy within 5 m behind rock is not near; one in the open is; `floor` keeps the production list (it does not look at walls)', () => {
    const sealed = fixture(() => stone, { health: 20, food: 3, inventory: { items: () => [bread], slots: new Array(46).fill(null) } }).bot;
    sealed.entities = { 2: { id: 2, name: 'zombie', position: new Vec3(3.5, 65, 0.5) } };
    expect(floorEatChoice(sealed)?.name).toBe('bread');
    expect(floorEatChoice(sealed, false)).toBeNull();
    const open = fixture(flat(), { health: 20, food: 3, inventory: { items: () => [bread], slots: new Array(46).fill(null) } }).bot;
    open.entities = { 2: { id: 2, name: 'zombie', position: new Vec3(3.5, 65, 0.5) } };
    expect(floorEatChoice(open)).toBeNull();
  });
});

// ---- M2 ------------------------------------------------------------------------------------------------------------------------------
describe('M2: the flee climbs a block, runs slopes of one block per block, and still refuses a real drop', () => {
  const at = (heightHere: number) => new Vec3(0.5, heightHere + 1, 0.5);
  const check = (height: (x: number, z: number) => number, patch?: (x: number, y: number, z: number) => Block | undefined) => {
    const { bot } = fixture(heights(height, patch), {}, at(height(0, 0)));
    return { bot, safe: fleeHeadingSafe(bot, bot.entity.position, WEST), plan: fleeHeadingPlan(bot, new Vec3(2.5, bot.entity.position.y, 0.5)) };
  };
  it('a one-block step: safe, and the plan says jump (straight away, not a detour)', () => {
    const { safe, plan, bot } = check(x => x <= -1 ? 65 : 64);
    expect(safe).toBe(true);
    expect(plan?.jump).toBe(true); expect(facing(plan!.yaw).x).toBeCloseTo(-1, 6);
    expect(fleeStart(bot, state(), Date.now())).not.toBeNull();
  });
  it('a one-block step two cells ahead is a jump too; level ground is not', () => {
    expect(check(x => x <= -2 ? 65 : 64).plan?.jump).toBe(true);
    expect(check(() => 64).plan?.jump).toBe(false);
    expect(check(x => x <= -4 ? 65 : 64).plan?.jump).toBe(false); // too far ahead to jump yet
  });
  it('a two-block wall is a wall; so is a one-block step with a block over it, or with a ceiling that leaves no room to rise', () => {
    expect(check(x => x <= -1 ? 66 : 64).safe).toBe(false);
    expect(check(x => x <= -1 ? 65 : 64, (x, y) => x === -1 && y === 67 ? stone : undefined).safe).toBe(false);     // a ceiling over the target
    expect(check(x => x <= -1 ? 65 : 64, (x, y) => x === 0 && y === 67 ? stone : undefined).safe).toBe(false);      // a ceiling over the take-off
    expect(check(x => x <= -1 ? 65 : 64, (x, y) => x === -1 && y === 68 ? stone : undefined).safe).toBe(true);      // high enough
  });
  it('a slope up of one block per block is open ground for the whole look-ahead', () => {
    const { safe, plan } = check(x => x < 0 ? 64 - x : 64);
    expect(safe).toBe(true); expect(plan?.jump).toBe(true);
  });
  it('a slope down of one block per block (five blocks in five) is open ground, and so is one of a block and a half; steps of two are not (P8 sixth review, M2); a single drop of four is not, and three is', () => {
    expect(check(x => x < 0 ? 64 + x : 64).safe).toBe(true);
    expect(check(x => x < 0 ? 64 + Math.ceil(1.5 * x) : 64).safe).toBe(true);   // 1.5 : 1 (drops of 1 and 2, three in two cells)
    // Two per block: a running body clears a step in one stride and comes down on the one after (open-loop physics: six blocks), so it is refused.
    expect(check(x => x < 0 ? 64 + 2 * x : 64).safe).toBe(false);
    expect(check(x => x <= -1 ? 61 : 64).safe).toBe(true);                  // a drop of three
    expect(check(x => x <= -1 ? 60 : 64).safe).toBe(false);                 // a drop of four
    expect(check(x => x <= -3 ? 60 : 64).safe).toBe(false);
  });
  it('a slope down that ends in lava, or at a drop of four, is refused', () => {
    const lava: Block = { name: 'lava', boundingBox: 'empty' };
    expect(check(x => x < 0 ? Math.max(60, 64 + x) : 64, (x, y) => x <= -4 && y <= 61 ? lava : undefined).safe).toBe(false);
    expect(check(x => x < 0 ? (x >= -2 ? 64 + x : 55) : 64).safe).toBe(false);
  });
  it('up then down (a hill) is run over', () => {
    expect(check(x => x === -1 ? 65 : x === -2 ? 66 : x === -3 ? 65 : x === -4 ? 64 : x < -4 ? 63 : 64).safe).toBe(true);
  });
  it('a staircase of stair blocks going up, and one going down, is run (each stair is two half steps, no jump)', () => {
    const stairs: Block = { name: 'oak_stairs', boundingBox: 'block', shapes: [[0, 0, 0, 1, 0.5, 1], [0, 0.5, 0, 0.5, 1, 1]] };
    for (const rising of [true, false]) {
      // Column k (x = -k) has stone below a stair block that is k higher (rising) or lower (falling) than the level stone at x >= 0.
      const world = (position: Vec3): Block => {
        const x = Math.floor(position.x), y = Math.floor(position.y);
        if (x >= 0) return y <= 64 ? stone : AIR;
        const top = 64 + (rising ? -x : x);
        return y < top ? stone : y === top ? stairs : AIR;
      };
      const bot = fixture(world, {}, new Vec3(0.5, 65, 0.5)).bot;
      expect(fleeHeadingSafe(bot, bot.entity.position, WEST), rising ? 'up' : 'down').toBe(true);
      expect(fleeHeadingPlan(bot, new Vec3(2.5, 65, 0.5))?.jump, rising ? 'up' : 'down').toBe(false);
    }
  });
  it('the step down is judged in the cell\'s own column: a drop of four is refused even where the exact position would read another block', () => {
    // A world that reads the position unfloored (as a careless fixture does) must not fool the walk: the cell decides.
    const careless = fixture((position: Vec3) => ((position.z <= -2 && position.y > 60) ? AIR : (position.y <= 64 ? stone : AIR)), {}, new Vec3(0.5, 65, 0.5)).bot;
    expect(fleeHeadingSafe(careless, careless.entity.position, 0)).toBe(false);
  });
  // A diagonal mining shaft in solid rock: three free cells above each step's floor (a body that must jump has to be able to rise).
  const shaft = (rising: boolean, free: number) => {
    const floorOf = (k: number) => 63 + (rising ? k : -k);
    return (position: Vec3): Block => {
      const x = Math.floor(position.x), y = Math.floor(position.y), z = Math.floor(position.z);
      if (z === 0 && x <= 0 && x >= -8) { const f = floorOf(-x); if (y > f && y <= f + free) return AIR; }
      return y <= 100 ? stone : AIR;
    };
  };
  it('a stair-mine shaft going up (a block per block, three high) is run; two high leaves no room to jump, and is refused as the pathfinder refuses it', () => {
    const open = fixture(shaft(true, 3), {}, new Vec3(0.5, 64, 0.5)).bot;
    expect(fleeHeadingSafe(open, open.entity.position, WEST)).toBe(true);
    expect(fleeHeadingPlan(open, new Vec3(2.5, 64, 0.5))?.jump).toBe(true);
    const low = fixture(shaft(true, 2), {}, new Vec3(0.5, 64, 0.5)).bot;
    expect(fleeHeadingSafe(low, low.entity.position, WEST)).toBe(false);
  });
  it('a stair-mine shaft going down is run', () => {
    for (const free of [2, 3]) {
      const bot = fixture(shaft(false, free), {}, new Vec3(0.5, 64, 0.5)).bot;
      // Two high: the body cannot walk into the next column at its own height (the ceiling steps down only a block later), so that one is not run.
      expect(fleeHeadingSafe(bot, bot.entity.position, WEST), `free ${free}`).toBe(free === 3);
    }
  });
  it('a half block is still a step, not a jump; and the old hazards are still refused after a climb (lava beyond the step)', () => {
    const lava: Block = { name: 'lava', boundingBox: 'empty' };
    expect(check(x => x <= -1 ? 65 : 64, (x, y) => x === -3 && y === 66 ? lava : undefined).safe).toBe(false);
    expect(check(() => 64, (x, y) => x === -1 && y === 65 ? { name: 'oak_slab', boundingBox: 'block', shapes: [[0, 0, 0, 1, 0.5, 1]] } : undefined).plan?.jump).toBe(false);
  });
  it('mid-jump (the feet above the ground) the step is still read as a step', () => {
    const { bot } = fixture(heights(x => x <= -1 ? 65 : 64), {}, new Vec3(0.5, 65.3, 0.5));
    bot.entity.onGround = false;
    expect(fleeHeadingSafe(bot, bot.entity.position, WEST)).toBe(true);
  });
  it('the run presses jump at a step and lets it go on level ground', async () => {
    const stepWorld = fixture(heights(x => x <= -1 ? 65 : 64), {}, new Vec3(0.5, 65, 0.5));
    await runLowHealthFlee(stepWorld.bot, { ...stepWorld.bot } as any, 1);
    expect(stepWorld.calls.some(([key, value]) => key === 'jump' && value === true)).toBe(true);
    const level = fixture(heights(() => 64), {}, new Vec3(0.5, 65, 0.5));
    await runLowHealthFlee(level.bot, { ...level.bot } as any, 1);
    expect(level.calls.filter(([key, value]) => key === 'jump' && value === true)).toEqual([]);
    expect(level.calls.some(([key, value]) => key === 'forward' && value === true)).toBe(true);
  });
  it('the whole reflex climbs a step: the flee starts and presses jump', async () => {
    const { bot, calls } = fixture(heights(x => x <= -1 ? 65 : 64));
    installFloorReflexes(bot, floorConfig({}), { fleeTickMs: 1 });
    tick(bot);
    expect(bot.floorReflexes.busy).toBe('flee');
    await vi.waitFor(() => expect(bot.floorReflexes.busy).toBeNull(), { timeout: 5000 });
    expect(calls.some(([key, value]) => key === 'jump' && value === true)).toBe(true);
  });
});

// ---- L3 ------------------------------------------------------------------------------------------------------------------------------
describe('L3: portals, traps and a stalagmite are not run into', () => {
  const ahead = (name: string, y = 65, boundingBox = 'empty') => (x: number, cy: number) => x === -1 && cy === y ? { name, boundingBox } : undefined;
  it.each(['end_portal', 'end_gateway', 'nether_portal', 'tripwire', 'stone_pressure_plate', 'oak_pressure_plate', 'light_weighted_pressure_plate', 'heavy_weighted_pressure_plate', 'polished_blackstone_pressure_plate'])('%s in the way refuses that heading, and another is taken', name => {
    const { bot } = fixture(flat((x, y) => ahead(name)(x, y)), {}, new Vec3(0.5, 65, 0.5));
    expect(fleeHeadingSafe(bot, bot.entity.position, WEST), name).toBe(false);
    const yaw = fleeHeading(bot, new Vec3(2.5, 65, 0.5));
    expect(yaw).not.toBeNull(); expect(facing(yaw!).x).toBeGreaterThan(-0.8);
  });
  it('a pointed dripstone to land on (a step down onto it) is refused, as is a floor of it; a plain step down is not', () => {
    const drip: Block = { name: 'pointed_dripstone', boundingBox: 'block', shapes: [[0.2, 0, 0.2, 0.8, 1, 0.8]] };
    // x = -1 is one lower, with a stalagmite as its floor.
    const landing = fixture(heights(x => x <= -1 ? 63 : 64, (x, y) => x <= -1 && y === 63 ? drip : undefined), {}, new Vec3(0.5, 65, 0.5)).bot;
    expect(fleeHeadingSafe(landing, landing.entity.position, WEST)).toBe(false);
    // Two lower: lands on it through the air.
    const far = fixture(heights(x => x <= -1 ? 62 : 64, (x, y) => x <= -1 && y === 62 ? drip : undefined), {}, new Vec3(0.5, 65, 0.5)).bot;
    expect(fleeHeadingSafe(far, far.entity.position, WEST)).toBe(false);
    const plain = fixture(heights(x => x <= -1 ? 62 : 64), {}, new Vec3(0.5, 65, 0.5)).bot;
    expect(fleeHeadingSafe(plain, plain.entity.position, WEST)).toBe(true);
  });
});

// ---- L4 ------------------------------------------------------------------------------------------------------------------------------
describe('L4: with several threats the last heading is kept while it is still safe and within 45 degrees of the new push', () => {
  const threats = [new Vec3(3.5, 65, 0.5), new Vec3(0.5, 65, 3.5)];
  const DIAGONAL = Math.PI / 4;  // facing (-0.707, -0.707): away from both
  const bot = () => fixture(flat(), {}, new Vec3(0.5, 65, 0.5)).bot;
  it('keeps a previous heading 30 degrees off, and takes the new push when the previous is further off or not given', () => {
    const b = bot();
    expect(fleeHeading(b, threats)).toBeCloseTo(DIAGONAL, 6);
    expect(fleeHeading(b, threats, DIAGONAL + 0.5)).toBeCloseTo(DIAGONAL + 0.5, 12);
    expect(fleeHeading(b, threats, DIAGONAL - 0.5)).toBeCloseTo(DIAGONAL - 0.5, 12);
    expect(fleeHeading(b, threats, DIAGONAL + 1.2)).toBeCloseTo(DIAGONAL, 6);
    expect(fleeHeading(b, threats, DIAGONAL + 2 * Math.PI + 0.3)).toBeCloseTo(DIAGONAL + 2 * Math.PI + 0.3, 9);
  });
  it('lets go of it when it is no longer safe, or runs toward a threat', () => {
    const walled = fixture(flat((x, y, z) => x === -1 && z === 0 && y >= 65 && y <= 66 ? stone : undefined), {}, new Vec3(0.5, 65, 0.5)).bot;
    // Previous = straight west (facing -x), 45 degrees off; a wall at x -1 on the row z 0 makes it unsafe.
    const kept = fleeHeading(walled, threats, WEST);
    expect(kept === WEST).toBe(false);
    const toward = fleeHeading(bot(), [new Vec3(3.5, 65, 0.5), new Vec3(-2.5, 65, 1.5)], Math.PI / 2 + 0.2);
    expect(toward).not.toBeNull();
  });
  it('a single threat always gets the straight-away heading (no hold)', () => {
    const b = bot();
    expect(fleeHeading(b, new Vec3(3.5, 65, 0.5), WEST + 0.5)).toBeCloseTo(WEST, 6);
  });
  it('the run remembers the heading from one tick to the next and from one segment to the next', async () => {
    const { bot: runner } = fixture(flat(), {}, new Vec3(0.5, 65, 0.5));
    runner.entities = { 2: { id: 2, name: 'zombie', position: new Vec3(3.5, 65, 0.5) }, 3: { id: 3, name: 'zombie', position: new Vec3(0.5, 65, 3.5) } };
    const memory: { heading?: number } = { heading: DIAGONAL + 0.4 };
    await runLowHealthFlee(runner, { ...runner } as any, 1, memory);
    expect(runner.look.mock.calls[0][0]).toBeCloseTo(DIAGONAL + 0.4, 12);
    expect(memory.heading).toBeCloseTo(DIAGONAL + 0.4, 12);
    const fresh = fixture(flat(), {}, new Vec3(0.5, 65, 0.5)).bot;
    fresh.entities = runner.entities;
    await runLowHealthFlee(fresh, { ...fresh } as any, 1, {});
    expect(fresh.look.mock.calls[0][0]).toBeCloseTo(DIAGONAL, 6);
  });
});
