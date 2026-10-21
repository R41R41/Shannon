import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { describe, expect, it, vi } from 'vitest';

// r5 (2026-10-22, run 28): the body's fixes. A walk that has not arrived says so and why; doors and leaves are passed inside the walk, by
// the one rule probe path also reads; a target no body stands in is said by both; a dig the eye cannot see is not tried; a pickup that
// fails says where the item lies; a chest counts what it gave; the scan at a spawn waits for the chunks.
const exposure = vi.hoisted(() => ({ threats: [] as any[] }));
vi.mock('../../src/services/minebot/utils/exposureGuard.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/services/minebot/utils/exposureGuard.js')>();
  return { ...actual, threatsExposedBy: () => exposure.threats };
});
vi.mock('../../src/services/minebot/utils/digBlockVerified.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/services/minebot/utils/digBlockVerified.js')>();
  return { ...actual, digBlockVerified: vi.fn(async (bot: any, block: any) => { bot.__dug.push(`${block.position.x},${block.position.y},${block.position.z}`); bot.__blocks.set(`${block.position.x},${block.position.y},${block.position.z}`, { name: 'air', boundingBox: 'empty' }); return { stateId: 0, blockName: 'air' }; }) };
});
// A fake body has no registry for the route search's movements: it gets a stand-in (the real one is built in the A* tests below).
vi.mock('../../src/services/minebot/utils/setMovements.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/services/minebot/utils/setMovements.js')>();
  return { ...actual, buildMovements: (bot: any, ...rest: any[]) => bot.__fakeMovements ? { getBlock: () => null, getNeighbors: () => [], exclusionAreasBreak: [] } : (actual.buildMovements as any)(bot, ...rest) };
});

const { walk, walkMovements } = await import('../../src/services/minebot/utils/primitives/walk.js');
const { dig } = await import('../../src/services/minebot/utils/primitives/dig.js');
const { pickup } = await import('../../src/services/minebot/utils/primitives/pickup.js');
const { chest } = await import('../../src/services/minebot/utils/primitives/chest.js');
const { probePath } = await import('../../src/services/minebot/utils/probeTools.js');
const { bodyReader } = await import('../../src/services/minebot/utils/localMap.js');
const { installSpawnScan } = await import('../../src/services/minebot/utils/worldScan.js');
const { closedWord } = await import('../../src/services/minebot/utils/actReport.js');
const { cellWay, standable, whyNotStand } = await import('../../src/services/minebot/utils/walkRules.js');

/** A fake body: blocks from a map (stone under y 64, air from 64), a route search that answers as `goto` says. */
function body(goto?: (bot: any, goal: any) => Promise<void>) {
  const blocks = new Map<string, any>();
  const bot: any = Object.assign(new EventEmitter(), {
    __blocks: blocks, __dug: [] as string[], __fakeMovements: true,
    entity: { position: new Vec3(0.5, 64, 0.5), yaw: 0, onGround: true },
    health: 20, food: 20, game: { dimension: 'overworld' }, entities: {} as Record<number, any>,
    registry: { blocksByName: { cobblestone: { id: 1 }, stone: { id: 2 } }, itemsByName: {}, items: {} },
    inventory: { items: () => [] as any[], slots: new Array(46).fill(null) },
    heldItem: null,
    blockAt: (p: Vec3) => {
      const key = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
      const position = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
      if (blocks.has(key)) return { diggable: true, hardness: 1, ...blocks.get(key), position };
      return position.y < 64 ? { name: 'stone', boundingBox: 'block', diggable: true, hardness: 1.5, position } : { name: 'air', boundingBox: 'empty', position };
    },
    setControlState: () => undefined, clearControlStates: () => undefined, stopDigging: () => undefined,
  });
  bot.pathfinder = { movements: null, setMovements(m: unknown) { this.movements = m; }, stop: () => undefined, setGoal: () => undefined,
    goto: vi.fn(async (goal: any) => { await goto?.(bot, goal); }) };
  return bot;
}
const ctx = (bot: any) => ({ bot, stop: new AbortController().signal, deadline: Date.now() + 30_000, facing: 'north' as const, base: { x: 0, y: 64, z: 0 } });
const stone = { name: 'stone', boundingBox: 'block' };

