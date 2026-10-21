import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';

// Run 24 (2026-10-21): obsidian took 550 s (the lab: 112-206). The first pool, 29 m off, was "a source to scoop" for find-blocks and "no lava
// with air over it" for use-item-on-block (0 obsidian, twice, 140 s); and in the pool that was used, 55 pours made 9 obsidian (274 s).
//   - lava is seen one way by the search and by the pourer (utils/lavaPools): open, covered (the rock over it dug from beside), or buried;
//   - the pool as big as the count needs and the least work to open is taken first;
//   - pours that make nothing to take are stopped, and the digging comes first when something can be taken.

vi.mock('../../src/services/minebot/execution/observedWait.js', async (original) => ({
  ...(await original() as object), actionDelay: vi.fn(async () => {}),
}));
vi.mock('../../src/services/minebot/utils/gotoSafe.js', () => ({ gotoSafe: vi.fn(async () => ({ success: true })) }));

const { lavaSourceInfo, rankLavaSources, poolSizeOf, describeLavaSource, wantedPoolSize } = await import('../../src/services/minebot/utils/lavaPools.js');
const { default: UseItemOnBlock } = await import('../../src/services/minebot/instantSkills/useItemOnBlock.js');
const { default: FindBlocks } = await import('../../src/services/minebot/instantSkills/findBlocks.js');
const { lavaAroundCount } = await import('../../src/services/minebot/utils/dropFate.js');

const key = (x: number, y: number, z: number) => `${x},${y},${z}`;

/** A cave of stone (y 30-60) with a lava pool at y 40 (x 0-3, z 0-3, 16 sources), a roof of stone over it, and a tunnel beside it at x -1. */
function caveWorld(options: { roofed?: boolean; flowing?: Set<string>; extra?: Map<string, string> } = {}) {
  const set = new Map<string, string>(options.extra ?? []);
  const roofed = options.roofed ?? true;
  const name = (x: number, y: number, z: number): string => {
    const own = set.get(key(x, y, z));
    if (own) return own;
    if (y === 40 && x >= 0 && x <= 3 && z >= 0 && z <= 3) return 'lava';
    // the air over the pool when it is not roofed; the tunnel to the west of the pool (feet and head)
    if (!roofed && y >= 41 && y <= 44 && x >= -1 && x <= 4 && z >= -1 && z <= 4) return 'air';
    if (x === -1 && z === 1 && (y === 41 || y === 42)) return 'air';
    return y >= 30 && y <= 60 ? 'stone' : 'air';
  };
  const blockAt = (p: Vec3) => {
    const q = p.floored();
    const n = name(q.x, q.y, q.z);
    const liquid = n === 'lava' || n === 'water';
    const level = options.flowing?.has(key(q.x, q.y, q.z)) ? 3 : 0;
    return { name: n, position: q, diggable: true, boundingBox: n === 'air' || liquid ? 'empty' : 'block', metadata: level, getProperties: () => (liquid ? { level } : {}) };
  };
  return { blockAt, set, name };
}

