import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { describe, expect, it, vi } from 'vitest';

// r9 (2026-10-22, run 33). The scenes of the run, built in a test world and run on the code of r8 (they fail there) and on r9 (they pass):
//   - +992 to +999 s: a normal piglin with a golden sword chased the body on a floor at its own speed; the reflex made three "one step away"
//     hands and said it would do no more, the flee did not shake it, five blows were taken in 6.5 s and the body died with an iron sword in hand;
//   - the walk's "probe path の決まりでは歩いて行ける … 体はそこまで進まなかった" (five acts, +504 to +1111): three of them to a cell with no floor
//     under it (act walks with range 0.5, which skipped the check of the target, and the stop quoted probe path's answer for a cell BESIDE it),
//     two to a landing three cells down (probe path and the walk's rules allow a fall of three; the route search was given maxDropDown 3,
//     which it reads as a floor two down).
vi.mock('../../src/services/minebot/utils/digBlockVerified.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/services/minebot/utils/digBlockVerified.js')>();
  return { ...actual, digBlockVerified: vi.fn(async (bot: any, block: any) => {
    const p = block.position;
    bot.__dug.push(`${p.x},${p.y},${p.z}`);
    bot.__blocks.set(`${p.x},${p.y},${p.z}`, { name: 'air', boundingBox: 'empty' });
    return { stateId: 0, blockName: 'air' };
  }) };
});
// A fake body has no registry for the route search's movements: a stand-in (the real one is built in the A* tests below).
vi.mock('../../src/services/minebot/utils/setMovements.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/services/minebot/utils/setMovements.js')>();
  return { ...actual, buildMovements: (bot: any, ...rest: any[]) => bot.__fakeMovements ? { getBlock: () => null, getNeighbors: () => [], exclusionAreasBreak: [] } : (actual.buildMovements as any)(bot, ...rest) };
});

const reflexes: any = await import('../../src/services/minebot/utils/floorReflexes.js');
const { floorConfig } = await import('../../src/services/minebot/utils/floorConfig.js');
const { ensureReflexLedger } = await import('../../src/services/minebot/utils/reflexLedger.js');
const { runAct, ACT_HANDS } = await import('../../src/services/minebot/instantSkills/act.js');
const walkModule: any = await import('../../src/services/minebot/utils/primitives/walk.js');
const localMap: any = await import('../../src/services/minebot/utils/localMap.js');
const { probePath } = await import('../../src/services/minebot/utils/probeTools.js');

type Cell = { name: string; boundingBox: string; diggable?: boolean; hardness?: number };
const AIR: Cell = { name: 'air', boundingBox: 'empty' };
const STONE: Cell = { name: 'stone', boundingBox: 'block', diggable: true, hardness: 1.5 };
const COBBLE = { name: 'cobblestone', type: 1, count: 16 };
const IRON_SWORD = { name: 'iron_sword', type: 20, count: 1 };
const IRON_PICKAXE = { name: 'iron_pickaxe', type: 21, count: 1 };

/** An open floor of stone under y 64 (the run's piglin was on level ground). */
const field = (_x: number, y: number, _z: number): Cell => (y < 64 ? STONE : AIR);
/** The same with a stone wall at x 1 (y 64 to 66) between the body and an enemy to the east. */
const walled = (x: number, y: number, z: number): Cell => (x === 1 && y >= 64 && y <= 66 ? STONE : field(x, y, z));
/** The same with a roof over the body: stone at y 67. */
const roofed = (x: number, y: number, z: number): Cell => (y === 67 ? STONE : field(x, y, z));
/** A ledge: stone floor for z 0 to 3 (x 0 to 10) at y 54, air round it, a lava sea under (the rim: r8's hands stand there). */
const LAVA: Cell = { name: 'lava', boundingBox: 'empty' };
const ledge = (x: number, y: number, z: number): Cell => (y <= 28 ? LAVA : y === 54 && z >= 0 && z <= 3 && x >= 0 && x <= 10 ? STONE : AIR);

const piglin = (id: number, x: number, y: number, z: number, health = 16) =>
  ({ id, name: 'piglin', type: 'hostile', height: 1.95, width: 0.6, position: new Vec3(x, y, z), health });

