import { describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import CraftOne from '../../src/services/minebot/instantSkills/craftOne.js';
import { blockCenterWithinUseReach } from '../../src/services/minebot/utils/blockInteractionReach.js';

describe('craft-one workbench recovery', () => {
  const airAt = (pos: Vec3) => ({ name: 'air', position: pos, boundingBox: 'empty', diggable: true });
  const blockAtTables = (...tables: Array<{ position: Vec3 }>) => (pos: Vec3) =>
    tables.find(table => table.position.equals(pos)) ?? airAt(pos);

  it('uses a vertically offset table inside eye-to-block reach without pathfinding to its floor', async () => {
    const table = { name: 'crafting_table', position: new Vec3(-343, 64, -113), boundingBox: 'block' };
    const feet = new Vec3(-342.5, 60, -114.5);
    expect(feet.distanceTo(table.position)).toBeGreaterThan(4);
    expect(blockCenterWithinUseReach(feet, table.position)).toBe(true);
    const move = vi.fn(async () => ({ success: false, result: 'stuck' }));
    const bot: any = {
      version: '1.21.11', currentWindow: null, entity: { position: feet, height: 1.8 },
      inventory: { items: () => [{ name: 'iron_ingot', count: 3 }, { name: 'stick', count: 4 }] },
      findBlock: vi.fn(() => table),
      blockAt: vi.fn(blockAtTables(table)),
      instantSkills: { getSkill: (name: string) => name === 'move-to' ? { run: move } : null },
      recipesFor: vi.fn(() => [{ result: { count: 1 } }]),
      craft: vi.fn(async () => {}),
    };
    const skill = new CraftOne(bot);
    vi.spyOn(skill as any, 'refreshIncompleteTableOutput').mockResolvedValue(undefined);
    vi.spyOn(skill as any, 'finalizeCraftOutcome').mockResolvedValue({ success: true, result: 'crafted' });

    expect(await skill.runImpl('iron_pickaxe', 1)).toMatchObject({ success: true });
    expect(move).not.toHaveBeenCalled();
    expect(bot.craft).toHaveBeenCalledWith(expect.any(Object), 1, table);
  });

  it('opens one ordinary stone cell and ascends beside a protected furnace before crafting', async () => {
    const table = { name: 'crafting_table', position: new Vec3(-343, 64, -113), boundingBox: 'block' };
    const furnace = { name: 'furnace', position: new Vec3(-343, 62, -115), boundingBox: 'block', diggable: true };
    const stoneAt = (pos: Vec3) => ({ name: 'stone', position: pos, boundingBox: 'block', diggable: true });
    const bot: any = {
      version: '1.21.11', currentWindow: null,
      entity: { position: new Vec3(-342.5, 60, -114.5), height: 1.8,
        velocity: new Vec3(0, 0, 0) },
      inventory: { items: () => [
        { name: 'cobblestone', count: 12 }, { name: 'iron_ingot', count: 3 }, { name: 'stick', count: 4 },
      ] },
      findBlock: vi.fn(() => table),
      recipesFor: vi.fn(() => [{ result: { count: 1 } }]),
      craft: vi.fn(async () => {}),
      dig: vi.fn(async () => {}),
      pathfinder: { goal: null, isMoving: vi.fn(() => false), setGoal: vi.fn() },
      clearControlStates: vi.fn(),
      getControlState: vi.fn(() => false),
    };
    let worksiteStoneCleared = false;
    bot.blockAt = vi.fn((pos: Vec3) => {
      if (pos.equals(table.position)) return table;
      if (pos.equals(furnace.position)) return furnace;
      if (pos.x === -343 && pos.z === -116 && pos.y === 59) return airAt(pos);
      if (pos.y <= 59) return stoneAt(pos);
      if (pos.x === -343 && pos.z === -116 && pos.y >= 60 && pos.y <= 63) return airAt(pos);
      if (pos.x === -343 && pos.z === -116 && pos.y === 64) {
        return { name: 'grass_block', position: pos, boundingBox: 'block', diggable: true };
      }
      if (pos.x === -343 && pos.z === -115 && (pos.y === 60 || pos.y === 61)) return airAt(pos);
      if (pos.x === -343 && pos.z === -114 && pos.y === 60) {
        return worksiteStoneCleared ? airAt(pos) : stoneAt(pos);
      }
      if (pos.x === -343 && pos.z === -114 && pos.y >= 61) return airAt(pos);
      if (pos.y >= 65) return airAt(pos);
      return stoneAt(pos);
    });
    let moveCount = 0;
    const move = vi.fn(async (x: number, y: number, z: number) => {
      moveCount++;
      bot.entity.position = new Vec3(x, y, z);
      if (moveCount === 1) {
        setTimeout(() => { bot.entity.position = new Vec3(-342.5, 60, -114.5); }, 50);
      }
      return { success: true, result: 'moved' };
    });
    const dig = vi.fn(async (x: number, y: number, z: number) => {
      if (x === -343 && y === 60 && z === -114) worksiteStoneCleared = true;
      return { success: worksiteStoneCleared, result: 'cleared ordinary stone' };
    });
    const tower = vi.fn(async (rise: number) => {
      bot.entity.position = bot.entity.position.offset(0, rise, 0);
      return { success: true, result: 'ascended' };
    });
    bot.instantSkills = { getSkill: (name: string) =>
      name === 'move-to' ? { run: move } : name === 'tower-up' ? { run: tower }
        : name === 'dig-block-at' ? { run: dig } : null };
    const skill = new CraftOne(bot);
    vi.spyOn(skill as any, 'refreshIncompleteTableOutput').mockResolvedValue(undefined);
    vi.spyOn(skill as any, 'finalizeCraftOutcome').mockResolvedValue({ success: true, result: 'crafted' });

    expect(await skill.runImpl('iron_pickaxe', 1)).toMatchObject({ success: true });
    expect(dig).toHaveBeenCalledOnce();
    expect(dig).toHaveBeenCalledWith(-343, 60, -114, false);
    expect(move).toHaveBeenCalledWith(-342.5, 60, -113.5, 0.5, 'near');
    expect(move).toHaveBeenCalledTimes(2);
    expect(worksiteStoneCleared).toBe(true);
    expect(tower).toHaveBeenCalledWith(4);
    expect(bot.clearControlStates).toHaveBeenCalledTimes(2);
    expect(bot.craft).toHaveBeenCalledWith(expect.any(Object), 1, table);
    expect(bot.dig).not.toHaveBeenCalled();
    expect(bot.blockAt(furnace.position)).toBe(furnace);
  });

  it('places a carried table when a detected table cannot be reached', async () => {
    const distantTable = { name: 'crafting_table', position: new Vec3(20, 64, 0), boundingBox: 'block' };
    const localTable = { name: 'crafting_table', position: new Vec3(1, 64, 0), boundingBox: 'block' };
    const move = vi.fn(async () => ({ success: false, result: 'no_path' }));
    const bot: any = {
      version: '1.21.11', currentWindow: null, entity: { position: new Vec3(0, 64, 0), height: 1.8 },
      inventory: { items: () => [
        { name: 'crafting_table', count: 1 }, { name: 'iron_ingot', count: 3 }, { name: 'stick', count: 2 },
      ] },
      findBlock: vi.fn(() => distantTable),
      blockAt: vi.fn(blockAtTables(distantTable, localTable)),
      instantSkills: { getSkill: (name: string) => name === 'move-to' ? { run: move } : null },
      recipesFor: vi.fn(() => [{ result: { count: 1 } }]),
      craft: vi.fn(async () => {}),
    };
    const skill = new CraftOne(bot);
    const place = vi.spyOn(skill as any, 'tryPlaceCraftingTable').mockResolvedValue(localTable);
    vi.spyOn(skill as any, 'refreshIncompleteTableOutput').mockResolvedValue(undefined);
    vi.spyOn(skill as any, 'finalizeCraftOutcome').mockResolvedValue({ success: true, result: 'crafted' });

    expect(await skill.runImpl('iron_pickaxe', 1)).toMatchObject({ success: true });
    expect(move).toHaveBeenCalledOnce();
    expect(place).toHaveBeenCalledOnce();
    expect(bot.recipesFor).toHaveBeenCalledWith(expect.any(Number), null, 1, localTable);
    expect(bot.craft).toHaveBeenCalledWith(expect.any(Object), 1, localTable);
  });

  it('returns a recoverable route/worksite hint when an out-of-reach table cannot be reached', async () => {
    const table = { name: 'crafting_table', position: new Vec3(0, 68, 2), boundingBox: 'block' };
    const move = vi.fn(async () => ({ success: false, result: 'stuck at stone' }));
    const bot: any = {
      version: '1.21.11', currentWindow: null, entity: { position: new Vec3(0.5, 60, 0.5), height: 1.8 },
      inventory: { items: () => [{ name: 'iron_ingot', count: 3 }, { name: 'stick', count: 4 }] },
      findBlock: vi.fn(() => table),
      blockAt: vi.fn(blockAtTables(table)),
      instantSkills: { getSkill: (name: string) => name === 'move-to' ? { run: move } : null },
      craft: vi.fn(async () => {}),
    };

    const result = await new CraftOne(bot).runImpl('iron_pickaxe', 1);
    expect(result).toMatchObject({ success: false, failureType: 'distance_too_far', recoverable: true });
    expect(result.result).toContain('上方への経路');
    expect(result.result).toContain('0,68,2');
    expect(move).toHaveBeenCalledOnce();
    expect(bot.craft).not.toHaveBeenCalled();
  });
});
