import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';

// Run 21 (body): a full pack (545 cobblestone, five stone pickaxes), a throw that came back, a pickaxe that could not be taken into the
// hand with the pack full, and a bed that could not be placed in a rock passage.

vi.mock('../../src/services/minebot/execution/observedWait.js', async (original) => ({
  ...(await original() as object), actionDelay: vi.fn(async () => {}),
}));

const { repairTierToolMaterials } = await import('../../src/services/minebot/utils/registryRepairs.js');
const { clutterPlan, pickaxeAllowance, surplusPickaxes } = await import('../../src/services/minebot/utils/inventoryTidy.js');
const { clutterToThrow, CLUTTER_GAP_MS, CLUTTER_REFUSED_GAP_MS, holdClutterTidy, tidyIfCluttered } = await import('../../src/services/minebot/utils/inventoryRoom.js');
const { isSelfDropped, noteSelfDropped, SELF_DROP_MS } = await import('../../src/services/minebot/utils/selfDropped.js');
const { ensureToolUses } = await import('../../src/services/minebot/utils/toolStock.js');
const { executeAction } = await import('../../src/services/minebot/execution/ActionExecution.js');
const { equipToHandVerified } = await import('../../src/services/minebot/utils/equipVerified.js');
const { planBedSpot, walkableCells } = await import('../../src/services/minebot/utils/bedSpot.js');
const { default: DropItem } = await import('../../src/services/minebot/instantSkills/dropItem.js');
const { default: SleepInBed, isFreeCell, bodyCells } = await import('../../src/services/minebot/instantSkills/sleepInBed.js');

const require = createRequire(import.meta.url);
const registry = require('prismarine-registry')('1.21.11');
repairTierToolMaterials(registry);
const Block = require('prismarine-block')(registry);
const block = (name: string) => Block.fromStateId(registry.blocksByName[name].defaultState, 0);
const item = (name: string, count = 1, used = 0) => ({ type: registry.itemsByName[name].id, name, count,
  maxDurability: registry.itemsByName[name].maxDurability, durabilityUsed: used });
const heap = (name: string, count: number) => [{ name, count }];
const stacks = (name: string, n: number, size = 64) => Array.from({ length: n }, () => ({ name, count: size }));
const filler = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `thing_${i}`, count: 1 }));

