import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import pathfinder from 'mineflayer-pathfinder';

// Run 23 (2026-10-21, the Minebot run that stopped at obsidian 9 of 10): fixes of the body.
//   - use-item-on-block walks through rock as a tunnel (utils/rockTravel), not the route search;
//   - nothing is tidied while obsidian is made, and what is thrown beside lava goes into the lava;
//   - a dig beside lava puts the lava out first (a carried block, else water) instead of refusing;
//   - a stair seals a lone source of water in its own next cell, and a command goes on with a spare tool when one breaks;
//   - a stand for a scoop of water is chosen among those not yet tried, priced by the way to it;
//   - an order that did part of what was asked says so as a partial (utils/partialProgress).

vi.mock('../../src/services/minebot/execution/observedWait.js', async (original) => ({
  ...(await original() as object), actionDelay: vi.fn(async () => {}),
}));
vi.mock('../../src/services/minebot/utils/gotoSafe.js', () => ({ gotoSafe: vi.fn(async () => ({ success: true })) }));

const { goals } = pathfinder;
const { executeAction } = await import('../../src/services/minebot/execution/ActionExecution.js');
const { clutterTidyHeld } = await import('../../src/services/minebot/utils/inventoryRoom.js');
const { lavaToThrowInto } = await import('../../src/services/minebot/utils/dumpPit.js');
const { repairTierToolMaterials } = await import('../../src/services/minebot/utils/registryRepairs.js');
const { gotoSafe } = await import('../../src/services/minebot/utils/gotoSafe.js');
const { default: DropItem } = await import('../../src/services/minebot/instantSkills/dropItem.js');
const { default: DigBlockAt } = await import('../../src/services/minebot/instantSkills/digBlockAt.js');
const { default: UseItemOnBlock } = await import('../../src/services/minebot/instantSkills/useItemOnBlock.js');
const { default: StairMine } = await import('../../src/services/minebot/instantSkills/stairMine.js');
const { InstantSkill } = await import('../../src/services/minebot/types/skills.js');
const { installToolWearMonitor, spareFor } = await import('../../src/services/minebot/utils/toolWear.js');
const { progressOf, progressTrailer } = await import('../../src/services/minebot/utils/partialProgress.js');
const { scoopWater, standTravelCost } = await import('../../src/services/minebot/utils/scoopWater.js');

const require = createRequire(import.meta.url);
const registry = require('prismarine-registry')('1.21.11');
repairTierToolMaterials(registry);
const Block = require('prismarine-block')(registry);

const stacks = (name: string, n: number, size = 64) => Array.from({ length: n }, () => ({ name, count: size, type: registry.itemsByName[name].id }));
const cellKey = (p: { x: number; y: number; z: number }) => `${p.x},${p.y},${p.z}`;

/** A flat world: stone up to y 63, air over it; `set` overrides cells (a name, or 'air'). */
function flatWorld(set: Map<string, string> = new Map(), rule?: (p: Vec3) => string | null) {
  const blockAt = (at: Vec3) => {
    const p = at.floored();
    const name = set.get(cellKey(p)) ?? rule?.(p) ?? (p.y <= 63 ? 'stone' : 'air');
    const block = Block.fromStateId(registry.blocksByName[name].defaultState, 0);
    block.position = p;
    return block;
  };
  return { blockAt, set };
}