/**
 * A fake body in the Nether at `at` (feet): a physics tick, a ledger, the floor installed. A swing at a creature hurts it 20 ms later
 * (`damage` health, `entityHurt`; `entityDead` and gone at 0), as the game does.
 */
function scene(shape: (x: number, y: number, z: number) => Cell, at: Vec3, options: { health?: number; items?: any[]; mobs?: Record<string, any>; now?: () => number; damage?: number } = {}) {
  const blocks = new Map<string, Cell>();
  const bot: any = Object.assign(new EventEmitter(), {
    __blocks: blocks, __dug: [] as string[], __placed: [] as string[], __jumped: false, __fakeMovements: true, __swings: [] as number[],
    entity: { id: 1, name: 'player', position: at.clone(), yaw: 0, pitch: 0, onGround: true, metadata: [0] },
    health: options.health ?? 20, food: 17, game: { dimension: 'the_nether' }, llmCentric: true,
    entities: options.mobs ?? {},
    registry: { blocksByName: { cobblestone: { id: 1 }, stone: { id: 2 } }, entitiesByName: { piglin: { type: 'hostile' }, zombie: { type: 'hostile' } }, itemsByName: {}, items: {} },
    heldItem: null, inventory: { items: () => options.items ?? [], slots: new Array(46).fill(null) }, controlState: {} as Record<string, boolean>,
    executingSkill: false, interruptExecution: false, clearControlStates: vi.fn(), look: vi.fn(async () => undefined), lookAt: vi.fn(async () => undefined),
    equip: vi.fn(async (item: any) => { bot.heldItem = item; }), consume: vi.fn(async () => undefined), stopDigging: () => undefined,
    attack: vi.fn((entity: any) => {
      bot.__swings.push(entity.id);
      setTimeout(() => {
        entity.health -= options.damage ?? 6;
        bot.emit('entityHurt', entity);
        if (entity.health <= 0) { delete bot.entities[entity.id]; bot.emit('entityDead', entity); }
      }, 20);
    }),
    setControlState: vi.fn((key: string, value: boolean) => { if (key === 'jump' && value) bot.__jumped = true; }),
    placeBlock: vi.fn(async (reference: any, face: Vec3) => {
      const dest = reference.position.plus(face);
      bot.__placed.push(`${dest.x},${dest.y},${dest.z}`);
      blocks.set(`${dest.x},${dest.y},${dest.z}`, { name: bot.heldItem?.name ?? 'cobblestone', boundingBox: 'block' });
    }),
    blockAt: (position: Vec3) => {
      const x = Math.floor(position.x), y = Math.floor(position.y), z = Math.floor(position.z);
      return { diggable: true, hardness: 1.5, ...(blocks.get(`${x},${y},${z}`) ?? shape(x, y, z)), position: new Vec3(x, y, z) };
    },
  });
  bot.pathfinder = { movements: null, setMovements(m: unknown) { this.movements = m; }, stop: () => undefined, setGoal: () => undefined,
    goto: vi.fn(async (goal: any) => { bot.entity.position = new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5); }) };
  const ledger = ensureReflexLedger(bot);
  reflexes.installFloorReflexes(bot, floorConfig({}), { fleeTickMs: 1, now: options.now });
  return { bot, ledger };
}
const tick = (bot: EventEmitter) => bot.emit('physicsTick');
const settle = (ms = 15) => new Promise(resolve => setTimeout(resolve, ms));
/** Ticks with the clock moving 300 ms each, the hand of each round finished before the next. */
async function rounds(bot: any, clock: { at: number }, count: number) {
  for (let i = 0; i < count; i++) {
    clock.at += 300; tick(bot);
    await vi.waitFor(() => expect(bot.floorReflexes.busy).toBeNull(), { timeout: 8000, interval: 5 });
    await settle(5);
  }
}
const meleeLines = (ledger: ReturnType<typeof ensureReflexLedger>) => ledger.entriesSince(-1).filter(entry => entry.kind === 'melee' || entry.kind === 'melee_none');
/** The first tick sees the health; then the piglin's blow takes `to` (run 33: 15.5, then 11.0). */
async function hurtTo(bot: any, clock: { at: number }, to: number) {
  clock.at += 300; tick(bot);
  bot.health = to;
}