describe('walk: over only when the feet are at the target (run 28: "着いた（0m）" without moving, ~350 s)', () => {
  it('a route search that returns without a step is a stop: not arrived, the feet now, what is left, the head-height block in the way', async () => {
    const bot = body();
    bot.__blocks.set('1,65,0', stone);
    const out = await walk(ctx(bot), { to: { x: 2, y: 64, z: 0 } });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('not_arrived');
    expect(closedWord(out.reason)).toBe('一歩ではない');
    expect(out.text).toContain('(2,64,0) に着いていない（今 (0,64,0)');
    expect(out.text).toContain('的まで 2.0m');
    expect(out.text).toContain('頭の高さ (1,65,0) が stone');
    expect(out.from).toEqual({ x: 0, y: 64, z: 0 });
  });

  it('a step of two is said as one ("段差 2"); with range, the range is said with what is left', async () => {
    const bot = body();
    bot.__blocks.set('1,64,0', stone); bot.__blocks.set('1,65,0', stone);
    const out = await walk(ctx(bot), { to: { x: 3, y: 64, z: 0 }, range: 1 });
    expect(out.reason).toBe('not_arrived');
    expect(out.text).toContain('段差 2');
    expect(out.text).toContain('的まで 3.0m（range 1）');
  });

  it('a walk that gets there says it, with the doors it opened and the leaves it broke on the way', async () => {
    const door = { name: 'oak_door', boundingBox: 'block', getProperties: () => ({ open: bot.__open, half: 'lower' }) };
    const upper = { name: 'oak_door', boundingBox: 'block', getProperties: () => ({ open: bot.__open, half: 'upper' }) };
    const bot = body(async (b, goal) => {
      b.emit('path_update', { status: 'success', path: [new Vec3(1, 64, 0), new Vec3(2, 64, 0), new Vec3(3, 64, 0)] });
      await new Promise(resolve => setTimeout(resolve, 400));
      b.emit('diggingCompleted', { name: 'oak_leaves', position: new Vec3(2, 65, 0) });
      b.entity.position = new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5);
    });
    bot.__open = false;
    bot.__blocks.set('1,64,0', door); bot.__blocks.set('1,65,0', upper);
    bot.activateBlock = vi.fn(async () => { bot.__open = true; });
    const out = await walk(ctx(bot), { to: { x: 3, y: 64, z: 0 } });
    expect(out.ok).toBe(true);
    expect(bot.activateBlock).toHaveBeenCalledTimes(1);
    expect(out.text).toMatch(/^\(3,64,0\) に着いた（3m、[\d.]+秒、扉を開けた \(1,64,0\)、葉を壊した ×1）$/u);
  });

  it('a target no body stands in is not walked to: the fact, and the cells beside it a body can stand in (none chosen)', async () => {
    const bot = body();
    for (let y = 60; y < 64; y++) bot.__blocks.set(`2,${y},0`, { name: 'air', boundingBox: 'empty' });
    const out = await walk(ctx(bot), { to: { x: 2, y: 64, z: 0 } });
    expect(out.reason).toBe('target_unstandable');
    expect(out.text).toContain('(2,64,0)（自分から東2）そのものには立てない（下 4 マスが空気（立つ床が無い））');
    expect(out.text).toContain('立てる隣: (3,64,0)・(1,64,0)・(2,64,1)');
    expect(bot.pathfinder.goto).not.toHaveBeenCalled();
    const roofed = body();
    roofed.__blocks.set('2,65,0', stone);
    expect((await walk(ctx(roofed), { to: { x: 2, y: 64, z: 0 } })).text).toContain('そのものには立てない（頭の高さ (2,65,0) が stone）');
  });
});

