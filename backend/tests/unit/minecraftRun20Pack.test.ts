import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';

vi.mock('../../src/services/minebot/execution/observedWait.js', async (original) => ({
  ...(await original() as object), actionDelay: vi.fn(async () => {}),
}));

const { repairTierToolMaterials } = await import('../../src/services/minebot/utils/registryRepairs.js');
const { describePack, isThrowable } = await import('../../src/services/minebot/utils/inventoryTidy.js');
const { planDumpPit } = await import('../../src/services/minebot/utils/dumpPit.js');
const { pickaxeUsesFor } = await import('../../src/services/minebot/utils/toolStock.js');
const { executeAction } = await import('../../src/services/minebot/execution/ActionExecution.js');
const { default: DropItem } = await import('../../src/services/minebot/instantSkills/dropItem.js');
const { default: MineBlock } = await import('../../src/services/minebot/instantSkills/mineBlock.js');
const { default: StairMine } = await import('../../src/services/minebot/instantSkills/stairMine.js');

const require = createRequire(import.meta.url);
const registry = require('prismarine-registry')('1.21.11');
repairTierToolMaterials(registry);
const Block = require('prismarine-block')(registry);
const block = (name: string) => Block.fromStateId(registry.blocksByName[name].defaultState, 0);
const item = (name: string, count = 1, used = 0) => ({ type: registry.itemsByName[name].id, name, count,
  maxDurability: registry.itemsByName[name].maxDurability, durabilityUsed: used });
const stacks = (name: string, n: number, size = 64) => Array.from({ length: n }, () => ({ name, count: size }));

/** What run 20's pack held after a 99-level shaft and its tunnels: heaps of rock on top of the things to keep. */
const run20Pack = () => [
  { name: 'iron_pickaxe', count: 1 }, { name: 'water_bucket', count: 1 }, { name: 'bucket', count: 1 }, { name: 'bread', count: 4 },
  { name: 'white_wool', count: 3 }, { name: 'oak_log', count: 5 }, { name: 'oak_planks', count: 12 }, { name: 'stick', count: 6 },
  { name: 'coal', count: 9 }, { name: 'raw_iron', count: 12 }, { name: 'iron_ingot', count: 6 }, { name: 'diamond', count: 3 },
  { name: 'obsidian', count: 2 }, { name: 'flint', count: 1 }, { name: 'white_bed', count: 1 }, { name: 'iron_chestplate', count: 1 },
  { name: 'cooked_beef', count: 8 }, { name: 'iron_sword', count: 1 }, { name: 'shield', count: 1 }, { name: 'crafting_table', count: 1 },
  ...stacks('tuff', 1, 49), ...stacks('andesite', 2), ...stacks('diorite', 1, 40), ...stacks('deepslate', 2), ...stacks('cobbled_deepslate', 2),
  ...stacks('cobblestone', 2), ...stacks('dirt', 1, 30), ...stacks('gravel', 1, 20), ...stacks('granite', 1, 11),
];

describe('what may be thrown away is one table (run 20: tuff, andesite, diorite and deepslate filled the pack)', () => {
  it('names the plain rock and clutter, and never tools, food, buckets, beds, wool, wood, coal, ores, ingots, diamonds, obsidian or flint', () => {
    const pack = run20Pack();
    expect(pack.length).toBeGreaterThan(30);
    expect(isThrowable('diorite')).toBe(true);
    for (const keep of ['iron_pickaxe', 'water_bucket', 'bucket', 'lava_bucket', 'bread', 'white_wool', 'oak_log', 'oak_planks', 'stick', 'coal', 'raw_iron',
      'iron_ore', 'iron_ingot', 'diamond', 'obsidian', 'flint', 'white_bed', 'iron_chestplate']) {
      expect(isThrowable(keep)).toBe(false);
    }
    for (const rock of ['tuff', 'diorite', 'andesite', 'granite', 'deepslate', 'cobbled_deepslate', 'dirt', 'gravel']) expect(isThrowable(rock)).toBe(true);
  });

  it('says what fills a pack and what cannot go, for a refusal', () => {
    const text = describePack(run20Pack(), ['obsidian']);
    expect(text).toMatch(/\/36マス/);
    expect(text).toContain('tuff×49');
    expect(text).toContain('捨てられない物');
  });
});