describe('lava seen the way the pourer sees it (run 24: "can be scooped" for a pool the pourer called one with no lava to pour on)', () => {
  it('an open top, a top under rock that can be dug from beside, and a source under other lava are told apart', () => {
    const open = caveWorld({ roofed: false });
    expect(lavaSourceInfo(open as any, new Vec3(1, 40, 1))).toMatchObject({ top: 'open', poolSize: 16 });
    const roofed = caveWorld();
    const edge = lavaSourceInfo(roofed as any, new Vec3(0, 40, 1))!;
    expect(edge.top).toBe('covered');
    expect(edge.cap).toEqual(new Vec3(0, 41, 1));
    expect(edge.stand).toEqual(new Vec3(-1, 41, 1));
    // a source in the middle of the pool: every cell beside its cover lies over lava, so there is nowhere to dig it from
    expect(lavaSourceInfo(roofed as any, new Vec3(2, 40, 2))!.top).toBe('buried');
    // lava over the source (a second layer)
    const deep = caveWorld({ extra: new Map([[key(1, 41, 1), 'lava']]) });
    expect(lavaSourceInfo(deep as any, new Vec3(1, 40, 1))!.top).toBe('buried');
    // flowing lava is no source at all
    const flowing = caveWorld({ roofed: false, flowing: new Set([key(1, 40, 1)]) });
    expect(lavaSourceInfo(flowing as any, new Vec3(1, 40, 1))).toBeNull();
  });

  it('a cover that lava or water lies beside, or that gravel hangs over, is not dug', () => {
    expect(lavaSourceInfo(caveWorld({ extra: new Map([[key(0, 41, 0), 'water']]) }) as any, new Vec3(0, 40, 1))!.top).toBe('buried');
    expect(lavaSourceInfo(caveWorld({ extra: new Map([[key(0, 42, 1), 'gravel']]) }) as any, new Vec3(0, 40, 1))!.top).toBe('buried');
  });

  it('counts the sources of a pool, flowing lava joined to it not counted', () => {
    const world = caveWorld({ roofed: false, flowing: new Set([key(3, 40, 3)]) });
    expect(poolSizeOf(world as any, new Vec3(0, 40, 0))).toBe(15);
  });

  it('takes the pool as big as the count needs before a small one, and the open top before the one that must be dug', () => {
    const here = new Vec3(0, 42, 0);
    const small = { at: new Vec3(2, 40, 0), top: 'open' as const, poolSize: 2, lavaNeighbours: 1 };
    const big = { at: new Vec3(30, 40, 0), top: 'open' as const, poolSize: 20, lavaNeighbours: 2 };
    const covered = { at: new Vec3(31, 40, 0), top: 'covered' as const, cap: new Vec3(31, 41, 0), stand: new Vec3(30, 41, 0), poolSize: 20, lavaNeighbours: 2 };
    expect(rankLavaSources([small, big], here, 10)[0]).toBe(big);
    expect(rankLavaSources([big, covered], here, 10)[0]).toBe(big);
    expect(rankLavaSources([small, covered], here, 10)[0]).toBe(covered);
    // a small pool will do for a small count
    expect(rankLavaSources([small, big], here, 1)[0]).toBe(small);
    // buried sources and sources refused twice are never offered
    expect(rankLavaSources([{ ...small, top: 'buried' as const }], here, 1)).toEqual([]);
    expect(rankLavaSources([small], here, 1, new Map([[key(2, 40, 0), 2]]))).toEqual([]);
    expect(wantedPoolSize(10)).toBe(6);
  });

  it('is told by the search the same way: the pool and how it is opened', async () => {
    const world = caveWorld();
    const findAll = (matching: any) => {
      const out: Vec3[] = [];
      for (let x = -1; x <= 4; x++) for (let y = 38; y <= 42; y++) for (let z = -1; z <= 4; z++) if (matching(world.blockAt(new Vec3(x, y, z)))) out.push(new Vec3(x, y, z));
      return out;
    };
    const bot: any = {
      version: '1.21.11', entity: { position: new Vec3(-1.5, 41, 1.5) }, blockAt: world.blockAt, interruptExecution: false,
      findBlocks: ({ matching, useExtraInfo }: any) => findAll((block: any) => block.name === 'lava' && (useExtraInfo ? useExtraInfo(block) : true)).map(at => at),
    };
    // the library matches by block id: stand in for it with the id of lava
    const lavaId = (await import('minecraft-data')).default('1.21.11').blocksByName.lava.id;
    bot.findBlocks = ({ matching, useExtraInfo }: any) => (matching === lavaId ? findAll((block: any) => block.name === 'lava' && (!useExtraInfo || useExtraInfo(block))) : []);
    const result: any = await new FindBlocks(bot).runImpl('lava', 16, 10);
    expect(result.success).toBe(true);
    expect(result.result).toContain('溜まり16個');
    expect(result.result).toContain('岩の覆いが1枚');
    expect(result.result).toContain('黒曜石を作るなら');
    expect(describeLavaSource({ at: new Vec3(0, 0, 0), top: 'open', poolSize: 3, lavaNeighbours: 0 })).toContain('上が開いている');
  });
});