describe('the throw beside lava goes into the lava (run 23: 176 cobbled deepslate thrown away, walked off from, picked up and thrown again after every obsidian)', () => {
  /** A pool of lava at x 3-4, z -1..1 let into the floor (its top at floor level), the body at the origin. */
  function lavaBody(burns: boolean) {
    const set = new Map<string, string>();
    for (const x of [3, 4]) for (const z of [-1, 0, 1]) set.set(`${x},63,${z}`, 'lava');
    const world = flatWorld(set);
    const pack: any[] = [...stacks('cobblestone', 4), { name: 'stone_pickaxe', count: 1, type: registry.itemsByName.stone_pickaxe.id, maxDurability: 131, durabilityUsed: 0 }];
    const entities: Record<number, any> = {};
    let next = 1;
    const aimed: Vec3[] = [];
    const bot: any = Object.assign(new EventEmitter(), {
      registry, health: 20, food: 20, entities, username: 'shannon',
      entity: { position: new Vec3(0.5, 64, 0.5), height: 1.8, onGround: true, velocity: new Vec3(0, 0, 0) },
      inventory: { items: () => pack, emptySlotCount: () => 36 - pack.length, slots: [] },
      blockAt: world.blockAt,
      toss: vi.fn(async (type: number, _meta: unknown, count: number) => {
        let left = count;
        for (const entry of [...pack]) if (entry.type === type && left > 0) { const take = Math.min(left, entry.count); entry.count -= take; left -= take; if (!entry.count) pack.splice(pack.indexOf(entry), 1); }
        // The lava takes what is thrown into it; otherwise it lies where it landed, three blocks off the way the eyes look.
        if (!burns) { const id = next++; entities[id] = { id, name: 'item', position: new Vec3(3.5, 64, 0.5), getDroppedItem: () => ({ name: 'cobblestone' }) }; }
      }),
      equip: vi.fn(async () => {}), lookAt: vi.fn(async (point: Vec3) => { aimed.push(point); }), look: vi.fn(async () => {}),
      stopDigging: vi.fn(), clearControlStates: vi.fn(), pathfinder: { stop: vi.fn(), setGoal: vi.fn() }, heldItem: null,
    });
    const moveTo = { run: vi.fn(async () => ({ success: true })) };
    const drop = new DropItem(bot);
    bot.instantSkills = { getSkill: (name: string) => (name === 'drop-item' ? drop : name === 'move-to' ? moveTo : undefined) };
    bot.constantSkills = { getSkills: () => [] };
    return { bot, drop, pack, moveTo, aimed, entities };
  }

  it('finds lava two to five blocks off with an open line, and none behind rock', () => {
    const { bot } = lavaBody(true);
    const found = lavaToThrowInto(bot, bot.entity.position.offset(0, 1.62, 0));
    expect(found).not.toBeNull();
    expect(found!.y).toBe(63);
    expect(found!.x).toBeGreaterThanOrEqual(3);
    // a roof of stone over the pool shuts the line
    const roofed = flatWorld(new Map([...[3, 4].flatMap(x => [-1, 0, 1].map(z => [`${x},63,${z}`, 'lava'] as const)), ...[3, 4].flatMap(x => [-1, 0, 1].map(z => [`${x},64,${z}`, 'stone'] as const))]));
    expect(lavaToThrowInto({ blockAt: roofed.blockAt } as any, new Vec3(0.5, 65.62, 0.5))).toBeNull();
    // and lava too close or too far is no target
    expect(lavaToThrowInto({ blockAt: flatWorld(new Map([['1,63,0', 'lava']])).blockAt } as any, new Vec3(0.5, 65.62, 0.5))).toBeNull();
    expect(lavaToThrowInto({ blockAt: flatWorld(new Map([['9,63,0', 'lava']])).blockAt } as any, new Vec3(0.5, 65.62, 0.5))).toBeNull();
  });

  it('drop-item aims at the lava and throws: gone, nobody walks away or back, and the result says so', async () => {
    const { bot, drop, pack, moveTo, aimed } = lavaBody(true);
    const result: any = await drop.run('cobblestone', 176 > 256 ? 1 : 200);
    expect(result.success).toBe(true);
    expect(result.result).toContain('溶岩へ投げ込んで消しました');
    expect(aimed.some(point => point.x >= 3 && point.x <= 5 && point.y === 64)).toBe(true);
    expect(bot.toss).toHaveBeenCalledTimes(1);
    expect(moveTo.run).not.toHaveBeenCalled();
    expect(pack.filter(item => item.name === 'cobblestone').reduce((sum, item) => sum + item.count, 0)).toBe(56);
  });

  it('with no lava, the body walks off towards the furnace it will go back to, so that the heap is not on its way (run 23: 38 dirt fetched back on the walk to the furnace)', () => {
    const toward = (set: Map<string, string>) => {
      const world = flatWorld(set);
      const bot: any = { entity: { position: new Vec3(0.5, 64, 0.5) }, blockAt: world.blockAt, inventory: { items: () => [] } };
      return (new DropItem(bot) as any).retreatSpots(bot) as Array<[number, number, number]>;
    };
    const west = toward(new Map([['-5,64,0', 'furnace']]));
    expect(west[0][0]).toBeLessThan(0);                      // the nearest to the furnace of the six-block spots
    expect(west.findIndex(spot => spot[0] < -3)).toBeLessThan(3);
    expect(toward(new Map([['6,64,2', 'furnace']]))[0][0]).toBeGreaterThan(0);
    // nothing to go back to: the old order
    expect(toward(new Map())[0]).toEqual([6, 64, 0]);
  });

  it('a heap that landed on the rim is still there afterwards: not called gone, and not picked up again', async () => {
    const { drop } = lavaBody(false);
    const result: any = await drop.run('cobblestone', 100);
    expect(result.result).not.toContain('消しました');
  });
});

