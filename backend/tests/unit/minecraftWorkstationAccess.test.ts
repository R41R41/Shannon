import { describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';

vi.mock('../../src/services/minebot/execution/observedWait.js', async (original) => ({
  ...(await original() as object), actionDelay: vi.fn(async () => {}),
}));

const { stationAccess, findStances, planWorkstationSpot, reachWorkstation, worksiteState, withSolidAt } =
  await import('../../src/services/minebot/utils/workstationAccess.js');
const { approachFurnace } = await import('../../src/services/minebot/utils/furnaceReach.js');
const { placeableSpots } = await import('../../src/services/minebot/instantSkills/findPlaceableSpot.js');
const { default: PlaceBlockAt } = await import('../../src/services/minebot/instantSkills/placeBlockAt.js');
const { default: CraftOne } = await import('../../src/services/minebot/instantSkills/craftOne.js');
const { default: StartSmelting } = await import('../../src/services/minebot/instantSkills/startSmelting.js');

const registry = minecraftData('1.21.11');

/** A small world: stone below y=64, air above, with cells overridden by name ('air' to carve). */
function makeWorld(base: (x: number, y: number, z: number) => string = (_x, y) => (y < 64 ? 'stone' : 'air')) {
  const overrides = new Map<string, string>();
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
  const nameAt = (x: number, y: number, z: number) => overrides.get(key(x, y, z)) ?? base(x, y, z);
  const blockAt = (position: Vec3) => {
    const p = position.floored();
    const name = nameAt(p.x, p.y, p.z);
    return { name, position: p, boundingBox: name === 'air' ? 'empty' : 'block', diggable: true };
  };
  return { blockAt, set: (x: number, y: number, z: number, name: string) => overrides.set(key(x, y, z), name), nameAt };
}

const stand = (x = 0.5, y = 64, z = 0.5) => new Vec3(x, y, z);

describe('workstation access: reach from the eyes and sight (run 20: table behind a furnace, furnace refused at 4.3 m)', () => {
  it('a table behind a furnace is not usable from the spot behind the furnace, and is from the side', () => {
    const world = makeWorld();
    world.set(3, 64, 0, 'crafting_table');
    world.set(2, 64, 0, 'furnace');
    const bot: any = { entity: { position: stand(), height: 1.8 }, blockAt: world.blockAt };
    const here = stationAccess(bot, new Vec3(3, 64, 0));
    expect(here).toMatchObject({ inReach: true, clear: false, ready: false });
    expect(here.obstruction?.name).toBe('furnace');
    expect(stationAccess(bot, new Vec3(3, 64, 0), stand(2.5, 64, 2.5)).ready).toBe(true);
  });

  it('reach is the eyes\' to the block centre, not the feet\'s: a furnace 4.3 m off on the flat is out of reach', () => {
    const world = makeWorld();
    world.set(4, 64, 0, 'furnace');
    const bot: any = { entity: { position: stand(0.2, 64, 0.5), height: 1.8 }, blockAt: world.blockAt };
    // Measured from the feet it is within 4.5 (which let it through, and the server then refused it); from the eyes it is not.
    expect(bot.entity.position.distanceTo(new Vec3(4.5, 64.5, 0.5))).toBeLessThan(4.5);
    expect(stationAccess(bot, new Vec3(4, 64, 0)).inReach).toBe(false);
    expect(stationAccess(bot, new Vec3(4, 64, 0), stand(1.5, 64, 0.5)).ready).toBe(true);
  });

  it('finds a stand beside the table that is on foot from the body, and none in the air', () => {
    const world = makeWorld();
    world.set(3, 64, 0, 'crafting_table');
    world.set(2, 64, 0, 'furnace');
    const bot: any = { entity: { position: stand(), height: 1.8 }, blockAt: world.blockAt };
    const stances = findStances(bot, [new Vec3(3, 64, 0)]);
    expect(stances.length).toBeGreaterThan(0);
    for (const stance of stances) {
      expect(stance.feet.y).toBe(64);
      expect(stationAccess(bot, new Vec3(3, 64, 0), stance.feet).ready).toBe(true);
    }
  });
});

describe('approachFurnace: a stand beside the furnace is looked for before it is given up', () => {
  it('walks to the stand when the coarse walk leaves the furnace in the shadow of a table', async () => {
    const world = makeWorld();
    world.set(3, 64, 0, 'furnace');
    world.set(2, 64, 0, 'crafting_table');
    const bot: any = { entity: { position: stand(), height: 1.8 }, blockAt: world.blockAt };
    const move = vi.fn(async (x: number, y: number, z: number) => { bot.entity.position = new Vec3(x, y, z); return { success: true, result: 'ok' }; });
    expect(await approachFurnace(bot, new Vec3(3, 64, 0), move as any)).toBeNull();
    expect(move).toHaveBeenCalledOnce();
    const [x, y, z, range, kind] = move.mock.calls[0] as any[];
    expect(range).toBe(0.5);
    expect(kind).toBe('near');
    expect(stationAccess(bot, new Vec3(3, 64, 0), new Vec3(x, y, z)).ready).toBe(true);
  });

  it('walks in when the furnace is 4.3 m off on the flat (the old feet-based check let it be opened from there)', async () => {
    const world = makeWorld();
    world.set(4, 64, 0, 'furnace');
    const bot: any = { entity: { position: stand(0.2, 64, 0.5), height: 1.8 }, blockAt: world.blockAt };
    const move = vi.fn(async (x: number, y: number, z: number) => { bot.entity.position = new Vec3(x, y, z); return { success: true, result: 'ok' }; });
    expect(await approachFurnace(bot, new Vec3(4, 64, 0), move as any)).toBeNull();
    expect(move).toHaveBeenCalledWith(4, 64, 0, 4, 'block');
  });

  it('says which block is in the way, and what to do, when no stand sees it', async () => {
    // A closed corridor, two high: the table in front of the furnace at its dead end. Nothing sees the furnace over the table.
    const world = makeWorld(() => 'stone');
    for (let x = 0; x <= 3; x++) for (const y of [64, 65]) world.set(x, y, 0, 'air');
    world.set(2, 64, 0, 'crafting_table');
    world.set(3, 64, 0, 'furnace');
    const bot: any = { entity: { position: stand(0.5, 64, 0.5), height: 1.8 }, blockAt: world.blockAt };
    const move = vi.fn(async () => ({ success: true, result: 'ok' }));
    const result = await approachFurnace(bot, new Vec3(3, 64, 0), move as any, { clearSight: async () => ({ clear: false, dug: false }) });
    expect(result).toMatchObject({ success: false, failureType: 'line_of_sight_blocked', recoverable: true });
    expect(result!.result).toContain('crafting_table(2, 64, 0)');
    expect(result!.result).toContain('かまど(3, 64, 0)');
    expect(result!.result).toContain('壊しません');
  });

  it('digs an ordinary wall in the way as the last resort', async () => {
    // A corridor ending in a stone wall, the furnace behind it.
    const world = makeWorld(() => 'stone');
    for (let x = 0; x <= 1; x++) for (const y of [64, 65]) world.set(x, y, 0, 'air');
    world.set(3, 64, 0, 'furnace');
    world.set(3, 65, 0, 'stone');
    const bot: any = { entity: { position: stand(0.5, 64, 0.5), height: 1.8 }, blockAt: world.blockAt };
    const move = vi.fn(async () => ({ success: true, result: 'ok' }));
    const clearSight = vi.fn(async () => { world.set(2, 64, 0, 'air'); world.set(2, 65, 0, 'air'); return { clear: true, dug: true }; });
    expect(await approachFurnace(bot, new Vec3(3, 64, 0), move as any, { clearSight })).toBeNull();
    expect(clearSight).toHaveBeenCalledOnce();
  });
});

describe('where a workstation is set down (planWorkstationSpot)', () => {
  it('does not put the furnace between the body and the table', () => {
    const world = makeWorld();
    world.set(3, 64, 0, 'crafting_table');
    const bot: any = { entity: { position: stand(), height: 1.8 }, blockAt: world.blockAt };
    const plan = planWorkstationSpot(bot, 'furnace', placeableSpots(bot, 4, 48));
    expect(plan.length).toBeGreaterThan(0);
    const best = plan[0];
    expect(best.hides).toBe(0);
    // The cell that would hide the table is scored as hiding it.
    const hiding = plan.find(entry => entry.cell.equals(new Vec3(2, 64, 0)));
    expect(hiding?.hides).toBe(1);
    expect(plan.indexOf(hiding!)).toBeGreaterThan(0);
    // With the best cell filled, the table is still in sight from here.
    expect(stationAccess(withSolidAt(bot, best.cell), new Vec3(3, 64, 0)).ready).toBe(true);
  });

  it('keeps clear of the body\'s own cells and of the ways out on open ground', () => {
    const world = makeWorld();
    const bot: any = { entity: { position: stand(), height: 1.8 }, blockAt: world.blockAt };
    const best = planWorkstationSpot(bot, 'crafting_table', placeableSpots(bot, 4, 48))[0];
    expect(best.exitLoss).toBe(0);
    expect(best.niche).toBe(false);
    expect(Math.floor(best.cell.x) === 0 && Math.floor(best.cell.z) === 0).toBe(false);
  });

  it('in a one-block tunnel digs a wall cell out instead of plugging the way', () => {
    const world = makeWorld(() => 'stone');
    for (let x = 0; x <= 6; x++) for (const y of [64, 65]) world.set(x, y, 0, 'air');
    const bot: any = { entity: { position: stand(), height: 1.8 }, blockAt: world.blockAt };
    const plan = planWorkstationSpot(bot, 'crafting_table', placeableSpots(bot, 4, 48));
    expect(plan[0].niche).toBe(true);
    expect(plan[0].exitLoss).toBe(0);
    // A wall cell (stone now), not a cell of the tunnel.
    expect(world.blockAt(plan[0].cell).name).toBe('stone');
    // And the plain cells in the tunnel are scored as closing the way out.
    const plug = plan.find(entry => !entry.niche && entry.cell.equals(new Vec3(1, 64, 0)));
    expect(plug === undefined || plug.score > plan[0].score + 700).toBe(true);
  });

  it('worksiteState lists what cannot be used from here and why', () => {
    const world = makeWorld();
    world.set(3, 64, 0, 'crafting_table');
    world.set(2, 64, 0, 'furnace');
    const bot: any = { entity: { position: stand(), height: 1.8 }, blockAt: world.blockAt };
    const state = worksiteState(bot);
    expect(state.stations).toHaveLength(2);
    expect(state.unusable.map(item => item.name)).toEqual(['crafting_table']);
    expect(state.unusable[0].obstruction).toBe('furnace');
  });
});

describe('place-block-at puts a workstation where it hides no other', () => {
  const placedBot = (world: ReturnType<typeof makeWorld>, name: string) => {
    const placed: Vec3[] = [];
    const bot: any = { version: '1.21.11', entity: { position: stand(), height: 1.8 }, entities: {},
      inventory: { items: () => [{ name, count: 1, type: registry.itemsByName[name].id }] }, heldItem: null,
      blockAt: world.blockAt,
      equip: async () => {}, lookAt: async () => {}, look: async () => {}, setControlState: () => {}, clearControlStates: () => {},
      placeBlock: async (ref: any, face: Vec3) => { const at = ref.position.plus(face); placed.push(at); world.set(at.x, at.y, at.z, name); },
      world: { raycast: () => null }, pathfinder: { stop: () => {} }, _client: { on: () => {} } };
    return { bot, placed };
  };

  it('a block put (by coordinates) in front of another is answered with a step to where both are in sight', async () => {
    const world = makeWorld();
    world.set(3, 64, 0, 'crafting_table');
    const { bot } = placedBot(world, 'furnace');
    const skill: any = new PlaceBlockAt(bot);
    vi.spyOn(skill, 'callSkill').mockImplementation(async (_name: string, x: number, y: number, z: number) => {
      bot.entity.position = new Vec3(x, y, z); return { success: true, result: 'moved' };
    });
    const result: any = await skill.runImpl('furnace', 2, 64, 0);
    expect(result.success).toBe(true);
    expect(result.result).toContain('立ち位置を');
    expect(stationAccess(bot, new Vec3(3, 64, 0)).ready).toBe(true);
    expect(stationAccess(bot, new Vec3(2, 64, 0)).ready).toBe(true);
  });
});

describe('craft-one finds a stand that sees the table (run 20: line_of_sight_blocked after 13.9 s)', () => {
  it('walks round a furnace standing in front of the table instead of giving up', async () => {
    const world = makeWorld();
    world.set(3, 64, 0, 'crafting_table');
    world.set(2, 64, 0, 'furnace');
    const table = world.blockAt(new Vec3(3, 64, 0));
    const bot: any = { version: '1.21.11', currentWindow: null, entity: { position: stand(), height: 1.8 },
      inventory: { items: () => [{ name: 'cobblestone', count: 8 }] },
      findBlock: vi.fn(() => table), findBlocks: vi.fn(() => [table.position]), blockAt: world.blockAt,
      recipesFor: vi.fn(() => [{ result: { count: 1 } }]), craft: vi.fn(async () => {}) };
    const move = vi.fn(async (x: number, y: number, z: number) => { bot.entity.position = new Vec3(x, y, z); return { success: true, result: 'ok' }; });
    bot.instantSkills = { getSkill: (name: string) => name === 'move-to' ? { run: move } : null };
    const skill = new CraftOne(bot);
    vi.spyOn(skill as any, 'refreshIncompleteTableOutput').mockResolvedValue(undefined);
    vi.spyOn(skill as any, 'finalizeCraftOutcome').mockResolvedValue({ success: true, result: 'crafted' });
    expect(await skill.runImpl('furnace', 1)).toMatchObject({ success: true });
    expect(move).toHaveBeenCalledOnce();
    expect(bot.craft).toHaveBeenCalledWith(expect.any(Object), 1, expect.objectContaining({ name: 'crafting_table' }));
  });

  it('with no stand that sees it, a table made from the planks carried is set down instead', async () => {
    // The table stands in a closed niche with the furnace in front; the body stands in a one-block corridor beside it.
    const world = makeWorld(() => 'stone');
    for (let x = 0; x <= 4; x++) for (const y of [64, 65]) world.set(x, y, 0, 'air');
    world.set(4, 64, 0, 'crafting_table');
    world.set(3, 64, 0, 'furnace');
    const table = world.blockAt(new Vec3(4, 64, 0));
    const own = { name: 'crafting_table', position: new Vec3(0, 65, 1), boundingBox: 'block' };
    const bot: any = { version: '1.21.11', currentWindow: null, entity: { position: stand(), height: 1.8 },
      inventory: { items: () => [{ name: 'cobblestone', count: 8 }, { name: 'oak_planks', count: 4 }] },
      findBlock: vi.fn(() => table), findBlocks: vi.fn(() => [table.position]), blockAt: world.blockAt,
      recipesFor: vi.fn(() => [{ result: { count: 1 } }]), craft: vi.fn(async () => {}) };
    const move = vi.fn(async () => ({ success: false, result: 'no path' }));
    bot.instantSkills = { getSkill: (name: string) => name === 'move-to' ? { run: move } : null };
    const skill = new CraftOne(bot);
    vi.spyOn(skill as any, 'refreshIncompleteTableOutput').mockResolvedValue(undefined);
    vi.spyOn(skill as any, 'finalizeCraftOutcome').mockResolvedValue({ success: true, result: 'crafted' });
    const make = vi.spyOn(skill as any, 'ownTable').mockResolvedValue(own);
    vi.spyOn(skill as any, 'tableAccess').mockImplementation(((candidate: any) => ({ ready: candidate === own, inReach: true })) as any);
    expect(await skill.runImpl('furnace', 1)).toMatchObject({ success: true });
    expect(make).toHaveBeenCalledOnce();
    expect(bot.craft).toHaveBeenCalledWith(expect.any(Object), 1, own);
  });
});

describe('start-smelting reaches a furnace the old check let through', () => {
  it('moves to a stand from which the furnace opens when the eyes are further than the feet say', async () => {
    const world = makeWorld();
    world.set(4, 64, 0, 'furnace');
    const furnace: any = { inputItem: () => null, fuelItem: () => null, outputItem: () => null, fuel: 0, progress: 0,
      putInput: vi.fn(async () => {}), putFuel: vi.fn(async () => {}), close: vi.fn(), takeOutput: vi.fn() };
    const bot: any = { version: '1.21.11', entity: { position: stand(0.2, 64, 0.5), height: 1.8 }, blockAt: world.blockAt,
      inventory: { items: () => [{ name: 'raw_iron', count: 3, type: 1 }, { name: 'coal', count: 2, type: 2 }] },
      openFurnace: vi.fn(async () => furnace), activeFurnaces: [], game: { dimension: 'overworld' }, entities: {} };
    const skill: any = new StartSmelting(bot);
    const move = vi.spyOn(skill, 'callSkill').mockImplementation(async (_name: string, x: number, y: number, z: number) => {
      bot.entity.position = new Vec3(x, y, z); return { success: true, result: 'moved' };
    });
    const result: any = await skill.runImpl(4, 64, 0, 'raw_iron', 'coal', 3);
    expect(result.success).toBe(true);
    expect(move).toHaveBeenCalled();
    expect(stationAccess(bot, new Vec3(4, 64, 0)).ready).toBe(true);
    expect(bot.openFurnace).toHaveBeenCalled();
  });
});

describe('when no stand sees the workstation, the open is tried and the failure is explained (instead of a third furnace)', () => {
  /** A closed corridor two high: the body at one end, a table, then the furnace at the dead end. No stand sees the furnace. */
  const corridor = () => {
    const world = makeWorld(() => 'stone');
    for (let x = 0; x <= 3; x++) for (const y of [64, 65]) world.set(x, y, 0, 'air');
    world.set(2, 64, 0, 'crafting_table');
    world.set(3, 64, 0, 'furnace');
    return world;
  };

  it('approachFurnace with tryAnyway lets the open go ahead when the furnace is within what the server takes', async () => {
    const world = corridor();
    const bot: any = { entity: { position: stand(0.5, 64, 0.5), height: 1.8 }, blockAt: world.blockAt };
    const move = vi.fn(async () => ({ success: true, result: 'ok' }));
    expect(await approachFurnace(bot, new Vec3(3, 64, 0), move as any, { tryAnyway: true })).toBeNull();
    expect(await approachFurnace(bot, new Vec3(3, 64, 0), move as any)).toMatchObject({ failureType: 'line_of_sight_blocked' });
  });

  it('start-smelting tries the furnace behind the table and, when the window does not open, says what stands in the way', async () => {
    const world = corridor();
    const bot: any = { version: '1.21.11', entity: { position: stand(0.5, 64, 0.5), height: 1.8 }, blockAt: world.blockAt,
      inventory: { items: () => [{ name: 'raw_iron', count: 3, type: 1 }, { name: 'coal', count: 2, type: 2 }] },
      openFurnace: vi.fn(async () => { throw new Error('Event windowOpen did not fire within timeout of 5000ms'); }),
      activeFurnaces: [], game: { dimension: 'overworld' }, entities: {} };
    const skill: any = new StartSmelting(bot);
    vi.spyOn(skill, 'callSkill').mockImplementation(async () => ({ success: true, result: 'moved' }));
    const result: any = await skill.runImpl(3, 64, 0, 'raw_iron', 'coal', 3);
    expect(bot.openFurnace).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ success: false, failureType: 'line_of_sight_blocked', recoverable: true });
    expect(result.result).toContain('crafting_table');
  });

  it('craft-one crafts at the table behind a furnace when it can find no stand and has nothing to make a table of', async () => {
    const world = makeWorld(() => 'stone');
    for (let x = 0; x <= 3; x++) for (const y of [64, 65]) world.set(x, y, 0, 'air');
    world.set(3, 64, 0, 'crafting_table');
    world.set(2, 64, 0, 'furnace');
    const table = world.blockAt(new Vec3(3, 64, 0));
    const bot: any = { version: '1.21.11', currentWindow: null, entity: { position: stand(0.5, 64, 0.5), height: 1.8 },
      inventory: { items: () => [{ name: 'cobblestone', count: 8 }] },
      findBlock: vi.fn(() => table), findBlocks: vi.fn(() => [table.position]), blockAt: world.blockAt,
      recipesFor: vi.fn(() => [{ result: { count: 1 } }]), craft: vi.fn(async () => {}) };
    const move = vi.fn(async () => ({ success: false, result: 'no path' }));
    bot.instantSkills = { getSkill: (name: string) => name === 'move-to' ? { run: move } : null };
    const skill = new CraftOne(bot);
    vi.spyOn(skill as any, 'refreshIncompleteTableOutput').mockResolvedValue(undefined);
    vi.spyOn(skill as any, 'finalizeCraftOutcome').mockResolvedValue({ success: true, result: 'crafted' });
    expect(await skill.runImpl('furnace', 1)).toMatchObject({ success: true });
    expect(bot.craft).toHaveBeenCalledWith(expect.any(Object), 1, table);
    // And when the window then does not open, the answer says why instead of a bare timeout.
    bot.craft = vi.fn(async () => { throw new Error('Event windowOpen did not fire within timeout of 5000ms'); });
    const failed: any = await new CraftOne(bot).runImpl('furnace', 1);
    expect(failed).toMatchObject({ success: false, failureType: 'line_of_sight_blocked' });
    expect(failed.result).toMatch(/furnace\(2, ?64, ?0\)/);
  });
});

describe('reachWorkstation keeps the old failure type when the walk itself fails', () => {
  it('passes move-to\'s failureType through when the block is out of reach', async () => {
    const world = makeWorld();
    world.set(20, 64, 0, 'furnace');
    const bot: any = { entity: { position: stand(), height: 1.8 }, blockAt: world.blockAt };
    const move = vi.fn(async () => ({ success: false, failureType: 'no_route_from_here', result: 'blocked' }));
    const result = await reachWorkstation(bot, new Vec3(20, 64, 0), move as any, { label: 'かまど' });
    expect(result).toMatchObject({ success: false, failureType: 'no_route_from_here' });
    expect(result!.result).toContain('かまど(20, 64, 0)');
  });
});
