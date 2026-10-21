import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { describe, expect, it, vi } from 'vitest';

// The parts of act, one by one (design mb-llm-centric 4: "部品ごとの小さな試験"): what each refuses and how exactly it says so.
// A fake body; the server-confirmed dig and the dig guard's reading of hostiles are replaced, nothing else.
const exposure = vi.hoisted(() => ({ threats: [] as Array<{ name: string; id?: number; distance: number; position: { x: number; y: number; z: number } }> }));
vi.mock('../../src/services/minebot/utils/exposureGuard.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/services/minebot/utils/exposureGuard.js')>();
  return { ...actual, threatsExposedBy: () => exposure.threats };
});
vi.mock('../../src/services/minebot/utils/digBlockVerified.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/services/minebot/utils/digBlockVerified.js')>();
  return { ...actual, digBlockVerified: vi.fn(async (bot: any, block: any) => { bot.__dug.push(`${block.position.x},${block.position.y},${block.position.z}`); bot.__blocks.set(`${block.position.x},${block.position.y},${block.position.z}`, { name: 'air', boundingBox: 'empty' }); return { stateId: 0, blockName: 'air' }; }) };
});

const { dig, exposeAllows } = await import('../../src/services/minebot/utils/primitives/dig.js');
const { place } = await import('../../src/services/minebot/utils/primitives/place.js');
const { craft } = await import('../../src/services/minebot/utils/primitives/craft.js');
const { whyBlocked, reachFacts } = await import('../../src/services/minebot/utils/primitives/walk.js');
const { aimPitch, bowSpeed } = await import('../../src/services/minebot/utils/primitives/shoot.js');
const { eat } = await import('../../src/services/minebot/utils/primitives/body.js');
const { furnace } = await import('../../src/services/minebot/utils/primitives/furnace.js');
const { chest } = await import('../../src/services/minebot/utils/primitives/chest.js');
const { pillarUp } = await import('../../src/services/minebot/utils/primitives/pillarUp.js');
const { use, lineBlocker } = await import('../../src/services/minebot/utils/primitives/use.js');
const { aroundText } = await import('../../src/services/minebot/utils/actReport.js');
const { bodyReader } = await import('../../src/services/minebot/utils/localMap.js');
const { foodPointsOf } = await import('../../src/services/minebot/utils/foodPoints.js');