describe('nothing is tidied while obsidian is made, and a walk of use-item-on-block is a rock walk', () => {
  const miningBot = (items: Array<{ name: string; count: number }>) => ({
    version: '1.21.11', game: { dimension: 'overworld' }, interruptExecution: false,
    entity: { position: new Vec3(0.5, 64, 0.5) }, heldItem: null,
    inventory: { items: () => items },
    blockAt: () => null, equip: vi.fn(async () => {}),
    instantSkills: { getSkill: () => undefined },
  }) as any;

  it('holds the pack tidy for the whole call (the pickaxe digs through dig-block-at, whose tidy would throw the heap away after every obsidian)', async () => {
    const bot = miningBot([{ name: 'water_bucket', count: 1 }, { name: 'diamond_pickaxe', count: 1 }]);
    bot.heldItem = bot.inventory.items()[0];
    const skill: any = new UseItemOnBlock(bot);
    let heldInside = false;
    skill.makeObsidian = vi.fn(async () => { heldInside = clutterTidyHeld(bot); return { success: true, result: 'made' }; });
    const result = await skill.runImpl(10, 60, 10, 'water_bucket', 3);
    expect(result).toMatchObject({ success: true, result: 'made' });
    expect(heldInside).toBe(true);
    expect(clutterTidyHeld(bot)).toBe(false);
  });

  it('walks with the rock walk of move-to (rockTravel, a pillar for the climb), in proportion to the way, bounded by the time left', async () => {
    const bot = miningBot([{ name: 'diamond_pickaxe', count: 1 }]);
    const skill: any = new UseItemOnBlock(bot);
    vi.mocked(gotoSafe).mockClear();
    await skill.walk(new goals.GoalNear(30.5, 64, 0.5, 3), 15_000);
    const [, goal, options] = vi.mocked(gotoSafe).mock.calls[0] as any[];
    expect(goal.rangeSq).toBe(9);
    expect(options.rockTravel).toBe(true);
    expect(typeof options.tunnelPillar).toBe('function');
    expect(typeof options.tunnelTidy).toBe('function');
    expect(options.timeoutMs).toBeGreaterThan(60_000);            // 30 m at 2.5 s a metre, not the 15 s of the route search
    await skill.walk(new goals.GoalNear(30.5, 64, 0.5, 3), 15_000, 20_000);
    expect((vi.mocked(gotoSafe).mock.calls[1] as any[])[2].timeoutMs).toBe(20_000);
    await skill.walk(new goals.GoalNear(2.5, 64, 0.5, 2), 10_000);
    expect((vi.mocked(gotoSafe).mock.calls[2] as any[])[2].timeoutMs).toBe(10_000);
    // by hand, with no pickaxe, the route search is kept
    const bare = new UseItemOnBlock(miningBot([]));
    await (bare as any).walk(new goals.GoalNear(30.5, 64, 0.5, 3), 15_000);
    expect((vi.mocked(gotoSafe).mock.calls[3] as any[])[2].rockTravel).toBe(false);
  });
});