describe('use-item-on-block takes a covered pool: the cover dug from beside, then the water (run 24: 0 obsidian twice at such a pool)', () => {
  /** A body at the tunnel by the pool, with fake skills that change the world. */
  function pouringBody(world = caveWorld()) {
    const pack: any[] = [{ name: 'water_bucket', count: 1 }, { name: 'diamond_pickaxe', count: 1 }, { name: 'bucket', count: 0 }];
    const calls: string[] = [];
    const bot: any = Object.assign(new EventEmitter(), {
      version: '1.21.11', game: { dimension: 'overworld' }, interruptExecution: false,
      entity: { position: new Vec3(-3.5, 41, 1.5) }, heldItem: null,
      inventory: { items: () => pack.filter(item => item.count > 0), emptySlotCount: () => 20 },
      blockAt: world.blockAt, equip: vi.fn(async () => {}),
      findBlocks: ({ matching, point, maxDistance }: any) => {
        const out: Vec3[] = [];
        for (let x = -1; x <= 4; x++) for (let y = 38; y <= 42; y++) for (let z = -1; z <= 4; z++) {
          const at = new Vec3(x, y, z);
          if (at.distanceTo(point) <= maxDistance && matching(world.blockAt(at))) out.push(at);
        }
        return out;
      },
    });
    const skill: any = new UseItemOnBlock(bot);
    const fake = (name: string, effect: (args: any[]) => any) => ({ run: vi.fn(), maxDurationMs: 5000, rootBot: bot, skillName: name,
      runImpl: vi.fn(async (...args: any[]) => { calls.push(`${name}(${args.slice(0, 3).join(',')})`); return effect(args); }) });
    const dig = fake('dig-block-at', ([x, y, z]) => {
      const was = world.name(x, y, z);
      world.set.set(key(x, y, z), 'air');
      if (was === 'obsidian') { const entry = pack.find(item => item.name === 'obsidian'); if (entry) entry.count++; else pack.push({ name: 'obsidian', count: 1 }); }
      return { success: true, result: 'dug' };
    });
    bot.instantSkills = { getSkill: (name: string) => (name === 'dig-block-at' ? dig : name === 'use-item-on-block' ? skill : name === 'pickup-nearest-item' ? fake('pickup', () => ({ success: true })) : undefined) };
    skill.walk = vi.fn(async (goal: any) => { calls.push(`walk(${goal.x},${goal.y},${goal.z})`); bot.entity.position = new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5); });
    return { bot, skill, calls, pack, world };
  }

  it('walks to the cell beside the cover, digs the cover, then pours into the opening', async () => {
    const { skill, calls, world, pack } = pouringBody();
    const chosen = skill.pourableLava(new Vec3(0, 40, 1), new Map(), 1);
    expect(chosen.top).toBe('covered');
    skill.placeWaterNearLava = vi.fn(async (lava: Vec3) => {
      calls.push(`pour(${lava.x},${lava.y},${lava.z})`);
      world.set.set(key(lava.x, lava.y, lava.z), 'obsidian');
      return { success: true, converted: true, pouredAt: lava, result: 'ok' };
    });
    skill.takeableObsidian = (_c: Vec3, skipped: Set<string>, _over?: boolean, crush?: boolean) => {
      if (crush) return [];
      const out: Vec3[] = [];
      for (let x = 0; x <= 3; x++) for (let z = 0; z <= 3; z++) if (world.name(x, 40, z) === 'obsidian' && !skipped.has(key(x, 40, z))) out.push(new Vec3(x, 40, z));
      return out;
    };
    const result: any = await skill.run(0, 40, 1, 'water_bucket', 1);
    expect(result.success).toBe(true);
    expect(pack.find(item => item.name === 'obsidian')?.count).toBe(1);
    const order = calls.filter(call => /^(walk|dig-block-at|pour)/.test(call));
    const walk = order.findIndex(call => call.startsWith(`walk(${chosen.stand.x},${chosen.stand.y},${chosen.stand.z})`));
    const digCap = order.findIndex(call => call.startsWith(`dig-block-at(${chosen.cap.x},${chosen.cap.y},${chosen.cap.z})`));
    const pour = order.findIndex(call => call.startsWith(`pour(${chosen.at.x},${chosen.at.y},${chosen.at.z})`));
    expect(walk).toBeGreaterThanOrEqual(0);
    expect(digCap).toBeGreaterThan(walk - 1);
    expect(pour).toBeGreaterThan(digCap);
    expect(result.result).toContain('岩の覆いを1か所掘って開けた');
  });

  it('a single use-item-on-block on a covered source opens it first', async () => {
    const { skill, bot, world, calls } = pouringBody();
    bot.entity.position = new Vec3(-0.5, 41, 1.5);
    bot.heldItem = { name: 'water_bucket' };
    skill.placeWaterNearLava = vi.fn(async (lava: Vec3) => { calls.push(`pour(${lava.x},${lava.y},${lava.z})`); return { success: true, result: 'poured' }; });
    await skill.run(0, 40, 1, 'water_bucket', 0);
    expect(world.name(0, 41, 1)).toBe('air');
    expect(calls.some(call => call.startsWith('dig-block-at(0,41,1)'))).toBe(true);
    expect(calls.at(-1)).toBe('pour(0,40,1)');
  });

  it('only sources that can be opened are offered: the middle of the pool, with nothing beside its cover to dig from, is not', async () => {
    const { skill } = pouringBody();
    const info = skill.pourableLava(new Vec3(2, 40, 2), new Map(), 1);
    expect(info).not.toBeNull();
    expect(info.top).toBe('covered');
    expect([1, 2].includes(info.at.x) && [1, 2].includes(info.at.z)).toBe(false);
  });
});

