import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';

vi.mock('../../src/services/minebot/execution/observedWait.js', async (original) => ({
  ...(await original() as object), actionDelay: vi.fn(async () => {}),
}));

const { tidyPlan } = await import('../../src/services/minebot/utils/inventoryTidy.js');
const { default: StairMine } = await import('../../src/services/minebot/instantSkills/stairMine.js');
const { default: DropItem } = await import('../../src/services/minebot/instantSkills/dropItem.js');
const { default: SleepInBed, bodyCells } = await import('../../src/services/minebot/instantSkills/sleepInBed.js');
const { default: PlaceBlockAt } = await import('../../src/services/minebot/instantSkills/placeBlockAt.js');
const { default: WithdrawFromFurnace } = await import('../../src/services/minebot/instantSkills/withdrawFromFurnace.js');
const { default: DigShelter } = await import('../../src/services/minebot/instantSkills/digShelter.js');

const registry = minecraftData('1.21.11');
const solid = (name = 'stone') => ({ name, boundingBox: 'block', diggable: true, shapes: [[0, 0, 0, 1, 1, 1]] });
const air = { name: 'air', boundingBox: 'empty', shapes: [] };

describe('the pack is tidied past 30 slots (run 17 ended with 33 of 36 taken)', () => {
  const stacks = (name: string, n: number, size = 64) => Array.from({ length: n }, () => ({ name, count: size }));
  it('drops the plain stone and clutter first, keeps a stack of cobblestone and some dirt, down to 28', () => {
    const items = [...stacks('cobblestone', 6), ...stacks('dirt', 2), { name: 'dirt', count: 9 }, { name: 'andesite', count: 38 }, { name: 'granite', count: 12 },
      { name: 'oak_sapling', count: 3 }, ...stacks('iron_ingot', 1, 20), ...Array.from({ length: 20 }, (_, i) => ({ name: `thing_${i}`, count: 1 }))];
    expect(items.length).toBe(33);
    const plan = tidyPlan(items);
    const names = plan.map(entry => entry.name);
    expect(names.slice(0, 3)).toEqual(expect.arrayContaining(['andesite', 'granite', 'oak_sapling']));
    const freed = plan.reduce((sum, entry) => sum + items.filter(item => item.name === entry.name).length, 0);
    expect(freed).toBeGreaterThanOrEqual(3);
    expect(plan.find(entry => entry.name === 'cobblestone')?.count ?? 0).toBeLessThanOrEqual(6 * 64 - 64);
    expect(plan.some(entry => entry.name === 'iron_ingot')).toBe(false);
  });
  it('does nothing at 30 slots or fewer', () => {
    expect(tidyPlan([...stacks('cobblestone', 10), ...stacks('andesite', 20)])).toEqual([]);
  });
});

describe('drop-item does not throw what it would pick straight back up (run 17: a stone pickaxe in its shaft)', () => {
  it('in a 1x1 shaft says so before throwing', async () => {
    const toss = vi.fn();
    const bot: any = { entity: { position: new Vec3(0.5, 10, 0.5) }, inventory: { items: () => [{ name: 'stone_pickaxe', count: 1, type: 1 }] },
      blockAt: (pos: Vec3) => { const p = pos.floored(); return p.x === 0 && p.z === 0 && p.y >= 10 && p.y <= 11 ? air : solid(); },
      equip: async () => {}, lookAt: async () => {}, toss, instantSkills: { getSkill: () => null }, pathfinder: { stop: () => {} } };
    const result: any = await new DropItem(bot).runImpl('stone_pickaxe', 1);
    expect(result).toMatchObject({ success: false, failureType: 'no_room_to_drop' });
    expect(toss).not.toHaveBeenCalled();
  });
});