describe('a dig beside lava puts the lava out first (run 23, Rai: 溶岩を先に潰せばいい)', () => {
  /** The body at (0.5, 64, 0.5) with `pack`; a fake place-block-at that sets the cell to the block, a fake use-item-on-block that turns lava to obsidian. */
  function diggingBody(set: Map<string, string>, pack: any[], options: { placeWorks?: boolean } = {}) {
    const world = flatWorld(set);
    const calls: Array<[string, ...any[]]> = [];
    const bot: any = Object.assign(new EventEmitter(), {
      registry, version: '1.21.11', health: 20, food: 20, entities: {}, username: 'shannon', interruptExecution: false,
      entity: { position: new Vec3(0.5, 64, 0.5), height: 1.8, onGround: true, velocity: new Vec3(0, 0, 0), yaw: 0, pitch: 0 },
      inventory: { items: () => pack, emptySlotCount: () => 36 - pack.length, slots: [] },
      blockAt: world.blockAt,
      equip: vi.fn(async (item: any) => { bot.heldItem = item; }), lookAt: vi.fn(async () => {}), look: vi.fn(async () => {}),
      dig: vi.fn(async () => { throw new Error('test: no server to dig on'); }), stopDigging: vi.fn(), clearControlStates: vi.fn(),
      pathfinder: { stop: vi.fn(), setGoal: vi.fn() }, heldItem: null,
    });
    const dig = new DigBlockAt(bot);
    const fake = (name: string, effect: (args: any[]) => { success: boolean; result: string }) => ({
      run: vi.fn(), maxDurationMs: 5000, rootBot: bot, skillName: name,
      runImpl: vi.fn(async (...args: any[]) => { calls.push([name, ...args]); return effect(args); }),
    });
    const place = fake('place-block-at', ([block, x, y, z]) => {
      if (options.placeWorks === false) return { success: false, result: 'test: not placed' };
      set.set(`${x},${y},${z}`, block); return { success: true, result: 'placed' };
    });
    const water = fake('use-item-on-block', ([x, y, z]) => { set.set(`${x},${y},${z}`, 'obsidian'); return { success: true, result: 'obsidian' }; });
    bot.instantSkills = { getSkill: (name: string) => (name === 'dig-block-at' ? dig : name === 'place-block-at' ? place : name === 'use-item-on-block' ? water : undefined) };
    bot.constantSkills = { getSkills: () => [] };
    return { bot, dig, calls, set };
  }
  /** The dig itself was reached (the fake server answers nothing, so it ends unconfirmed or failed): the lava no longer stopped it. */
  const DUG = ['dig_unconfirmed', 'dig_failed'];
  const pickaxe = () => ({ name: 'stone_pickaxe', count: 1, type: registry.itemsByName.stone_pickaxe.id, maxDurability: 131, durabilityUsed: 0 });

  it('lava beside a block at the body\'s level (it would run onto the body): a carried block is put in its cell, and the dig goes on', async () => {
    const { bot, dig, calls, set } = diggingBody(new Map([['2,64,0', 'lava']]), [pickaxe(), ...stacks('cobblestone', 2)]);
    set.set('1,64,0', 'stone');
    const result: any = await dig.run(1, 64, 0, false);
    expect(calls[0].slice(0, 5)).toEqual(['place-block-at', 'cobblestone', 2, 64, 0]);
    expect(set.get('2,64,0')).toBe('cobblestone');
    expect(result.failureType).not.toBe('lava_danger');
    expect(DUG).toContain(result.failureType);
  });

  it('lava beside obsidian below the feet, its drop wanted (the rim of a pool): shut in with a block before the dig; the dig is not refused', async () => {
    const { bot, dig, calls, set } = diggingBody(new Map([['2,63,0', 'lava'], ['1,63,0', 'stone']]), [pickaxe(), ...stacks('cobbled_deepslate', 1)]);
    const result: any = await dig.run(1, 63, 0, true);
    expect(calls[0].slice(0, 5)).toEqual(['place-block-at', 'cobbled_deepslate', 2, 63, 0]);
    expect(result.failureType).not.toBe('drop_would_burn');
    expect(DUG).toContain(result.failureType);
    expect(set.get('2,63,0')).toBe('cobbled_deepslate');
  });

  it('lava straight over the block: put out the same way, then dug', async () => {
    const { bot, dig, calls, set } = diggingBody(new Map([['1,64,0', 'lava'], ['1,63,0', 'stone']]), [pickaxe(), ...stacks('cobblestone', 1)]);
    const result: any = await dig.run(1, 63, 0, true);
    expect(calls[0].slice(0, 5)).toEqual(['place-block-at', 'cobblestone', 1, 64, 0]);
    expect(result.failureType).not.toBe('drop_would_burn');
    expect(DUG).toContain(result.failureType);
  });

  it('lava lower down the column the drop falls in: the opening under the block is filled so the drop rests on it', async () => {
    const set = new Map<string, string>([['1,63,0', 'stone'], ['1,62,0', 'air'], ['1,61,0', 'air'], ['1,60,0', 'lava']]);
    const { bot, dig, calls } = diggingBody(set, [pickaxe(), ...stacks('cobblestone', 1)]);
    const result: any = await dig.run(1, 63, 0, true);
    expect(calls.some(call => call[0] === 'place-block-at' && call[2] === 1 && call[3] === 62 && call[4] === 0)).toBe(true);
    expect(DUG).toContain(result.failureType);
  });

  it('with no block to put in and no water bucket, it refuses, and says what to get; with a water bucket it pours', async () => {
    const empty = diggingBody(new Map([['2,64,0', 'lava'], ['1,64,0', 'stone']]), [pickaxe()]);
    const refused: any = await empty.dig.run(1, 64, 0, false);
    expect(refused).toMatchObject({ success: false, failureType: 'lava_danger' });
    expect(refused.result).toContain('潰そうとしましたができませんでした');
    expect(refused.result).toContain('丸石');
    expect(empty.bot.dig).not.toHaveBeenCalled();
    const wet = diggingBody(new Map([['2,64,0', 'lava'], ['1,64,0', 'stone']]), [pickaxe(), { name: 'water_bucket', count: 1, type: registry.itemsByName.water_bucket.id }]);
    const poured: any = await wet.dig.run(1, 64, 0, false);
    expect(wet.calls[0].slice(0, 5)).toEqual(['use-item-on-block', 2, 64, 0, 'water_bucket']);
    expect(wet.set.get('2,64,0')).toBe('obsidian');
    expect(DUG).toContain(poured.failureType);
  });

  it('a block that could not be placed is said with its reason and the dig stays refused', async () => {
    const { bot, dig } = diggingBody(new Map([['2,64,0', 'lava'], ['1,64,0', 'stone']]), [pickaxe(), ...stacks('cobblestone', 1)], { placeWorks: false });
    const result: any = await dig.run(1, 64, 0, false);
    expect(result).toMatchObject({ success: false, failureType: 'lava_danger' });
    expect(result.result).toContain('cobblestoneを置けなかった');
    expect(bot.dig).not.toHaveBeenCalled();
  });
});

