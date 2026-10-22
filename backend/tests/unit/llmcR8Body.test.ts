import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { describe, expect, it, vi } from 'vitest';

// r8 (2026-10-22, run 32): the body's small facts. The footing (what is round the feet that falls three or more, or into lava), `probe around`
// and `probe column` saying it (the map shows no fall deeper than five; a body buried in stone saw no number for the way up), and whose a
// protected block is (a bed the body placed 200 s before stopped its dig as "守られた物"). The scenes of the run itself are in llmcR8Scene.
vi.mock('../../src/services/minebot/utils/exposureGuard.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/services/minebot/utils/exposureGuard.js')>();
  return { ...actual, threatsExposedBy: () => [] };
});
vi.mock('../../src/services/minebot/utils/digBlockVerified.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/services/minebot/utils/digBlockVerified.js')>();
  return { ...actual, digBlockVerified: vi.fn(async (bot: any, block: any) => {
    bot.__dug.push(`${block.position.x},${block.position.y},${block.position.z}`);
    bot.__blocks.set(`${block.position.x},${block.position.y},${block.position.z}`, { name: 'air', boundingBox: 'empty' });
    return { stateId: 0, blockName: 'air' };
  }) };
});

const { footingAt, footingWords, dropUnder } = await import('../../src/services/minebot/utils/voidFooting.js');
const { probeAround, probeColumn } = await import('../../src/services/minebot/utils/probeTools.js');
const { noteOwned, noteSpawnBed, ownedAt, ownedBlocksPlugin, ownerWords } = await import('../../src/services/minebot/utils/ownedBlocks.js');
const { bedHalves } = await import('../../src/services/minebot/utils/bedRules.js');
const { dig } = await import('../../src/services/minebot/utils/primitives/dig.js');

type Cell = { name: string; solid: boolean };
const AIR: Cell = { name: 'air', solid: false }, STONE: Cell = { name: 'stone', solid: true }, DIRT: Cell = { name: 'dirt', solid: true };
const BRICKS: Cell = { name: 'nether_bricks', solid: true }, LAVA: Cell = { name: 'lava', solid: false }, WATER: Cell = { name: 'water', solid: false };
const reader = (shape: (x: number, y: number, z: number) => Cell | null) => (x: number, y: number, z: number) => shape(x, y, z);

/** Run 32's bridge: nether bricks at y 54, z 0, x 225 to 256, air round it, a lava sea at y 28 and under. */
const bridge = (x: number, y: number, z: number): Cell => (y <= 28 ? LAVA : y === 54 && z === 0 && x >= 225 && x <= 256 ? BRICKS : AIR);