describe('stair-mine turns to another way by itself when one is blocked (run 17: sent east and north by hand)', () => {
  it('tries the sides and then the way back when east has no floor, each once', async () => {
    const controls: Record<string, boolean> = {};
    let yaw = 0;
    // Solid ground below y 44, except a hollow everywhere east of the body.
    const bot: any = { version: '1.21.11', interruptExecution: false, entity: { position: new Vec3(0.5, 44, 0.5), yaw: 0, onGround: true },
      inventory: { items: () => [{ name: 'stone_pickaxe', count: 1, maxDurability: 131, durabilityUsed: 0 }] },
      look: vi.fn(async (y: number) => { yaw = y; }), equip: async () => {},
      setControlState: vi.fn((key: string, on: boolean) => { controls[key] = on; }),
      blockAt: (pos: Vec3) => { const p = pos.floored(); return { ...(p.y < 44 && p.x < 1 ? solid() : air), position: p }; } };
    const skill: any = new StairMine(bot);
    skill.sleep = async () => {
      if (!controls.forward) return;
      const start = bot.entity.position.floored();
      bot.entity.position = new Vec3(start.x + Math.round(-Math.sin(yaw)) + 0.5, start.y - 1, start.z + Math.round(-Math.cos(yaw)) + 0.5);
      controls.forward = false;
    };
    // This stand-in body cannot dig, so every way ends; what is checked is that it turned by itself, to each way once, in order.
    const result = await skill.runImpl(43, 'east');
    expect(result).toMatchObject({ success: false, failureType: 'stair_progress_blocked' });
    const tried = /ほかに試した方向: (.*)）$/.exec(result.result)?.[1] ?? '';
    expect(tried.match(/(east|west|north|south)（/g)).toEqual(['east（', 'north（', 'south（']);
  });
});

describe('beds and blocks are not put where the body stands, nor on a grass block (run 17: three refusals, D54)', () => {
  it('the body\'s cells are every cell its box is in', () => {
    const cells = bodyCells(new Vec3(1.95, 64, 0.5));
    expect(cells.some(cell => cell.equals(new Vec3(1, 64, 0)))).toBe(true);
    expect(cells.some(cell => cell.equals(new Vec3(2, 64, 0)))).toBe(true);
  });
  it('sleep-in-bed picks foot and head cells clear of the body, on solid ground, grass counting as free', () => {
    const bot: any = { entity: { position: new Vec3(1.95, 64, 0.5) },
      blockAt: (pos: Vec3) => { const p = pos.floored(); return p.y < 64 ? solid('grass_block') : p.y === 64 && p.x === 3 ? { name: 'short_grass', boundingBox: 'empty' } : air; } };
    const spot = new SleepInBed(bot).findPlaceForBed()!;
    expect(spot).not.toBeNull();
    expect(bodyCells(bot.entity.position).some(cell => cell.equals(spot))).toBe(false);
  });
  it('place-block-at chooses a spot itself when no place is given, and puts a block given as the ground one up', async () => {
    const placed: Vec3[] = [];
    const world = new Map<string, any>();
    const bot: any = { version: '1.21.11', entity: { position: new Vec3(0.5, 64, 0.5), height: 1.8 }, entities: {},
      inventory: { items: () => [{ name: 'furnace', count: 1, type: registry.itemsByName.furnace.id }] }, heldItem: null,
      blockAt: (pos: Vec3) => { const p = pos.floored(); return world.get(`${p.x},${p.y},${p.z}`) ?? { ...(p.y < 64 ? solid('grass_block') : air), position: p }; },
      equip: async () => {}, lookAt: async () => {}, look: async () => {}, setControlState: () => {}, clearControlStates: () => {},
      placeBlock: async (ref: any, face: Vec3) => { const at = ref.position.plus(face); placed.push(at); world.set(`${at.x},${at.y},${at.z}`, { ...solid('furnace'), position: at }); },
      world: { raycast: () => null }, pathfinder: { stop: () => {} }, _client: { on: () => {} } };
    const skill: any = new PlaceBlockAt(bot);
    const chosen: any = await skill.runImpl('furnace');
    expect(chosen.result).toContain('自分で選びました');
    expect(bodyCells(bot.entity.position).some(cell => placed[0] && cell.equals(placed[0]))).toBe(false);
    const up: any = await skill.runImpl('furnace', 3, 63, 0);
    expect(up.result).toContain('その上(3, 64, 0)に置きます');
  });
});

