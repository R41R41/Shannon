import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import { repairTierToolMaterials } from '../../src/services/minebot/utils/registryRepairs.js';
import { chooseTool } from '../../src/services/minebot/utils/toolChoice.js';
import { blocksAlong, decideRestock, describeToolOptions, keepCheapTool, planCraft } from '../../src/services/minebot/utils/toolStock.js';
import { installToolWearMonitor } from '../../src/services/minebot/utils/toolWear.js';
import { executeAction } from '../../src/services/minebot/execution/ActionExecution.js';
import { beginEngagement } from '../../src/services/minebot/utils/engagement.js';
import { InstantSkill } from '../../src/services/minebot/types/skills.js';

const require = createRequire(import.meta.url);
const registry = require('prismarine-registry')('1.21.11');
repairTierToolMaterials(registry);
const Block = require('prismarine-block')(registry);
const block = (name: string) => Block.fromStateId(registry.blocksByName[name].defaultState, 0);
const item = (name: string, count = 1, used = 0) => ({ type: registry.itemsByName[name].id, name, count,
  maxDurability: registry.itemsByName[name].maxDurability, durabilityUsed: used });

/** The L111 bag after the stone and wooden pickaxes broke: the iron pickaxe, cobblestone, sticks, planks, logs. */
const l111Bag = () => [item('iron_pickaxe', 1, 80), item('cobblestone', 64), item('cobblestone', 64), item('stick', 3),
  item('oak_planks', 5), item('oak_log', 9), item('iron_ingot', 29), item('shield')];

describe('making the cheap tool from what is carried (registry recipes)', () => {
  it('plans a stone pickaxe from cobblestone and sticks at a table, and says what it uses', () => {
    const outcome = planCraft(registry, [item('cobblestone', 10), item('stick', 2)], 'stone_pickaxe', true);
    expect('plan' in outcome && outcome.plan).toMatchObject({ steps: [{ item: 'stone_pickaxe', count: 1 }], table: 'near',
      uses: expect.arrayContaining([['cobblestone', 3], ['stick', 2]]) });
  });

  it('makes the sticks and the crafting table on the way from planks and logs', () => {
    const outcome = planCraft(registry, [item('cobblestone', 10), item('oak_log', 2)], 'stone_pickaxe', false);
    expect('plan' in outcome).toBe(true);
    const plan = (outcome as any).plan;
    expect(plan.steps.map((step: any) => step.item)).toContain('crafting_table');
    expect(plan.steps.map((step: any) => step.item)).toContain('stick');
    expect(plan.steps.at(-1).item).toBe('stone_pickaxe');
    expect(plan.table).toBe('made');
  });

  it('says what is missing when it cannot be made', () => {
    const outcome = planCraft(registry, [item('stick', 2)], 'stone_pickaxe', true);
    expect(outcome).toEqual({ missing: expect.stringContaining('cobblestone×3') });
  });
});

describe('deciding to restock (cost model, not item lists)', () => {
  const stone = block('stone');

  it('L111: only the iron pickaxe left for stone, materials carried → make a stone pickaxe', () => {
    const decision = decideRestock(registry, l111Bag(), [stone], { tableNear: false });
    expect(decision).toMatchObject({ kind: 'make', block: 'stone', current: 'iron_pickaxe', plan: { item: 'stone_pickaxe' } });
    expect((decision as any).saving).toBeGreaterThan(1);
  });

  it('nothing is spent that need not be: a stone pickaxe on stone, or iron where only iron harvests', () => {
    expect(decideRestock(registry, [item('stone_pickaxe'), item('cobblestone', 64), item('stick', 8)], [stone], { tableNear: true })).toBeNull();
    expect(decideRestock(registry, [item('iron_pickaxe'), item('cobblestone', 64), item('stick', 8)], [block('diamond_ore')], { tableNear: true })).toBeNull();
    // A wooden pickaxe is not upgraded: the dearer material is never what is made.
    expect(decideRestock(registry, [item('wooden_pickaxe'), item('cobblestone', 64), item('stick', 8)], [stone], { tableNear: true })).toBeNull();
  });

  it('no materials → a shortage, nothing to craft', () => {
    const decision = decideRestock(registry, [item('iron_pickaxe'), item('dirt', 10)], [stone], { tableNear: true });
    expect(decision).toMatchObject({ kind: 'short', current: 'iron_pickaxe', wanted: 'stone_pickaxe' });
  });

  it('samples the blocks a tunnel would meet, one of each kind', () => {
    const world = new Map<string, any>([['3,64,0', block('stone')], ['3,65,0', block('stone')], ['5,64,0', block('andesite')], ['6,65,0', block('dirt')]]);
    const bot: any = { blockAt: (p: Vec3) => world.get(`${p.x},${p.y},${p.z}`) ?? block('air') };
    expect(blocksAlong(bot, new Vec3(0.5, 64, 0.5), new Vec3(8.5, 64, 0.5)).map(b => b.name)).toEqual(['stone', 'andesite']);
  });
});