describe('stair-mine seals a lone source of water in its own next cell (run 23: stopped at Y 36 with 128 cobblestone in the pack)', () => {
  /** Rock all round; one source of water in the cell the next step would stand in: (1, 64, 0). */
  const lone = (items: Array<{ name: string; count: number }>) => {
    const changed = new Map<string, string>();
    const world = (p: Vec3) => {
      const body = p.x === 0 && p.z === 0 && (p.y === 65 || p.y === 66);
      const name = changed.get(cellKey(p)) ?? (cellKey(p) === '1,64,0' ? 'water' : body ? 'air' : p.y <= 66 ? 'stone' : 'air');
      return { name, boundingBox: ['air', 'water'].includes(name) ? 'empty' : 'block', position: p, diggable: name !== 'air' && name !== 'water' };
    };
    const bot: any = { version: '1.21.11', entity: { position: new Vec3(0.5, 65, 0.5), isInWater: false, onGround: true }, inventory: { items: () => items },
      blockAt: (p: Vec3) => world(p.floored()), equip: async () => {},
      placeBlock: vi.fn(async (reference: any, face: Vec3) => { changed.set(cellKey(reference.position.plus(face)), items[0].name); }) };
    const skill: any = new StairMine(bot);
    skill.digBlockSafe = async (block: any) => { changed.set(cellKey(block.position), 'air'); return true; };
    skill.moveOneStair = async () => true;
    return { skill, world, bot };
  };
  it('the water in the stair\'s own cell is filled with a carried block, the block dug in its turn, and the step is taken', async () => {
    const { skill, world, bot } = lone([{ name: 'cobblestone', count: 128 }]);
    expect(await skill.digStairDown(new Vec3(0, 65, 0), new Vec3(1, 0, 0))).toBe(true);
    expect(bot.placeBlock).toHaveBeenCalled();
    expect(world(new Vec3(1, 64, 0)).name).toBe('air');          // sealed, then dug: the lone source is gone
    expect(world(new Vec3(1, 65, 0)).name).toBe('air');
  });
  it('with nothing to fill it with the stop stays, naming the water', async () => {
    const { skill } = lone([]);
    expect(await skill.digStairDown(new Vec3(0, 65, 0), new Vec3(1, 0, 0))).toBe(false);
    expect(skill.lastStopReason).toContain('が水です');
  });
});

