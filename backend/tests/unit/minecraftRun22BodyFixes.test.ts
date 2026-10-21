import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';

// Run 22: the body's side of what the live run showed (furnace parts, the wait refusal, the tool named, the third furnace, why a blow cannot land).
vi.mock('../../src/services/minebot/execution/observedWait.js', async (original) => ({
  ...(await original() as object), actionDelay: vi.fn(async () => {}),
}));
const scanned = vi.hoisted(() => ({ hits: [] as Array<{ kind: string; hit: { name: string; position: unknown; distance: number } }> }));
vi.mock('../../src/services/minebot/utils/loadedBlockScan.js', async (original) => ({
  ...(await original() as object), nearestOreHits: () => scanned.hits,
}));

const { explainUnreachable } = await import('../../src/services/minebot/utils/attackReach.js');
const { decideRestock, planCraft, keepCheapTool, ensureToolUses } = await import('../../src/services/minebot/utils/toolStock.js');
const { repairTierToolMaterials } = await import('../../src/services/minebot/utils/registryRepairs.js');
const { executeAction } = await import('../../src/services/minebot/execution/ActionExecution.js');
const { default: WaitTime, meanwhileWork, smallWorkText } = await import('../../src/services/minebot/instantSkills/waitTime.js');
const { default: WithdrawFromFurnace } = await import('../../src/services/minebot/instantSkills/withdrawFromFurnace.js');
const { default: PlaceBlockAt } = await import('../../src/services/minebot/instantSkills/placeBlockAt.js');
const { nearestDryStand } = await import('../../src/services/minebot/utils/exitWater.js');
const { chooseRockTravel } = await import('../../src/services/minebot/utils/rockTravel.js');
const { default: AutoWearArmor } = await import('../../src/services/minebot/constantSkills/autoWearArmor.js');
const { equipWillClick, closeStaleWindow } = await import('../../src/services/minebot/utils/staleWindow.js');

const require = createRequire(import.meta.url);
const toolRegistry = require('prismarine-registry')('1.21.11');
repairTierToolMaterials(toolRegistry);
const Block = require('prismarine-block')(toolRegistry);
const stoneBlock = () => Block.fromStateId(toolRegistry.blocksByName.stone.defaultState, 0);
const carried = (name: string, count = 1, used = 0) => ({ type: toolRegistry.itemsByName[name].id, name, count,
  maxDurability: toolRegistry.itemsByName[name].maxDurability, durabilityUsed: used });

type Rule = (x: number, y: number, z: number) => string | null;
function world(rule: Rule) {
  return (p: Vec3) => {
    const q = p.floored();
    const name = rule(q.x, q.y, q.z);
    if (name === null) return null;
    return { name, position: q, boundingBox: ['air', 'water', 'lava', 'cave_air'].includes(name) ? 'empty' : 'block', diggable: true };
  };
}