describe('the footing: the cells round the feet that fall three or more, or into lava', () => {
  it('a bridge one wide over a lava sea: seven voids at its tip, six in its middle, 26 deep, lava; and the words', () => {
    const tip = footingAt(reader(bridge), { x: 225, y: 55, z: 0 });
    expect(tip).toMatchObject({ count: 7, deepest: 26, lava: true, bridge: true, pillar: false });
    const middle = footingAt(reader(bridge), { x: 240, y: 55, z: 0 });
    expect(middle).toMatchObject({ count: 6, bridge: true });
    expect(footingWords(middle)).toBe('幅 1 の橋・左右とも空所（落差 26、下は溶岩）');
    expect(dropUnder(reader(bridge), 240, 55, 1)).toMatchObject({ drop: 26, lava: true });
  });

  it('a floor, a drop of two, a drop into water, a wall and a cell not loaded are no void; a pillar and a ledge are told as what they are', () => {
    const floor = (x: number, y: number, z: number): Cell => (y < 64 ? STONE : AIR);
    expect(footingAt(reader(floor), { x: 0, y: 64, z: 0 })).toMatchObject({ count: 0, bridge: false });
    expect(footingWords(footingAt(reader(floor), { x: 0, y: 64, z: 0 }))).toBe('');
    // A drop of two (the neighbour's floor two lower): not a void; three: one.
    const step = (depth: number) => (x: number, y: number, z: number): Cell => (y >= 64 ? AIR : x === 0 && z === 0 ? STONE : y < 64 - depth ? STONE : AIR);
    expect(footingAt(reader(step(2)), { x: 0, y: 64, z: 0 }).count).toBe(0);
    expect(footingAt(reader(step(3)), { x: 0, y: 64, z: 0 }).count).toBe(8);
    // Into water: no damage.
    const pond = (x: number, y: number, z: number): Cell => (y >= 64 ? AIR : x === 0 && z === 0 ? STONE : y === 56 ? WATER : y < 56 ? STONE : AIR);
    expect(footingAt(reader(pond), { x: 0, y: 64, z: 0 }).count).toBe(0);
    // A wall beside the feet (stone at feet height) is nothing to fall into.
    const walled = (x: number, y: number, z: number): Cell => (x === 1 && y >= 64 && y <= 66 ? STONE : y < 64 && !(x === 0 && z === 0) ? AIR : y < 64 ? STONE : AIR);
    expect(footingAt(reader(walled), { x: 0, y: 64, z: 0 }).sides.some(side => side.dx === 1)).toBe(false);
    // Not loaded: unknown, not a void.
    expect(footingAt(reader((x, y, z) => (x === 0 && z === 0 ? (y < 64 ? STONE : AIR) : null)), { x: 0, y: 64, z: 0 }).count).toBe(0);
    // A pillar: four sides.
    const pillar = (x: number, y: number, z: number): Cell => (y >= 64 ? AIR : x === 0 && z === 0 ? STONE : y > 30 ? AIR : STONE);
    expect(footingAt(reader(pillar), { x: 0, y: 64, z: 0 })).toMatchObject({ count: 8, pillar: true, bridge: false });
    expect(footingWords(footingAt(reader(pillar), { x: 0, y: 64, z: 0 }))).toBe('幅 1 の足場・四方とも空所（落差 33）');
    // A ledge: the cells beyond one edge.
    const ledge = (x: number, y: number, z: number): Cell => (y >= 64 ? AIR : z >= 0 ? STONE : AIR);
    expect(footingWords(footingAt(reader(ledge), { x: 0, y: 64, z: 0 }))).toBe('周り 8 マスのうち空所 3（落差 48 以上）');
  });
});

describe('lava beside the feet', () => {
  it('is a void with no depth (a push into it, nothing to fall through): "隣が溶岩"', () => {
    const beside = (x: number, y: number, z: number): Cell => (x === 1 && z === 0 && y === 64 ? LAVA : y < 64 ? STONE : AIR);
    const footing = footingAt(reader(beside), { x: 0, y: 64, z: 0 });
    expect(footing).toMatchObject({ count: 1, lava: true, deepest: 0 });
    expect(footingWords(footing)).toBe('周り 8 マスのうち空所 1（隣が溶岩）');
  });
});

describe('probe around says the footing first, and what a drop ends on', () => {
  it('on the bridge: "足場: 幅 1 の橋・左右とも空所（落差 26、下は溶岩）。押されたら落ちる" before the dangers, and the footing as a field', () => {
    const answer = probeAround(reader(bridge), { x: 240.5, y: 55, z: 0.5 }, [], 8);
    expect(answer.footing).toMatchObject({ voids: 6, deepest: 26, lava: true, bridge: true });
    expect(answer.text.startsWith('足場: 幅 1 の橋・左右とも空所（落差 26、下は溶岩）。押されたら落ちる。')).toBe(true);
    expect(answer.dangers.filter(danger => danger.kind === 'drop').every(danger => danger.bottom === 'lava')).toBe(true);
    expect(answer.text).toContain('（落差 26、底は溶岩）');
  });
  it('on a floor there is no footing line and no field', () => {
    const answer = probeAround(reader((x, y, z) => (y < 64 ? STONE : AIR)), { x: 0.5, y: 64, z: 0.5 }, [], 8);
    expect(answer.footing).toBeUndefined();
    expect(answer.text).not.toContain('足場');
  });
});