describe('the body\'s own limit on the rock it digs (run 21: 545 cobblestone in a 34/36 pack)', () => {
  it('throws cobblestone down to 96 past 192 at any time, and past 160 only when the pack is short of room', () => {
    expect(clutterPlan(heap('cobblestone', 545), 20)).toEqual([{ name: 'cobblestone', count: 449 }]);
    expect(clutterPlan(heap('cobblestone', 193), 20)).toEqual([{ name: 'cobblestone', count: 97 }]);
    expect(clutterPlan(heap('cobblestone', 192), 20)).toEqual([]);
    expect(clutterPlan(heap('cobblestone', 170), 20)).toEqual([]);
    expect(clutterPlan(heap('cobblestone', 170), 6)).toEqual([{ name: 'cobblestone', count: 74 }]);
    expect(clutterPlan(heap('cobblestone', 160), 2)).toEqual([]);
  });

  it('counts a kind over all its stacks, goes by the table for other rock, and never names a kind that is kept', () => {
    expect(clutterPlan([...stacks('cobblestone', 3), ...stacks('andesite', 4), { name: 'andesite', count: 1 }], 3))
      .toEqual([{ name: 'andesite', count: 257 }, { name: 'cobblestone', count: 96 }]);
    const kept = [...stacks('coal', 10, 64), ...stacks('iron_ingot', 5, 64), ...stacks('stone_pickaxe', 1, 1), ...stacks('bread', 4, 64)];
    expect(clutterPlan(kept, 0)).toEqual([]);
    // Below the head's own keep of 128 the body leaves it alone: the two never fight over one heap.
    expect(clutterPlan(heap('cobblestone', 128), 0)).toEqual([]);
  });

  it('keeps at most two stone pickaxes, one beside a good iron one, and never the last pickaxe', () => {
    const five = [item('iron_pickaxe', 1, 10), ...Array.from({ length: 5 }, () => item('stone_pickaxe'))];
    expect(pickaxeAllowance(five, 'stone_pickaxe')).toBe(1);
    expect(surplusPickaxes(five)).toEqual([{ name: 'stone_pickaxe', count: 4 }]);
    expect(surplusPickaxes([...Array.from({ length: 3 }, () => item('stone_pickaxe'))])).toEqual([{ name: 'stone_pickaxe', count: 1 }]);
    // An iron pickaxe nearly spent is not a reason to go without a stone one.
    expect(pickaxeAllowance([item('iron_pickaxe', 1, 245), item('stone_pickaxe')], 'stone_pickaxe')).toBe(2);
    expect(surplusPickaxes([item('stone_pickaxe')])).toEqual([]);
    expect(surplusPickaxes([item('iron_pickaxe'), item('iron_pickaxe')])).toEqual([]);
  });

  function room(items: any[]) { return { inventory: { items: () => items, emptySlotCount: () => 36 - items.length } } as any; }

  it('throws from a cheap check, drops the largest heap first, at most two kinds, not what is being mined', async () => {
    const pack = [...stacks('cobblestone', 9), ...stacks('andesite', 4), ...stacks('dirt', 4), ...filler(10)];
    expect(clutterToThrow(room(pack)).map(entry => entry.name)).toEqual(['cobblestone', 'andesite', 'dirt']);
    const thrown: Array<[string, number]> = [];
    const call = vi.fn(async (_skill: string, name: string, count: number) => { thrown.push([name, count]); return { success: true }; });
    const note = await tidyIfCluttered(room(pack), call, { now: () => 1000 });
    expect(thrown).toEqual([['cobblestone', 480], ['andesite', 256]]);
    expect(note).toContain('掘り進みで石が溜まっていた');
    // The stone being mined is never named.
    const mined = vi.fn(async () => ({ success: true }));
    await tidyIfCluttered(room([...stacks('cobblestone', 9), ...filler(10)]), mined, { asked: ['cobblestone'], now: () => 5000 });
    expect(mined).not.toHaveBeenCalled();
  });

  it('does nothing for a tidy pack, so the check can run at every dig', async () => {
    const call = vi.fn();
    expect(await tidyIfCluttered(room([...stacks('cobblestone', 2), ...filler(12)]), call, {})).toBe('');
    expect(call).not.toHaveBeenCalled();
  });

  it('waits a short while after a throw that went, long after one that was refused, and is quiet while a throw is under way', async () => {
    const pack = () => [...stacks('cobblestone', 9), ...filler(10)];
    const bot = room(pack());
    let clock = 10_000;
    const refuse = vi.fn(async () => ({ success: false, failureType: 'picked_up_again', result: 'came back' }));
    const first = await tidyIfCluttered(bot, refuse, { now: () => clock });
    expect(first).toContain('断られました');
    expect(first).toContain('picked_up_again');
    clock += CLUTTER_GAP_MS + 1;
    await tidyIfCluttered(bot, refuse, { now: () => clock });
    expect(refuse).toHaveBeenCalledTimes(1);
    clock += CLUTTER_REFUSED_GAP_MS;
    await tidyIfCluttered(bot, refuse, { now: () => clock });
    expect(refuse).toHaveBeenCalledTimes(2);

    const held = room(pack());
    const quiet = vi.fn(async () => ({ success: true }));
    const release = holdClutterTidy(held);
    expect(await tidyIfCluttered(held, quiet, { now: () => 1 })).toBe('');
    release();
    expect(quiet).not.toHaveBeenCalled();
    // Not with a hostile near, in an emergency, or with the action nearly out of time.
    expect(await tidyIfCluttered(room(pack()), quiet, { blocked: () => true })).toBe('');
    expect(await tidyIfCluttered(room(pack()), quiet, { timeLeftMs: 5000 })).toBe('');
    expect(quiet).not.toHaveBeenCalled();
  });

  it('spare pickaxes are thrown through drop-item too (kept: the best one)', async () => {
    const pack = [item('iron_pickaxe', 1, 10), ...Array.from({ length: 4 }, () => item('stone_pickaxe')), ...filler(5)];
    const call = vi.fn(async () => ({ success: true }));
    await tidyIfCluttered(room(pack), call, { now: () => 1 });
    expect(call).toHaveBeenCalledWith('drop-item', 'stone_pickaxe', 3);
  });
});