describe('why a blow cannot land (attack-continuously gave up after 62 s with only "cannot attack")', () => {
  const chicken = (position: Vec3) => ({ name: 'chicken', position, height: 0.7 });
  const open = world((x, y) => (y < 64 ? 'stone' : 'air'));

  it('a target well above the feet is out of reach (a ledge, a tree), well below is a pit', () => {
    const bot: any = { entity: { position: new Vec3(0.5, 64, 0.5) }, blockAt: open };
    const up = explainUnreachable(bot, chicken(new Vec3(5.5, 69, 0.5)), 0, 12);
    expect(up.kind).toBe('height');
    expect(up.reason).toContain('上');
    expect(explainUnreachable(bot, chicken(new Vec3(5.5, 58, 0.5)), 0, 12).kind).toBe('height');
  });

  it('a fence on the line, or round the target on two sides, is named', () => {
    const fenced = world((x, y, z) => (y < 64 ? 'stone' : x === 3 && y === 64 ? 'oak_fence' : 'air'));
    const bot: any = { entity: { position: new Vec3(0.5, 64, 0.5) }, blockAt: fenced };
    const result = explainUnreachable(bot, chicken(new Vec3(6.5, 64, 0.5)), 1, 12);
    expect(result.kind).toBe('fence');
    expect(result.reason).toContain('oak_fence');
    const pen = world((x, y, z) => (y < 64 ? 'stone' : y === 64 && ((x === 9 && z === 0) || (x === 7 && z === 0)) ? 'cobblestone_wall' : 'air'));
    expect(explainUnreachable({ entity: { position: new Vec3(0.5, 64, 0.5) }, blockAt: pen } as any, chicken(new Vec3(8.5, 64, 0.5)), 1, 12).kind).toBe('fence');
  });

  it('a target in the water, or water between, is named; a block between the eyes and a close target is the sight', () => {
    const lake = world((x, y) => (y < 63 ? 'stone' : y === 63 && x >= 4 ? 'water' : y === 64 && x >= 4 ? 'air' : y === 63 ? 'stone' : 'air'));
    const swimmer = explainUnreachable({ entity: { position: new Vec3(0.5, 64, 0.5) }, blockAt: lake } as any, chicken(new Vec3(8.5, 63, 0.5)), 0, 12);
    expect(swimmer.kind).toBe('water');
    const near: any = { entity: { position: new Vec3(0.5, 64, 0.5) }, blockAt: world((x, y) => (y < 64 ? 'stone' : x === 1 && y <= 65 ? 'glass' : 'air')),
      world: { raycast: () => ({ position: new Vec3(1, 64, 0) }) } };
    const behind = explainUnreachable(near, chicken(new Vec3(2.5, 64, 0.5)), 0, 12);
    expect(behind.kind).toBe('sight');
    expect(behind.reason).toContain('glass');
  });

  it('otherwise says how little the walk closed in the time it was tried', () => {
    const bot: any = { entity: { position: new Vec3(0.5, 64, 0.5) }, blockAt: open };
    const result = explainUnreachable(bot, chicken(new Vec3(40.5, 64, 0.5)), 0.4, 14);
    expect(result.kind).toBe('path');
    expect(result.reason).toContain('14秒');
    expect(result.reason).toContain('近づけなかった');
  });
});