describe('probe column: what is over the head (run 32: respawned in stone at y=48, 860 s of bare-handed stairs up)', () => {
  // Stone y 50 to 62, dirt 63 and 64, air from 65; the body's feet at 48 in a pocket (air 48, 49).
  const buried = (x: number, y: number, z: number): Cell => (y === 48 || y === 49 ? AIR : y <= 62 ? STONE : y <= 64 ? DIRT : AIR);
  it('says how many cells are solid up to the first open one, of what, and the seconds one of each takes with the tool carried', () => {
    const ms = (_x: number, y: number) => (y <= 62 ? 7700 : 750);
    const answer = probeColumn(reader(buried), 0, 0, 32, 64, { x: 0, y: 48, z: 0 }, ms);
    expect(answer.above).toMatchObject({ solid: 15, openAt: 65, opensTo: '空気', seconds: 102 });
    expect(answer.above!.runs).toEqual([{ name: 'stone', n: 13, each: 7.7 }, { name: 'dirt', n: 2, each: 0.8 }]);
    expect(answer.text).toContain('真上: 頭の上 y=50〜64 の 15 段が固い（stone×13・dirt×2）、y=65 から空気。今の持ち物で 1 段 stone 約 7.7 秒・dirt 約 0.8 秒（合わせて約 102 秒）');
  });
  it('without the seconds (no digTime) the numbers of cells are still said; a clear head says nothing; another column has no "above"', () => {
    const answer = probeColumn(reader(buried), 0, 0, 32, 64, { x: 0, y: 48, z: 0 });
    expect(answer.above?.seconds).toBeNull();
    expect(answer.text).toContain('真上: 頭の上 y=50〜64 の 15 段が固い（stone×13・dirt×2）、y=65 から空気。');
    expect(answer.text).not.toContain('今の持ち物で');
    expect(probeColumn(reader(buried), 0, 0, 32, 64, { x: 0, y: 65, z: 0 }).above).toBeUndefined();
    expect(probeColumn(reader(buried), 3, 3, 32, 64, { x: 0, y: 48, z: 0 }).above).toBeUndefined();
  });
});

// ===== whose a block is =====

function digBody() {
  const blocks = new Map<string, any>();
  const bot: any = Object.assign(new EventEmitter(), {
    __blocks: blocks, __dug: [] as string[],
    entity: { position: new Vec3(0.5, 64, 0.5), yaw: 0, onGround: true },
    health: 20, food: 20, game: { dimension: 'overworld' }, entities: {},
    registry: { blocksByName: { cobblestone: { id: 1 }, stone: { id: 2 } }, itemsByName: {}, items: {} },
    inventory: { items: () => [] as any[], slots: new Array(46).fill(null) }, heldItem: null,
    blockAt: (p: Vec3) => {
      const key = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
      const position = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
      if (blocks.has(key)) return { diggable: true, hardness: 1, ...blocks.get(key), position };
      return position.y < 64 ? { name: 'stone', boundingBox: 'block', diggable: true, hardness: 1.5, position } : { name: 'air', boundingBox: 'empty', position };
    },
    setControlState: () => undefined, clearControlStates: () => undefined,
  });
  return bot;
}
const ctx = (bot: any) => ({ bot, stop: new AbortController().signal, deadline: Date.now() + 30_000, facing: 'north' as const, base: { x: 0, y: 64, z: 0 } });
const BED = { name: 'black_bed', boundingBox: 'block' };