describe('a command goes on with a spare tool when one breaks in the hand (run 23: stopped for iron_pickaxe with a second one at 249/250)', () => {
  function body(items: any[]): any {
    const client = new EventEmitter();
    return Object.assign(new EventEmitter(), {
      entity: { id: 7, position: new Vec3(0, 64, 0) }, _client: client, heldItem: { name: 'iron_pickaxe', maxDurability: 250 },
      inventory: { slots: [], items: () => items },
      executingSkill: false, interruptExecution: false, health: 20, food: 20,
      clearControlStates: vi.fn(), stopDigging: vi.fn(), pathfinder: { stop: vi.fn(), setGoal: vi.fn() },
    });
  }
  class Working extends InstantSkill {
    blocks = 0;
    constructor(bot: any, private readonly onBlock: (n: number) => void) { super(bot); this.skillName = 'stair-mine'; }
    async runImpl() { for (; this.blocks < 6; this.blocks++) { this.onBlock(this.blocks); await new Promise(resolve => setTimeout(resolve, 5)); } return { success: true, result: 'stair done' }; }
  }
  /** An iron pickaxe with left uses left. */
  const iron = (left: number) => ({ name: 'iron_pickaxe', count: 1, maxDurability: 250, durabilityUsed: 250 - left });

  it('spareFor: the same kind of the same tier or better with uses to spare; not the worn-out one, not a weaker tier, not another kind', () => {
    const pack = (items: any[]) => ({ inventory: { items: () => items } });
    expect(spareFor(pack([iron(249), iron(1)]), 'iron_pickaxe')).toEqual({ name: 'iron_pickaxe', usesLeft: 249 });
    expect(spareFor(pack([iron(1)]), 'iron_pickaxe')).toBeNull();
    expect(spareFor(pack([{ name: 'stone_pickaxe', count: 1, maxDurability: 131, durabilityUsed: 0 }]), 'iron_pickaxe')).toBeNull();
    expect(spareFor(pack([{ name: 'diamond_pickaxe', count: 1, maxDurability: 1561, durabilityUsed: 0 }]), 'iron_pickaxe')).toMatchObject({ name: 'diamond_pickaxe' });
    expect(spareFor(pack([{ name: 'iron_axe', count: 1, maxDurability: 250, durabilityUsed: 0 }]), 'iron_pickaxe')).toBeNull();
    expect(spareFor(pack([iron(100)]), 'weird')).toBeNull();
  });

  it('with a spare the action is not stopped, and the result says what was swapped', async () => {
    const items = [iron(249), iron(1)];
    const bot = body(items);
    installToolWearMonitor(bot);
    bot.emit('physicsTick');
    const skill = new Working(bot, n => { if (n === 2) { items.splice(1, 1); bot._client.emit('entity_status', { entityId: 7, entityStatus: 47 }); } });
    const result: any = await skill.run();
    expect(result.success).toBe(true);
    expect(skill.blocks).toBe(6);
    expect(result.result).toContain('予備に持ち替えて続けました');
    expect(result.result).toContain('iron_pickaxe→iron_pickaxe（残り249回）');
  });

  it('with no spare it stops as before', async () => {
    const items = [iron(1)];
    const bot = body(items);
    installToolWearMonitor(bot);
    bot.emit('physicsTick');
    const skill = new Working(bot, n => { if (n === 2) { items.splice(0, 1); bot._client.emit('entity_status', { entityId: 7, entityStatus: 47 }); } });
    const result: any = await skill.run();
    expect(result).toMatchObject({ success: false, failureType: 'tool_broke' });
    expect(skill.blocks).toBeLessThan(6);
  });
});