describe('the tool named when a cheaper one cannot be made (run 22: a golden pickaxe, three gold ingots away, on nearly every result)', () => {
  const bag = () => [carried('iron_pickaxe', 1, 20), carried('dirt', 10), carried('oak_planks', 0)].filter(entry => entry.count > 0);

  it('never makes or names gold: it wears out after 32 blocks and nothing on the way to the Nether needs it', () => {
    const decision = decideRestock(toolRegistry, bag(), [stoneBlock()], { tableNear: true });
    expect(decision).toMatchObject({ kind: 'short', current: 'iron_pickaxe' });
    expect((decision as any).wanted).not.toMatch(/golden/);
    // with the gold in the bag: still not made
    const rich = decideRestock(toolRegistry, [carried('iron_pickaxe', 1, 20), carried('gold_ingot', 6), carried('stick', 4)], [stoneBlock()], { tableNear: true });
    expect(rich?.kind === 'make' ? rich.plan.item : '').not.toMatch(/golden/);
  });

  it('never makes or names copper either (run 23 named a copper pickaxe once gold was taken out)', () => {
    const decision = decideRestock(toolRegistry, bag(), [stoneBlock()], { tableNear: true });
    expect((decision as any)?.wanted ?? '').not.toMatch(/copper/);
    const rich = decideRestock(toolRegistry, [carried('iron_pickaxe', 1, 20), carried('copper_ingot', 6), carried('stick', 4)], [stoneBlock()], { tableNear: true });
    expect(rich?.kind === 'make' ? rich.plan.item : (rich as any)?.wanted ?? '').not.toMatch(/copper/);
  });

  it('names the one nearest to being made: the stone pickaxe, with the sticks it lacks', () => {
    const decision: any = decideRestock(toolRegistry, [carried('iron_pickaxe', 1, 20), carried('cobblestone', 8)], [stoneBlock()], { tableNear: true });
    expect(decision).toMatchObject({ kind: 'short', wanted: 'stone_pickaxe' });
    expect(decision.missing).toContain('stick');
    const outcome: any = planCraft(toolRegistry, [carried('stick', 2)], 'stone_pickaxe', true);
    expect(outcome.shortfall).toBe(3);
  });

  it('a shortage is said once a minute and a half, not on every result of a long run', async () => {
    const items = [carried('iron_pickaxe', 1, 20), carried('cobblestone', 8)];
    const host: any = Object.assign(new EventEmitter(), {
      registry: toolRegistry, version: '1.21.11', entity: { id: 7, position: new Vec3(0.5, 50, 0.5), effects: {} }, _client: new EventEmitter(),
      inventory: { slots: [], items: () => items }, executingSkill: false, interruptExecution: false, health: 20, food: 20,
      clearControlStates: vi.fn(), stopDigging: vi.fn(), deactivateItem: vi.fn(), pathfinder: { stop: vi.fn(), setGoal: vi.fn() },
      findBlocks: () => [],
    });
    const { takeToolStockNotes } = await import('../../src/services/minebot/utils/toolStock.js');
    const notes: string[][] = [];
    for (let i = 0; i < 3; i++) {
      await executeAction(host, 'mine-block', 0, async (context: any) => {
        await keepCheapTool(host, [stoneBlock()], async () => ({ success: true, result: '' }));
        notes.push(takeToolStockNotes((await import('../../src/services/minebot/execution/ActionExecution.js')).currentAction(host) as any));
        return { success: true, result: 'ok' };
      });
    }
    expect(notes[0].join('')).toContain('stone_pickaxe');
    expect(notes[0].join('')).not.toContain('golden');
    expect(notes[1]).toEqual([]);
    expect(notes[2]).toEqual([]);
    void ensureToolUses;
  });
});

describe('withdraw-from-furnace: a part taken is a success (run 22: four times outcome=failed for finished ingots)', () => {
  function furnaceBot(state: { input: number; fuel: number; output: number; burning?: boolean }) {
    const counts = new Map<string, number>();
    const inventory = Object.assign(new EventEmitter(), {
      items: () => [...counts].map(([name, count]) => ({ name, count })), emptySlotCount: () => 30 });
    const add = (name: string, count: number) => { counts.set(name, (counts.get(name) ?? 0) + count); inventory.emit('updateSlot'); };
    const furnace: any = Object.assign(new EventEmitter(), {
      fuel: state.burning === false ? 0 : 1, totalFuel: 10,
      inputItem: () => (state.input ? { name: 'raw_iron', count: state.input } : null),
      fuelItem: () => (state.fuel ? { name: 'coal', count: state.fuel } : null),
      outputItem: () => (state.output ? { name: 'iron_ingot', count: state.output } : null),
      takeOutput: vi.fn(async () => { add('iron_ingot', state.output); state.output = 0; furnace.emit('update'); }),
      takeInput: vi.fn(), takeFuel: vi.fn(), close: vi.fn(),
    });
    return { furnace, bot: { version: '1.21.11', entity: { position: new Vec3(0, 64, 1) }, inventory, currentWindow: inventory, entities: {},
      game: { dimension: 'overworld' }, blockAt: () => ({ name: 'furnace' }), openFurnace: vi.fn(async () => furnace),
      activeFurnaces: [{ pos: { x: 0, y: 64, z: 0 }, item: 'raw_iron', count: 8 }] } as any };
  }

  it('2 ingots out of 8 still cooking: success, no failureType, the rest said', async () => {
    const { bot } = furnaceBot({ input: 6, fuel: 2, output: 2 });
    const result: any = await new WithdrawFromFurnace(bot).runImpl(0, 64, 0, 'all', false);
    expect(result.success).toBe(true);
    expect(result.failureType).toBeUndefined();
    expect(result.result).toContain('完成済みのiron_ingot x2');
    expect(result.result).toContain('回収しました');
    expect(result.result).toContain('材料6個の精錬は未完了');
  });

  it('nothing ready is still the wait it was, and a furnace out of fuel stays a failure to see', async () => {
    const { bot } = furnaceBot({ input: 6, fuel: 2, output: 0 });
    const waiting: any = await new WithdrawFromFurnace(bot).runImpl(0, 64, 0, 'all', false);
    expect(waiting).toMatchObject({ success: false, failureType: 'waiting_external' });
    const dead = furnaceBot({ input: 2, fuel: 0, output: 1, burning: false });
    const fuel: any = await new WithdrawFromFurnace(dead.bot).runImpl(0, 64, 0, 'all', true);
    expect(fuel).toMatchObject({ success: false, failureType: 'material_missing' });
  });
});