/** A 1x2 tunnel along x at y 10..11 in stone (cells x from..to), with extra cells given. */
function tunnelCells(from = 0, to = 9, extra: Record<string, string> = {}) {
  const cells = new Map<string, string>();
  for (let x = from; x <= to; x++) { cells.set(`${x},10,0`, 'air'); cells.set(`${x},11,0`, 'air'); }
  for (const [key, name] of Object.entries(extra)) cells.set(key, name);
  const blockAt = (p: Vec3) => {
    const q = p.floored();
    const name = cells.get(`${q.x},${q.y},${q.z}`) ?? 'stone';
    return { name, boundingBox: ['air', 'cave_air', 'water', 'lava'].includes(name) ? 'empty' : 'block', diggable: name !== 'bedrock', shapes: name === 'air' ? [] : [[0, 0, 0, 1, 1, 1]] };
  };
  return { cells, blockAt };
}
/** The four columns beside the body at (4, 10, 0), at one level, all set to one block. */
const beside = (y: number, name: string) => Object.fromEntries([[5, 0], [3, 0], [4, 1], [4, -1]].map(([x, z]) => [`${x},${y},${z}`, name]));

describe('a hole to throw things into in a tunnel (utils/dumpPit)', () => {
  it('a tunnel cell beside the body: the floor and two blocks under it are dug, and the floor is put back', () => {
    const plan = planDumpPit(tunnelCells(), new Vec3(4, 10, 0))!;
    expect(plan.dig.map(cell => cell.y)).toEqual([9, 8, 7]);
    expect(plan.cap?.y).toBe(9);
    expect(plan.column.z).toBe(0);
    expect(Math.abs(plan.column.x - 4)).toBe(1);
  });

  it('a shaft with rock all round: a niche in the wall (head and feet) and the three under it, five digs', () => {
    const world = tunnelCells(0, -1);
    world.cells.set('0,10,0', 'air'); world.cells.set('0,11,0', 'air');
    const plan = planDumpPit(world, new Vec3(0, 10, 0))!;
    expect(plan.dig.map(cell => cell.y)).toEqual([11, 10, 9, 8, 7]);
  });

  it('never beside or under water or lava, under gravel, through bedrock or equipment, or with no floor to stand on', () => {
    // Lava or water ringing every column beside the body.
    expect(planDumpPit(tunnelCells(0, 9, { ...beside(8, 'stone'), '6,8,0': 'lava', '2,8,0': 'water', '5,8,1': 'lava', '3,8,-1': 'water', '4,8,2': 'lava', '4,8,-2': 'lava' }), new Vec3(4, 10, 0))).toBeNull();
    expect(planDumpPit(tunnelCells(0, 9, beside(8, 'bedrock')), new Vec3(4, 10, 0))).toBeNull();
    expect(planDumpPit(tunnelCells(0, 9, beside(8, 'chest')), new Vec3(4, 10, 0))).toBeNull();
    // Gravel over the cells to dig (it would fall into the hole).
    expect(planDumpPit(tunnelCells(0, 9, beside(12, 'gravel')), new Vec3(4, 10, 0))).toBeNull();
    // The body is not over a floor.
    expect(planDumpPit(tunnelCells(0, 9, { '4,9,0': 'air' }), new Vec3(4, 10, 0))).toBeNull();
    // Lava under the bottom of the hole.
    expect(planDumpPit(tunnelCells(0, 9, beside(6, 'lava')), new Vec3(4, 10, 0))).toBeNull();
  });
});