describe('the walk\'s one rule (utils/walkRules): doors, leaves, iron doors', () => {
  it('a shut wooden door, gate or trapdoor is opened on the way, leaves are broken, a shut iron door is a wall; leaves are a floor', () => {
    expect(cellWay({ name: 'spruce_door', solid: true, open: false })).toBe('door');
    expect(cellWay({ name: 'oak_fence_gate', solid: true })).toBe('door');
    expect(cellWay({ name: 'spruce_trapdoor', solid: true, open: false })).toBe('door');
    expect(cellWay({ name: 'oak_door', solid: true, open: true })).toBe('open');
    expect(cellWay({ name: 'iron_door', solid: true, open: false })).toBe('iron_door');
    expect(cellWay({ name: 'spruce_leaves', solid: true })).toBe('leaves');
    const read = (x: number, y: number) => y === 63 ? { name: 'oak_leaves', solid: true } : y < 63 ? { name: 'stone', solid: true } : x === 1 && y === 65 ? { name: 'oak_leaves', solid: true } : { name: 'air', solid: false };
    expect(standable(read, 1, 64, 0)).toBe(true);
    expect(standable(read, 0, 64, 0)).toBe(true);
    // Leaves in the feet cell are broken on the way (passable); stone is not.
    expect(whyNotStand(read, { x: 0, y: 63, z: 0 })).toBeNull();
    expect(whyNotStand(read, { x: 0, y: 62, z: 0 })).toMatchObject({ solidFeet: true, text: '足のマスが stone で埋まっている' });
  });
});

// A real world (prismarine) and the real route search (mineflayer-pathfinder's A*) with the walk's movements, against probe path.
const require = createRequire(import.meta.url);
function lib() {
  try {
    const registry = require('prismarine-registry')('1.20.4');
    return { registry, Chunk: require('prismarine-chunk')(registry), World: require('prismarine-world')(registry), Block: require('prismarine-block')(registry),
      AStar: require('mineflayer-pathfinder/lib/astar'), Move: require('mineflayer-pathfinder/lib/move'), goals: require('mineflayer-pathfinder').goals };
  } catch { return null; }
}
const L = lib();

/** A corridor along +x at z 0 (y 64..65, stone round it), with `inside` put into it. */
function corridor(inside: Array<[number, number, number, string, Record<string, unknown>?]>) {
  const { registry, Chunk, World, Block } = L!;
  const chunk = new Chunk({ minY: -64, worldHeight: 384 });
  const put = (x: number, y: number, z: number, name: string, props?: Record<string, unknown>) => chunk.setBlockStateId(new Vec3(x, y, z & 15),
    props ? Block.fromProperties(name, props, 0).stateId : registry.blocksByName[name].defaultState);
  for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) for (let y = 56; y <= 70; y++) put(x, y, z, 'stone');
  for (let x = 1; x <= 9; x++) { put(x, 64, 0, 'air'); put(x, 65, 0, 'air'); }
  for (const [x, y, z, name, props] of inside) put(x, y, z, name, props);
  const world = new World(null, null);
  world.sync.setColumn(0, 0, chunk);
  const bot: any = Object.assign(new EventEmitter(), {
    version: '1.20.4', registry, world: world.sync, entity: { position: new Vec3(1.5, 64, 0.5), effects: {}, onGround: true }, entities: {},
    game: { dimension: 'overworld', minY: -64 }, inventory: { items: () => [], slots: new Array(46).fill(null) },
    blockAt: (p: Vec3, extra?: boolean) => world.sync.getBlock(p, extra), pathfinder: { bestHarvestTool: () => null },
  });
  return bot;
}
function route(bot: any, to: { x: number; y: number; z: number }) {
  const { AStar, Move, goals } = L!;
  const movements = walkMovements(bot, true);
  const start = new Move(1, 64, 0, movements.countScaffoldingItems(), 0);
  return new AStar(start, movements, new goals.GoalBlock(to.x, to.y, to.z), 3000).compute();
}
const doorProps = (half: string) => ({ facing: 'east', half, hinge: 'left', open: false, powered: false });