describe('a spare pickaxe is made at most once per tier (run 21: five stone pickaxes beside an iron one)', () => {
  const inAction = (bot: any, work: () => Promise<any>) => executeAction(bot, 'mine-block', 0, async () => ({ success: true, result: String(await work()) }));
  function body(items: any[]) {
    return Object.assign(new EventEmitter(), {
      registry, version: '1.21.11', entity: { id: 7, position: new Vec3(0.5, 50, 0.5), effects: {} }, _client: new EventEmitter(),
      inventory: { slots: [], items: () => items, emptySlotCount: () => 20 }, executingSkill: false, interruptExecution: false, health: 20, food: 20,
      clearControlStates: vi.fn(), stopDigging: vi.fn(), deactivateItem: vi.fn(), pathfinder: { stop: vi.fn(), setGoal: vi.fn() },
      findBlocks: () => [], items,
    }) as any;
  }
  const crafting = (bot: any, calls: string[]) => async (skill: string, ...args: any[]) => {
    calls.push(`${skill}:${args[0]}`);
    bot.items.push(item('stone_pickaxe'));
    return { success: true, result: 'crafted' };
  };

  it('with two stone pickaxes carried, a third is not made however short the uses are', async () => {
    const bot = body([item('stone_pickaxe', 1, 125), item('stone_pickaxe', 1, 125), item('cobblestone', 75), item('stick', 4), item('crafting_table')]);
    const calls: string[] = [];
    let check: any;
    await inAction(bot, async () => { check = await ensureToolUses(bot, [block('iron_ore')], 40, crafting(bot, calls)); });
    expect(calls).toEqual([]);
    expect(check.enough).toBe(false);
    expect(check.note).toContain('stone_pickaxeはすでに2本持っています');
  });

  it('with an iron pickaxe of enough uses and one stone pickaxe carried, no stone spare is made', async () => {
    const bot = body([item('iron_pickaxe', 1, 20), item('stone_pickaxe', 1, 120), item('cobblestone', 75), item('stick', 4), item('crafting_table')]);
    const calls: string[] = [];
    let check: any;
    await inAction(bot, async () => { check = await ensureToolUses(bot, [block('iron_ore')], 300, crafting(bot, calls)); });
    expect(calls).toEqual([]);
    expect(check.note).toContain('stone_pickaxeはすでに1本持っています');
  });

  it('with one stone pickaxe and no better one, the second is still made', async () => {
    const bot = body([item('stone_pickaxe', 1, 120), item('cobblestone', 75), item('stick', 4), item('crafting_table')]);
    const calls: string[] = [];
    await inAction(bot, async () => { await ensureToolUses(bot, [block('iron_ore')], 16, crafting(bot, calls)); });
    expect(calls).toEqual(['craft-one:stone_pickaxe']);
  });
});