describe('a refused wait names the small jobs that fit it (the head runs one instead of ending the procedure)', () => {
  const hostBase = () => Object.assign(new EventEmitter(), {
    executingSkill: false, interruptExecution: false, clearControlStates: vi.fn(), stopDigging: vi.fn(), deactivateItem: vi.fn(),
    pathfinder: { stop: vi.fn(), setGoal: vi.fn() },
  });
  const cookingBot = () => Object.assign(hostBase(), {
    entity: { position: new Vec3(0, 64, 0) }, entities: {}, game: { dimension: 'overworld' }, time: { timeOfDay: 6000 }, health: 20, food: 20,
    inventory: { items: () => [{ name: 'stone_pickaxe', count: 1 }], slots: [] }, instantSkills: { getSkill: () => null },
    activeFurnaces: [{ pos: { x: 1, y: 64, z: 0 }, item: 'raw_iron', count: 6, readyAt: Date.now() + 51_000, startedAt: Date.now(), dimension: 'overworld' }],
  }) as any;

  it('wait-time: the refusal carries the jobs as tool calls in one tag, the quickest first', async () => {
    scanned.hits = [
      { kind: 'iron_ore', hit: { name: 'iron_ore', position: new Vec3(7, 60, 0), distance: 7 } },
      { kind: 'coal_ore', hit: { name: 'coal_ore', position: new Vec3(4, 64, 0), distance: 4 } },
    ];
    const bot = cookingBot();
    const result: any = await executeAction(bot, 'wait-time', 0, () => new WaitTime(bot).run(30_000));
    expect(result).toMatchObject({ success: false, failureType: 'wait_refused' });
    expect(result.result).toContain('残り約51秒');
    const tag = /<small_work>(.*)<\/small_work>/s.exec(result.result);
    expect(tag).not.toBeNull();
    const jobs = JSON.parse(tag![1]);
    expect(jobs[0]).toMatchObject({ tool: 'mine-block', input: { blockName: 'coal_ore', count: 3 } });
    expect(jobs[0].input.searchRadius).toBeGreaterThanOrEqual(4);
    expect(jobs[1]).toMatchObject({ tool: 'mine-block', input: { blockName: 'iron_ore' } });
    expect(jobs[0].approxSeconds).toBeLessThan(jobs[1].approxSeconds);
    expect(jobs.every((job: any) => typeof job.why === 'string' && job.why.length > 0)).toBe(true);
  });

  it('withdraw-from-furnace refuses a long wait with the same tag, and the list is empty text when there is nothing to name', () => {
    scanned.hits = [];
    const bot = Object.assign(cookingBot(), { inventory: { items: () => [] } });
    expect(meanwhileWork(bot).small.filter(job => job.tool === 'mine-block')).toEqual([]);
    expect(smallWorkText([])).toBe('');
    scanned.hits = [{ kind: 'coal_ore', hit: { name: 'coal_ore', position: new Vec3(3, 64, 0), distance: 3 } }];
    const withPick = cookingBot();
    const work = meanwhileWork(withPick);
    expect(work.concrete).toBe(true);
    expect(work.small[0]).toMatchObject({ tool: 'mine-block', input: { blockName: 'coal_ore' } });
    const skill: any = new WithdrawFromFurnace(Object.assign(withPick, { version: '1.21.11' }));
    const refused = skill.preflight(1, 64, 0, 'all', true);
    expect(refused).toMatchObject({ failureType: 'wait_refused' });
    expect(refused.result).toContain('<small_work>');
  });
});

