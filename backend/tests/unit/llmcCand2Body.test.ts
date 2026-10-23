import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { describe, expect, it, vi } from 'vitest';

// mb-llmc-cand 2 (2026-10-23, run 36): the body's part of what the run found. One reach for the hand; a walk that does not move says what holds it;
// the map's symbols told apart by how the walk treats them; the water round her as sources and flow.
vi.mock('../../src/services/minebot/utils/digBlockVerified.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/services/minebot/utils/digBlockVerified.js')>();
  return { ...actual, digBlockVerified: vi.fn(async () => ({ stateId: 0, blockName: 'air' })) };
});
vi.mock('../../src/services/minebot/utils/setMovements.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/services/minebot/utils/setMovements.js')>();
  return { ...actual, buildMovements: (bot: any, ...rest: any[]) => bot.__fakeMovements ? { getBlock: () => null, getNeighbors: () => [], exclusionAreasBreak: [] } : (actual.buildMovements as any)(bot, ...rest) };
});

const { walk, walkMovements } = await import('../../src/services/minebot/utils/primitives/walk.js');
const { dig } = await import('../../src/services/minebot/utils/primitives/dig.js');
const { DIG_REACH, USE_REACH } = await import('../../src/services/minebot/utils/primitives/common.js');
const { BLOCK_REACH } = await import('../../src/services/minebot/utils/blockReach.js');
const { probeAround, probePath, probeSight, BLOCK_REACH: SIGHT_REACH } = await import('../../src/services/minebot/utils/probeTools.js');
const { bodyReader, symbolFor, MAP_LEGEND } = await import('../../src/services/minebot/utils/localMap.js');
const { cellWay } = await import('../../src/services/minebot/utils/walkRules.js');
type MapBlock = import('../../src/services/minebot/utils/localMap.js').MapBlock;

// ===== 1. one reach =====

describe('one reach for the hand: dig, place, use, sight and path say the same number and stop at it (run 36: dig 5, sight 4.5, six digs at 5.2-5.8)', () => {
  it('the constants are one', () => {
    expect(BLOCK_REACH).toBe(5);
    expect(DIG_REACH).toBe(BLOCK_REACH);
    expect(USE_REACH).toBe(BLOCK_REACH);
    expect(SIGHT_REACH).toBe(BLOCK_REACH);
  });

  it('sight: a block 4.8 m from the eye is in reach (4.5 said no), 5.3 m is not; the text says 5m', () => {
    const stone: MapBlock = { name: 'stone', solid: true }, air: MapBlock = { name: 'air', solid: false };
    const read = (x: number, y: number, z: number) => (x === 5 && y === 64 && z === 0 ? stone : air);
    // Eye at x 0.9: the centre of (5,64,0) is 4.6 m away (4.5 said "届かない"), the centre of (6,64,0) 5.6 m.
    const mid = probeSight(read, [0.9, 64.5, 0.5], { block: { x: 5, y: 64, z: 0 } });
    expect(mid).toMatchObject({ distance: 4.6, reach: true, reachLimit: 5 });
    const far = probeSight((x, y, z) => (x === 6 && y === 64 && z === 0 ? stone : air), [0.9, 64.5, 0.5], { block: { x: 6, y: 64, z: 0 } });
    expect(far.reach).toBe(false);
    expect(far.text).toContain('届かない、掘る・使う・置くは 5m まで');
  });

  it('dig: a cell 5.4 m from the eye stops with "5m まで"; one 4.8 m away is tried', async () => {
    const blocks = new Map<string, any>();
    const bot: any = Object.assign(new EventEmitter(), {
      entity: { position: new Vec3(0.5, 64, 0.5), yaw: 0, onGround: true }, health: 20, food: 20, game: { dimension: 'overworld' }, entities: {},
      registry: { blocksByName: {}, itemsByName: {}, items: {} }, inventory: { items: () => [], slots: new Array(46).fill(null) }, heldItem: null,
      blockAt: (p: Vec3) => {
        const key = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
        const position = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
        return blocks.get(key) ?? (position.y < 64 ? { name: 'stone', boundingBox: 'block', diggable: true, hardness: 1.5, position } : { name: 'air', boundingBox: 'empty', position });
      },
      setControlState: () => undefined, clearControlStates: () => undefined, stopDigging: () => undefined,
    });
    const ctx = { bot, stop: new AbortController().signal, deadline: Date.now() + 30_000, facing: 'north' as const, base: { x: 0, y: 64, z: 0 } };
    // The eye is at (0.5, 65.62, 0.5): the centre of (4,63,3) is 5.4 m away, that of (4,63,2) 4.98 m.
    const far = await dig(ctx as any, { at: [{ x: 4, y: 63, z: 3 }] });
    expect(far.reason).toBe('out_of_reach');
    expect(far.text).toMatch(/に届かない（目から5\.[0-9]m、5m まで）/u);
    const edge = await dig(ctx as any, { at: [{ x: 4, y: 63, z: 2 }] });
    expect(edge.reason).not.toBe('out_of_reach');
  });
});