describe('dig: a protected block the body put there itself is dug; any other is stopped with whose it is not known to be', () => {
  it('an unknown bed: stopped "守られた物", saying nobody is known to own it, and the hand\'s real field (takeOk)', async () => {
    const bot = digBody();
    bot.__blocks.set('1,64,0', BED);
    const out = await dig(ctx(bot), { at: [{ x: 1, y: 64, z: 0 }] });
    expect(out).toMatchObject({ ok: false, reason: 'protected' });
    expect(out.text).toContain('誰の物か分からない: 自分で置いた記録もスポーン地点のベッドでもない');
    expect(out.text).toContain('壊すなら takeOk:true');
    expect(bot.__dug).toEqual([]);
    // takeOk digs it, as before.
    expect((await dig(ctx(bot), { at: [{ x: 1, y: 64, z: 0 }], take: true, collect: false })).ok).toBe(true);
  });

  it('a bed the body placed (the ledger, by the place hand or by any skill through mineflayer\'s blockPlaced) is dug, and the line says whose it was', async () => {
    const bot = digBody();
    ownedBlocksPlugin(bot);
    bot.__blocks.set('1,64,0', BED);
    bot.__blocks.set('1,64,1', BED);
    bot.__blocks.set('2,64,0', { name: 'chest', boundingBox: 'block' });
    // Any skill's placement: the foot arrives with its properties, the head is the other cell of the pair.
    const foot = { name: 'black_bed', position: new Vec3(1, 64, 0), getProperties: () => ({ part: 'foot', facing: 'south', occupied: false }) };
    bot.emit('blockPlaced', { name: 'air' }, foot);
    const out = await dig(ctx(bot), { at: [{ x: 1, y: 64, z: 0 }, { x: 1, y: 64, z: 1 }], collect: false });
    expect(out.ok).toBe(true);
    expect(out.text).toMatch(/\(1,64,0\) black_bed を掘った（[^）]*自分で置いた物（\d+秒前）[^）]*）/u);
    expect(out.text).toMatch(/\(1,64,1\) black_bed を掘った（[^）]*自分で置いた物/u);
    // A chest nobody put there is still stopped.
    expect((await dig(ctx(bot), { at: [{ x: 2, y: 64, z: 0 }] })).reason).toBe('protected');
  });

  it('the bed slept in (the spawn point) is the body\'s own; a ledger entry for another block is not (the cell holds something else now)', async () => {
    const bot = digBody();
    bot.__blocks.set('1,64,0', { name: 'red_bed', boundingBox: 'block' });
    noteSpawnBed(bot, [{ x: 1, y: 64, z: 0 }], 'red_bed');
    expect(ownedAt(bot, { x: 1, y: 64, z: 0 }, 'red_bed')).toMatchObject({ kind: 'spawn_bed' });
    expect(ownerWords(ownedAt(bot, { x: 1, y: 64, z: 0 }, 'red_bed')!)).toBe('自分のスポーン地点のベッド');
    const out = await dig(ctx(bot), { at: [{ x: 1, y: 64, z: 0 }], collect: false });
    expect(out.ok).toBe(true);
    expect(out.text).toContain('自分のスポーン地点のベッド');
    // The cell was a placed chest; a village's chest stands there now.
    noteOwned(bot, { x: 3, y: 64, z: 0 }, 'cobblestone');
    bot.__blocks.set('3,64,0', { name: 'chest', boundingBox: 'block' });
    expect(ownedAt(bot, { x: 3, y: 64, z: 0 }, 'chest')).toBeNull();
    expect((await dig(ctx(bot), { at: [{ x: 3, y: 64, z: 0 }] })).reason).toBe('protected');
    // Not in another dimension.
    bot.game.dimension = 'the_nether';
    expect(ownedAt(bot, { x: 1, y: 64, z: 0 }, 'red_bed')).toBeNull();
  });

  it('bedHalves reads the pair from the block\'s own state: the foot\'s head lies the way it faces, the head\'s foot the other way', () => {
    const block = (part: string, facing: string) => ({ getProperties: () => ({ part, facing }) });
    expect(bedHalves(block('foot', 'south'), { x: 5, y: 64, z: 3 })).toMatchObject({ foot: { x: 5, y: 64, z: 3 }, head: { x: 5, y: 64, z: 4 }, other: { x: 5, y: 64, z: 4 } });
    expect(bedHalves(block('head', 'south'), { x: 5, y: 64, z: 4 })).toMatchObject({ foot: { x: 5, y: 64, z: 3 }, head: { x: 5, y: 64, z: 4 }, other: { x: 5, y: 64, z: 3 } });
    expect(bedHalves(block('foot', 'west'), { x: 5, y: 64, z: 3 })?.head).toEqual({ x: 4, y: 64, z: 3 });
    expect(bedHalves(block('foot', 'north'), { x: 5, y: 64, z: 3 })?.head).toEqual({ x: 5, y: 64, z: 2 });
    expect(bedHalves(block('foot', 'east'), { x: 5, y: 64, z: 3 })?.head).toEqual({ x: 6, y: 64, z: 3 });
    expect(bedHalves({}, { x: 0, y: 0, z: 0 })).toBeNull();
  });
});