function body(items: any[], options: { table?: Vec3 | null } = {}): any {
  const tables: Vec3[] = options.table ? [options.table] : [];
  const bot: any = Object.assign(new EventEmitter(), {
    registry, version: '1.21.11', entity: { id: 7, position: new Vec3(0.5, 50, 0.5), effects: {} }, _client: new EventEmitter(),
    inventory: { slots: [], items: () => items }, executingSkill: false, interruptExecution: false, health: 20, food: 20,
    clearControlStates: vi.fn(), stopDigging: vi.fn(), deactivateItem: vi.fn(), pathfinder: { stop: vi.fn(), setGoal: vi.fn() },
    findBlocks: ({ maxDistance }: any) => tables.filter(t => t.distanceTo(bot.entity.position) <= maxDistance),
    tables, items, setItems: (next: any[]) => { items.length = 0; items.push(...next); },
  });
  return bot;
}

/** A fake craft-one that applies the recipe to the bag, putting a carried table down when none is near. */
function fakeCrafting(bot: any, calls: string[]) {
  return async (skill: string, ...args: any[]) => {
    calls.push(`${skill}:${args[0]}`);
    if (skill === 'dig-block-at') {
      const index = bot.tables.findIndex((t: Vec3) => t.x === args[0] && t.y === args[1] && t.z === args[2]);
      bot.tables.splice(index, 1); bot.items.push(item('crafting_table'));
      return { success: true, result: 'dug' };
    }
    const outcome = planCraft(registry, bot.items, args[0], bot.tables.length > 0);
    if (!('plan' in outcome)) return { success: false, result: outcome.missing };
    const last = outcome.plan.steps.at(-1)!;
    if (outcome.plan.steps.length !== 1) return { success: false, result: 'one craft at a time' };
    // Use the materials, add the product.
    for (const [name, n] of outcome.plan.uses) {
      let left = n;
      for (const carried of bot.items) if (carried.name === name && left > 0) { const t = Math.min(left, carried.count); carried.count -= t; left -= t; }
    }
    if (outcome.plan.table === 'carried') {
      const t = bot.items.find((c: any) => c.name === 'crafting_table'); t.count -= 1; bot.tables.push(new Vec3(1, 50, 0));
    }
    bot.setItems(bot.items.filter((c: any) => c.count > 0));
    const made = registry.recipes[registry.itemsByName[last.item].id][0].result.count;
    bot.items.push(item(last.item, Math.max(made, args[1] ?? 1)));
    return { success: true, result: `${last.item} crafted` };
  };
}