describe('drop-item in a 1x2 tunnel digs a hole, throws into it and puts the floor back (run 20: "too narrow" for 49 tuff)', () => {
  function tunnelBot(pack: any[], from = 0, to = 9) {
    const { cells, blockAt } = tunnelCells(from, to);
    const calls: string[] = [];
    const bot: any = {
      entity: { position: new Vec3(4.5, 10, 0.5) }, blockAt, equip: async () => {}, lookAt: async () => {}, pathfinder: { stop: () => {} },
      inventory: { items: () => pack, emptySlotCount: () => 36 - pack.length },
      toss: vi.fn(async (type: number, _meta: null, count: number) => {
        const stack = pack.find(entry => entry.type === type)!; stack.count -= count; if (stack.count <= 0) pack.splice(pack.indexOf(stack), 1);
      }),
      instantSkills: { getSkill: (name: string) => name === 'move-to' ? { run: async () => ({ success: true }) } : { run: async () => ({ success: true }) } },
    };
    const skill: any = new DropItem(bot);
    skill.callSkill = vi.fn(async (name: string, ...args: any[]) => {
      calls.push(name);
      if (name === 'dig-block-at') { cells.set(`${args[0]},${args[1]},${args[2]}`, 'air'); return { success: true, result: 'dug' }; }
      if (name === 'place-block-at') { cells.set(`${args[1]},${args[2]},${args[3]}`, args[0]); return { success: true, result: 'placed' }; }
      return { success: false };
    });
    return { bot, skill, cells, calls };
  }
  const pack = () => [{ name: 'stone_pickaxe', count: 1, type: 1 }, { name: 'tuff', count: 49, type: 2 }, { name: 'cobblestone', count: 20, type: 3 },
    ...Array.from({ length: 33 }, (_, i) => ({ name: `thing_${i}`, count: 1, type: 100 + i }))];

  it('digs three cells, throws the whole stack in, covers the floor, and says the slot is free', async () => {
    const { skill, calls, cells } = tunnelBot(pack());
    const result: any = await skill.runImpl('tuff', 49);
    expect(result.success).toBe(true);
    expect(calls.filter(call => call === 'dig-block-at')).toHaveLength(3);
    expect(calls.at(-1)).toBe('place-block-at');
    expect([...cells].filter(([key, name]) => key.startsWith('5,') && name === 'cobblestone')).toHaveLength(1);
    expect(result.result).toContain('穴を掘って捨てました');
    expect(result.result).toContain('1スロット空いた');
  });

  it('with no pickaxe to dig with, or when the pickaxe is the thing thrown, it digs nothing and says it is too narrow', async () => {
    // A short tunnel (4 cells): nowhere to walk to and no open line three cells long.
    const noPick = tunnelBot(pack().filter(entry => entry.name !== 'stone_pickaxe'), 3, 6);
    const refused: any = await noPick.skill.runImpl('tuff', 49);
    expect(refused).toMatchObject({ success: false, failureType: 'no_room_to_drop' });
    expect(noPick.calls).toEqual([]);
    const throwingIt = tunnelBot(pack(), 3, 6);
    const pickaxe: any = await throwingIt.skill.runImpl('stone_pickaxe', 1);
    expect(pickaxe.failureType).toBe('no_room_to_drop');
    expect(throwingIt.calls).toEqual([]);
  });

  it('a hole that cannot be dug (the dig is refused) leaves the old answer', async () => {
    const { skill, calls } = tunnelBot(pack(), 3, 6);
    skill.callSkill = vi.fn(async (name: string) => { calls.push(name); return { success: false, result: 'lava_danger' }; });
    const result: any = await skill.runImpl('tuff', 49);
    expect(result).toMatchObject({ success: false, failureType: 'no_room_to_drop' });
    expect(calls).toEqual(['dig-block-at']);
  });
});

