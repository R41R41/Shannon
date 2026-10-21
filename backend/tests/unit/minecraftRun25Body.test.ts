import { describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import pathfinder from 'mineflayer-pathfinder';
import minecraftData from 'minecraft-data';

// Run 25 (2026-10-21, the Minebot run that did not reach the Nether in 1,800 s): body fixes.
//   - the body no longer keeps from digging beside water on its own (a shore is always beside water), and a stop says exactly what stopped it;
//   - the trail of tunnels cut holds legal steps only, and is not taken through a cell a walk stopped at twice;
//   - the flood fills of the threat judgement have a budget for all the mobs together;
//   - what the body threw away is remembered on the body, not on the port of one skill;
//   - a bed dug up after sleeping is picked up; the walk-only search is not asked again at once.

const sim = vi.hoisted(() => ({ tick: (_ms: number) => {}, dig: async (_position: { x: number; y: number; z: number }) => {} }));
vi.mock('../../src/services/minebot/execution/observedWait.js', async (original) => ({
  ...(await original() as object), actionDelay: vi.fn(async (_bot: unknown, ms: number) => { sim.tick(ms); }),
}));
vi.mock('../../src/services/minebot/utils/digBlockVerified.js', () => ({ digBlockVerified: vi.fn(async (_bot: unknown, block: any) => sim.dig(block.position)) }));
vi.mock('../../src/services/minebot/utils/toolChoice.js', () => ({ chooseTool: () => null }));
// buildMovements needs a real bot's version and registry; the profile it was asked for is what matters here.
vi.mock('../../src/services/minebot/utils/setMovements.js', () => ({ buildMovements: (_bot: unknown, ...profile: unknown[]) => ({ profile }) }));

const { goals } = pathfinder;
const { TrailRecorder } = await import('../../src/services/minebot/utils/trailRecorder.js');
const { trailOf, TunnelTrail } = await import('../../src/services/minebot/utils/stairLine.js');
const { chooseRockTravel } = await import('../../src/services/minebot/utils/rockTravel.js');
const { walkCells, digRefusalAt, explainRefusal, relativeTo } = await import('../../src/services/minebot/utils/tunnelWalk.js');
const { threatExposure, resetExposureBudget } = await import('../../src/services/minebot/utils/threatExposure.js');
const { noteSelfDropped, isSelfDropped, SELF_DROP_MS } = await import('../../src/services/minebot/utils/selfDropped.js');
const { createMotorPort } = await import('../../src/services/minebot/execution/ActionExecution.js');
const { default: StairMine } = await import('../../src/services/minebot/instantSkills/stairMine.js');
const { default: SleepInBed } = await import('../../src/services/minebot/instantSkills/sleepInBed.js');

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
  sim.dig = async (p) => { set.set(key(p.x, p.y, p.z), 'air'); };
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

const steps = (...cells: Array<[number, number, number]>) => cells.map(([x, y, z]) => new Vec3(x, y, z));
const noPath = { getPathFromTo: () => ({ next: () => ({ value: { result: { status: 'noPath', path: [] } } }) }), movements: undefined };

describe('a shore is reached through the rock beside the water (run 25: 7 shores not reached, 280 cells dug on the way round, two iron pickaxes used up)', () => {
  /** Rock all round, a pocket of air at the body, a pool of water at x 8-10 (y 89-92, z -2..2) with its source at its middle. */
  const pool: Rule = (x, y, z) => (x === 0 && z === 0 && (y === 90 || y === 91) ? 'air'
    : x >= 8 && x <= 10 && y >= 89 && y <= 92 && Math.abs(z) <= 2 ? 'water' : 'stone');

  it('digs the cell beside the water, where the stand for the bucket is, and leaves the water standing', async () => {
    const world = liveWorld(pool);
    world.bot.pathfinder = noPath;
    const goal = new goals.GoalBlock(7, 90, 0);
    const choice = chooseRockTravel(world.bot, goal as any);
    expect(choice.mode).toBe('cells');
    if (choice.mode !== 'cells') return;
    expect(choice.cells.at(-1)).toMatchObject({ x: 7, y: 90, z: 0 });
    const outcome = await walkCells(world.bot, choice.cells, { isEnd: feet => goal.isEnd(feet as never), deadline: Date.now() + 120_000 });
    expect(outcome).toMatchObject({ stopped: 'reached' });
    expect(world.name(7, 90, 0)).toBe('air');
    expect(world.name(8, 90, 0)).toBe('water');
  });

  it('goes on through rock with water over it the whole way (an aquifer layer over the tunnel)', async () => {
    const world = liveWorld((x, y, z) => (x === 0 && z === 0 && (y === 90 || y === 91) ? 'air' : y === 92 ? 'water' : 'stone'));
    world.bot.pathfinder = noPath;
    const goal = new goals.GoalBlock(12, 90, 0);
    const choice = chooseRockTravel(world.bot, goal as any);
    expect(choice).toMatchObject({ mode: 'cells', source: 'tunnel' });
    if (choice.mode !== 'cells') return;
    const outcome = await walkCells(world.bot, choice.cells, { isEnd: feet => goal.isEnd(feet as never), deadline: Date.now() + 120_000 });
    expect(outcome).toMatchObject({ stopped: 'reached' });
  });

  it('is still refused beside lava', () => {
    const world = liveWorld((x, y, z) => (x === 6 && y === 90 && z === 1 ? 'lava' : 'stone'));
    expect(digRefusalAt(world.bot, { x: 6, y: 90, z: 0 }, [])).toMatchObject({ reason: 'lava_beside:lava', at: { x: 6, y: 90, z: 1 } });
  });
});

describe('a stop says what stopped it: the block, its coordinates, and where it lies from the body', () => {
  it('names the lava, its cell and its place from the feet', async () => {
    const world = liveWorld((x, y, z) => (x === 2 && z === 1 && y === 90 ? 'lava' : x === 0 && z === 0 && (y === 90 || y === 91) ? 'air' : y === 89 || (x > 0 && y >= 90 && y <= 91 && z === 0) ? 'stone' : 'air'));
    const outcome = await walkCells(world.bot, steps([1, 90, 0], [2, 90, 0], [3, 90, 0]), { isEnd: feet => feet.x === 3, deadline: Date.now() + 60_000 });
    expect(outcome.stopped).toBe('blocked');
    expect(outcome.reason).toContain('lava_beside:lava(2,90,0)');
    expect(outcome.reason).toContain('(2,90,1)にlavaがある');
    expect(outcome.reason).toMatch(/自分から東1・南1/);
  });

  it('says where a missing floor is, what is there instead, and how far it lies', async () => {
    const world = liveWorld((x, y, z) => (x === 3 && y <= 89 && y >= 80 ? 'air' : y <= 89 ? 'stone' : 'air'));
    const outcome = await walkCells(world.bot, steps([1, 90, 0], [2, 90, 0], [3, 90, 0], [4, 90, 0]), { isEnd: feet => feet.x === 4, deadline: Date.now() + 60_000 });
    expect(outcome.stopped).toBe('blocked');
    expect(outcome.reason).toContain('足場がありません(3,89,0)');
    expect(outcome.reason).toContain('air');
    expect(outcome.reason).toMatch(/自分から東1・下1/);
  });

  it('words a refusal and a relative place', () => {
    const world = liveWorld(() => 'stone');
    expect(relativeTo({ x: 0, y: 70, z: 0 }, { x: 3, y: 69, z: -2 })).toBe('東3・下1・北2（約3.7m）');
    const text = explainRefusal(world.bot, { reason: 'protected:furnace', at: { x: 4, y: 70, z: 0 } }, { x: 4, y: 70, z: 0 }, { x: 1, y: 70, z: 0 });
    expect(text).toContain('(4,70,0)');
    expect(text).toContain('東3');
  });

  it('a stair that finds water it cannot shut off says which water, where, and why it could not be shut', async () => {
    const solid = { name: 'stone', boundingBox: 'block', diggable: true };
    const bot: any = { version: '1.21.11', interruptExecution: false, entity: { position: new Vec3(0.5, 44, 0.5), yaw: 0, onGround: true },
      inventory: { items: () => [{ name: 'stone_pickaxe', count: 1, maxDurability: 131, durabilityUsed: 0 }] },
      look: vi.fn(async () => {}), equip: async () => {}, setControlState: vi.fn(),
      blockAt: (pos: Vec3) => { const p = pos.floored();
        const air = p.x === 0 && p.z === 0 && (p.y === 44 || p.y === 45);
        return { ...(air ? { name: 'air', boundingBox: 'empty' } : p.x === 2 && p.y === 45 && p.z === 0 ? { name: 'water', boundingBox: 'empty' } : solid), position: p }; } };
    const skill: any = new StairMine(bot);
    const ok = await skill.digStairDown(new Vec3(0, 44, 0), new Vec3(1, 0, 0), 'cobblestone');
    expect(ok).toBe(false);
    expect(skill.lastStopReason).toContain('(2, 45, 0)');
    expect(skill.lastStopReason).toContain('water');
    expect(skill.lastStopReason).toMatch(/自分\(0, 44, 0\)から東2・上1/);
    expect(skill.lastStopReason).toContain('持っていない');
  });

  it('a stair at the edge of a cave says how far down the air goes, what ends it, and what the pack has to bridge with', () => {
    const bot: any = { version: '1.21.11', entity: { position: new Vec3(0.5, 44, 0.5) },
      inventory: { items: () => [{ name: 'cobblestone', count: 12 }] },
      blockAt: (pos: Vec3) => { const p = pos.floored(); return p.y <= 30 ? { name: 'stone', boundingBox: 'block', position: p } : { name: 'air', boundingBox: 'empty', position: p }; } };
    const skill: any = new StairMine(bot);
    expect(skill.describeDropBelow(new Vec3(1, 42, 0))).toContain('12マス先の(1, 30, 0)のstoneまで空いています');
    expect(skill.describeDropBelow(new Vec3(1, 42, 0))).toContain('3マスを超える');
    expect(skill.describeBridgeStock('cobblestone')).toContain('cobblestone×12');
    bot.blockAt = () => ({ name: 'air', boundingBox: 'empty', position: new Vec3(0, 0, 0) });
    expect(skill.describeDropBelow(new Vec3(1, 42, 0))).toContain('40マス下まで空いています');
  });
});

describe('the trail of tunnels holds legal steps only, and is not taken through a cell a walk stopped at (run 25: "not one step" seven times)', () => {
  const tunnel: Rule = (x, y, z) => (z === 0 && x >= 0 && x <= 6 && (y === 90 || y === 91) ? 'air' : 'stone');

  it('does not keep a fall of three as a way', () => {
    const trail = new TunnelTrail();
    trail.add({ x: 201, y: 48, z: 277 }, { x: 201, y: 45, z: 277 });
    expect(trail.size).toBe(0);
    trail.add({ x: 201, y: 48, z: 277 }, { x: 201, y: 47, z: 277 });
    trail.add({ x: 201, y: 47, z: 277 }, { x: 202, y: 46, z: 277 });
    trail.add({ x: 202, y: 46, z: 277 }, { x: 203, y: 46, z: 278 });   // a diagonal
    expect(trail.size).toBe(3);
    expect(trail.route({ x: 202, y: 46, z: 277 }, cell => cell.y === 48)).toHaveLength(2);
  });

  it('a body that dropped three cells does not leave the drop as a way back', () => {
    const { bot } = liveWorld((x, y, z) => (x === 0 && z === 0 && y >= 86 && y <= 91 ? 'air' : 'stone'));
    const recorder = new TrailRecorder(bot);
    bot.entity.position = new Vec3(0.5, 90, 0.5); recorder.observe();
    bot.entity.position = new Vec3(0.5, 87, 0.5); recorder.observe();
    expect(trailOf(bot).route(new Vec3(0, 87, 0), cell => cell.y === 90)).toBeNull();
  });

  it('the trail is passed over when it runs through a cell the walks avoid, and taken when it does not', () => {
    const { bot } = liveWorld(tunnel);
    const recorder = new TrailRecorder(bot);
    for (let x = 0; x <= 6; x++) { bot.entity.position = new Vec3(x + 0.5, 90, 0.5); recorder.observe(); }
    const goal = new goals.GoalNear(0, 90, 0, 1);
    expect(chooseRockTravel(bot, goal as any)).toMatchObject({ mode: 'cells', source: 'trail' });
    const avoided = chooseRockTravel(bot, goal as any, process.env, { avoid: new Set(['3,90,0']) });
    expect(avoided.mode === 'cells' && avoided.source === 'trail').toBe(false);
  });
});

describe('the walk-only search is not asked again at once for the same goal from the same cell (run 25: stops of 1.8 s, 0.4 s a search)', () => {
  it('asks the navigator once for two choices in a row', () => {
    const world = liveWorld((x, y, z) => (x === 0 && z === 0 && (y === 90 || y === 91) ? 'air' : 'stone'));
    const getPathFromTo = vi.fn(() => ({ next: () => ({ value: { result: { status: 'noPath', path: [] } } }) }));
    world.bot.pathfinder = { getPathFromTo, movements: undefined };
    const goal = new goals.GoalNear(24, 90, 0, 2);
    chooseRockTravel(world.bot, goal as any);
    chooseRockTravel(world.bot, goal as any);
    expect(getPathFromTo).toHaveBeenCalledTimes(1);
    world.bot.entity.position = new Vec3(0.5, 90, 4.5);
    chooseRockTravel(world.bot, new goals.GoalNear(24, 90, 0, 2) as any);
    expect(getPathFromTo).toHaveBeenCalledTimes(2);
  });
});

describe('the flood fills of the threat judgement are bounded for all the mobs together (run 25: stops of 1.6-3.5 s inside openWay)', () => {
  it('twenty hostiles behind a wall in a wide cave cost a few dozen ms of reads in all, not 15 ms each', () => {
    resetExposureBudget();
    let reads = 0;
    const burn = () => { const until = performance.now() + 0.004; while (performance.now() < until) { /* a slow read */ } };
    const bot: any = { entity: { position: new Vec3(0.5, 64, 0.5), height: 1.8 },
      blockAt: (position: Vec3) => { reads++; burn(); return position.x === 3 && Math.abs(position.z) <= 4 && position.y >= 63 && position.y <= 66 ? { boundingBox: 'block' } : { boundingBox: 'empty' }; } };
    const mobs = Array.from({ length: 20 }, (_, i) => ({ position: new Vec3(6.5, 64, -3.5 + (i % 8)), height: 1.8 }));
    const started = performance.now();
    const answers = mobs.map(mob => threatExposure(bot, mob, 1_000));
    const spent = performance.now() - started;
    expect(answers.every(answer => ['seen', 'reachable', 'sealed'].includes(answer))).toBe(true);
    // never 'sealed' for a mob that has open air all round it
    expect(answers).not.toContain('sealed');
    expect(spent).toBeLessThan(250);
    expect(reads).toBeLessThan(40_000);
  });
});

describe('what the body threw away is remembered on the body, whichever skill\'s port asks (run 25: the same heaps thrown and fetched back three times)', () => {
  it('a heap noted through one port is a heap of the body for another port and for the native body', () => {
    const native: any = { entities: {} };
    const writer = createMotorPort(native);
    const reader = createMotorPort(native);
    const heap = { id: 41, name: 'item' };
    expect(noteSelfDropped(writer, 'dirt', [heap], 1_000)).toBe(1);
    expect(isSelfDropped(reader, heap, 2_000)).toBe(true);
    expect(isSelfDropped(native, heap, 2_000)).toBe(true);
    expect(isSelfDropped(createMotorPort({}), heap, 2_000)).toBe(false);
  });

  it('is kept for almost as long as an item lies on the ground', () => {
    const native: any = {};
    noteSelfDropped(native, 'dirt', [{ id: 5, name: 'item' }], 0);
    expect(SELF_DROP_MS).toBeGreaterThanOrEqual(280_000);
    expect(isSelfDropped(native, { id: 5, name: 'item' }, 200_000)).toBe(true);
    expect(isSelfDropped(native, { id: 5, name: 'item' }, SELF_DROP_MS + 1)).toBe(false);
  });
});

describe('a bed dug up after sleeping is picked up from the floor (run 25: left lying, the next night had none)', () => {
  const registry = minecraftData('1.21.11');
  void registry;
  const solid = { name: 'stone', boundingBox: 'block', diggable: true, shapes: [[0, 0, 0, 1, 1, 1]] };
  const air = { name: 'air', boundingBox: 'empty', shapes: [] };

  function sleeper() {
    const inventory: Array<{ name: string; count: number; type: number }> = [{ name: 'red_bed', count: 1, type: 900 }];
    const bedAt = new Vec3(1, 64, 0);
    let bedPlaced = false;
    const bot: any = {
      entity: { position: new Vec3(0.5, 64, 0.5), yaw: 0 }, entities: {}, time: { timeOfDay: 14000 }, game: { dimension: 'minecraft:overworld' },
      isSleeping: false, isABed: (block: any) => block?.name?.endsWith('_bed'),
      inventory: { items: () => inventory },
      blockAt: (pos: Vec3) => { const p = pos.floored(); if (bedPlaced && p.equals(bedAt)) return { name: 'red_bed', boundingBox: 'block', position: p };
        return { ...(p.y < 64 ? solid : air), position: p }; },
      findBlock: vi.fn(() => (bedPlaced ? { name: 'red_bed', position: bedAt } : null)),
      equip: vi.fn(async () => {}), lookAt: vi.fn(async () => {}), pathfinder: { stop: () => {} },
      placeBlock: vi.fn(async () => { bedPlaced = true; inventory.length = 0; }),
      sleep: vi.fn(async () => {}),
      once: (event: string, listener: () => void) => { if (event === 'wake') setImmediate(listener); },
      removeListener: () => {},
    };
    return { bot, inventory };
  }

  it('looks for the dropped bed once more after dig-block-at says it was not collected', async () => {
    const { bot, inventory } = sleeper();
    const skill: any = new SleepInBed(bot);
    const calls: string[] = [];
    skill.callSkill = vi.fn(async (name: string, ...args: unknown[]) => {
      calls.push(`${name}:${args.join(',')}`);
      if (name === 'dig-block-at') return { success: false, failureType: 'drop_not_collected', result: '' };
      if (name === 'pickup-nearest-item') { inventory.push({ name: 'red_bed', count: 1, type: 900 }); return { success: true, result: '' }; }
      return { success: true, result: '' };
    });
    const result: any = await skill.runImpl();
    expect(result.success).toBe(true);
    expect(calls.some(call => call.startsWith('pickup-nearest-item:red_bed'))).toBe(true);
    expect(result.result).toContain('ベッドは拾い直しました');
    expect(result.result).not.toContain('持ち物に入っていません');
  });
});