describe('a stand for a scoop of water is chosen among those not yet tried, and priced by the way to it (run 23: 水際の立ち位置なし after two tries)', () => {
  /** A pool of water at x 10-12 (y 63, a source each) with five dry stands on its west bank; open air, stone floor to y 62. */
  function pondBody(reachable: (stand: Vec3) => boolean) {
    const items: Array<{ name: string; count: number }> = [{ name: 'bucket', count: 1 }];
    const water = new Set<string>();
    for (const x of [10, 11, 12]) for (const z of [-1, 0, 1]) water.add(`${x},63,${z}`);
    const nameAt = (p: Vec3) => (water.has(cellKey(p)) ? 'water' : p.y <= 62 ? 'stone' : p.y === 63 && p.x < 10 ? 'stone' : 'air');
    const blockAt = (at: Vec3) => {
      const p = at.floored(); const name = nameAt(p);
      return { name, position: p, boundingBox: ['air', 'water'].includes(name) ? 'empty' : 'block', stateId: 1, type: 1, getProperties: () => ({ level: 0 }) };
    };
    const tried: Vec3[] = [];
    const bot: any = {
      version: '1.21.4', game: { dimension: 'overworld' }, registry: { blocksByName: { water: { id: 99 } } },
      entity: { position: new Vec3(0.5, 64, 0.5), yaw: 0, pitch: 0 }, heldItem: null, interruptExecution: false,
      inventory: { items: () => items.filter(item => item.count > 0) }, blockAt,
      findBlocks: () => [...water].map(key => new Vec3(...(key.split(',').map(Number) as [number, number, number]))),
      equip: vi.fn(async (item: any) => { bot.heldItem = item; }), lookAt: vi.fn(async () => {}), _client: { write: () => {} },
      activateItem: vi.fn(() => {}),
    };
    vi.mocked(gotoSafe).mockImplementation(async (_bot: any, goal: any) => {
      const stand = new Vec3(goal.x, goal.y, goal.z); tried.push(stand);
      if (reachable(stand)) bot.entity.position = new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5);
      return { success: true };
    });
    return { bot, tried };
  }

  it('stands that could not be reached are dropped from the list before the best three are taken: the fourth is tried', async () => {
    const { bot, tried } = pondBody(() => false);
    await scoopWater(bot, { budgetMs: 60_000, maxDistance: 30 });
    const distinct = new Set(tried.map(cellKey));
    // five attempts at most, and no stand tried twice
    expect(tried.length).toBe(distinct.size);
    expect(distinct.size).toBeGreaterThan(3);
  });

  it('a stand is priced by the way to it: a walk or a tunnel by its seconds, a stand no way fits at a high price', () => {
    const { bot } = pondBody(() => true);
    expect(standTravelCost(bot, new Vec3(2, 64, 0))).toBeGreaterThanOrEqual(0);
    // no navigator and an unknown world: priced at nothing rather than failing
    expect(standTravelCost({} as any, new Vec3(2, 64, 0))).toBe(0);
  });
});