describe('the pickaxes against the work to come (run 20: the stone pickaxe broke on the twelfth iron ore, 75 cobblestone carried)', () => {
  const inAction = (bot: any, work: () => Promise<any>, capability = 'mine-block') =>
    executeAction(bot, capability, 0, async () => ({ success: true, result: String(await work()) }));
  function body(items: any[]) {
    const bot: any = Object.assign(new EventEmitter(), {
      registry, version: '1.21.11', entity: { id: 7, position: new Vec3(0.5, 50, 0.5), effects: {} }, _client: new EventEmitter(),
      inventory: { slots: [], items: () => items, emptySlotCount: () => 20 }, executingSkill: false, interruptExecution: false, health: 20, food: 20,
      clearControlStates: vi.fn(), stopDigging: vi.fn(), deactivateItem: vi.fn(), pathfinder: { stop: vi.fn(), setGoal: vi.fn() },
      findBlocks: () => [], items,
    });
    return bot;
  }
  /** craft-one that makes a stone pickaxe from three cobblestone and two sticks. */
  const crafting = (bot: any, calls: string[]) => async (skill: string, ...args: any[]) => {
    calls.push(`${skill}:${args[0]}`);
    for (const [name, n] of [['cobblestone', 3], ['stick', 2]] as const) bot.items.find((c: any) => c.name === name).count -= n;
    bot.items.push(item('stone_pickaxe'));
    return { success: true, result: 'crafted' };
  };

  it('counts what each pickaxe has left (less its last two uses) for the blocks it can break', () => {
    const iron = block('iron_ore');
    expect(pickaxeUsesFor([item('stone_pickaxe', 1, 100), item('iron_pickaxe', 1, 0)], [iron])).toBe(29 + 248);
    // A wooden pickaxe breaks no iron ore.
    expect(pickaxeUsesFor([item('wooden_pickaxe', 1, 0), item('stone_pickaxe', 1, 100)], [iron])).toBe(29);
    expect(pickaxeUsesFor([item('wooden_pickaxe', 1, 0)], [block('stone')])).toBe(57);
    expect(pickaxeUsesFor([item('stone_pickaxe', 1, 130)], [iron])).toBe(0);
  });
});

describe('mine-block makes room and keeps its pickaxe (run 20)', () => {
  const ironOre = registry.blocksByName.iron_ore.id;
  /** A body beside a 2x6x2 block of iron ore, with the pack given. */
  function oreBody(pack: any[]) {
    const dug = new Set<string>();
    const ores: Vec3[] = [];
    for (const x of [1, 2]) for (let y = 39; y <= 44; y++) for (const z of [0, 1]) ores.push(new Vec3(x, y, z));
    const key = (p: Vec3) => `${p.x},${p.y},${p.z}`;
    const bot: any = Object.assign(new EventEmitter(), {
      version: '1.21.11', registry, entity: { position: new Vec3(0.5, 40, 0.5), effects: {} }, entities: {}, interruptExecution: false,
      inventory: { items: () => pack, emptySlotCount: () => 36 - pack.length },
      findBlocks: ({ matching }: any) => matching === ironOre ? ores.filter(p => !dug.has(key(p))) : [],
      blockAt: (p: Vec3) => ores.some(o => o.equals(p.floored())) && !dug.has(key(p.floored()))
        ? { name: 'iron_ore', position: p.floored(), diggable: true, boundingBox: 'block' } : { name: 'stone', boundingBox: 'block', position: p.floored() },
      canDigBlock: () => true,
    });
    const dig = { run: vi.fn(async (x: number, y: number, z: number) => {
      dug.add(`${x},${y},${z}`);
      const pick = pack.find(entry => entry.name.endsWith('_pickaxe'));
      if (pick) pick.durabilityUsed += 1;
      const raw = pack.find(entry => entry.name === 'raw_iron');
      if (raw) raw.count += 1; else pack.push({ name: 'raw_iron', count: 1 });
      bot.emit('diggingCompleted', { name: 'air', position: new Vec3(x, y, z) });
      return { success: true, result: 'dug' };
    }) };
    bot.instantSkills = { getSkill: (name: string) => name === 'dig-block-at' ? dig : { run: vi.fn(async () => ({ success: true })) } };
    const skill: any = new MineBlock(bot);
    skill.collectAllNearbyDrops = async () => [];
    return { bot, skill, dig, dug };
  }
  const inAction = (bot: any, work: () => Promise<any>) => executeAction(bot, 'mine-block', 0, async () => ({ success: true, result: 'x', value: await work() } as any));

  it('refuses at once, digging nothing, when the pickaxe can take no ore at all', async () => {
    const pack = [item('stone_pickaxe', 1, 129), item('dirt', 10)];
    const { bot, skill, dig } = oreBody(pack);
    skill.callSkill = vi.fn(async () => ({ success: true }));
    let result: any;
    await inAction(bot, async () => { result = await skill.runImpl('iron_ore', 12, 16); });
    expect(dig.run).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: false, failureType: 'tool_durability_low' });
    expect(result.result).toContain('掘る前に止めました');
  });
});
