import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { describe, expect, it, vi } from 'vitest';

// r7 (2026-10-22, runs 30 and 31): the body's fixes. Burning in a shooter's line, the body cuts the line by itself (run 31: three fireballs
// in a fortress corridor, 18 to 0 in ten seconds, three of them standing still after the last stand); a stopIf says the line it stopped
// in. The walk's rules read fences, slabs, stairs and carpets as the route search does, and a body on a slab stands in the cell over it.
// The scan's summary gives the loop back between its reads, and the log says what the longest hold was doing.
vi.mock('../../src/services/minebot/utils/digBlockVerified.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/services/minebot/utils/digBlockVerified.js')>();
  return { ...actual, digBlockVerified: vi.fn(async (bot: any, block: any) => {
    const p = block.position;
    bot.__dug.push(`${p.x},${p.y},${p.z}`);
    bot.__blocks.set(`${p.x},${p.y},${p.z}`, { name: 'air', boundingBox: 'empty' });
    // The body falls into the cell dug under its feet.
    const at = bot.entity.position;
    if (p.x === Math.floor(at.x) && p.z === Math.floor(at.z) && p.y === Math.floor(at.y) - 1) bot.entity.position = new Vec3(at.x, p.y, at.z);
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
const scanModule: any = await import('../../src/services/minebot/utils/loadedBlockScan.js');
const worldScan: any = await import('../../src/services/minebot/utils/worldScan.js');

type Cell = { name: string; boundingBox: string; diggable?: boolean; hardness?: number };
const STONE: Cell = { name: 'stone', boundingBox: 'block', diggable: true, hardness: 1.5 }, AIR: Cell = { name: 'air', boundingBox: 'empty' };
const COBBLE = { name: 'cobblestone', type: 1, count: 16 };
const blaze = (id: number, x: number, y: number, z: number) => ({ id, name: 'blaze', type: 'hostile', height: 1.8, width: 0.6, position: new Vec3(x, y, z) });

// ===== the cover =====

/**
 * A fake body in the Nether, burning (metadata flag 1), at (0.5, 64, 0.5). `shape(x, y, z)` says what a cell is when `__blocks` does not; the
 * route search answers by moving the body to the goal's cell (a step of the cover is walked as the walk walks).
 */
function burning(shape: (x: number, y: number, z: number) => Cell, options: { health?: number; items?: any[]; mobs?: Record<string, any>; now?: () => number } = {}) {
  const blocks = new Map<string, Cell>();
  const bot: any = Object.assign(new EventEmitter(), {
    __blocks: blocks, __dug: [] as string[], __fakeMovements: true,
    entity: { id: 1, name: 'player', position: new Vec3(0.5, 64, 0.5), yaw: 0, pitch: 0, onGround: true, metadata: [1] },
    health: options.health ?? 18, food: 17, game: { dimension: 'the_nether' }, llmCentric: true,
    entities: options.mobs ?? {},
    registry: { blocksByName: { cobblestone: { id: 1 }, stone: { id: 2 } }, entitiesByName: { blaze: { type: 'hostile' } }, itemsByName: {}, items: {} },
    heldItem: null, inventory: { items: () => options.items ?? [], slots: new Array(46).fill(null) }, controlState: {} as Record<string, boolean>,
    executingSkill: false, interruptExecution: false, clearControlStates: vi.fn(), look: vi.fn(async () => undefined), lookAt: vi.fn(async () => undefined),
    equip: vi.fn(async (item: any) => { bot.heldItem = item; }), consume: vi.fn(async () => undefined), attack: vi.fn(), setControlState: vi.fn(), stopDigging: () => undefined,
    placeBlock: vi.fn(async (reference: any, face: Vec3) => { const at = reference.position.plus(face); bot.__placed.push(`${at.x},${at.y},${at.z}`); blocks.set(`${at.x},${at.y},${at.z}`, { name: 'cobblestone', boundingBox: 'block' }); }),
    __placed: [] as string[],
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
const covers = (ledger: ReturnType<typeof ensureReflexLedger>) => ledger.entriesSince(-1).filter(entry => /射手から見えている/u.test(entry.detail));
/** Run 31's corridor: stone, but a corridor along x at z 0 (y 64-65) and an alcove at (0, 64..65, 1); a blaze down the corridor. */
const corridor = (x: number, y: number, z: number): Cell => ((z === 0 && x >= -3 && x <= 12 && (y === 64 || y === 65)) || (x === 0 && z === 1 && (y === 64 || y === 65)) ? AIR : STONE);
/** An open floor: stone under y 64, air from 64. */
const field = (_x: number, y: number, _z: number): Cell => (y < 64 ? STONE : AIR);
/** Ticks with the clock moving, until the body's reflexes rest. */
async function ticksUntilQuiet(bot: any, clock: { at: number }, rounds = 12) {
  for (let i = 0; i < rounds; i++) {
    clock.at += 300; tick(bot);
    await vi.waitFor(() => expect(bot.floorReflexes.busy).toBeNull(), { timeout: 6000, interval: 5 });
    await settle(5);
  }
}

describe('the cover: burning in a shooter\'s line, the body cuts the line by itself (run 31: 18 to 0 in 10 s in a fortress corridor)', () => {
  it('a blaze down the corridor: one step into the alcove beside, told with the line cut', async () => {
    const clock = { at: 9_000_000 };
    const { bot, ledger } = burning(corridor, { mobs: { 9: blaze(9, 10.5, 64, 0.5) }, now: () => clock.at });
    tick(bot);
    await vi.waitFor(() => expect(covers(ledger)).toHaveLength(1), { timeout: 4000, interval: 5 });
    expect(bot.pathfinder.goto).toHaveBeenCalledTimes(1);
    expect(bot.entity.position).toEqual(new Vec3(0.5, 64, 1.5));
    expect(covers(ledger)[0]).toMatchObject({ kind: 'cover', outcome: 'done' });
    expect(covers(ledger)[0].detail).toMatch(/^燃えて射手から見えている: 南1へ動いた \(0,64,0\)→\(0,64,1\)。射線が切れた 体力18$/u);
    // Out of the line: no more hands, though still burning.
    await ticksUntilQuiet(bot, clock, 4);
    expect(covers(ledger)).toHaveLength(1);
    expect(bot.__dug).toEqual([]);
  });

  it('no cell out of the line within two (an open floor): digs down, and seals the hole over the head when that cuts the line', async () => {
    const clock = { at: 9_100_000 };
    const { bot, ledger } = burning(field, { mobs: { 9: blaze(9, 1.5, 72, 0.5) }, items: [COBBLE], now: () => clock.at });
    bot.heldItem = COBBLE;
    await ticksUntilQuiet(bot, clock, 10);
    expect(bot.__dug).toEqual(['0,63,0', '0,62,0', '0,61,0']);
    expect(bot.__placed).toEqual(['0,63,0']);
    const lines = covers(ledger).map(entry => entry.detail);
    expect(lines[0]).toMatch(/^燃えて射手から見えている: 足元を掘って下がった \(0,64,0\)。まだ見えている: blaze #9 上9・\d+\.\dm 体力18$/u);
    expect(lines.at(-1)).toMatch(/^燃えて射手から見えている: 頭の上 \(0,63,0\) を cobblestone で塞いだ。射線が切れた/u);
    expect(lines).toHaveLength(4);
  });

  it('lava beside the cell under the feet: no dig; the facts of why no hand is made are told once', async () => {
    const clock = { at: 9_200_000 };
    const lavaBeside = (x: number, y: number, z: number): Cell => (x === 1 && y === 63 && z === 0 ? { name: 'lava', boundingBox: 'empty' } : field(x, y, z));
    const { bot, ledger } = burning(lavaBeside, { mobs: { 9: blaze(9, 6.5, 68, 0.5) }, now: () => clock.at });
    // An act running is not stopped by that fact (it may be what takes the body out of the line).
    const acting = runAct(bot, ACT_HANDS.parse([{ do: 'wait', seconds: 0.4 }]), undefined, undefined, { tickMs: 20 });
    await ticksUntilQuiet(bot, clock, 4);
    expect(JSON.parse((await acting).result)).toMatchObject({ ok: true });
    expect(bot.__dug).toEqual([]);
    const lines = covers(ledger);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ kind: 'cover_none', outcome: 'failed' });
    expect(lines[0].detail).toContain('動ける手が無い');
    expect(lines[0].detail).toContain('足元の隣 (1,63,0) が溶岩');
    expect(lines[0].detail).toContain('見えている: blaze #9 上4・');
  });

  it('only while burning (or, after a hand, still losing health) and seen; a blaze the planner fights by choice is left out above the flee\'s health', async () => {
    const clock = { at: 9_300_000 };
    // Not burning: nothing.
    const cool = burning(corridor, { mobs: { 9: blaze(9, 10.5, 64, 0.5) }, now: () => clock.at });
    cool.bot.entity.metadata = [0];
    await ticksUntilQuiet(cool.bot, clock, 3);
    expect(covers(cool.ledger)).toHaveLength(0);
    // Burning, the blaze walled off: nothing.
    const walled = burning((x, y, z) => (x === 5 ? STONE : corridor(x, y, z)), { mobs: { 9: blaze(9, 10.5, 64, 0.5) }, now: () => clock.at });
    await ticksUntilQuiet(walled.bot, clock, 3);
    expect(covers(walled.ledger)).toHaveLength(0);
    // The planner's fight with blazes (an act's accept): left alone at 18, covered at 7.
    for (const [health, expected] of [[18, 0], [7, 1]] as const) {
      const fight = burning(corridor, { health, mobs: { 9: blaze(9, 10.5, 64, 0.5) }, now: () => clock.at });
      fight.bot.engagements = [{ kinds: ['blaze'] }];
      await ticksUntilQuiet(fight.bot, clock, 3);
      expect(covers(fight.ledger), `health ${health}`).toHaveLength(expected);
    }
  });

  it('an act running stops as a reflex, and says what the body did and that the line is cut', async () => {
    const { bot } = burning(corridor, { mobs: { 9: blaze(9, 10.5, 64, 0.5) } });
    const acting = runAct(bot, ACT_HANDS.parse([{ do: 'wait', seconds: 5 }, { do: 'jump' }]), undefined, undefined, { tickMs: 20 });
    await settle(60);
    tick(bot);
    const json = JSON.parse((await acting).result);
    expect(json).toMatchObject({ ok: false, stoppedBy: 'reflex' });
    expect(json.stoppedWhy).toContain('燃えて射手から見えている: 南1へ動いた (0,64,0)→(0,64,1)。射線が切れた');
    expect(json.lines[0].status).toBe('stopped');
  });

  it('a stopIf that stops the act says whether shooters in reach see the body (run 31: hpBelow in the corridor, in the line)', async () => {
    const { bot } = burning(corridor, { mobs: { 9: blaze(9, 10.5, 64, 0.5) } });
    bot.entity.metadata = [0];
    bot.health = 8.7;
    const inLine = JSON.parse((await runAct(bot, ACT_HANDS.parse([{ do: 'wait', seconds: 2 }]), { hpBelow: 9 }, undefined, { tickMs: 20 })).result);
    expect(inLine).toMatchObject({ stoppedBy: 'stopIf' });
    expect(inLine.stoppedWhy).toBe('hpBelow:8.7。射線の中: blaze #9 10.0m から見えている');
    // In the alcove: out of its line.
    bot.entity.position = new Vec3(0.5, 64, 1.5);
    const outOf = JSON.parse((await runAct(bot, ACT_HANDS.parse([{ do: 'wait', seconds: 2 }]), { hpBelow: 9 }, undefined, { tickMs: 20 })).result);
    expect(outOf.stoppedWhy).toBe('hpBelow:8.7。射線の外: blaze #9 10.0m からは見えない');
  });
});

// ===== the walk's rules against the route search =====

const require = createRequire(import.meta.url);
function lib() {
  try {
    const registry = require('prismarine-registry')('1.20.4');
    return { registry, Chunk: require('prismarine-chunk')(registry), World: require('prismarine-world')(registry), Block: require('prismarine-block')(registry),
      AStar: require('mineflayer-pathfinder/lib/astar'), Move: require('mineflayer-pathfinder/lib/move'), goals: require('mineflayer-pathfinder').goals };
  } catch { return null; }
}
const L = lib();

/** A corridor along +x at z 0 (y 64 up to `height` cells, stone round it and a stone floor at 63), with `inside` put into it. */
function corridorWorld(inside: Array<[number, number, number, string, Record<string, unknown>?]>, height = 2) {
  const { registry, Chunk, World, Block } = L!;
  const chunk = new Chunk({ minY: -64, worldHeight: 384 });
  const put = (x: number, y: number, z: number, name: string, props?: Record<string, unknown>) => chunk.setBlockStateId(new Vec3(x, y, z & 15),
    props ? Block.fromProperties(name, props, 0).stateId : registry.blocksByName[name].defaultState);
  for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) for (let y = 56; y <= 72; y++) put(x, y, z, 'stone');
  for (let x = 1; x <= 9; x++) for (let h = 0; h < height; h++) put(x, 64 + h, 0, 'air');
  for (const [x, y, z, name, props] of inside) put(x, y, z, name, props);
  const world = new World(null, null);
  world.sync.setColumn(0, 0, chunk);
  const bot: any = Object.assign(new EventEmitter(), {
    version: '1.20.4', registry, world: world.sync, entity: { position: new Vec3(1.5, 64, 0.5), effects: {}, onGround: true }, entities: {},
    game: { dimension: 'the_nether', minY: -64 }, inventory: { items: () => [], slots: new Array(46).fill(null) },
    blockAt: (p: Vec3, extra?: boolean) => world.sync.getBlock(p, extra), pathfinder: { bestHarvestTool: () => null },
  });
  return bot;
}
function route(bot: any, from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }) {
  const { AStar, Move, goals } = L!;
  const movements = walkModule.walkMovements(bot, true);
  return new AStar(new Move(from.x, from.y, from.z, movements.countScaffoldingItems(), 0), movements, new goals.GoalBlock(to.x, to.y, to.z), 3000).compute();
}
const slab = { type: 'bottom', waterlogged: false };

describe.skipIf(!L)('the walk\'s rules read fences, slabs and carpets as the route search does (runs 30, 31: fortress walks "一歩ではない")', () => {
  it('a nether brick fence across a corridor three high: no route, and probe path no longer climbs it (it said "行ける" over the fence)', async () => {
    const bot = corridorWorld([[4, 64, 0, 'nether_brick_fence']], 3);
    expect(route(bot, { x: 1, y: 64, z: 0 }, { x: 8, y: 64, z: 0 }).status).not.toBe('success');
    const probe = await probePath(localMap.bodyReader(bot), { x: 1, y: 64, z: 0 }, { x: 8, y: 64, z: 0 });
    expect(probe.reachable).toBe(false);
    expect(probe.text).toContain('(4,64,0) は nether_brick_fence（高さ 1.5。柵・塀は上れず、上にも立てない）');
    // The walk's own reading of the straight line says the same.
    expect(walkModule.whyBlocked(bot, { x: 1, y: 64, z: 0 }, { x: 8, y: 64, z: 0 })?.text).toBe('壁: (4,64,0) nether_brick_fence は高さ 1.5（柵・塀は上れない）（一歩ではない）');
  });

  it('a slab, then a block a cell up: the route search does not climb 1.5 from the slab, and neither does probe path', async () => {
    const bot = corridorWorld([[3, 64, 0, 'nether_brick_slab', slab], [4, 64, 0, 'stone'], [4, 65, 0, 'stone'], [5, 64, 0, 'stone'], [5, 65, 0, 'stone']], 4);
    expect(route(bot, { x: 1, y: 64, z: 0 }, { x: 3, y: 65, z: 0 }).status).toBe('success');
    expect(route(bot, { x: 1, y: 64, z: 0 }, { x: 5, y: 66, z: 0 }).status).not.toBe('success');
    const probe = await probePath(localMap.bodyReader(bot), { x: 1, y: 64, z: 0 }, { x: 5, y: 66, z: 0 });
    expect(probe.reachable).toBe(false);
    expect(probe.text).toContain('(4,65,0) の stone へは上り 1.5（今の床 (3,64,0) が低い。walk の上りは 1.2 まで）');
    expect((await probePath(localMap.bodyReader(bot), { x: 1, y: 64, z: 0 }, { x: 3, y: 65, z: 0 })).reachable).toBe(true);
  });

  it('a carpet in a corridor two high: walked through by both (probe path took it for a wall)', async () => {
    const bot = corridorWorld([[4, 64, 0, 'red_carpet']]);
    expect(route(bot, { x: 1, y: 64, z: 0 }, { x: 8, y: 64, z: 0 }).status).toBe('success');
    const probe = await probePath(localMap.bodyReader(bot), { x: 1, y: 64, z: 0 }, { x: 8, y: 64, z: 0 });
    expect(probe.reachable).toBe(true);
    expect(probe.steps).toBe(7);
  });

  it('a body on a slab or on soul sand stands in the cell over it: its feet cell, and a walk to that cell is arrived (it was "着いていない")', () => {
    const bot = corridorWorld([[3, 64, 0, 'nether_brick_slab', slab], [6, 63, 0, 'soul_sand']]);
    bot.entity.position = new Vec3(3.5, 64.5, 0.5);
    expect(localMap.feetCell(bot)).toEqual({ x: 3, y: 65, z: 0 });
    const { goals } = L!;
    expect(walkModule.atGoal(bot, new goals.GoalBlock(3, 65, 0))).toBe(true);
    bot.entity.position = new Vec3(6.5, 63.875, 0.5);
    expect(localMap.feetCell(bot)).toEqual({ x: 6, y: 64, z: 0 });
    // In the air (a jump) nothing changes; on a full block nothing changes.
    bot.entity.position = new Vec3(2.5, 64.4, 0.5); bot.entity.onGround = false;
    expect(localMap.feetCell(bot)).toEqual({ x: 2, y: 64, z: 0 });
    bot.entity.position = new Vec3(2.5, 64, 0.5); bot.entity.onGround = true;
    expect(localMap.feetCell(bot)).toEqual({ x: 2, y: 64, z: 0 });
  });
});

// ===== the scan's holds =====

function random(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }

/**
 * A heavy Nether (r7: every lab world held the loop 4 ms, production 19.4 and 27.6): 441 distinct columns with many states in their
 * palettes (basalt axes, weeping vines' ages, fence and stair shapes), a lava sea, scattered sources, lava lakes of mostly flowing lava under
 * the body, and a fortress of 9 x 9 chunks with fences, stairs, slabs, soul sand, wart, chests and spawners.
 */
function heavyNether() {
  const { registry, Chunk, World } = L!;
  const statesOf = (name: string) => { const block = registry.blocksByName[name]; const out: number[] = []; for (let s = block.minStateId; s <= block.maxStateId; s++) out.push(s); return out; };
  const id = (name: string) => registry.blocksByName[name].defaultState;
  const lava = statesOf('lava'), fence = statesOf('nether_brick_fence'), stairs = statesOf('nether_brick_stairs'), basalt = statesOf('basalt'), vines = statesOf('weeping_vines'), wart = statesOf('nether_wart');
  const scatter = ['nether_quartz_ore', 'nether_gold_ore', 'glowstone', 'soul_sand', 'gravel', 'magma_block', 'blackstone', 'soul_soil', 'ancient_debris', 'nether_wart_block', 'shroomlight', 'crimson_nylium', 'warped_nylium'].map(id);
  const world = new World(null, null);
  for (let cx = -10; cx <= 10; cx++) for (let cz = -10; cz <= 10; cz++) {
    const chunk = new Chunk({ minY: 0, worldHeight: 256 });
    const r = random(cx * 7919 + cz * 104729 + 17);
    const pick = (list: number[]) => list[Math.floor(r() * list.length)];
    const set = (x: number, y: number, z: number, state: number) => chunk.setBlockStateId(new Vec3(x, y, z), state);
    const fortress = Math.abs(cz) <= 4 && cx >= -2 && cx <= 6, lake = Math.abs(cx - 2) <= 1 && Math.abs(cz - 2) <= 1;
    for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) {
      set(x, 0, z, id('bedrock')); set(x, 127, z, id('bedrock'));
      for (let y = 1; y < 127; y++) {
        if (y <= 31) { set(x, y, z, y >= 22 ? lava[0] : r() < 0.1 ? pick(scatter) : id('netherrack')); continue; }
        if (lake && y >= 40 && y <= 58) { set(x, y, z, r() < 0.04 ? lava[0] : lava[1 + Math.floor(r() * 8)]); continue; }
        if (((x * 7 + z * 3 + y * 5 + cx * 11 + cz * 13) % 23) < 7) { if (r() < 0.01) set(x, y, z, pick(lava)); else if (r() < 0.01) set(x, y, z, pick(vines)); continue; }
        const v = r();
        set(x, y, z, v < 0.02 ? lava[0] : v < 0.06 ? pick(basalt) : v < 0.16 ? pick(scatter) : id('netherrack'));
      }
      if (fortress) {
        for (let y = 60; y <= 80; y++) {
          const wall = x === 0 || x === 15 || z === 0 || z === 15 || y === 60 || y === 80 || y === 70, v = r();
          set(x, y, z, wall ? (v < 0.1 ? id('cracked_nether_bricks') : v < 0.15 ? id('chiseled_nether_bricks') : id('nether_bricks'))
            : v < 0.08 ? pick(fence) : v < 0.14 ? pick(stairs) : v < 0.16 ? id('nether_brick_slab') : v < 0.18 ? id('soul_sand') : v < 0.2 ? pick(wart) : 0);
        }
      }
    }
    if (fortress && (cx * 31 + cz) % 7 === 0) set(8, 66, 8, id('spawner'));
    if (fortress && (cx + cz) % 5 === 0) set(4, 61, 4, id('chest'));
    world.sync.setColumn(cx, cz, chunk);
  }
  return world;
}

/** A heavy overworld: a village (beds of every colour and facing, bells, hay, farmland and crops of every age, chests), oceans, lava lakes. */
function heavyOverworld() {
  const { registry, Chunk, World } = L!;
  const statesOf = (name: string) => { const block = registry.blocksByName[name]; const out: number[] = []; for (let s = block.minStateId; s <= block.maxStateId; s++) out.push(s); return out; };
  const id = (name: string) => registry.blocksByName[name].defaultState;
  const beds = Object.keys(registry.blocksByName).filter(name => name.endsWith('_bed')).flatMap(statesOf);
  const crops = ['wheat', 'carrots', 'potatoes', 'beetroots', 'farmland'].flatMap(statesOf), lava = statesOf('lava'), water = statesOf('water');
  const ores = ['coal_ore', 'iron_ore', 'copper_ore', 'deepslate_iron_ore', 'gravel', 'andesite', 'diorite', 'granite', 'dirt', 'tuff'].map(id);
  const world = new World(null, null);
  for (let cx = -10; cx <= 10; cx++) for (let cz = -10; cz <= 10; cz++) {
    const chunk = new Chunk({ minY: -64, worldHeight: 384 });
    const r = random(cx * 31337 + cz * 7907 + 3);
    const pick = (list: number[]) => list[Math.floor(r() * list.length)];
    const set = (x: number, y: number, z: number, state: number) => chunk.setBlockStateId(new Vec3(x, y, z), state);
    const ocean = cx <= -6, village = Math.abs(cx) <= 3 && Math.abs(cz) <= 3;
    for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) {
      set(x, -64, z, id('bedrock'));
      for (let y = -63; y < 62; y++) {
        const v = r();
        if (y > 10 && y < 30 && ((x + z + cx + cz) % 9 === 0)) { set(x, y, z, v < 0.1 ? lava[0] : pick(lava)); continue; }
        set(x, y, z, v < 0.12 ? pick(ores) : y < 0 ? id('deepslate') : id('stone'));
      }
      if (ocean) { for (let y = 40; y < 63; y++) set(x, y, z, y === 62 && r() < 0.2 ? pick(water) : water[0]); continue; }
      set(x, 62, z, id('dirt')); set(x, 63, z, id('grass_block'));
      if (village) {
        const v = r();
        set(x, 64, z, v < 0.05 ? pick(beds) : v < 0.25 ? pick(crops) : v < 0.27 ? id('hay_block') : v < 0.28 ? id('chest') : v < 0.285 ? id('bell') : v < 0.3 ? water[0] : 0);
      } else if (r() < 0.01) for (let y = 64; y < 70; y++) set(x, y, z, id('oak_log'));
    }
    world.sync.setColumn(cx, cz, chunk);
  }
  return world;
}

describe.skipIf(!L)('the scan gives the loop back inside its summary too, and says what its longest hold was doing (runs 30, 31: 19.4 and 27.6 ms)', () => {
  it('the summary\'s reads (lava pools, spawners) give the loop back between them; the longest hold\'s phase is named', async () => {
    const world = heavyNether();
    const bot = Object.assign(new EventEmitter(), {
      entity: { id: 1, position: new Vec3(40.5, 66, 40.5), yaw: 0, onGround: true }, entities: {}, game: { dimension: 'the_nether' },
      registry: L!.registry, world: world.sync, health: 20, food: 20, inventory: { items: () => [] },
      blockAt: (position: Vec3, extraInfos?: boolean) => world.sync.getBlock(position, extraInfos),
    }) as any;
    const phases: string[] = [];
    class Spent extends scanModule.LoopSlicer { override due() { return true; } override async pause() { phases.push((this as any).phase); await super.pause(); } }
    const summary = await worldScan.scanWorld(bot, { slicer: new Spent(0, async () => undefined) });
    const reads = phases.filter(phase => phase === '要約の読み').length;
    // Three pools and two spawners: a turn of the loop after each (before, the whole summary was one hold).
    expect(summary.rows.filter((row: string) => row.startsWith('溶岩の溜まり'))).toHaveLength(3);
    expect(summary.rows.filter((row: string) => row.startsWith('スポナー'))).toHaveLength(2);
    expect(reads).toBeGreaterThanOrEqual(5);
    expect(summary.longestSliceWords).toMatch(/^(状態の表とチャンクの一覧|ブロック読み|要約の読み|要約の文)(・CPU [\d.]+ ms)?・GC /u);
  }, 120_000);

  it('heavy Nether and overworld, 441 chunks each, a heap of a few hundred MB beside it: every hold 10 ms or less (printed as [scan r7])', async () => {
    const kept: unknown[] = [];
    for (let i = 0; i < 2_000_000; i++) kept.push({ i, v: [i] });
    const lines: string[] = [];
    for (const [label, world, dimension, at] of [['Nether', heavyNether(), 'the_nether', new Vec3(40.5, 66, 40.5)], ['overworld', heavyOverworld(), 'overworld', new Vec3(8.5, 65, 8.5)]] as const) {
      const bot = Object.assign(new EventEmitter(), {
        entity: { id: 1, position: at, yaw: 0, onGround: true }, entities: {}, game: { dimension }, registry: L!.registry, world: world.sync, health: 20, food: 20,
        inventory: { items: () => [] }, blockAt: (position: Vec3, extraInfos?: boolean) => world.sync.getBlock(position, extraInfos),
      }) as any;
      const runs: Array<{ longest: number; words: string; gap: number; ms: number; rows: number }> = [];
      for (let i = 0; i < 3; i++) {
        // The loop's other work beside the scan: garbage made at each turn (packets at a login).
        let running = true, last = performance.now(), gap = 0;
        const churn = () => { const now = performance.now(); gap = Math.max(gap, now - last); last = now; const junk: unknown[] = []; for (let j = 0; j < 2000; j++) junk.push({ j }); if (running) setImmediate(churn); };
        setImmediate(churn);
        const scan = await worldScan.scanWorld(bot);
        running = false;
        runs.push({ longest: scan.longestSliceMs, words: scan.longestSliceWords, gap: Math.round(gap * 10) / 10, ms: scan.ms, rows: scan.rows.length });
        expect(scan.chunks).toBe(441);
      }
      lines.push(`${label}: ${runs.map(run => `${run.ms} ms, longest ${run.longest} ms (${run.words}), ${run.rows} rows`).join(' / ')}`);
      const sorted = runs.map(run => run.longest).sort((a, b) => a - b);
      expect(sorted[1], label).toBeLessThanOrEqual(10);
    }
    // eslint-disable-next-line no-console
    console.log(`[scan r7] ${lines.join(' | ')}`);
    expect(kept.length).toBe(2_000_000);
  }, 300_000);

  it('the spawn scan\'s log line says the longest hold\'s phase, CPU and collections', async () => {
    const world = heavyNether();
    const lines: string[] = [];
    const bot = Object.assign(new EventEmitter(), {
      entity: { id: 1, position: new Vec3(40.5, 66, 40.5), yaw: 0, onGround: true }, entities: {}, game: { dimension: 'the_nether', serverViewDistance: 10 },
      registry: L!.registry, world: world.sync, health: 20, food: 20, inventory: { items: () => [] }, llmCentric: true, settings: { viewDistance: 10 },
      blockAt: (position: Vec3, extraInfos?: boolean) => world.sync.getBlock(position, extraInfos),
    }) as any;
    worldScan.installSpawnScan(bot, { minWaitMs: 0, pollMs: 5, log: (line: string) => lines.push(line) });
    bot.emit('spawn');
    await vi.waitFor(() => expect(lines.length).toBe(1), { timeout: 20_000, interval: 20 });
    expect(lines[0]).toMatch(/longest slice [\d.]+ ms \((状態の表とチャンクの一覧|ブロック読み|要約の読み|要約の文)(・CPU [\d.]+ ms)?・GC [^)]*\), \d+ rows$/u);
    // Not in the observation (the frame's digest stays as it was).
    expect(bot.worldScan.longestSliceWords).toBeUndefined();
    expect(bot.worldScanCost.longestSliceWords).toBeTruthy();
  }, 60_000);
});