describe('place-block-at: the block in hand for placing (run 22: the third furnace crafted, then "invalid operation")', () => {
  const registry = minecraftData('1.21.11');
  function placing(options: { stale?: boolean; equipAlwaysFails?: boolean; placeFailsFirst?: boolean } = {}) {
    const stoneBase = (_x: number, y: number) => (y < 64 ? 'stone' : 'air');
    const overrides = new Map<string, string>();
    const nameAt = (x: number, y: number, z: number) => overrides.get(`${x},${y},${z}`) ?? stoneBase(x, y);
    const placed: Vec3[] = [];
    let pending = options.placeFailsFirst === true;
    const bot: any = Object.assign(new EventEmitter(), {
      version: '1.21.11', entity: { position: new Vec3(0.5, 64, 0.5), height: 1.8 }, entities: {}, heldItem: null,
      inventory: { items: () => [{ name: 'furnace', count: 1, type: registry.itemsByName.furnace.id, slot: 38 }] },
      currentWindow: options.stale ? { type: 'minecraft:crafting', inventoryEnd: 46 } : null,
      closeWindow: vi.fn(() => { bot.currentWindow = null; }),
      blockAt: (position: Vec3) => { const p = position.floored(); const name = nameAt(p.x, p.y, p.z); return { name, position: p, boundingBox: name === 'air' ? 'empty' : 'block', diggable: true }; },
      equip: vi.fn(async () => {
        if (options.equipAlwaysFails || bot.currentWindow) throw new Error('invalid operation');
        bot.heldItem = { name: 'furnace' };
      }),
      setQuickBarSlot: vi.fn(),
      lookAt: async () => {}, look: async () => {}, setControlState: () => {}, clearControlStates: () => {},
      placeBlock: vi.fn(async (ref: any, face: Vec3) => {
        if (pending) { pending = false; throw new Error('Event blockUpdate:(1, 64, 0) did not fire within timeout of 5000ms'); }
        const at = ref.position.plus(face); placed.push(at); overrides.set(`${at.x},${at.y},${at.z}`, 'furnace');
      }),
      world: { raycast: () => null }, pathfinder: { stop: () => {} }, _client: Object.assign(new EventEmitter(), { write: () => {} }),
    });
    return { bot, placed };
  }

  it('a window left open is closed before the block is taken in hand, and the furnace is set down', async () => {
    const { bot, placed } = placing({ stale: true });
    const result: any = await new PlaceBlockAt(bot).runImpl('furnace');
    expect(result.success).toBe(true);
    expect(bot.closeWindow).toHaveBeenCalled();
    expect(placed).toHaveLength(1);
  });

  it('a block that cannot be taken in hand is said as that, with what the body saw (not "設置エラー: invalid operation")', async () => {
    const { bot, placed } = placing({ equipAlwaysFails: true, stale: true });
    const result: any = await new PlaceBlockAt(bot).runImpl('furnace', 1, 64, 0);
    expect(result).toMatchObject({ success: false, failureType: 'equip_failed', recoverable: true });
    expect(result.result).toContain('手に持てませんでした');
    expect(result.result).toContain('invalid operation');
    expect(result.result).toContain('minecraft:crafting');
    expect(result.result).toContain('furnaceのスロット: 38');
    expect(result.result).not.toContain('設置エラー');
    expect(placed).toHaveLength(0);
    // a hotbar item (slot 38) is tried by selecting its slot, which needs no click
    expect(bot.setQuickBarSlot).toHaveBeenCalledWith(2);
  });

  it('a cell the server would not take is given up for another one, once or twice, and said', async () => {
    const { bot, placed } = placing({ placeFailsFirst: true });
    const result: any = await new PlaceBlockAt(bot).runImpl('furnace');
    expect(result.success).toBe(true);
    expect(placed).toHaveLength(1);
    expect(result.result).toContain('別の場所に置き直しました');
    expect(bot.placeBlock).toHaveBeenCalledTimes(2);
  });
});