describe.skipIf(!L)('walk and probe path read the cells alike (run 28: probe "行ける" and the walk stopped at a door and leaves)', () => {
  it('a shut spruce door and leaves at head height: the route goes through (the door opened, not broken; the leaves broken), and probe says the same', async () => {
    const bot = corridor([[3, 64, 0, 'spruce_door', doorProps('lower')], [3, 65, 0, 'spruce_door', doorProps('upper')], [5, 65, 0, 'spruce_leaves', { distance: 7, persistent: true, waterlogged: false }],
      [7, 64, 0, 'spruce_trapdoor', { facing: 'east', half: 'bottom', open: false, powered: false, waterlogged: false }]]);
    const result = route(bot, { x: 9, y: 64, z: 0 });
    expect(result.status).toBe('success');
    const cells = result.path.map((node: any) => `${node.x},${node.y},${node.z}`);
    expect(cells).toContain('3,64,0');
    const broken = result.path.flatMap((node: any) => node.toBreak.map((p: any) => `${p.x},${p.y},${p.z}`));
    expect(broken).toEqual(['5,65,0']);
    expect(result.path.every((node: any) => node.toPlace.length === 0)).toBe(true);
    const probe = await probePath(bodyReader(bot), { x: 1, y: 64, z: 0 }, { x: 9, y: 64, z: 0 });
    expect(probe.reachable).toBe(true);
    expect(probe.steps).toBe(8);
  });

  it('a shut iron door: no route, and probe names it', async () => {
    const bot = corridor([[3, 64, 0, 'iron_door', doorProps('lower')], [3, 65, 0, 'iron_door', doorProps('upper')]]);
    expect(route(bot, { x: 9, y: 64, z: 0 }).status).not.toBe('success');
    const probe = await probePath(bodyReader(bot), { x: 1, y: 64, z: 0 }, { x: 9, y: 64, z: 0 });
    expect(probe.reachable).toBe(false);
    expect(probe.text).toContain('(3,64,0) は iron_door（閉じた鉄の扉は手では開かない）');
  });

  it('leaves under the feet are not broken to go down', () => {
    const bot = corridor([[4, 63, 0, 'oak_leaves', { distance: 7, persistent: true, waterlogged: false }], [4, 62, 0, 'air'], [4, 61, 0, 'air']]);
    const result = route(bot, { x: 4, y: 61, z: 0 });
    expect(result.status).not.toBe('success');
  });

  it('probe path says first when no body stands on the target itself, and how far beside it the way ends', async () => {
    const bot = corridor([[6, 63, 0, 'air'], [6, 62, 0, 'air']]);
    const probe = await probePath(bodyReader(bot), { x: 1, y: 64, z: 0 }, { x: 6, y: 64, z: 0 });
    expect(probe.onTarget).toBe(false);
    expect(probe.text).toMatch(/^的そのものには立てない（下 2 マスが空気（立つ床が無い））。隣 \(\d+,\d+,0\) まで。/u);
  });
});

describe('dig: the eye has to see the block (run 28: "Digging aborted" ×31 behind stone)', () => {
  it('a cell behind stone is not dug: "見えない：間に (x,y,z) stone"; dug from the near end, the same row goes', async () => {
    const bot = body();
    for (const key of ['1,64,0', '1,65,0', '2,64,0']) bot.__blocks.set(key, stone);
    const out = await dig(ctx(bot), { at: [{ x: 2, y: 64, z: 0 }] });
    expect(out.reason).toBe('not_visible');
    expect(closedWord(out.reason)).toBe('掘れない');
    expect(out.text).toMatch(/見えない：間に \(1,6[45],0\) stone/u);
    expect(bot.__dug).toEqual([]);
    const row = await dig(ctx(bot), { at: [{ x: 1, y: 65, z: 0 }, { x: 1, y: 64, z: 0 }, { x: 2, y: 64, z: 0 }], collect: false });
    expect(row.ok).toBe(true);
    expect(bot.__dug).toEqual(['1,65,0', '1,64,0', '2,64,0']);
  });
});

