import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';
import HarvestCrop from '../../src/services/minebot/instantSkills/harvestCrop.js';
import PickupNearestItem from '../../src/services/minebot/instantSkills/pickupNearestItem.js';
import MineBlock from '../../src/services/minebot/instantSkills/mineBlock.js';
import TowerUp from '../../src/services/minebot/instantSkills/towerUp.js';
import CraftOne from '../../src/services/minebot/instantSkills/craftOne.js';
import AutoEat from '../../src/services/minebot/constantSkills/autoEat.js';
import { CombatController } from '../../src/services/minebot/combat/CombatController.js';
import { ActionScorer } from '../../src/services/minebot/combat/ActionScorer.js';
import { ActionExecutor } from '../../src/services/minebot/combat/ActionExecutor.js';
import { SituationScanner } from '../../src/services/minebot/combat/SituationScanner.js';
import { setMovements } from '../../src/services/minebot/utils/setMovements.js';
import { blockCenterWithinDigReach, GoalReachBlock } from '../../src/services/minebot/utils/blockInteractionReach.js';
import type { SituationVector } from '../../src/services/minebot/combat/types.js';

describe('progressive live trial regressions', () => {
  it('uses eye-to-block reach and an attainable walking node for a floating trunk', () => {
    const target = new Vec3(1, 105, 0);
    const feet = new Vec3(0.5, 100, 0.5);
    expect(feet.distanceTo(target)).toBeGreaterThan(4.5);
    expect(blockCenterWithinDigReach(feet, target)).toBe(true);
    expect(new GoalReachBlock(1, 105, 0).isEnd(new Vec3(0, 100, 0))).toBe(true);
    expect(new GoalReachBlock(1, 105, 0).isEnd(new Vec3(15, 100, 0))).toBe(false);
    expect(new GoalReachBlock(1, 110, 0).isEnd(new Vec3(0, 100, 0))).toBe(false);
  });

  it('does not declare a walking node arrived if its far edge exceeds real dig reach', () => {
    const target = new Vec3(0, 98, 0);
    const goal = new GoalReachBlock(0, 98, 0);
    const node = new Vec3(4, 100, 0);
    const farCorner = new Vec3(4.99, 100, 0.99);
    expect(blockCenterWithinDigReach(farCorner, target)).toBe(false);
    expect(goal.isEnd(node)).toBe(false);
  });

  it('tries an exposed mining target before a slightly nearer buried one', async () => {
    const buried = new Vec3(5, 100, 0);
    const exposed = new Vec3(8, 100, 0);
    const bot: any = Object.assign(new EventEmitter(), {
      version: '1.21.11', registry: minecraftData('1.21.11'),
      entity: { position: new Vec3(0.5, 100, 0.5) }, entities: {}, interruptExecution: false,
      inventory: { items: () => [], emptySlotCount: () => 30 },
      findBlocks: () => [buried, exposed],
      blockAt: (pos: Vec3) => pos.x === 9 ? { name: 'air' }
        : pos.x === 5 || pos.x === 8 ? { name: 'oak_log', position: pos, diggable: true }
        : { name: 'stone' },
    });
    const move = { run: vi.fn().mockResolvedValue({ success: false, failureType: 'path_not_found', recoverable: true }) };
    bot.instantSkills = { getSkill: (name: string) => name === 'move-to' ? move : { run: vi.fn() } };
    await new MineBlock(bot).runImpl('oak_log', 1, 16);
    expect(move.run.mock.calls[0].slice(0, 3)).toEqual([8, 100, 0]);
  });
  it('tries a different log on the next call after the nearest ones could not be reached', async () => {
    // Paid run 2026-10-01 (run15): repeated calls re-picked the same two cliff-top logs and timed out.
    const near = [new Vec3(3, 100, 0), new Vec3(3, 100, 1), new Vec3(3, 100, 2)];
    const far = new Vec3(12, 100, 0);
    const bot: any = Object.assign(new EventEmitter(), {
      version: '1.21.11', registry: minecraftData('1.21.11'),
      entity: { position: new Vec3(-10.5, 100, 0.5) }, entities: {}, interruptExecution: false,
      inventory: { items: () => [], emptySlotCount: () => 30 },
      findBlocks: () => [...near, far],
      blockAt: (pos: Vec3) => [...near, far].some(p => p.equals(pos.floored()))
        ? { name: 'oak_log', position: pos, diggable: true } : { name: 'air' },
    });
    const move = { run: vi.fn().mockResolvedValue({ success: false, failureType: 'movement_failed', recoverable: true }) };
    const dig = { run: vi.fn().mockResolvedValue({ success: false, failureType: 'dig_failed', result: 'fixture' }) };
    bot.instantSkills = { getSkill: (name: string) => name === 'move-to' ? move : dig };
    const first: any = await new MineBlock(bot).runImpl('oak_log', 1, 32);
    expect(first.result).toContain('後回し');
    expect(move.run.mock.calls.map(call => call[0])).toEqual([3, 3, 3]);
    move.run.mockClear();
    await new MineBlock(bot).runImpl('oak_log', 1, 32);
    expect(move.run.mock.calls[0].slice(0, 3)).toEqual([12, 100, 0]);
  });
  it('skips ore touching a water source so mining never pulls the bot under water', async () => {
    // Paid run 2026-10-01: mine-block dived for lake-floor iron ore and the bot drowned.
    const lakeFloor = new Vec3(3, 58, 0);
    const dry = new Vec3(10, 61, 0);
    const registry = minecraftData('1.21.11');
    const stonePickaxe = { name: 'stone_pickaxe', type: registry.itemsByName.stone_pickaxe.id, count: 1, maxDurability: 131, durabilityUsed: 0 };
    const blocks = (ores: Vec3[]) => (position: Vec3) => ores.some(ore => ore.equals(position))
      ? { name: 'iron_ore', position, diggable: true }
      : position.equals(lakeFloor.offset(0, 1, 0)) ? { name: 'water', metadata: 0 } : { name: 'air' };
    const bot: any = Object.assign(new EventEmitter(), {
      version: '1.21.11', registry, entity: { position: new Vec3(0, 61, 0) }, entities: {}, interruptExecution: false,
      inventory: { items: () => [stonePickaxe], emptySlotCount: () => 30 },
      findBlocks: () => [lakeFloor, dry], blockAt: blocks([lakeFloor, dry]),
    });
    const move = { run: vi.fn().mockResolvedValue({ success: false, failureType: 'path_not_found', recoverable: true }) };
    bot.instantSkills = { getSkill: (name: string) => name === 'move-to' ? move : { run: vi.fn() } };
    await new MineBlock(bot).runImpl('iron_ore', 1, 32);
    const targets = move.run.mock.calls.map(call => call.slice(0, 3));
    expect(targets[0]).toEqual([10, 61, 0]);
    expect(targets).not.toContainEqual([3, 58, 0]);

    bot.findBlocks = () => [lakeFloor];
    bot.blockAt = blocks([lakeFloor]);
    const onlySubmerged = await new MineBlock(bot).runImpl('iron_ore', 1, 32);
    expect(onlySubmerged).toMatchObject({ success: false, failureType: 'target_not_found' });
    expect(onlySubmerged.result).toContain('水源に接する1個');
  });
  it('tries shallow ore before a geometrically nearer deep one while retaining deep fallback', async () => {
    const deep = new Vec3(6, 48, -10);
    const shallow = new Vec3(12, 59, -14);
    const registry = minecraftData('1.21.11');
    const stonePickaxe = { name: 'stone_pickaxe', type: registry.itemsByName.stone_pickaxe.id,
      count: 1, maxDurability: 131, durabilityUsed: 0 };
    const bot: any = Object.assign(new EventEmitter(), {
      version: '1.21.11', registry,
      entity: { position: new Vec3(0, 61, 0) }, entities: {}, interruptExecution: false,
      inventory: { items: () => [stonePickaxe], emptySlotCount: () => 30 },
      findBlocks: () => [deep, shallow],
      blockAt: (position: Vec3) => [deep, shallow].some(ore => ore.equals(position))
        ? { name: 'iron_ore', position, diggable: true } : { name: 'air' },
    });
    const move = { run: vi.fn().mockResolvedValue({ success: false, failureType: 'path_not_found', recoverable: true }) };
    bot.instantSkills = { getSkill: (name: string) => name === 'move-to' ? move : { run: vi.fn() } };
    await new MineBlock(bot).runImpl('iron_ore', 1, 32);
    expect(move.run.mock.calls[0].slice(0, 3)).toEqual([12, 59, -14]);
    expect(move.run.mock.calls[1].slice(0, 3)).toEqual([6, 48, -10]);
  });
  it('prefers an ore already in digging reach over one with a lower travel proxy', async () => {
    const reachableUpper = new Vec3(1, 65, 0);
    const levelButFarther = new Vec3(7, 61, 0);
    const registry = minecraftData('1.21.11');
    let dug = false;
    const bot: any = Object.assign(new EventEmitter(), {
      version: '1.21.11', registry,
      entity: { position: new Vec3(0.5, 61, 0.5) }, entities: {}, interruptExecution: false,
      inventory: { items: () => [{ name: 'stone_pickaxe', type: registry.itemsByName.stone_pickaxe.id,
        count: 1, maxDurability: 131, durabilityUsed: 0 }, ...(dug ? [{ name: 'raw_iron', count: 1 }] : [])], emptySlotCount: () => 30 },
      findBlocks: () => dug ? [] : [reachableUpper, levelButFarther],
      blockAt: (position: Vec3) => !dug && [reachableUpper, levelButFarther].some(ore => ore.equals(position))
        ? { name: 'iron_ore', position, diggable: true } : { name: 'air' },
    });
    const move = { run: vi.fn() };
    const dig = { run: vi.fn(async (x: number, y: number, z: number) => {
      dug = true; bot.emit('diggingCompleted', { name: 'air', position: new Vec3(x, y, z) });
      return { success: true, result: 'dug' };
    }) };
    bot.instantSkills = { getSkill: (name: string) => name === 'move-to' ? move : dig };
    const skill: any = new MineBlock(bot);
    skill.collectAllNearbyDrops = async () => [];
    const result = await skill.runImpl('iron_ore', 1, 16);
    expect(result.success).toBe(true);
    expect(move.run).not.toHaveBeenCalled();
    expect(dig.run.mock.calls[0].slice(0, 3)).toEqual([1, 65, 0]);
  });
  it('counts every stack of tower material before deciding it is insufficient', async () => {
    const items = [{ name: 'cobblestone', count: 5 }, { name: 'cobblestone', count: 64 }];
    const bot: any = { inventory: { items: () => items }, entity: { position: new Vec3(0, 60, 0) },
      equip: vi.fn().mockRejectedValue(new Error('fixture stop after preflight')) };
    const result = await new TowerUp(bot).runImpl(7, 'cobblestone');
    expect(result.failureType).toBe('equip_failed');
    expect(bot.equip).toHaveBeenCalledOnce();
  });

  it('digs a reachable upper log without pathing into its unsupported Y level', async () => {
    const target = new Vec3(1, 104, 0);
    let harvested = false;
    const bot: any = Object.assign(new EventEmitter(), {
      version: '1.21.11', registry: minecraftData('1.21.11'), entity: { position: new Vec3(0.5, 100, 0.5) }, interruptExecution: false,
      inventory: { items: () => harvested ? [{ name: 'oak_log', count: 1 }] : [], emptySlotCount: () => 30 },
      findBlocks: () => harvested ? [] : [target],
      blockAt: () => harvested ? null : { name: 'oak_log', position: target, diggable: true },
    });
    const move = { run: vi.fn().mockResolvedValue({ success: false, failureType: 'path_not_found' }) };
    const dig = { run: vi.fn(async () => { harvested = true; bot.emit('diggingCompleted', { name: 'air', position: target }); return { success: true, result: 'dug' }; }) };
    bot.instantSkills = { getSkill: (name: string) => name === 'dig-block-at' ? dig : move };
    const skill: any = new MineBlock(bot);
    skill.collectAllNearbyDrops = async () => [];
    expect(await skill.runImpl('oak_log', 1, 16)).toMatchObject({ success: true });
    expect(move.run).not.toHaveBeenCalled();
    expect(dig.run).toHaveBeenCalledOnce();
  });
  it('refreshes a stale closed-table inventory through a new server window', async () => {
    let count = 2;
    const window = { type: 'minecraft:crafting', id: 2 };
    const bot: any = Object.assign(new EventEmitter(), {
      version: '1.21.11', interruptExecution: false,
      inventory: { items: () => [{ name: 'bread', count }] },
      activateBlock: vi.fn(async () => { bot.currentWindow = window; bot.emit('windowOpen', window); }),
      closeWindow: vi.fn(() => { count = 3; bot.currentWindow = null; }),
    });
    const skill: any = new CraftOne(bot);
    await skill.refreshIncompleteTableOutput({}, 'bread', 0, 3);
    expect(count).toBe(3);
    expect(bot.activateBlock).toHaveBeenCalledOnce();
    expect(bot.closeWindow).toHaveBeenCalledWith(window);
    expect(bot.listenerCount('windowOpen')).toBe(0);
    await skill.refreshIncompleteTableOutput({}, 'bread', 0, 3);
    expect(bot.activateBlock).toHaveBeenCalledOnce(); // no extra round trip when already complete
  });
  it('rejects an unexpected numeric window type without losing the partial output', async () => {
    const window = { type: 1, id: 2 };
    const bot: any = Object.assign(new EventEmitter(), {
      version: '1.21.11', interruptExecution: false,
      inventory: { items: () => [{ name: 'bread', count: 2 }] },
      activateBlock: async () => { bot.currentWindow = window; bot.emit('windowOpen', window); },
      closeWindow: vi.fn(),
    });
    await (new CraftOne(bot) as any).refreshIncompleteTableOutput({}, 'bread', 0, 3);
    expect(bot.closeWindow).not.toHaveBeenCalled();
    expect(bot.inventory.items()[0].count).toBe(2);
    expect(bot.listenerCount('windowOpen')).toBe(0);
  });
  it.each([3, 2])('observes delayed craft output while retaining a real partial outcome (%i)', async finalCount => {
    vi.useFakeTimers();
    try {
      let count = 2;
      const bot: any = { version: '1.21.11', interruptExecution: false, entities: {},
        entity: { position: new Vec3(0, 100, 0) },
        inventory: { items: () => [{ name: 'bread', count }], emptySlotCount: () => 30 } };
      const skill: any = new CraftOne(bot);
      setTimeout(() => { count = finalCount; }, 650);
      const result = skill.finalizeCraftOutcome('bread', 0, 3);
      await vi.runAllTimersAsync();
      expect(await result).toMatchObject({ success: true });
      expect((await result).result).toContain(`breadを${finalCount}個`);
      expect((await result).result.includes('少ない可能性')).toBe(finalCount < 3);
    } finally { vi.useRealTimers(); }
  });
  it('waits for actual food recovery when consume resolves before eating completes', async () => {
    const bot: any = { health: 19, food: 0, interruptExecution: false,
      heldItem: { name: 'bread' }, inventory: { items: () => [{ name: 'bread', count: 3 }] },
      consume: async () => { setTimeout(() => { bot.food = 5; }, 150); } };
    await new AutoEat(bot).runImpl();
    expect(bot.food).toBe(5);
  });
  it('targets the walking node above a partial solid surface, not its interior', () => {
    const bot: any = { version: '1.21.11', blockAt: () => ({ boundingBox: 'block' }) };
    const skill: any = new PickupNearestItem(bot);
    expect(skill.pickupGoal(new Vec3(3.3, 99.9375, 2.3)).y).toBe(100);
    bot.blockAt = () => ({ boundingBox: 'empty' });
    expect(skill.pickupGoal(new Vec3(3.3, 100.125, 2.3)).y).toBe(100);
  });
  it('protects farmland during navigation without disabling ordinary excavation', () => {
    const registry = minecraftData('1.21.11');
    const apply = vi.fn();
    setMovements({ version: '1.21.11', registry,
      inventory: { items: () => [{ name: 'stone_pickaxe' }] },
      pathfinder: { setMovements: apply } } as any);
    const movement = apply.mock.calls[0][0];
    expect(movement.canDig).toBe(true);
    expect(movement.blocksCantBreak.has(registry.blocksByName.farmland.id)).toBe(true);
    expect(movement.blocksCantBreak.has(registry.blocksByName.wheat.id)).toBe(true);
    expect(movement.blocksCantBreak.has(registry.blocksByName.bedrock.id)).toBe(true);
    expect(movement.blocksCantBreak.has(registry.blocksByName.stone.id)).toBe(false);
  });
  it('counts target blocks mined by nested movement and removes its event listener', async () => {
    const positions = [new Vec3(1, 100, 0), new Vec3(1, 101, 0)];
    let harvested = false;
    const bot: any = Object.assign(new EventEmitter(), {
      version: '1.21.11', registry: minecraftData('1.21.11'), entity: { position: new Vec3(0, 100, 0) }, interruptExecution: false,
      inventory: { items: () => harvested ? [{ name: 'oak_log', count: 2 }] : [], emptySlotCount: () => 30 },
      findBlocks: () => harvested ? [] : positions,
      blockAt: (position: Vec3) => harvested ? null : { name: 'oak_log', position },
    });
    const dig = { run: async () => {
      harvested = true;
      for (const position of positions) bot.emit('diggingCompleted', { name: 'air', position });
      return { success: true, result: 'dug' };
    } };
    bot.instantSkills = { getSkill: (name: string) => name === 'dig-block-at' ? dig : {} };
    const skill: any = new MineBlock(bot);
    skill.collectAllNearbyDrops = async () => [];
    expect(await skill.runImpl('oak_log', 2, 16)).toMatchObject({ success: true });
    expect(bot.listenerCount('diggingCompleted')).toBe(0);
  });
  it('rechecks batch reach after collecting an earlier drop moves the bot', async () => {
    const positions = [new Vec3(1, 100, 0), new Vec3(1, 101, 0)];
    const dug = new Set<string>();
    const bot: any = Object.assign(new EventEmitter(), {
      version: '1.21.11', registry: minecraftData('1.21.11'), entity: { position: new Vec3(0, 100, 0) }, interruptExecution: false,
      inventory: { items: () => dug.size ? [{ name: 'oak_log', count: dug.size }] : [], emptySlotCount: () => 30 },
      findBlocks: () => positions.filter(p => !dug.has(p.toString())),
      blockAt: (position: Vec3) => dug.has(position.toString()) ? null : { name: 'oak_log', position },
    });
    const move = { run: vi.fn(async (x, y, z) => {
      bot.entity.position = new Vec3(x, y, z);
      return { success: true };
    }) };
    const dig = { run: vi.fn(async (x: number, y: number, z: number) => {
      const position = new Vec3(x, y, z);
      if (bot.entity.position.distanceTo(position) > 4.5) return { success: false, failureType: 'distance_too_far' };
      dug.add(position.toString());
      bot.emit('diggingCompleted', { name: 'air', position });
      bot.entity.position = new Vec3(9, 100, 0); // the real drop pickup can walk away
      return { success: true };
    }) };
    bot.instantSkills = { getSkill: (name: string) => name === 'dig-block-at' ? dig : move };
    const skill: any = new MineBlock(bot);
    skill.collectAllNearbyDrops = async () => [];
    expect(await skill.runImpl('oak_log', 2, 16)).toMatchObject({ success: true });
    expect(dug.size).toBe(2);
    expect(dig.run.mock.calls.map(call => (call as unknown[])[3])).toEqual([true, true]);
    expect(move.run).toHaveBeenCalledOnce();
    expect(bot.listenerCount('diggingCompleted')).toBe(0);
  });
  it('defers pickup in bounded level stone groups with solid support', async () => {
    const positions = [1, 2, 3, 4].map(x => new Vec3(x, 100, 0));
    const dug = new Set<string>();
    let cobblestone = 0;
    const registry = minecraftData('1.21.11');
    const bot: any = Object.assign(new EventEmitter(), {
      version: '1.21.11', registry, entity: { position: new Vec3(0.5, 100, 0.5) },
      entities: {}, interruptExecution: false,
      inventory: { items: () => [
        { name: 'stone_pickaxe', type: registry.itemsByName.stone_pickaxe.id, count: 1 },
        ...(cobblestone ? [{ name: 'cobblestone', count: cobblestone }] : []),
      ], emptySlotCount: () => 30 },
      findBlocks: () => positions.filter(position => !dug.has(position.toString())),
      blockAt: (position: Vec3) => position.y === 99
        ? { name: 'stone', boundingBox: 'block' }
        : positions.some(target => target.toString() === position.toString()) && !dug.has(position.toString())
          ? { name: 'stone', position, diggable: true }
          : { name: 'air', boundingBox: 'empty' },
    });
    const dig = { run: vi.fn(async (x: number, y: number, z: number) => {
      const position = new Vec3(x, y, z);
      dug.add(position.toString());
      bot.emit('diggingCompleted', { name: 'air', position });
      return { success: true, result: 'dug' };
    }) };
    bot.instantSkills = { getSkill: (name: string) => name === 'dig-block-at' ? dig : { run: vi.fn() } };
    const skill: any = new MineBlock(bot);
    let firstCollection = true;
    const collect = vi.fn(async (origins: Vec3[]) => {
      if (!firstCollection) return [];
      firstCollection = false;
      cobblestone += origins.length;
      return origins.length ? [`cobblestonex${origins.length}`] : [];
    });
    skill.collectAllNearbyDrops = collect;
    expect(await skill.runImpl('stone', 4, 16)).toMatchObject({ success: true });
    expect(dig.run.mock.calls.map(call => (call as unknown[])[3])).toEqual([false, false, false, false]);
    expect(collect.mock.calls[0][0]).toHaveLength(4);
    expect(collect).toHaveBeenCalledTimes(2); // final sweep is retained even after apparent success
    expect((collect.mock.calls[1] as unknown[])[5]).toBe(1200);
    expect(cobblestone).toBe(4);
    expect(bot.listenerCount('diggingCompleted')).toBe(0);
  });
  it('keeps per-block pickup for a mixed-height vein', async () => {
    const positions = [new Vec3(1, 100, 0), new Vec3(1, 101, 0)];
    const dug = new Set<string>();
    let rawIron = 0;
    const registry = minecraftData('1.21.11');
    const bot: any = Object.assign(new EventEmitter(), {
      version: '1.21.11', registry, entity: { position: new Vec3(0.5, 100, 0.5) },
      entities: {}, interruptExecution: false,
      inventory: { items: () => [
        { name: 'stone_pickaxe', type: registry.itemsByName.stone_pickaxe.id, count: 1 },
        ...(rawIron ? [{ name: 'raw_iron', count: rawIron }] : []),
      ], emptySlotCount: () => 30 },
      findBlocks: () => positions.filter(position => !dug.has(position.toString())),
      blockAt: (position: Vec3) => positions.some(target => target.toString() === position.toString()) && !dug.has(position.toString())
        ? { name: 'iron_ore', position, diggable: true }
        : { name: 'stone', boundingBox: 'block' },
    });
    const dig = { run: vi.fn(async (x: number, y: number, z: number) => {
      const position = new Vec3(x, y, z);
      dug.add(position.toString()); rawIron++;
      bot.emit('diggingCompleted', { name: 'air', position });
      return { success: true, result: 'dug' };
    }) };
    bot.instantSkills = { getSkill: (name: string) => name === 'dig-block-at' ? dig : { run: vi.fn() } };
    const skill: any = new MineBlock(bot);
    skill.collectAllNearbyDrops = async () => [];
    expect(await skill.runImpl('iron_ore', 2, 16)).toMatchObject({ success: true });
    expect(dig.run.mock.calls.map(call => (call as unknown[])[3])).toEqual([true, true]);
  });
  it('keeps failed-target rescans bounded across batches', async () => {
    const positions = [new Vec3(1, 100, 0), new Vec3(1, 101, 0)];
    const bot: any = Object.assign(new EventEmitter(), {
      version: '1.21.11', registry: minecraftData('1.21.11'), entity: { position: new Vec3(0, 100, 0) }, interruptExecution: false,
      inventory: { items: () => [], emptySlotCount: () => 30 },
      findBlocks: () => positions, blockAt: (position: Vec3) => ({ name: 'oak_log', position }),
    });
    const dig = { run: vi.fn().mockResolvedValue({ success: false, failureType: 'dig_failed', recoverable: true }) };
    bot.instantSkills = { getSkill: (name: string) => name === 'dig-block-at' ? dig : {} };
    expect(await new MineBlock(bot).runImpl('oak_log', 2, 16)).toMatchObject({ success: false, failureType: 'dig_failed' });
    expect(dig.run).toHaveBeenCalledTimes(3);
    expect(bot.listenerCount('diggingCompleted')).toBe(0);
  });
  it('releasing a shield for a ready close strike also attacks in the same tick', async () => {
    const events: string[] = [];
    const bot: any = { entity: { position: new Vec3(0, 100, 0) },
      deactivateItem: () => events.push('release'), lookAt: async () => {},
      attack: () => events.push('attack') };
    const target: any = { position: new Vec3(1, 100, 0), height: 2 };
    expect(await new ActionExecutor(bot).execute({ type: 'shield-release', score: 1.1, target })).toEqual({ attacked: true });
    expect(events.at(-1)).toBe('attack');
    expect(events[0]).toBe('release');
  });
  it('tracks a moving shield threat without resetting shield activation or changing movement', async () => {
    const bot: any = { lookAt: vi.fn(async () => {}), activateItem: vi.fn(),
      deactivateItem: vi.fn(), setControlState: vi.fn() };
    const executor = new ActionExecutor(bot);
    const target: any = { position: new Vec3(1, 100, 0), height: 2, isValid: true };
    await executor.faceThreat(target);
    target.position = new Vec3(-2, 100, 3); await executor.faceThreat(target);
    expect(bot.lookAt.mock.calls.map(call => call[0])).toEqual([
      new Vec3(1, 101.6, 0), new Vec3(-2, 101.6, 3),
    ]);
    expect(bot.activateItem).not.toHaveBeenCalled(); expect(bot.deactivateItem).not.toHaveBeenCalled();
    expect(bot.setControlState).not.toHaveBeenCalled();
  });
  it('a wheat request does not select wheat seeds', async () => {
    const seed = { name: 'item', position: new Vec3(0, 100, 0), getDroppedItem: () => ({ name: 'wheat_seeds' }) };
    const bot: any = { version: '1.21.11', entity: { position: seed.position }, inventory: { items: () => [] },
      nearestEntity: (predicate: any) => predicate(seed) ? seed : null };
    expect((await new PickupNearestItem(bot).runImpl('wheat', 8)).success).toBe(false);
  });

  it('incidental seeds collected on the way cannot prove the requested wheat was picked', async () => {
    const wheat = { name: 'item', position: new Vec3(0, 100, 0), getDroppedItem: () => ({ name: 'wheat' }) };
    let searches = 0;
    let reads = 0;
    const bot: any = { version: '1.21.11', entity: { position: wheat.position },
      inventory: { items: () => reads++ === 0 ? [] : [{ name: 'wheat_seeds', count: 2 }] },
      nearestEntity: (predicate: any) => searches++ === 0 && predicate(wheat) ? wheat : null };
    expect(await new PickupNearestItem(bot).runImpl('wheat', 8)).toMatchObject({ success: false, failureType: 'target_not_picked' });
  });
  it('counts chestplate and leggings armour by their real slots', () => {
    const slots = [{ name: 'iron_chestplate' }, { name: 'iron_leggings' }];
    const scanner: any = new SituationScanner({ inventory: { slots },
      getEquipmentDestSlot: (slot: string) => ({ head: 2, torso: 0, legs: 1, feet: 3 })[slot] } as any);
    expect(scanner.calcArmorPoints()).toBe(11);
  });
  it.each([['wheat', 8], ['carrots', 8], ['potatoes', 8], ['beetroots', 4], ['cocoa', 3]])
    ('uses registry maturity for %s, never a numeric block ID', async (name, numValues) => {
      let age: number | string = String(numValues - 2);
      const client = new EventEmitter();
      const dig = vi.fn(async (block: { position: Vec3 }) => {
        client.emit('block_change', { location: block.position, type: 0 });
      });
      const bot: any = {
        entity: { position: new Vec3(0, 100, 0) }, dig, _client: client,
        registry: { blocksByName: { [name]: { states: [{ name: 'age', num_values: numValues }] } },
          blocksByStateId: minecraftData('1.21.11').blocksByStateId },
        blockAt: () => ({ name, type: 1234, stateId: 1234,
          position: new Vec3(1, 100, 0), getProperties: () => ({ age }) }),
      };
      const skill = new HarvestCrop(bot);
      expect(await skill.runImpl(1, 100, 0)).toMatchObject({ success: false, failureType: 'crop_immature' });
      expect(dig).not.toHaveBeenCalled();
      age = String(numValues - 1);
      expect((await skill.runImpl(1, 100, 0)).success).toBe(true);
      expect(dig).toHaveBeenCalledOnce();
    });

  it('death followed by automatic respawn cannot count as combat success', async () => {
    const bot: any = Object.assign(new EventEmitter(), {
      health: 20, inventory: { items: () => [] },
      pathfinder: { stop: vi.fn() }, clearControlStates: vi.fn(), deactivateItem: vi.fn(),
    });
    const controller: any = new CombatController(bot, { tickIntervalMs: 1 });
    controller.scanner.scan = vi.fn().mockReturnValue({ hostiles: [{}], hp: 20, armorPoints: 11, totalThreat: 3 });
    controller.scorer.score = () => [{ type: 'hold', score: 1 }];
    controller.executor.execute = async () => {
      bot.emit('death'); bot.health = 20;
      controller.scanner.scan.mockReturnValue({ hostiles: [] });
      return { attacked: false };
    };
    const result = await controller.engage();
    expect(result).toMatchObject({ success: false, reason: '死亡', kills: 0, damageTaken: 20 });
    expect(bot.listenerCount('death')).toBe(0);
  });

  it('an empty scan without a kill is not enemy annihilation', async () => {
    const bot: any = Object.assign(new EventEmitter(), {
      health: 20, inventory: { items: () => [] },
      pathfinder: { stop: vi.fn() }, clearControlStates: vi.fn(), deactivateItem: vi.fn(),
    });
    const controller: any = new CombatController(bot);
    controller.scanner.scan = () => ({ hostiles: [] });
    expect(await controller.engage()).toMatchObject({ success: false, kills: 0 });
  });

  it('keeps successful escape distinct from killing the enemies', async () => {
    const bot: any = Object.assign(new EventEmitter(), {
      health: 20, inventory: { items: () => [] },
      pathfinder: { stop: vi.fn() }, clearControlStates: vi.fn(), deactivateItem: vi.fn(),
    });
    const controller: any = new CombatController(bot, { tickIntervalMs: 1 });
    controller.scanner.scan = vi.fn().mockReturnValue({ hostiles: [{}], hp: 20, armorPoints: 11, totalThreat: 3 });
    controller.scorer.score = () => [{ type: 'flee', score: 1 }];
    controller.executor.execute = async () => {
      controller.scanner.scan.mockReturnValue({ hostiles: [] });
      return { attacked: false };
    };
    expect(await controller.engage()).toMatchObject({ success: true, reason: '逃走成功（敵撃破ではない）', kills: 0 });
  });

  it('ranged enemies do not create an endless shield-release loop in melee range', () => {
    const sit = { hp: 20, food: 20, armorPoints: 11, hasShield: true, hasWeapon: true,
      weaponDamage: 6, hasBow: false, arrowCount: 0, blockCount: 0,
      nearestHostile: { distance: 2, profile: { damage: 3 }, entity: {} },
      hostiles: [{}], totalThreat: 3, hasRangedEnemy: true, hasHighGround: false,
      attackCooldownReady: true, isBlocking: false } as SituationVector;
    const scorer = new ActionScorer();
    expect(scorer.score(sit)[0].type).toMatch(/attack/);
    expect(scorer.score({ ...sit, attackCooldownReady: false })[0].type).toBe('shield-block');
  });
});