// ===== 2. a walk that does not move says what holds it =====

function stuckBody(shape: (x: number, y: number, z: number) => any, route: Vec3[], status = 'success') {
  const bot: any = Object.assign(new EventEmitter(), {
    __fakeMovements: true,
    entity: { position: new Vec3(0.5, 64, 0.5), yaw: 0, onGround: true, isInWater: false }, health: 20, food: 20, game: { dimension: 'overworld' }, entities: {},
    registry: { blocksByName: {}, itemsByName: {}, items: {} }, inventory: { items: () => [], slots: new Array(46).fill(null) }, heldItem: null,
    blockAt: (p: Vec3) => {
      const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
      return { diggable: true, hardness: 1, ...(shape(x, y, z)), position: new Vec3(x, y, z) };
    },
    setControlState: () => undefined, clearControlStates: () => undefined, stopDigging: () => undefined,
  });
  let release: (() => void) | null = null;
  bot.pathfinder = { movements: null, setMovements(m: unknown) { this.movements = m; }, stop: () => release?.(), setGoal: () => undefined,
    goto: vi.fn(() => { bot.emit('path_update', { status, path: route }); return new Promise<void>(resolve => { release = resolve; }); }) };
  return bot;
}
const floor = (x: number, y: number, z: number) => (y < 64 ? { name: 'stone', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' });
const ctxOf = (bot: any) => ({ bot, stop: new AbortController().signal, deadline: Date.now() + 30_000, facing: 'north' as const, base: { x: 0, y: 64, z: 0 } });

describe('walk: four seconds without headway names the cells the body is in and goes to, and what the route search said (run 36: 12 "同じマスで 4 秒進めず")', () => {
  it('flowing water ahead and the body in it: the flow level, the body in water, and the search that found a way', async () => {
    const water = (level: number) => ({ name: 'water', boundingBox: 'empty', getProperties: () => ({ level }) });
    const bot = stuckBody((x, y, z) => (y === 64 && z === 0 && x >= 0 && x <= 2 ? water(x === 0 ? 5 : 3) : floor(x, y, z)), [new Vec3(1, 64, 0), new Vec3(2, 64, 0)]);
    bot.entity.isInWater = true;
    const out = await walk(ctxOf(bot) as any, { to: { x: 2, y: 64, z: 0 } });
    expect(out.ok).toBe(false);
    expect(out.text).toContain('4秒進めず止まった');
    expect(out.text).toContain('足のマス (0,64,0) は 足 water（流れ 5（0 が源、7 が先））');
    expect(out.text).toContain('次のマス (1,64,0)（東1）は 足 water（流れ 3（0 が源、7 が先））');
    expect(out.text).toContain('体: 水の中');
    expect(out.text).toContain('経路探索は道を見つけた（2 マス）が体は進まなかった');
  }, 20000);

  it('a shut trapdoor in the next cell: shut, which half, and that the walk opens it; the search that found no way is said so', async () => {
    const trapdoor = { name: 'oak_trapdoor', boundingBox: 'block', getProperties: () => ({ open: false, half: 'bottom', facing: 'east', waterlogged: false }) };
    const bot = stuckBody((x, y, z) => (x === 1 && y === 64 && z === 0 ? trapdoor : floor(x, y, z)), [], 'noPath');
    const out = await walk(ctxOf(bot) as any, { to: { x: 2, y: 64, z: 0 } });
    expect(out.text).toContain('次のマス (1,64,0)（東1）は 足 oak_trapdoor（閉じている・下半分）［歩きで開ける］');
    expect(out.text).toContain('経路探索は道が見つからないと答えた');
  }, 20000);
});

describe('walk: a door the walk tried to open and could not is said', () => {
  it('the trapdoor stayed shut: "扉の試し: … を開けようとして失敗"', async () => {
    const trapdoor = { name: 'oak_trapdoor', boundingBox: 'block', getProperties: () => ({ open: false, half: 'bottom', facing: 'east', waterlogged: false }) };
    const bot = stuckBody((x, y, z) => (x === 1 && y === 64 && z === 0 ? trapdoor : floor(x, y, z)), [new Vec3(1, 64, 0)]);
    bot.activateBlock = vi.fn(async () => { throw new Error('no reach'); });
    const out = await walk(ctxOf(bot) as any, { to: { x: 2, y: 64, z: 0 } });
    expect(bot.activateBlock).toHaveBeenCalled();
    expect(out.text).toContain('扉の試し: (1,64,0) oak_trapdoor を開けようとして失敗: no reach');
  }, 20000);
});

// ===== the walk's rules and the route search, on the real search =====

const require = createRequire(import.meta.url);
function lib() {
  try {
    const registry = require('prismarine-registry')('1.20.4');
    return { registry, Chunk: require('prismarine-chunk')(registry), World: require('prismarine-world')(registry), Block: require('prismarine-block')(registry),
      AStar: require('mineflayer-pathfinder/lib/astar'), Move: require('mineflayer-pathfinder/lib/move'), goals: require('mineflayer-pathfinder').goals };
  } catch { return null; }
}
const L = lib();

type Spec = [string, Record<string, unknown> | undefined];
function corridor(feet: Spec | null, head: Spec | null) {
  const { registry, Chunk, World, Block } = L!;
  const chunk = new Chunk({ minY: -64, worldHeight: 384 });
  const put = (x: number, y: number, z: number, spec: Spec | string) => {
    const [name, props] = typeof spec === 'string' ? [spec, undefined] : spec;
    chunk.setBlockStateId(new Vec3(x, y, z & 15), props ? Block.fromProperties(name, props, 0).stateId : registry.blocksByName[name].defaultState);
  };
  for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) for (let y = 56; y <= 70; y++) put(x, y, z, 'stone');
  for (let x = 1; x <= 9; x++) { put(x, 64, 0, 'air'); put(x, 65, 0, 'air'); }
  if (feet) put(3, 64, 0, feet);
  if (head) put(3, 65, 0, head);
  const world = new World(null, null);
  world.sync.setColumn(0, 0, chunk);
  return Object.assign(new EventEmitter(), {
    version: '1.20.4', registry, world: world.sync, entity: { position: new Vec3(1.5, 64, 0.5), effects: {}, onGround: true }, entities: {},
    game: { dimension: 'overworld', minY: -64 }, inventory: { items: () => [], slots: new Array(46).fill(null) },
    blockAt: (p: Vec3, extra?: boolean) => world.sync.getBlock(p, extra), pathfinder: { bestHarvestTool: () => null },
  }) as any;
}
const CELLS: Array<[string, Spec]> = [
  ['a shut oak trapdoor', ['oak_trapdoor', { facing: 'east', half: 'bottom', open: false, powered: false, waterlogged: false }]],
  ['an open oak trapdoor', ['oak_trapdoor', { facing: 'east', half: 'bottom', open: true, powered: false, waterlogged: false }]],
  ['a shut fence gate', ['oak_fence_gate', { facing: 'east', in_wall: false, open: false, powered: false }]],
  ['a glass pane', ['glass_pane', undefined]], ['iron bars', ['iron_bars', undefined]], ['a cobblestone wall', ['cobblestone_wall', undefined]], ['an oak fence', ['oak_fence', undefined]],
  ['a bottom slab', ['oak_slab', { type: 'bottom', waterlogged: false }]], ['flowing water 5', ['water', { level: 5 }]], ['falling water', ['water', { level: 8 }]],
  ['water source', ['water', { level: 0 }]], ['a ladder', ['ladder', { facing: 'east', waterlogged: false }]], ['scaffolding', ['scaffolding', undefined]],
  ['a sign', ['oak_sign', undefined]], ['a pressure plate', ['stone_pressure_plate', undefined]], ['a chest', ['chest', undefined]], ['cobweb', ['cobweb', undefined]],
  ['a closed iron trapdoor', ['iron_trapdoor', { facing: 'east', half: 'bottom', open: false, powered: false, waterlogged: false }]],
];
describe.skipIf(!L)('the walk\'s rules and the route search agree on what is walked through (lab of mb-llmc-cand; scaffolding was the one they differed on)', () => {
  for (const [label, spec] of CELLS) {
    for (const where of ['feet', 'head'] as const) {
      it(`${label} in the ${where} cell`, async () => {
        const bot = corridor(where === 'feet' ? spec : null, where === 'head' ? spec : null);
        const { AStar, Move, goals } = L!;
        const movements = walkMovements(bot, true);
        const start = new Move(1, 64, 0, movements.countScaffoldingItems(), 0);
        const result = new AStar(start, movements, new goals.GoalBlock(9, 64, 0), 3000).compute();
        const probe = await probePath(bodyReader(bot), { x: 1, y: 64, z: 0 }, { x: 9, y: 64, z: 0 });
        expect(probe.reachable).toBe(result.status === 'success');
      });
    }
  }
});

// ===== 3. the map's symbols =====

describe('the map\'s symbols are told apart by how the walk treats the block', () => {
  const cases: Array<[string, string]> = [
    ['oak_leaves', '%'], ['azalea_leaves', '%'], ['nether_wart_block', 'Y'], ['warped_wart_block', 'Y'], ['shroomlight', 'Y'],
    ['oak_planks', 'P'], ['spruce_stairs', 'P'], ['birch_slab', 'P'], ['bookshelf', 'P'],
    ['oak_door', 'D'], ['spruce_door', 'D'], ['oak_trapdoor', 'A'], ['jungle_trapdoor', 'A'], ['oak_fence_gate', 'J'],
    ['iron_door', 'K'], ['iron_trapdoor', 'K'],
    ['oak_fence', '+'], ['cobblestone_wall', '+'], ['nether_brick_fence', 'N'],
    ['glass', 'b'], ['glass_pane', 'b'], ['white_stained_glass_pane', 'b'], ['tinted_glass', 'b'], ['iron_bars', 'b'], ['chain', 'b'],
    ['oak_sign', 'q'], ['oak_wall_sign', 'q'], ['stone_pressure_plate', 'q'], ['oak_pressure_plate', 'q'], ['stone_button', 'q'], ['lever', 'q'],
  ];
  for (const [name, symbol] of cases) it(`${name} is ${symbol}`, () => expect(symbolFor({ name })).toBe(symbol));

  it('every new symbol is in the legend, and a symbol is one kind of walk: D, A, J are opened on the way; K is a wall; Y, P, b, + are walls; % is broken', () => {
    for (const symbol of ['Y', 'A', 'J', 'K', 'b', 'q']) expect(MAP_LEGEND).toMatch(new RegExp(`(^|[ /])${symbol} `, 'u'));
    const way = (name: string, open?: boolean) => cellWay({ name, solid: true, ...(open !== undefined ? { open } : {}) });
    expect(['oak_door', 'oak_trapdoor', 'oak_fence_gate'].map(name => way(name))).toEqual(['door', 'door', 'door']);
    expect(['iron_door', 'iron_trapdoor'].map(name => way(name))).toEqual(['iron_door', 'iron_door']);
    expect(['nether_wart_block', 'shroomlight', 'oak_planks', 'glass_pane', 'oak_fence'].map(name => way(name))).toEqual(['solid', 'solid', 'solid', 'solid', 'solid']);
    expect(way('oak_leaves')).toBe('leaves');
    expect(cellWay({ name: 'scaffolding', solid: false })).toBe('solid');
  });
});

// ===== 4. the water round her =====

describe('around: the water as sources and flow, with the facts of using it (run 36: a bucket could not take its water back)', () => {
  const STONE: MapBlock = { name: 'stone', solid: true }, AIR: MapBlock = { name: 'air', solid: false };
  const water = (level: number): MapBlock => ({ name: 'water', solid: false, level });
  it('the nearest sources and flows, the distance from the eye, reach, and a wall between', () => {
    const read = (x: number, y: number, z: number): MapBlock => {
      if (y < 64) return STONE;
      if (x === 3 && y === 64 && z === 0) return water(0);                 // a source, in reach, in the open
      if (x === -2 && y === 64 && z === 0) return water(4);                // flow 4, west
      if (x === 0 && y === 64 && z === 6) return water(0);                 // a source 6 south: out of reach
      if (x === 0 && y === 64 && z === -4) return water(0);                // a source 4 north behind a wall
      if (x === 0 && (y === 64 || y === 65) && (z === -2 || z === -1)) return STONE;
      return AIR;
    };
    const answer = probeAround(read, { x: 0.5, y: 64, z: 0.5 }, [], 8);
    expect(answer.water).toBeDefined();
    expect(answer.water!.sources).toBe(3);
    expect(answer.water!.flowing).toBe(1);
    const [near, behind, far] = answer.water!.nearestSources;
    expect(near).toMatchObject({ at: { x: 3, y: 64, z: 0 }, level: 0, reach: true, visible: true });
    expect(behind).toMatchObject({ at: { x: 0, y: 64, z: -4 }, reach: true, visible: false });
    expect(far).toMatchObject({ at: { x: 0, y: 64, z: 6 }, reach: false });
    expect(answer.water!.nearestFlowing[0]).toMatchObject({ at: { x: -2, y: 64, z: 0 }, level: 4 });
    expect(answer.text).toContain('水の内訳：源 3 マス（近い順 (3,64,0) 東 3m・同じ高さ 目から 3.2m・届く・見える');
    expect(answer.text).toContain('(0,64,-4)');
    expect(answer.text).toContain('・間に壁');
    expect(answer.text).toContain('・届かない');
    expect(answer.text).toContain('流れ 1 マス（近い順 (-2,64,0) 西 2m・同じ高さ 目から 2.3m・届く・見える・流れ 4）');
  });
  it('no water, no fields', () => {
    const answer = probeAround((x, y) => (y < 64 ? STONE : AIR), { x: 0.5, y: 64, z: 0.5 }, [], 8);
    expect(answer.water).toBeUndefined();
    expect(answer.text).not.toContain('水の内訳');
  });
});