describe('the body keeps a cheap tool for routine digging (paid run L111)', () => {
  const inAction = (bot: any, work: () => Promise<any>, capability = 'mine-block') =>
    executeAction(bot, capability, 0, async () => ({ success: true, result: String(await work()) }));

  it('only an iron pickaxe, cobblestone and sticks, a table in reach: a stone pickaxe is made before stone is dug', async () => {
    const bot = body([item('iron_pickaxe', 1, 80), item('cobblestone', 64), item('stick', 3)], { table: new Vec3(2, 50, 0) });
    const calls: string[] = [];
    let dugWith = '';
    await inAction(bot, async () => {
      await keepCheapTool(bot, [block('stone')], fakeCrafting(bot, calls));
      dugWith = chooseTool(block('stone'), bot.items, { requireHarvest: true })!.name;
      // Once per action: a second dig in the same action does not craft again.
      await keepCheapTool(bot, [block('stone')], fakeCrafting(bot, calls));
    });
    expect(calls).toEqual(['craft-one:stone_pickaxe']);
    expect(dugWith).toBe('stone_pickaxe');
  });

  it('L111 as it was: no table near, planks carried → a table is made, used and taken back', async () => {
    const bot = body(l111Bag());
    const calls: string[] = [];
    await inAction(bot, () => keepCheapTool(bot, [block('stone'), block('andesite')], fakeCrafting(bot, calls)));
    expect(calls[0]).toBe('craft-one:crafting_table');
    expect(calls).toContain('craft-one:stone_pickaxe');
    expect(calls.at(-1)).toBe('dig-block-at:1');
    expect(bot.items.some((c: any) => c.name === 'stone_pickaxe')).toBe(true);
    expect(bot.items.some((c: any) => c.name === 'crafting_table')).toBe(true);
    expect(chooseTool(block('stone'), bot.items, { requireHarvest: true })!.name).toBe('stone_pickaxe');
  });

  it('no materials: nothing is crafted, and the action result says what is missing', async () => {
    const bot = body([item('iron_pickaxe'), item('dirt', 10)], { table: new Vec3(2, 50, 0) });
    const calls: string[] = [];
    class Digging extends InstantSkill {
      constructor(host: any) { super(host); this.skillName = 'dig-block-at'; }
      async runImpl() { await keepCheapTool(this.bot as any, [block('stone')], fakeCrafting(bot, calls)); return { success: true, result: 'dug' }; }
    }
    const result = await new Digging(bot).run();
    expect(calls).toEqual([]);
    expect(result.result).toContain('stone_pickaxeは材料が足りず作れません');
    expect(result.result).toContain('cobblestone×3');
  });

  it('never while an emergency or a chosen fight runs, nor in a reflex', async () => {
    const calls: string[] = [];
    const emergency = body([item('iron_pickaxe'), item('cobblestone', 64), item('stick', 4)], { table: new Vec3(2, 50, 0) });
    emergency.minebotControlState = 'emergency_llm';
    await inAction(emergency, () => keepCheapTool(emergency, [block('stone')], fakeCrafting(emergency, calls)), 'dig-shelter');
    const fighting = body([item('iron_pickaxe'), item('cobblestone', 64), item('stick', 4)], { table: new Vec3(2, 50, 0) });
    const end = beginEngagement(fighting, ['zombie']);
    await inAction(fighting, () => keepCheapTool(fighting, [block('stone')], fakeCrafting(fighting, calls)));
    end();
    const reflex = body([item('iron_pickaxe'), item('cobblestone', 64), item('stick', 4)], { table: new Vec3(2, 50, 0) });
    await executeAction(reflex, 'flee-from', 0, async () => {
      await keepCheapTool(reflex, [block('stone')], fakeCrafting(reflex, calls)); return { success: true, result: '' };
    }, { priority: 200 });
    expect(calls).toEqual([]);
  });

  it('a tool break tells the planner what the carried materials can make', async () => {
    vi.useFakeTimers();
    try {
      const items = [item('iron_pickaxe', 1, 80), item('stone_pickaxe', 1, 130), item('cobblestone', 64), item('stick', 3)];
      const bot = body(items, { table: new Vec3(2, 50, 0) });
      bot.heldItem = { name: 'stone_pickaxe', maxDurability: 131 };
      installToolWearMonitor(bot);
      bot.emit('physicsTick');
      class Mining extends InstantSkill {
        constructor(host: any) { super(host); this.skillName = 'mine-block'; }
        async runImpl() { await new Promise(resolve => setTimeout(resolve, 5000)); return { success: true, result: 'mined' }; }
      }
      const running = new Mining(bot).run();
      await vi.advanceTimersByTimeAsync(100);
      bot.setItems(items.filter(c => c.name !== 'stone_pickaxe'));
      bot._client.emit('entity_status', { entityId: 7, entityStatus: 47 });
      await vi.advanceTimersByTimeAsync(5000);
      const result: any = await running;
      expect(result.failureType).toBe('tool_broke');
      expect(result.result).toContain('手持ちの材料で作れるpickaxe: stone_pickaxe（cobblestone×3・stick×2を使う）');
      expect(describeToolOptions(body([item('iron_pickaxe'), item('dirt', 3)]), ['stone_pickaxe'])).toContain('stone_pickaxeには');
    } finally { vi.useRealTimers(); }
  });
});