describe('pours that make nothing are stopped, and the digging comes first when something can be taken (run 24: 55 pours for 9 obsidian)', () => {
  function loopBody(pourResult: (n: number) => any, options: { takeable?: (obsidian: number) => Vec3[]; crushable?: Vec3[] } = {}) {
    let obsidian = 0;
    const order: string[] = [];
    const bot: any = Object.assign(new EventEmitter(), {
      version: '1.21.11', game: { dimension: 'overworld' }, interruptExecution: false, entity: { position: new Vec3(0.5, 64, 0.5) }, heldItem: null,
      inventory: { items: () => [{ name: 'water_bucket', count: 1 }, { name: 'diamond_pickaxe', count: 1 }, ...(obsidian ? [{ name: 'obsidian', count: obsidian }] : [])], emptySlotCount: () => 20 },
      blockAt: () => null, equip: vi.fn(async () => {}),
    });
    const skill: any = new UseItemOnBlock(bot);
    const dig = { run: vi.fn(), maxDurationMs: 5000, rootBot: bot, runImpl: vi.fn(async (x: number, y: number, z: number) => { order.push(`dig(${x},${y},${z})`); obsidian++; return { success: true, result: 'dug' }; }) };
    bot.instantSkills = { getSkill: (name: string) => (name === 'dig-block-at' ? dig : name === 'use-item-on-block' ? skill : undefined) };
    let pours = 0;
    skill.placeWaterNearLava = vi.fn(async (lava: Vec3) => { order.push('pour'); return { ...pourResult(pours++), pouredAt: lava }; });
    skill.walk = vi.fn(async () => {});
    skill.roomForDrops = async () => '';
    skill.takeableObsidian = (_c: Vec3, _s: Set<string>, _o?: boolean, crush?: boolean) => (crush ? options.crushable ?? [] : options.takeable?.(obsidian) ?? []);
    bot.entity.position = new Vec3(10.5, 64, 0.5);
    // the lava is always within reach of the body
    const near = (n: number) => { bot.entity.position = new Vec3(10 + n + 0.5, 64, 0.5); };
    skill.pourableLava = () => { near(pours); return { at: new Vec3(10 + pours, 63, 0), top: 'open', poolSize: 30, lavaNeighbours: 0 }; };
    return { skill, order, getObsidian: () => obsidian };
  }

  it('six pours in a row that turn nothing to obsidian end the call, with the reason', async () => {
    const { skill, order } = loopBody(() => ({ success: true, converted: false, result: 'water set, lava not turned' }));
    const result: any = await skill.run(10, 63, 0, 'water_bucket', 5);
    expect(result.success).toBe(false);
    expect(order.filter(step => step === 'pour')).toHaveLength(6);
    expect(result.result).toContain('黒曜石になりません');
  });

  it('digs what can be taken after four pours ahead, not after the pours for the whole count', async () => {
    let made = 0;
    const takeable = (obsidian: number) => Array.from({ length: Math.max(0, made - obsidian) }, (_, i) => new Vec3(20 + i, 63, 0));
    const { skill, order } = loopBody(() => { made++; return { success: true, converted: true, result: 'ok' }; }, { takeable });
    await skill.run(10, 63, 0, 'water_bucket', 10);
    // one obsidian to take from the first pour on: four more pours at most before the first dig
    const firstDig = order.findIndex(step => step.startsWith('dig'));
    expect(firstDig).toBeGreaterThan(0);
    expect(firstDig).toBeLessThanOrEqual(5);
  });

  it('when the pours leave only obsidian with lava beside it, that is dug (the lava put out first) rather than poured on again', async () => {
    const crush = [new Vec3(30, 63, 0), new Vec3(31, 63, 0), new Vec3(32, 63, 0)];
    const { skill, order } = loopBody(() => ({ success: true, converted: false, result: 'not turned' }), { crushable: crush });
    const result: any = await skill.run(10, 63, 0, 'water_bucket', 2);
    expect(result.success).toBe(true);
    expect(order.filter(step => step === 'pour')).toHaveLength(2);
    expect(order.filter(step => step.startsWith('dig'))).toHaveLength(2);
  });

  it('counts the lava over and beside a block', () => {
    const world = caveWorld({ roofed: false });
    expect(lavaAroundCount(world as any, new Vec3(-1, 40, 1))).toBe(1);
    expect(lavaAroundCount(world as any, new Vec3(1, 41, 1))).toBe(0);
    expect(lavaAroundCount(world as any, new Vec3(1, 40, 1))).toBe(4);
  });
});