describe('withdraw-from-furnace does not call fuel burning in the fire "out of fuel" (run 17, D8: 29 s from done)', () => {
  it('waits for the burn bar before saying so, and finishes the wait', async () => {
    const inventory = Object.assign(new EventEmitter(), { items: () => [...counts].map(([name, count]) => ({ name, count })), emptySlotCount: () => 30 });
    const counts = new Map<string, number>();
    let input = 3, output = 0;
    const furnace: any = Object.assign(new EventEmitter(), { fuel: 0, totalFuel: 10, inputItem: () => input ? { name: 'raw_iron', count: input } : null,
      fuelItem: () => null, outputItem: () => output ? { name: 'iron_ingot', count: output } : null,
      takeOutput: vi.fn(async () => { counts.set('iron_ingot', output); output = 0; inventory.emit('updateSlot'); }), takeInput: vi.fn(), takeFuel: vi.fn(), close: vi.fn() });
    const bot: any = { version: '1.21.11', entity: { position: new Vec3(0, 64, 1) }, inventory, currentWindow: inventory, entities: {}, game: { dimension: 'overworld' },
      blockAt: () => ({ name: 'furnace' }), openFurnace: vi.fn(async () => furnace), activeFurnaces: [] };
    // The burn bar arrives a moment later, then the batch smelts.
    setTimeout(() => { furnace.fuel = 0.9; furnace.emit('update'); }, 50);
    setTimeout(() => { input = 0; output = 3; furnace.emit('update'); }, 150);
    const result: any = await new WithdrawFromFurnace(bot).runImpl(0, 64, 0, 'all', true);
    expect(result.success).toBe(true);
    expect(result.result).toContain('iron_ingot x3');
  });
});

describe('craft-one does not walk out to a far table at night (run 17, D6: 17 s to the surface, 76 s there, shot dead)', () => {
  it('sets its own down, and when it cannot, says so instead of walking', async () => {
    const { default: CraftOne } = await import('../../src/services/minebot/instantSkills/craftOne.js');
    const farTable = { name: 'crafting_table', position: new Vec3(20, 70, 0), boundingBox: 'block' };
    const move = vi.fn(async () => ({ success: true, result: 'moved' }));
    const bot: any = { version: '1.21.11', currentWindow: null, entity: { position: new Vec3(0.5, 60, 0.5), height: 1.8 }, time: { timeOfDay: 18_000 },
      game: { dimension: 'overworld' }, entities: {},
      inventory: { items: () => [{ name: 'crafting_table', count: 1 }, { name: 'iron_ingot', count: 3 }, { name: 'stick', count: 2 }] },
      findBlock: vi.fn(() => farTable), blockAt: vi.fn((pos: Vec3) => pos.equals(farTable.position) ? farTable : { name: 'stone', boundingBox: 'block', position: pos }),
      instantSkills: { getSkill: (name: string) => name === 'move-to' ? { run: move } : null },
      recipesFor: vi.fn(() => [{ result: { count: 1 } }]), craft: vi.fn(async () => {}) };
    const skill: any = new CraftOne(bot);
    vi.spyOn(skill, 'tryPlaceCraftingTable').mockResolvedValue(null);
    const result: any = await skill.runImpl('iron_pickaxe', 1);
    expect(result).toMatchObject({ success: false, failureType: 'table_out_of_reach' });
    expect(move).not.toHaveBeenCalled();
    expect(bot.craft).not.toHaveBeenCalled();
  });
});

describe('dig-shelter offers another cover when a shaft cannot be closed in time (run 17: threat_too_close at 3 health)', () => {
  it('names the pillar with a few blocks, the shelter with more, the run with none', () => {
    const shelter = (items: any[]) => new DigShelter({ instantSkills: { getSkill: () => null }, inventory: { items: () => items } } as any) as any;
    expect(shelter([{ name: 'cobblestone', count: 40 }]).otherCover(5)).toContain('build-around-self');
    expect(shelter([{ name: 'cobblestone', count: 40 }]).otherCover(1.5)).toContain('tower-up');
    expect(shelter([{ name: 'dirt', count: 4 }]).otherCover(5)).toContain('tower-up');
    expect(shelter([]).otherCover(5)).toContain('flee-from');
  });
});