// ===== B1: a blow back on a floor =====

describe('run 33\'s piglin: a normal piglin with a golden sword, level ground, health 15.5, an iron sword in hand', () => {
  it('the first blow taken at 2.1 m: a blow back (r8 stepped one cell away three times, was caught, and said it would do no more)', async () => {
    const clock = { at: 50_000_000 };
    const mob = piglin(1677, 2.6, 64, 0.5);
    const { bot, ledger } = scene(field, new Vec3(0.5, 64, 0.5), { health: 15.5, items: [IRON_SWORD, COBBLE], mobs: { 1677: mob }, now: () => clock.at });
    await hurtTo(bot, clock, 11);
    await rounds(bot, clock, 1);
    // Two blows, both landed; the piglin has 16 and iron takes 6 a blow in the world of this test: 4 left.
    expect(bot.__swings).toEqual([1677, 1677]);
    expect(bot.entity.position).toEqual(new Vec3(0.5, 64, 0.5));
    expect(meleeLines(ledger)).toHaveLength(1);
    expect(meleeLines(ledger)[0]).toMatchObject({ kind: 'melee', outcome: 'done' });
    expect(meleeLines(ledger)[0].detail).toMatch(/^近接の piglin #1677 2\.1m: 打ち返した 2 回（iron_sword）・当たった 2・相手の残り体力 4。足場: 空所なし 今2\.1m 体力11$/u);
    // The sword was put in the hand first.
    expect(bot.equip).toHaveBeenCalledWith(IRON_SWORD, 'hand');
    // Still on the body (no hurt, within 3 m after a hand of this episode): the next hand finishes it, and then there is nothing near.
    await rounds(bot, clock, 1);
    expect(meleeLines(ledger)).toHaveLength(2);
    expect(meleeLines(ledger)[1].detail).toMatch(/^近接の piglin #1677 2\.1m: 打ち返した 1 回（iron_sword）・当たった 1（倒した）。足場: 空所なし 4m内に居ない 体力11$/u);
    await rounds(bot, clock, 2);
    expect(meleeLines(ledger)).toHaveLength(2);
    expect(bot.__swings).toHaveLength(3);
  }, 20_000);

  it('an act running stops as a reflex and says the blows (the receipt the planner reads)', async () => {
    const clock = { at: 51_000_000 };
    const { bot } = scene(field, new Vec3(0.5, 64, 0.5), { health: 15.5, items: [IRON_SWORD], mobs: { 1677: piglin(1677, 2.6, 64, 0.5) }, now: () => clock.at });
    const acting = runAct(bot, ACT_HANDS.parse([{ do: 'wait', seconds: 5 }, { do: 'jump' }]), undefined, undefined, { tickMs: 20 });
    await settle(60);
    await hurtTo(bot, clock, 11);
    clock.at += 300; tick(bot);
    const json = JSON.parse((await acting).result);
    expect(json).toMatchObject({ ok: false, stoppedBy: 'reflex' });
    expect(json.stoppedWhy).toContain('近接の piglin #1677 2.1m: 打ち返した');
    expect(json.stoppedWhy).toContain('iron_sword');
  }, 20_000);

  it('health 6 or less, or no blade: no blow. A block between (the planner\'s pickaxe is no blade); with nothing to put, a step away above the flee\'s health', async () => {
    const clock = { at: 52_000_000 };
    for (const [label, health, items] of [['no blade', 11, [IRON_PICKAXE, COBBLE]], ['six', 6, [IRON_SWORD, COBBLE]]] as const) {
      const { bot, ledger } = scene(field, new Vec3(0.5, 64, 0.5), { health: 15.5, items: [...items], mobs: { 1677: piglin(1677, 2.6, 64, 0.5) }, now: () => clock.at });
      await hurtTo(bot, clock, health);
      await rounds(bot, clock, 1);
      expect(bot.__swings, label).toEqual([]);
      expect(bot.__placed, label).toEqual(['1,64,0']);
      expect(meleeLines(ledger)[0].detail, label).toMatch(/^近接の piglin #1677 2\.1m: 間 \(1,64,0\) に cobblestone を置いた。足場: 空所なし 今2\.1m 体力/u);
    }
    // Seven is above six: the blow.
    const seven = scene(field, new Vec3(0.5, 64, 0.5), { health: 15.5, items: [IRON_SWORD, COBBLE], mobs: { 1677: piglin(1677, 2.6, 64, 0.5) }, now: () => clock.at });
    await hurtTo(seven.bot, clock, 7);
    await rounds(seven.bot, clock, 1);
    expect(seven.bot.__swings).toHaveLength(2);
    // Nothing to put, no blade, health 15: a step away (r8's hand).
    const bare = scene(field, new Vec3(0.5, 64, 0.5), { health: 15.5, items: [], mobs: { 1677: piglin(1677, 2.6, 64, 0.5) }, now: () => clock.at });
    await hurtTo(bare.bot, clock, 11);
    await rounds(bare.bot, clock, 1);
    expect(meleeLines(bare.ledger)[0].detail).toMatch(/^近接の piglin #1677 2\.1m: 敵から離れる向きへ西1/u);
    // At the flee's health with nothing to put: the flee is the one that runs (no melee line at all).
    const low = scene(field, new Vec3(0.5, 64, 0.5), { health: 15.5, items: [], mobs: { 1677: piglin(1677, 2.6, 64, 0.5) }, now: () => clock.at });
    await hurtTo(low.bot, clock, 7);
    await rounds(low.bot, clock, 1);
    expect(meleeLines(low.ledger)).toHaveLength(0);
  }, 30_000);

  it('no chase: an enemy out of the eye\'s reach (3.3 m to its box) or behind a wall is left, though the body was just hurt', async () => {
    const clock = { at: 53_000_000 };
    const far = scene(field, new Vec3(0.5, 64, 0.5), { health: 15.5, items: [IRON_SWORD], mobs: { 1677: piglin(1677, 4.1, 64, 0.5) }, now: () => clock.at });
    await hurtTo(far.bot, clock, 11);
    await rounds(far.bot, clock, 2);
    expect(far.bot.__swings).toEqual([]);
    expect(far.bot.entity.position).toEqual(new Vec3(0.5, 64, 0.5));
    expect(meleeLines(far.ledger)).toHaveLength(0);
    const wall = scene(walled, new Vec3(0.5, 64, 0.5), { health: 15.5, items: [IRON_SWORD], mobs: { 1677: piglin(1677, 2.6, 64, 0.5) }, now: () => clock.at });
    await hurtTo(wall.bot, clock, 11);
    await rounds(wall.bot, clock, 2);
    expect(wall.bot.__swings).toEqual([]);
  }, 20_000);

  it('a hurt that nothing melee is near for, a shooter, a creeper, a kind the planner fights by choice (above the flee\'s health), and the old mode: no blow', async () => {
    const clock = { at: 54_000_000 };
    const fight = scene(field, new Vec3(0.5, 64, 0.5), { health: 15.5, items: [IRON_SWORD], mobs: { 1677: piglin(1677, 2.6, 64, 0.5) }, now: () => clock.at });
    fight.bot.engagements = [{ kinds: ['piglin'] }];
    await hurtTo(fight.bot, clock, 11);
    await rounds(fight.bot, clock, 1);
    expect(fight.bot.__swings).toEqual([]);
    for (const name of ['blaze', 'skeleton', 'creeper']) {
      const mob = { id: 3, name, type: 'hostile', height: 1.8, width: 0.6, position: new Vec3(2.6, 64, 0.5) };
      const { bot, ledger } = scene(field, new Vec3(0.5, 64, 0.5), { health: 15.5, items: [IRON_SWORD], mobs: { 3: mob }, now: () => clock.at });
      await hurtTo(bot, clock, 11);
      await rounds(bot, clock, 1);
      expect(bot.__swings, name).toEqual([]);
      expect(meleeLines(ledger), name).toHaveLength(0);
    }
    const old = scene(field, new Vec3(0.5, 64, 0.5), { health: 15.5, items: [IRON_SWORD], mobs: { 1677: piglin(1677, 2.6, 64, 0.5) }, now: () => clock.at });
    old.bot.llmCentric = false;
    await hurtTo(old.bot, clock, 11);
    await rounds(old.bot, clock, 1);
    expect(old.bot.__swings).toEqual([]);
  }, 20_000);

  it('five blow-hands in an episode at most; then it says so, and leaves the decision to the planner', async () => {
    const clock = { at: 55_000_000 };
    const { bot, ledger } = scene(field, new Vec3(0.5, 64, 0.5), { health: 15.5, items: [IRON_SWORD], mobs: { 1677: piglin(1677, 2.6, 64, 0.5, 1000) }, now: () => clock.at, damage: 1 });
    await hurtTo(bot, clock, 11);
    await rounds(bot, clock, 6);
    const lines = meleeLines(ledger);
    expect(lines.filter(entry => entry.kind === 'melee')).toHaveLength(5);
    expect(lines.at(-1)).toMatchObject({ kind: 'melee_none' });
    expect(lines.at(-1)!.detail).toContain('この間に打ち返しを5手続けたがまだ近い。これ以上は反射でしない');
    expect(bot.__swings).toHaveLength(10);
  }, 30_000);

  it('a blow back stops when the health falls to 6 in the hand (the next hand is a block between)', async () => {
    const clock = { at: 56_000_000 };
    const { bot, ledger } = scene(field, new Vec3(0.5, 64, 0.5), { health: 15.5, items: [IRON_SWORD, COBBLE], mobs: { 1677: piglin(1677, 2.6, 64, 0.5, 1000) }, now: () => clock.at, damage: 1 });
    await hurtTo(bot, clock, 11);
    const running = (async () => { clock.at += 300; tick(bot); })();
    await running;
    await settle(40);
    bot.health = 4.5;
    await vi.waitFor(() => expect(bot.floorReflexes.busy).toBeNull(), { timeout: 5000, interval: 5 });
    expect(bot.__swings).toHaveLength(1);
    expect(meleeLines(ledger)[0].detail).toContain('打ち返した 1 回（iron_sword）');
    expect(meleeLines(ledger)[0].detail).toContain('体力が6以下になった');
  }, 20_000);
});

describe('the hands of a floor: a block between, two up, and the rim as r8 had it', () => {
  const choice = (shape: (x: number, y: number, z: number) => Cell, items: any[], enemyAt: [number, number, number], health = 15) => {
    const { bot } = scene(shape, new Vec3(0.5, 64, 0.5), { health, items, mobs: { 1: piglin(1677, ...enemyAt) } });
    const threats = reflexes.meleeThreatsNear(bot);
    return reflexes.meleeChoice(bot, threats, { hands: 0, beingHit: true });
  };
  it('an enemy in the next cell (1.4 m): no cell to put a block in, so two blocks up; a roof: no pillar, a step away', () => {
    expect(choice(field, [COBBLE], [1.9, 64, 0.5]).hand).toMatchObject({ kind: 'pillar', block: 'cobblestone', n: 2, detail: '2段積んで上がった' });
    // One block is not two.
    const one = choice(field, [{ ...COBBLE, count: 1 }], [1.9, 64, 0.5]);
    expect(one.hand?.kind).toBe('step');
    // A roof over the head: the pillar is not made (the cell over the head is stone), the r8 step away is.
    const roof = choice(roofed, [COBBLE], [1.9, 64, 0.5]);
    expect(roof.hand?.kind).toBe('step');
  });
  it('at a rim no blow is struck and no pillar made, with a sword in the pack: r8\'s step off the rim (the bridge and ledge are r8\'s tests)', () => {
    const { bot } = scene(ledge, new Vec3(5.5, 55, 0.5), { health: 15.5, items: [IRON_SWORD], mobs: { 2: piglin(2, 8.5, 55, 0.5) } });
    const result = reflexes.meleeChoice(bot, reflexes.meleeThreatsNear(bot), { hands: 0, beingHit: true });
    expect(result.hand).toMatchObject({ kind: 'step' });
    expect(result.hand.detail).toContain('空所から離れる向きへ');
  });
  it('a blade is a sword or an axe; a pickaxe, a shovel and a hoe are tools', () => {
    expect(reflexes.bestBlade([IRON_PICKAXE, { name: 'diamond_shovel' }, { name: 'iron_hoe' }])).toBeNull();
    expect(reflexes.bestBlade([IRON_PICKAXE, { name: 'stone_axe' }, { name: 'wooden_sword' }])?.name).toBe('wooden_sword');
    expect(reflexes.bestBlade([{ name: 'stone_axe' }, { name: 'iron_axe' }])?.name).toBe('iron_axe');
  });
});

// ===== B2: the walk and the route search =====

const require = createRequire(import.meta.url);
function lib() {
  try {
    const registry = require('prismarine-registry')('1.20.4');
    return { registry, Chunk: require('prismarine-chunk')(registry), World: require('prismarine-world')(registry),
      AStar: require('mineflayer-pathfinder/lib/astar'), Move: require('mineflayer-pathfinder/lib/move'), goals: require('mineflayer-pathfinder').goals };
  } catch { return null; }
}
const L = lib();

/** A corridor along +x at z 0 (y 64 and 65, stone floor at 63) from x 1 to 4, and at x 5 a shaft whose floor is at y `floorY` (feet cells from floorY+1 to 65). */
function shaftWorld(floorY: number) {
  const { registry, Chunk, World } = L!;
  const chunk = new Chunk({ minY: -64, worldHeight: 384 });
  const put = (x: number, y: number, z: number, name: string) => chunk.setBlockStateId(new Vec3(x, y, z), registry.blocksByName[name].defaultState);
  for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) for (let y = 50; y <= 72; y++) put(x, y, z, 'stone');
  for (let x = 1; x <= 4; x++) for (const y of [64, 65]) put(x, y, 0, 'air');
  for (let y = floorY + 1; y <= 65; y++) put(5, y, 0, 'air');
  const world = new World(null, null);
  world.sync.setColumn(0, 0, chunk);
  return Object.assign(new EventEmitter(), {
    version: '1.20.4', registry, world: world.sync, entity: { position: new Vec3(4.5, 64, 0.5), effects: {}, onGround: true }, entities: {},
    game: { dimension: 'the_nether', minY: -64 }, inventory: { items: () => [], slots: new Array(46).fill(null) },
    blockAt: (p: Vec3, extra?: boolean) => world.sync.getBlock(p, extra), pathfinder: { bestHarvestTool: () => null },
  }) as any;
}
function route(bot: any, from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }) {
  const { AStar, Move, goals } = L!;
  const movements = walkModule.walkMovements(bot, true);
  return new AStar(new Move(from.x, from.y, from.z, movements.countScaffoldingItems(), 0), movements, new goals.GoalBlock(to.x, to.y, to.z), 3000).compute();
}

describe.skipIf(!L)('a fall of three: probe path, the walk\'s rules and the route search agree (run 33 +1093 and +1111: "(-37,46,190) に着いていない")', () => {
  it('three cells down into a shaft one wide: probe path walks it, and the route search now does (it read maxDropDown 3 as a floor two down)', async () => {
    const bot = shaftWorld(60);
    const probe = await probePath(localMap.bodyReader(bot), { x: 4, y: 64, z: 0 }, { x: 5, y: 61, z: 0 });
    expect(probe.reachable).toBe(true);
    expect(probe.maxDrop).toBe(3);
    expect(walkModule.whyBlocked(bot, { x: 4, y: 64, z: 0 }, { x: 5, y: 61, z: 0 })).toBeNull();
    // The goal is the landing cell (5,61,0): feet 61 over the floor 60.
    expect(route(bot, { x: 4, y: 64, z: 0 }, { x: 5, y: 61, z: 0 }).status).toBe('success');
  });
  it('four cells down: none of them walks it (a fall of four hurts)', async () => {
    const bot = shaftWorld(59);
    const probe = await probePath(localMap.bodyReader(bot), { x: 4, y: 64, z: 0 }, { x: 5, y: 60, z: 0 });
    expect(probe.reachable).toBe(false);
    expect(walkModule.whyBlocked(bot, { x: 4, y: 64, z: 0 }, { x: 5, y: 60, z: 0 })?.reason).toBe('drop');
    expect(route(bot, { x: 4, y: 64, z: 0 }, { x: 5, y: 60, z: 0 }).status).not.toBe('success');
  });
  it('two cells down is walked as before', () => {
    const bot = shaftWorld(61);
    expect(route(bot, { x: 4, y: 64, z: 0 }, { x: 5, y: 62, z: 0 }).status).toBe('success');
  });
});

describe('a walk to a cell with no floor under it (run 33 +504, +726, +754: act walks with range 0.5)', () => {
  /** A stone floor under y 64 with one cell of it missing at (4,63,0): the target (4,64,0) hangs over it (run 33: the cell under the target was the body's own, air). */
  const holeShape = (x: number, y: number, z: number): Cell => (x === 4 && z === 0 && y === 63 ? AIR : y < 64 ? STONE : AIR);
  const ctxOf = (bot: any) => ({ bot, stop: new AbortController().signal, deadline: Date.now() + 8000, facing: 'north' as const, base: { x: 0, y: 64, z: 0 } });
  const body = (x = 3.5) => scene(holeShape, new Vec3(x, 64, 0.5), { health: 20 }).bot;

  it('range 0.5 (the act\'s default) is the cell itself: refused at the start with the fact, the route search is not asked', async () => {
    const bot = body();
    const outcome = await walkModule.walk(ctxOf(bot), { to: { x: 4, y: 64, z: 0 }, range: 0.5 });
    expect(outcome).toMatchObject({ ok: false, reason: 'target_unstandable' });
    expect(outcome.text).toContain('そのものには立てない（下 1 マスが空気（立つ床が無い））');
    expect(bot.pathfinder.goto).not.toHaveBeenCalled();
    // The same through an act: the line the planner reads.
    const json = JSON.parse((await runAct(bot, ACT_HANDS.parse([{ do: 'walk', to: { x: 4, y: 64, z: 0 } }]), undefined, undefined, { tickMs: 20 })).result);
    expect(json.lines[0].line).toContain('そのものには立てない');
    expect(bot.pathfinder.goto).not.toHaveBeenCalled();
  });
  it('a range of one or more is "near it": the walk is tried, and when the body does not arrive the stop says the target cannot be stood in (not "probe path walks it")', async () => {
    const bot = body(1.5);
    bot.pathfinder.goto = vi.fn(async () => undefined);
    const outcome = await walkModule.walk(ctxOf(bot), { to: { x: 4, y: 64, z: 0 }, range: 1 });
    expect(bot.pathfinder.goto).toHaveBeenCalled();
    expect(outcome.ok).toBe(false);
    expect(outcome.text).toContain('(4,64,0) そのものには立てない（下 1 マスが空気（立つ床が無い））');
    expect(outcome.text).not.toContain('probe path の決まりでは歩いて行ける');
  });
  it('a cell that can be stood in and was not reached comes with the cells: the floor under the feet, the next cell, and who stands in it', async () => {
    const bot = scene(field, new Vec3(0.5, 64, 0.5), { health: 20, mobs: { 9: { id: 9, name: 'zombie', type: 'hostile', position: new Vec3(1.5, 64, 0.5) } } }).bot;
    bot.pathfinder.goto = vi.fn(async () => undefined);
    const outcome = await walkModule.walk(ctxOf(bot), { to: { x: 3, y: 64, z: 0 }, range: 0.5 });
    expect(outcome).toMatchObject({ ok: false, reason: 'not_arrived' });
    expect(outcome.text).toMatch(/probe path の決まりでは歩いて行ける（3 マス）が、体はそこまで進まなかった。足のマス \(0,64,0\) の下は stone。次のマス \(1,64,0\)（東1）は 足 air・頭 air・下 stone。そのマスに zombie #9 がいる$/u);
  });
});