describe('pickup: a failure says where the item lies (run 28: 19 "拾えなかった" with no place)', () => {
  it('the item\'s cell, its way and distance from her, out of her reach, and the stone between', async () => {
    const bot = body();
    bot.__blocks.set('2,64,0', stone); bot.__blocks.set('2,65,0', stone);
    bot.entities = { 7: { id: 7, name: 'item', position: new Vec3(3.5, 64, 0.5), getDroppedItem: () => ({ name: 'coal' }) } };
    const out = await pickup(ctx(bot), { ids: [7] });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('not_picked');
    expect(out.text).toContain('coal（そこまで着けない。(3,64,0) 自分から東3・3.0m、拾える所（体から横 1.4m・上 2.3m・下 0.7m）に無い、間に (2,64,0) stone');
    expect(out.text).toContain('壁: 段差 2');
  });
});

describe('chest: what it took, counted in the open window (run 28: "iron_pickaxe×0 を取った" for what it took)', () => {
  it('counts the container and the window\'s pack slots, not the pack that is only brought up to date on closing', async () => {
    const bot = body();
    bot.__blocks.set('1,64,0', { name: 'chest', boundingBox: 'block' });
    const container = [{ name: 'iron_pickaxe', count: 1, type: 40 }, { name: 'bread', count: 3, type: 41 }];
    const pack: any[] = [];
    const window = {
      containerItems: () => container.filter(item => item.count > 0),
      items: () => pack,
      withdraw: async (type: number, _meta: unknown, count: number) => {
        const item = container.find(entry => entry.type === type)!;
        item.count -= count;
        pack.push({ name: item.name, count, type });
      },
      close: () => undefined,
    };
    bot.openContainer = async () => window;
    const out = await chest(ctx(bot), { at: { x: 1, y: 64, z: 0 }, takeAll: true });
    expect(out.ok).toBe(true);
    expect(out.text).toContain('iron_pickaxe×1 を取った');
    expect(out.text).toContain('bread×3 を取った');
    expect(out.text).not.toContain('×0 を取った');
    expect(out.text).toContain('の中身: 空（前は iron_pickaxe×1 bread×3）');
  });
});

describe.skipIf(!L)('the scan at a spawn waits for the chunks (run 28: 25 of 441, 2.6 s after the login)', () => {
  it('runs when most of the view distance has come, and says how many chunks, out to which ring, of what view distance', async () => {
    const { registry, Chunk, World } = L!;
    const chunk = new Chunk({ minY: -64, worldHeight: 384 });
    for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) chunk.setBlockStateId(new Vec3(x, 63, z), registry.blocksByName.grass_block.defaultState);
    const world = new World(null, null);
    for (let cx = -10; cx <= 10; cx++) for (let cz = -10; cz <= 10; cz++) world.sync.setColumn(cx, cz, chunk);
    const all = world.sync.getColumns();
    const near = all.filter((entry: any) => Math.abs(entry.chunkX) <= 2 && Math.abs(entry.chunkZ) <= 2);
    const began = Date.now();
    const sync = Object.create(world.sync);
    sync.getColumns = () => (Date.now() - began < 300 ? near : all);
    const bot: any = Object.assign(new EventEmitter(), {
      entity: { id: 1, position: new Vec3(8.5, 64, 8.5), yaw: 0, onGround: true }, entities: {}, game: { dimension: 'overworld', serverViewDistance: 10 },
      registry, world: sync, inventory: { items: () => [] }, llmCentric: true, arrival: { kind: 'login', at: Date.now() },
      blockAt: (position: Vec3, extra?: boolean) => world.sync.getBlock(position, extra),
    });
    installSpawnScan(bot, { minWaitMs: 20, settleMs: 20, pollMs: 5 });
    bot.emit('spawn');
    await vi.waitFor(() => expect(bot.worldScan).toBeDefined(), { timeout: 5000, interval: 10 });
    expect(bot.worldScan.chunks).toBe(441);
    expect(bot.worldScan).toMatchObject({ radiusChunks: 10, viewDistance: 10 });
    expect(bot.worldScan.waitedMs).toBeGreaterThanOrEqual(290);
    expect(bot.worldScan.rows[0]).toMatch(/^範囲 読み込み 441 チャンク・半径 10 チャンク（約 \d+m）・描画の距離 10（441 チャンクの 100%）・待ち [\d.]+ 秒$/u);
    expect(bot.worldScan.text).toContain('（読み込み 441 チャンク・半径 10 チャンク');
  });
});