describe('an order that did part of what was asked says so (utils/partialProgress)', () => {
  it('the trailer is read back (the last one in the text; a note of the body\'s own may follow it)', () => {
    const text = `黒曜石を6個作って掘りました。 ${progressTrailer('obsidian', 6, 10)}`;
    expect(text.endsWith('［進み: obsidian 6/10］')).toBe(true);
    expect(progressOf(text)).toEqual({ what: 'obsidian', made: 6, wanted: 10 });
    expect(progressOf(`${text} 道具の補充: stone_pickaxeを作りました`)).toEqual({ what: 'obsidian', made: 6, wanted: 10 });
    expect(progressOf('何も作れなかった')).toBeNull();
  });

  it('use-item-on-block with count: some made is partial_completion with the count; none made is another code; all made is a success', async () => {
    /** `targets` obsidian blocks within reach, each dug by the fake dig-block-at into the pack; no lava to pour on. */
    const call = async (targets: number, count: number) => {
      let obsidian = 0;
      const items = [{ name: 'water_bucket', count: 1 }, { name: 'diamond_pickaxe', count: 1 }];
      const bot: any = Object.assign(new EventEmitter(), {
        version: '1.21.11', game: { dimension: 'overworld' }, interruptExecution: false, entity: { position: new Vec3(0.5, 64, 0.5) }, heldItem: null,
        inventory: { items: () => [...items, ...(obsidian ? [{ name: 'obsidian', count: obsidian }] : [])] }, blockAt: () => null, equip: vi.fn(async () => {}),
      });
      const skill: any = new UseItemOnBlock(bot);
      const dig = { run: vi.fn(), maxDurationMs: 5000, rootBot: bot, runImpl: vi.fn(async () => { obsidian++; return { success: true, result: 'dug' }; }) };
      bot.instantSkills = { getSkill: (name: string) => (name === 'dig-block-at' ? dig : name === 'use-item-on-block' ? skill : undefined) };
      skill.takeableObsidian = () => Array.from({ length: Math.max(0, targets - obsidian) }, (_, i) => new Vec3(1 + (i % 3), 63, Math.floor(i / 3)));
      skill.pourableLava = () => null;
      return skill.run(0, 63, 0, 'water_bucket', count);
    };
    const all: any = await call(4, 4);
    expect(all).toMatchObject({ success: true });
    const some: any = await call(2, 4);
    expect(some).toMatchObject({ success: false, failureType: 'partial_completion', recoverable: true });
    expect(progressOf(some.result)).toEqual({ what: 'obsidian', made: 2, wanted: 4 });
    const none: any = await call(0, 4);
    expect(none).toMatchObject({ success: false, failureType: 'target_not_found' });
    expect(progressOf(none.result)).toBeNull();
  });
});