function body(items: Array<{ name: string; count: number; type?: number }> = []) {
  const blocks = new Map<string, any>();
  const bot: any = Object.assign(new EventEmitter(), {
    __blocks: blocks, __dug: [] as string[],
    entity: { position: new Vec3(0.5, 64, 0.5), yaw: 0, onGround: true },
    health: 20, food: 20, game: { dimension: 'overworld' }, entities: {},
    registry: { blocksByName: { cobblestone: { id: 1 }, stone: { id: 2 } }, itemsByName: {}, items: {} },
    inventory: { items: () => items, slots: new Array(46).fill(null) },
    heldItem: null,
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

describe('dig', () => {
  it('passes an empty cell, refuses a chest without take, bedrock, and a cell out of reach', async () => {
    const bot = body();
    bot.__blocks.set('1,64,0', { name: 'chest', boundingBox: 'block' });
    bot.__blocks.set('0,62,1', { name: 'bedrock', boundingBox: 'block', diggable: false });
    const chestOut = await dig(ctx(bot), { at: [{ x: 1, y: 65, z: 0 }, { x: 1, y: 64, z: 0 }] });
    expect(chestOut.reason).toBe('protected');
    expect(chestOut.text).toContain('(1,65,0) は既に air（掘らずに次へ）');
    expect(chestOut.text).toContain('take:true');
    expect((await dig(ctx(bot), { at: [{ x: 0, y: 62, z: 1 }] })).reason).toBe('unbreakable');
    expect((await dig(ctx(bot), { at: [{ x: 0, y: 63, z: 9 }] })).reason).toBe('out_of_reach');
  });
  it('refuses the block under the feet over a dangerous drop', async () => {
    const bot = body();
    for (let y = 50; y < 63; y++) bot.__blocks.set(`0,${y},0`, { name: 'air', boundingBox: 'empty' });
    expect((await dig(ctx(bot), { at: [{ x: 0, y: 63, z: 0 }] })).reason).toBe('footing');
  });
  it('says which hostile a dig lets in, from where and how far, and digs with exposeOk (all, or the kind)', async () => {
    const bot = body();
    exposure.threats = [{ name: 'blaze', id: 41, distance: 6.04, position: { x: 5, y: 66, z: 3 } }];
    const refused = await dig(ctx(bot), { at: [{ x: 1, y: 63, z: 0 }] });
    expect(refused.reason).toBe('threat_exposed');
    expect(refused.text).toContain('blaze（id 41、(5,66,3) 自分から東5・南3・上2、6.0m）');
    expect(exposeAllows(['blaze'], 'blaze')).toBe(true);
    expect(exposeAllows(['zombie'], 'blaze')).toBe(false);
    const named = await dig(ctx(bot), { at: [{ x: 1, y: 63, z: 0 }], exposeOk: ['blaze'], collect: false });
    expect(named.ok).toBe(true);
    expect(bot.__dug).toEqual(['1,63,0']);
    expect((await dig(ctx(bot), { at: [{ x: -1, y: 63, z: 0 }], exposeOk: ['zombie'] })).reason).toBe('threat_exposed');
    exposure.threats = [];
  });
});

describe('place', () => {
  it('refuses a taken cell, the body\'s own cell, a cell with nothing to set against, and a block not carried', async () => {
    const stoneItem = [{ name: 'cobblestone', count: 3, type: 1 }];
    const bot = body(stoneItem);
    expect((await place(ctx(bot), { block: 'cobblestone', at: [{ x: 1, y: 63, z: 0 }] })).reason).toBe('occupied');
    expect((await place(ctx(bot), { block: 'cobblestone', at: [{ x: 0, y: 64, z: 0 }] })).reason).toBe('body_in_cell');
    expect((await place(ctx(bot), { block: 'cobblestone', at: [{ x: 2, y: 67, z: 0 }] })).reason).toBe('nothing_to_set_against');
    expect((await place(ctx(body()), { block: 'cobblestone', at: [{ x: 1, y: 64, z: 0 }] })).reason).toBe('missing_item');
    expect((await place(ctx(bot), { block: 'wheat_seeds', at: [{ x: 1, y: 64, z: 0 }] })).reason).toBe('invalid_block');
  });
});

describe('craft', () => {
  it('needs a table in reach and never sets one down, and names what is short', async () => {
    const bot = body();
    bot.registry.itemsByName = { stone_pickaxe: { id: 10 }, oak_planks: { id: 11 } };
    bot.registry.items = { 12: { name: 'oak_log' } };
    bot.world = { getColumns: () => [] };
    bot.recipesAll = (id: number, _meta: unknown, table: unknown) => id === 10 ? (table === true ? [{ requiresTable: true }] : [])
      : table === null ? [{ result: { count: 4 }, delta: [{ id: 12, count: -1 }, { id: 11, count: 4 }] }] : [];
    const noTable = await craft(ctx(bot), { item: 'stone_pickaxe' });
    expect(noTable.reason).toBe('no_table_in_reach');
    expect(noTable.text).toContain('48m 内に無い');
    const short = await craft(ctx(bot), { item: 'oak_planks', count: 8 });
    expect(short.reason).toBe('missing_material');
    expect(short.text).toContain('oak_log 2（持っている 0／要る 2）');
  });
});

describe('walk: what stops a walk on the straight line', () => {
  it('names the wall and the drop', () => {
    const bot = body();
    bot.__blocks.set('3,64,0', { name: 'stone', boundingBox: 'block' });
    bot.__blocks.set('3,65,0', { name: 'stone', boundingBox: 'block' });
    expect(whyBlocked(bot, { x: 0, y: 64, z: 0 }, { x: 6, y: 64, z: 0 })).toMatchObject({ reason: 'wall', at: { x: 3, y: 64, z: 0 } });
    const cliff = body();
    for (let y = 55; y < 64; y++) cliff.__blocks.set(`0,${y},-2`, { name: 'air', boundingBox: 'empty' });
    expect(whyBlocked(cliff, { x: 0, y: 64, z: 0 }, { x: 0, y: 64, z: -5 })).toMatchObject({ reason: 'drop', at: { x: 0, y: 64, z: -2 } });
    const step = body();
    step.__blocks.set('2,64,0', { name: 'stone', boundingBox: 'block' });
    expect(whyBlocked(step, { x: 0, y: 64, z: 0 }, { x: 4, y: 65, z: 0 })).toBeNull();
  });
});

describe('shoot: the arrow\'s fall', () => {
  it('a full draw is speed 3; the aim rises with distance and a far mark is out of reach', () => {
    expect(bowSpeed(1)).toBe(3);
    expect(bowSpeed(0.5)).toBeCloseTo((0.25 + 1) / 3 * 3, 5);
    const near = aimPitch(3, 10, 0)!, far = aimPitch(3, 40, 0)!;
    expect(near.pitch).toBeGreaterThan(0);
    expect(far.pitch).toBeGreaterThan(near.pitch);
    expect(far.ticks).toBeGreaterThan(near.ticks);
    expect(aimPitch(3, 400, 0)).toBeNull();
  });
});

describe('the small parts', () => {
  it('eat refuses at a full bar; furnace and chest refuse what is not one; pillarUp stops at a ceiling; a bucket only fills at a source', async () => {
    const bot = body([{ name: 'bread', count: 2, type: 5 }]);
    expect((await eat(ctx(bot), { item: 'bread' })).reason).toBe('full');
    expect((await furnace(ctx(bot), { at: { x: 1, y: 63, z: 0 } })).reason).toBe('not_furnace');
    expect((await chest(ctx(bot), { at: { x: 1, y: 63, z: 0 } })).reason).toBe('not_container');
    bot.__blocks.set('0,66,0', { name: 'stone', boundingBox: 'block' });
    bot.registry.blocksByName.dirt = { id: 3 };
    const pillar = await pillarUp(ctx(bot), { n: 2, block: 'dirt' });
    expect(pillar.reason).toBe('missing_item');
    const withDirt = body([{ name: 'dirt', count: 4, type: 3 }]);
    withDirt.registry.blocksByName.dirt = { id: 3 };
    withDirt.__blocks.set('0,66,0', { name: 'stone', boundingBox: 'block' });
    const ceiling = await pillarUp(ctx(withDirt), { n: 2, block: 'dirt' });
    expect(ceiling.reason).toBe('ceiling');
    expect(ceiling.text).toContain('(0,66,0)');
    const water = body([{ name: 'bucket', count: 1, type: 7 }]);
    water.heldItem = { name: 'bucket', type: 7 };
    water.__blocks.set('1,64,0', { name: 'water', boundingBox: 'empty', getProperties: () => ({ level: 3 }) });
    const flowing = await use(ctx(water), { item: 'bucket', at: { x: 1, y: 64, z: 0 } });
    expect(flowing.reason).toBe('not_source');
    expect(flowing.text).toContain('流れ 3');
  });
  it('attack hold stands still and strikes only what comes within reach', async () => {
    const { attack } = await import('../../src/services/minebot/utils/primitives/attack.js');
    const bot = body();
    bot.registry.entitiesByName = { blaze: { type: 'hostile' } };
    const near = { id: 5, name: 'blaze', type: 'hostile', height: 1.8, position: new Vec3(2.5, 64, 0.5) };
    const far = { id: 6, name: 'blaze', type: 'hostile', height: 1.8, position: new Vec3(9.5, 64, 0.5) };
    bot.entities = { 5: near, 6: far };
    const struck: number[] = [];
    let moved = false;
    Object.assign(bot, { heldItem: { name: 'iron_sword' }, attack: (entity: any) => { struck.push(entity.id); if (struck.length === 2) bot.emit('entityDead', near); },
      lookAt: async () => undefined, pathfinder: { setGoal: () => undefined }, setControlState: () => { moved = true; } });
    const out = await attack(ctx(bot), { mode: 'hold', target: 'blaze', maxSeconds: 1.5 });
    expect(out.ok).toBe(true);
    expect(new Set(struck)).toEqual(new Set([5]));
    expect(moved).toBe(false);
    expect(out.text).toContain('倒した 1（blaze）');
  });
  it('counts food in points (hunger + saturation)', () => {
    const food = foodPointsOf({ food: 14, foodSaturation: 2, inventory: { items: () => [{ name: 'bread', count: 3 }, { name: 'cooked_mutton', count: 2 }, { name: 'stone', count: 9 }] } });
    expect(food.carried).toBe(64.2);
    expect(food.items).toBe('bread×3(33) cooked_mutton×2(31.2)');
    expect(food.hunger).toBe(14);
  });
});

describe('r2: a stop says what is round it (scene replay 2026-10-21)', () => {
  it('a walk to a cell up a shaft says how far up and how much air is under it', () => {
    const bot = body();
    expect(whyBlocked(bot, { x: 0, y: 64, z: 0 }, { x: 0, y: 67, z: 0 })).toBeNull();
    expect(reachFacts(bot, { x: 0, y: 64, z: 0 }, { x: 0, y: 67, z: 0 })).toBe('着く所は足より3上（walk の段差は1まで）。着く所の下 3 マスが空気（立つ床が無い）');
    expect(reachFacts(bot, { x: 0, y: 64, z: 0 }, { x: 2, y: 64, z: 0 })).toBe('');
  });

  it('a bucket that could not reach its water names the stone between', () => {
    const bot = body();
    bot.__blocks.set('3,64,0', { name: 'water', boundingBox: 'empty' });
    bot.__blocks.set('2,65,0', { name: 'stone', boundingBox: 'block' });
    bot.__blocks.set('2,64,0', { name: 'stone', boundingBox: 'block' });
    expect(lineBlocker(bot, { x: 3, y: 64, z: 0 })).toEqual({ cell: { x: 2, y: 65, z: 0 }, name: 'stone' });
    bot.__blocks.delete('2,65,0'); bot.__blocks.delete('2,64,0');
    expect(lineBlocker(bot, { x: 3, y: 64, z: 0 })).toBeNull();
  });

  it('chest on a furnace says which hand opens it', async () => {
    const bot = body();
    bot.__blocks.set('1,64,0', { name: 'furnace', boundingBox: 'block' });
    const out = await chest(ctx(bot), { at: { x: 1, y: 64, z: 0 } });
    expect(out.ok).toBe(false);
    expect(out.text).toContain('furnace（箱・樽ではない。かまどは furnace の手）');
  });

  it('the 3x3x3 round a stop in the map\'s symbols, top first, north up', () => {
    const bot = body();
    bot.__blocks.set('0,63,0', { name: 'air', boundingBox: 'empty' });
    bot.__blocks.set('1,63,-1', { name: 'water', boundingBox: 'empty', metadata: 0, getProperties: () => ({ level: 0 }) });
    expect(aroundText(bodyReader(bot), { x: 0, y: 64, z: 0 }, { x: 0, y: 64, z: 0 }))
      .toBe('x=-1..1 z=-1..1 y=65: .../.../... y=64: .../.@./... y=63: ##w/#.#/###');
  });
});
describe('r2: a dig down the column under the feet (run 27: fell 19 hearts into a cave)', () => {
  it('refuses a cell under the feet a step below the footing when the fall past it is dangerous, and waits for the body to land first', async () => {
    const bot = body();
    // The cell under the feet already dug (the body not yet dropped into it), the next one stone, then air down to y=40.
    bot.__blocks.set('0,63,0', { name: 'air', boundingBox: 'empty' });
    for (let y = 40; y <= 61; y++) bot.__blocks.set(`0,${y},0`, { name: 'air', boundingBox: 'empty' });
    let landed = false;
    bot.entity.onGround = false;
    setTimeout(() => { bot.entity.onGround = true; landed = true; }, 50);
    const out = await dig(ctx(bot), { at: [{ x: 0, y: 62, z: 0 }] });
    expect(landed).toBe(true);
    expect(out.reason).toBe('footing');
    expect(out.text).toContain('(0,62,0)');
    expect(out.text).toContain('足の下の柱');
    expect(bot.__dug).toEqual([]);
    // A cell lower in the column with stone between is no danger.
    const safe = body();
    safe.entity.position = new Vec3(0.5, 64, 0.5);
    expect((await dig(ctx(safe), { at: [{ x: 1, y: 63, z: 0 }] })).ok).toBe(true);
  });
});