describe('the dry stand for a body in the water (a far walk is chosen from land)', () => {
  it('finds the nearest floor with two open cells over it, towards the goal, and none in a flooded world', () => {
    const lake = world((x, y) => (x <= 2 ? (y <= 57 ? 'stone' : y <= 62 ? 'water' : 'air') : y <= 61 ? 'stone' : 'air'));
    const bot: any = { entity: { position: new Vec3(0.5, 62, 0.5), isInWater: true, onGround: false }, blockAt: lake };
    const stand = nearestDryStand(bot, 50, 0);
    expect(stand).not.toBeNull();
    expect(stand!.x).toBeGreaterThanOrEqual(3);
    expect(stand!.y).toBe(62);
    expect(nearestDryStand({ ...bot, blockAt: world(() => 'water') }, 50, 0)).toBeNull();
    // water within two cells of the stand costs a few cells of walking: the stand is taken a little off the shore
    const shore = nearestDryStand(bot, 50, 0)!;
    expect(shore.x).toBeGreaterThanOrEqual(5);
  });

  it('the rock walk is chosen after the line is read: open ground in the water is the route search\'s, rock in the water waits for land', () => {
    const rockWorld = world((x, y, z) => (x === 0 && z === 0 && (y === 90 || y === 91) ? 'air' : 'stone'));
    const entity = { position: new Vec3(0.5, 90, 0.5), onGround: true, effects: {}, isInWater: true };
    const goal: any = { constructor: { name: 'GoalNear' }, x: 24, y: 66, z: 0, isEnd: () => false };
    const rockBot: any = { entity, blockAt: rockWorld, inventory: { items: () => [] }, pathfinder: {} };
    expect(chooseRockTravel(rockBot, goal)).toMatchObject({ mode: 'default', why: 'in_water' });
    const openBot: any = { entity: { ...entity }, blockAt: world(() => 'air'), inventory: { items: () => [] }, pathfinder: {} };
    expect(chooseRockTravel(openBot, goal)).toMatchObject({ mode: 'default', why: 'open_ground' });
  });
});

describe('every equip of the body closes a window left open when it would click (the same fault, wherever the equip is called from)', () => {
  it('equipWillClick: a hotbar item is taken by its slot, anything else by clicks', () => {
    expect(equipWillClick({}, [{ slot: 38 }, 'hand'])).toBe(false);
    expect(equipWillClick({}, [{ slot: 12 }, 'hand'])).toBe(true);
    expect(equipWillClick({}, [{ slot: 38 }, 'head'])).toBe(true);
    expect(equipWillClick({}, [{ name: 'no slot known' }])).toBe(true);
  });

  it('the queued equip of the body (autoWearArmor installs it) closes the window first, only when it would click', async () => {
    const calls: string[] = [];
    const bot: any = Object.assign(new EventEmitter(), {
      entity: { id: 7, position: new Vec3(0, 64, 0) }, currentWindow: { type: 'minecraft:furnace' }, inventory: { slots: [], items: () => [] },
      getEquipmentDestSlot: () => 5,
      closeWindow: vi.fn(() => { calls.push('close'); bot.currentWindow = null; }),
      equip: async (item: any) => { calls.push(`equip ${item.slot}`); },
    });
    const skill: any = new AutoWearArmor(bot);
    skill.queueEquips();
    await bot.equip({ slot: 38 }, 'hand');
    expect(calls).toEqual(['equip 38']);                       // a hotbar item: no click, the window is left alone
    await bot.equip({ slot: 12 }, 'hand');
    expect(calls).toEqual(['equip 38', 'close', 'equip 12']);
    expect(closeStaleWindow({})).toBe(false);
  });
});