describe('what the body threw away is not picked up again', () => {
  it('remembers junk kinds by entity id for a while, never a tool', () => {
    const bot = {};
    const heapEntity = { id: 5, name: 'item' };
    expect(noteSelfDropped(bot, 'cobblestone', [heapEntity, { id: 6, name: 'zombie' }], 1000)).toBe(1);
    expect(isSelfDropped(bot, heapEntity, 2000)).toBe(true);
    expect(isSelfDropped(bot, { id: 9, name: 'item' }, 2000)).toBe(false);
    expect(isSelfDropped(bot, heapEntity, 1000 + SELF_DROP_MS + 1)).toBe(false);
    // Food, ore and the like thrown by mistake can be fetched back on purpose; the spare pickaxes the tidy throws are left lying.
    expect(noteSelfDropped(bot, 'iron_ingot', [{ id: 8, name: 'item' }], 1000)).toBe(0);
    expect(isSelfDropped(bot, { id: 8, name: 'item' }, 1500)).toBe(false);
    expect(noteSelfDropped(bot, 'stone_pickaxe', [{ id: 10, name: 'item' }], 1000)).toBe(1);
  });

  /** An open field: ground under y 64, air above; moving "succeeds" by moving; a toss lays item entities near the body. */
  function field(pack: any[]) {
    const entities: Record<number, any> = {};
    let nextId = 100;
    const bot: any = {
      entity: { position: new Vec3(0.5, 64, 0.5) }, entities, version: '1.21.11', registry,
      blockAt: (pos: Vec3) => { const p = pos.floored(); return p.y < 64 ? { name: 'stone', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' }; },
      equip: async () => {}, lookAt: async () => {}, pathfinder: { stop: () => {} },
      inventory: { items: () => pack, emptySlotCount: () => 36 - pack.length },
      toss: vi.fn(async (type: number, _meta: null, count: number) => {
        const stack = pack.find(entry => entry.type === type)!;
        stack.count -= count; if (stack.count <= 0) pack.splice(pack.indexOf(stack), 1);
        // The heap lands a block or two ahead, as separate item entities.
        for (let i = 0; i < Math.ceil(count / 64); i++) {
          const id = nextId++;
          entities[id] = { id, name: 'item', position: bot.entity.position.offset(2 + i * 0.2, 0, 0), getDroppedItem: () => ({ name: stack.name }) };
        }
      }),
      tossStack: vi.fn(async (entry: any) => { pack.splice(pack.indexOf(entry), 1); }),
      instantSkills: { getSkill: () => ({ run: async (x: number, y: number, z: number) => { bot.entity.position = new Vec3(x + 0.5, y, z + 0.5); return { success: true }; } }) },
    };
    return bot;
  }

  it('drop-item marks the heap it threw, ends 3.5 blocks or more from where it threw, and counts nothing back', async () => {
    const pack = [{ name: 'cobblestone', count: 448, type: 3 }, ...filler(30).map((entry, i) => ({ ...entry, type: 100 + i }))];
    const bot = field(pack);
    const result: any = await new DropItem(bot).runImpl('cobblestone', 400);
    expect(result.success).toBe(true);
    const heaps = Object.values(bot.entities) as any[];
    expect(heaps).toHaveLength(7);
    for (const entity of heaps) expect(isSelfDropped(bot, entity)).toBe(true);
    expect(Math.hypot(bot.entity.position.x - 0.5, bot.entity.position.z - 0.5)).toBeGreaterThanOrEqual(3.5);
  });

  it('throws the most worn pickaxes and keeps the best (bot.toss would take them in slot order)', async () => {
    const pack = [{ ...item('stone_pickaxe', 1, 10), name: 'stone_pickaxe' }, { ...item('stone_pickaxe', 1, 120) }, { ...item('stone_pickaxe', 1, 60) }, { ...item('stone_pickaxe', 1, 100) }];
    const bot = field(pack);
    const thrown: number[] = [];
    bot.tossStack = vi.fn(async (entry: any) => { thrown.push(entry.durabilityUsed); pack.splice(pack.indexOf(entry), 1); });
    await (new DropItem(bot) as any).tossItems('stone_pickaxe', pack[0].type, 2);
    expect(thrown).toEqual([120, 100]);
    expect(pack.map(entry => entry.durabilityUsed).sort((a, b) => a - b)).toEqual([10, 60]);
    expect(bot.toss).not.toHaveBeenCalled();
  });

  it('a walk over standable cells finds a place far enough from the heap in a winding tunnel', () => {
    const cells = new Set(['0,10,0', '1,10,0', '2,10,0', '3,10,0', '4,10,0', '5,10,0', '6,10,0', '7,10,0', '8,10,0']);
    const bot: any = { entity: { position: new Vec3(2.5, 10, 0.5) },
      blockAt: (pos: Vec3) => { const p = pos.floored(); const open = (p.y === 10 || p.y === 11) && cells.has(`${p.x},10,${p.z}`);
        return { name: open ? 'air' : 'stone', boundingBox: open ? 'empty' : 'block' }; } };
    const spots = (new DropItem(bot) as any).farSpots(2.5, 0.5, 4);
    expect(spots[0]).toEqual([6, 10, 0]);
    for (const [x] of spots) expect(Math.abs(x + 0.5 - 2.5)).toBeGreaterThanOrEqual(4);
  });

  it('an item that landed on the rim is within the body\'s reach; one in the hole three blocks down is not', () => {
    const bot: any = { entity: { position: new Vec3(0.5, 64, 0.5) } };
    const skill: any = new DropItem(bot);
    expect(skill.strayNearBody([{ id: 1, position: new Vec3(1.2, 64, 0.5) }])).toBe(true);
    expect(skill.strayNearBody([{ id: 2, position: new Vec3(1.2, 61, 0.5) }])).toBe(false);
    expect(skill.strayNearBody([{ id: 3, position: new Vec3(4.2, 64, 0.5) }])).toBe(false);
  });
});

describe('a pickaxe in the pack is taken into the hand with the pack full (run 21: held=none, slot 23, hotbar target 0)', () => {
  /** 36 slots all taken: hotbar 36..44 full, the pickaxe in slot 23. clickWindow(mode 2) swaps with a hotbar slot, as the server does. */
  function fullPack(options: { moveWorks?: boolean; swapWorks?: boolean } = {}) {
    const slots: any[] = Array(46).fill(null);
    for (let slot = 9; slot < 36; slot++) slots[slot] = { name: 'cobblestone', type: 900 + slot, count: 64, slot };
    const hotbar = ['stone_sword', 'bread', 'water_bucket', 'iron_ingot', 'cobblestone', 'torch', 'oak_planks', 'bread', 'coal'];
    hotbar.forEach((name, i) => { slots[36 + i] = { name, type: 500 + i, count: name === 'stone_sword' ? 1 : 8, slot: 36 + i }; });
    const pickaxe = { name: 'stone_pickaxe', type: 7, count: 1, slot: 23, maxDurability: 131, durabilityUsed: 0 };
    slots[23] = pickaxe;
    let quickBarSlot = 0;
    const calls = { equip: 0, move: [] as number[][], click: [] as number[][] };
    const bot: any = Object.assign(new EventEmitter(), {
      registry, inventory: { slots, items: () => slots.filter(Boolean), emptySlotCount: () => 0 },
      equip: async () => { calls.equip++; },
      moveSlotItem: async (from: number, to: number) => { calls.move.push([from, to]); if (options.moveWorks) { const a = slots[from]; slots[from] = slots[to]; slots[to] = a; slots[from].slot = from; slots[to].slot = to; } },
      clickWindow: async (slot: number, button: number, mode: number) => {
        calls.click.push([slot, button, mode]);
        if (options.swapWorks === false) return;
        const other = 36 + button; const a = slots[slot]; slots[slot] = slots[other]; slots[other] = a; slots[slot].slot = slot; slots[other].slot = other;
      },
      setQuickBarSlot: (index: number) => { quickBarSlot = index; },
    });
    Object.defineProperty(bot, 'heldItem', { get: () => slots[36 + quickBarSlot] ?? null });
    Object.defineProperty(bot, 'quickBarSlot', { get: () => quickBarSlot });
    return { bot, slots, calls, pickaxe };
  }

  it('swaps it with the least valuable hotbar slot (the cobblestone), selects it, and loses nothing', async () => {
    const { bot, slots, calls, pickaxe } = fullPack();
    const outcome = await equipToHandVerified(bot, pickaxe);
    expect(outcome.held).toBe(true);
    expect(outcome.detail).toContain('入れ替え');
    expect(calls.click).toEqual([[23, 4, 2]]);
    expect(bot.heldItem?.name).toBe('stone_pickaxe');
    // The cobblestone from the hotbar is in the pack now; the sword, the bread and the bucket are where they were.
    expect(slots[23]?.name).toBe('cobblestone');
    expect(slots.filter(Boolean)).toHaveLength(36);
    expect(slots[36]?.name).toBe('stone_sword');
    expect(slots[38]?.name).toBe('water_bucket');
  });

  it('never gives up a tool, weapon, food or bucket slot while another kind is there', async () => {
    const { bot, slots, calls, pickaxe } = fullPack();
    for (let i = 0; i < 9; i++) slots[36 + i] = { name: ['stone_sword', 'bread', 'water_bucket', 'iron_pickaxe', 'cooked_beef', 'torch', 'shield', 'bread', 'bow'][i], type: 500 + i, count: 1, slot: 36 + i };
    slots[41] = { name: 'oak_planks', type: 600, count: 32, slot: 41 };
    await equipToHandVerified(bot, pickaxe);
    expect(calls.click).toEqual([[23, 5, 2]]);
    expect(slots[23]?.name).toBe('oak_planks');
  });

  it('uses the plain move first, and does not swap when it worked', async () => {
    const { bot, calls, pickaxe } = fullPack({ moveWorks: true });
    const outcome = await equipToHandVerified(bot, pickaxe);
    expect(outcome.held).toBe(true);
    expect(calls.move).toHaveLength(1);
    expect(calls.click).toEqual([]);
  });

  it('says what happened when the swap was not taken either, and tries it only once', async () => {
    const { bot, calls, pickaxe } = fullPack({ swapWorks: false });
    const outcome = await equipToHandVerified(bot, pickaxe);
    expect(outcome.held).toBe(false);
    expect(calls.click).toHaveLength(1);
    expect(outcome.detail).toContain('held=cobblestone');
  });
});

// ---- the bed ----

/** A world of named cells (default stone), from a map of "x,y,z" to a block name. */
function world(cells: Map<string, string>, fallback = 'stone') {
  const air = new Set(['air', 'cave_air']);
  const blockAt = (position: Vec3) => {
    const p = position.floored();
    const name = cells.get(`${p.x},${p.y},${p.z}`) ?? fallback;
    const empty = air.has(name) || name === 'lava' || name === 'water';
    return { name, boundingBox: empty ? 'empty' : 'block', diggable: name !== 'bedrock', position: p };
  };
  return { cells, blockAt };
}
/** A passage along x at y 10..11 (cells x from..to), stone round it. */
function passage(from: number, to: number, extra: Record<string, string> = {}, fallback = 'stone') {
  const cells = new Map<string, string>();
  for (let x = from; x <= to; x++) { cells.set(`${x},10,0`, 'air'); cells.set(`${x},11,0`, 'air'); }
  for (const [key, name] of Object.entries(extra)) cells.set(key, name);
  return world(cells, fallback);
}
const keys = (cells: Vec3[]) => cells.map(cell => `${cell.x},${cell.y},${cell.z}`);

describe('a bed spot is made where there is none (run 21: a rock passage one block wide)', () => {
  const body = (x: number) => bodyCells(new Vec3(x, 10, 0.5));
  const options = (x: number, patch: object = {}) => ({ isFree: isFreeCell, hasPickaxe: true, fillers: 10, body: body(x), ...patch });

  it('a two-cell passage: the bed lies away from the body, the fewest cells are dug, the cells over it first', () => {
    const w = passage(0, 1);
    const plan = planBedSpot(w, new Vec3(1.5, 10, 0.5), options(1.5))!;
    expect(plan).not.toBeNull();
    expect(`${plan.pos.x},${plan.pos.y},${plan.pos.z}`).toBe('0,10,0');
    expect(`${plan.head.x},${plan.head.y},${plan.head.z}`).toBe('-1,10,0');
    expect(keys(plan.dig)).toEqual(['-1,11,0', '-1,10,0']);
    expect(plan.fill).toEqual([]);
  });

  it('never digs beside lava or water, under a falling block, or through goods, workstations and obsidian', () => {
    // Lava past the head cell of the cheapest spot: it is not chosen, and nothing planned touches a hazard.
    const hazards: Record<string, string> = { '-2,10,0': 'lava', '3,10,0': 'water', '2,10,1': 'lava', '-1,12,0': 'gravel', '2,12,0': 'sand',
      '0,10,1': 'chest', '0,10,-1': 'furnace', '1,9,0': 'obsidian', '-1,10,1': 'crafting_table' };
    const w = passage(0, 1, hazards);
    const plan = planBedSpot(w, new Vec3(1.5, 10, 0.5), options(1.5))!;
    expect(plan).not.toBeNull();
    expect(keys([plan.pos, plan.head])).not.toContain('-1,10,0');
    const nameAt = (cell: Vec3) => w.blockAt(cell).name;
    for (const cell of plan.dig) {
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]]) {
        expect(['lava', 'water']).not.toContain(nameAt(cell.offset(dx, dy, dz)));
      }
      expect(['gravel', 'sand']).not.toContain(nameAt(cell.offset(0, 1, 0)));
      expect(['chest', 'furnace', 'obsidian', 'crafting_table']).not.toContain(nameAt(cell));
    }
    // Rock that is all liquid: nothing to make a spot of.
    expect(planBedSpot(passage(0, 1, {}, 'lava'), new Vec3(1.5, 10, 0.5), options(1.5))).toBeNull();
  });

  it('with no pickaxe, only a spot that needs no digging; with no filler, none with a hole in the floor', () => {
    expect(planBedSpot(passage(0, 1), new Vec3(1.5, 10, 0.5), options(1.5, { hasPickaxe: false }))).toBeNull();
    const open = passage(0, 5);
    const noPick = planBedSpot(open, new Vec3(1.5, 10, 0.5), options(1.5, { hasPickaxe: false }))!;
    expect(noPick.dig).toEqual([]);
    // Air two deep under the whole passage (a hole): a floor has to be put in one level down, which needs a filler.
    const holes: Record<string, string> = {};
    for (let x = 0; x <= 5; x++) { holes[`${x},9,0`] = 'air'; holes[`${x},8,0`] = 'air'; }
    // (Bedrock all round, so the passage is all there is to use.)
    expect(planBedSpot(passage(0, 5, holes, 'bedrock'), new Vec3(1.5, 10, 0.5), options(1.5, { hasPickaxe: false, fillers: 0 }))).toBeNull();
    const filled = planBedSpot(passage(0, 5, holes, 'bedrock'), new Vec3(1.5, 10, 0.5), options(1.5, { fillers: 4 }))!;
    expect(filled.fill.length).toBeGreaterThan(0);
    expect(filled.fill.every(cell => cell.y === 8)).toBe(true);
  });

  it('walks over standable cells: a cave a few steps off is reachable, one behind rock is not', () => {
    const cave = passage(0, 8);
    const walk = walkableCells(cave, new Vec3(1.5, 10, 0.5), 10);
    expect(walk.has('7,10,0')).toBe(true);
    expect(walk.get('4,10,0')).toBe(3);
    const split = passage(0, 8, { '4,10,0': 'stone', '4,11,0': 'stone' });
    expect(walkableCells(split, new Vec3(1.5, 10, 0.5), 10).has('7,10,0')).toBe(false);
    expect(walkableCells(cave, new Vec3(1.5, 10, 0.5), 3).has('7,10,0')).toBe(false);
  });

  /** A body in a passage, a bed in the pack, night; digging turns a cell to air, placing a block sets it, and a placed bed can be slept in. */
  function sleeper(w: ReturnType<typeof world>, items: any[], position = new Vec3(1.5, 10, 0.5)) {
    let placedAt: Vec3 | null = null;
    const bot: any = Object.assign(new EventEmitter(), {
      entity: { position }, entities: {}, time: { timeOfDay: 15_000 }, game: { dimension: 'overworld' }, isSleeping: false,
      isABed: (b: any) => String(b?.name).endsWith('_bed'),
      findBlock: () => placedAt ? { name: 'white_bed', position: placedAt } : null,
      blockAt: w.blockAt, inventory: { items: () => items }, equip: vi.fn(async () => {}), lookAt: vi.fn(async () => {}), pathfinder: { stop: () => {} },
      placeBlock: vi.fn(async (reference: any, face: Vec3) => { placedAt = reference.position.plus(face); w.cells.set(`${placedAt.x},${placedAt.y},${placedAt.z}`, 'white_bed'); }),
      sleep: vi.fn(async () => { setTimeout(() => bot.emit('wake'), 5); }),
    });
    const skill: any = new SleepInBed(bot);
    const calls: string[] = [];
    skill.callSkill = vi.fn(async (name: string, ...args: any[]) => {
      calls.push(`${name}:${args.slice(0, 4).join(',')}`);
      if (name === 'dig-block-at') { w.cells.set(`${args[0]},${args[1]},${args[2]}`, 'air'); return { success: true, result: 'dug' }; }
      if (name === 'place-block-at') { w.cells.set(`${args[1]},${args[2]},${args[3]}`, args[0]); return { success: true, result: 'placed' }; }
      return { success: false };
    });
    return { bot, skill, calls };
  }

  it('in a passage with no room: digs the head cell and the air over it, then places the bed along the cleared cells and sleeps', async () => {
    const w = passage(0, 1);
    const { bot, skill, calls } = sleeper(w, [{ name: 'white_bed', count: 1 }, { name: 'stone_pickaxe', count: 1 }]);
    expect(skill.findPlaceForBed()).toBeNull();
    expect(skill.findWiderPlaceForBed()).toBeNull();
    const result: any = await skill.runImpl(false, false);
    expect(result.success).toBe(true);
    expect(result.result).toContain('ベッドを設置して眠');
    expect(calls.slice(0, 2)).toEqual(['dig-block-at:-1,11,0,false', 'dig-block-at:-1,10,0,false']);
    expect(bot.placeBlock).toHaveBeenCalledTimes(1);
    const reference = bot.placeBlock.mock.calls[0][0];
    expect(`${reference.position.x},${reference.position.y},${reference.position.z}`).toBe('0,9,0');
    // The body faces the head cell, so the bed lies that way.
    expect(bot.lookAt).toHaveBeenCalled();
    const looked = bot.lookAt.mock.calls.at(-1)[0];
    expect(looked.x).toBeCloseTo(-0.5);
  });

  it('a cave a few steps off is found by the wider search and nothing is dug', async () => {
    // A passage 1 wide and 2 high in rock, going down a stair of four steps (three high) to a room at x 6..9, four levels lower.
    const w = passage(0, 1);
    for (let i = 0; i < 4; i++) for (let dy = 0; dy < 3; dy++) w.cells.set(`${2 + i},${9 - i + dy},0`, 'air');
    for (let x = 6; x <= 9; x++) for (let z = -2; z <= 2; z++) for (const y of [6, 7, 8]) w.cells.set(`${x},${y},${z}`, 'air');
    const { skill, calls } = sleeper(w, [{ name: 'white_bed', count: 1 }], new Vec3(0.5, 10, 0.5));
    expect(skill.findPlaceForBed()).toBeNull();
    const spot = skill.findWiderPlaceForBed();
    expect(spot).not.toBeNull();
    expect(spot.x).toBeGreaterThanOrEqual(5);
    expect(spot.y).toBe(6);
    expect(calls).toEqual([]);
    // Behind rock (the stair cut off) the same room is not "a short walk": nothing is found without digging.
    w.cells.set('3,8,0', 'stone'); w.cells.set('3,9,0', 'stone'); w.cells.set('3,10,0', 'stone');
    expect(skill.findWiderPlaceForBed()).toBeNull();
  });

  it('says why, with its own failure type, when no spot can be made (no pickaxe), and when a dig is refused', async () => {
    const w = passage(0, 1);
    const none = sleeper(w, [{ name: 'white_bed', count: 1 }]);
    const refused: any = await none.skill.runImpl(false, false);
    expect(refused).toMatchObject({ success: false, failureType: 'no_bed_spot', recoverable: true });
    expect(refused.result).toContain('ベッドを設置できる適切な場所が見つかりませんでした');
    expect(refused.result).toContain('ツルハシを持っていません');

    const w2 = passage(0, 1);
    const stuck = sleeper(w2, [{ name: 'white_bed', count: 1 }, { name: 'stone_pickaxe', count: 1 }]);
    stuck.skill.callSkill = vi.fn(async () => ({ success: false, result: 'lava_danger' }));
    const failed: any = await stuck.skill.runImpl(false, false);
    expect(failed).toMatchObject({ success: false, failureType: 'bed_spot_prepare_failed' });
    expect(failed.result).toContain('lava_danger');
  });

  it('keeps the refusal for a hostile near, before any spot is touched', async () => {
    const w = passage(0, 1);
    const { bot, skill, calls } = sleeper(w, [{ name: 'white_bed', count: 1 }, { name: 'stone_pickaxe', count: 1 }]);
    bot.entities = { 1: { name: 'zombie', position: new Vec3(4.5, 10, 0.5) } };
    const result: any = await skill.runImpl(false, false);
    expect(result.success).toBe(false);
    expect(result.result).toContain('近くに敵');
    expect(calls).toEqual([]);
  });
});
