import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';

vi.mock('../../src/services/minebot/execution/observedWait.js', async (original) => ({
  ...(await original() as object), actionDelay: vi.fn(async () => {}),
}));

const { executeAction, isCommandLevel } = await import('../../src/services/minebot/execution/ActionExecution.js');
const { default: WaitTime } = await import('../../src/services/minebot/instantSkills/waitTime.js');
const { default: AttackContinuously } = await import('../../src/services/minebot/instantSkills/attackContinuously.js');
const { chooseTool, nearlyBroken } = await import('../../src/services/minebot/utils/toolChoice.js');
const { spareToolNote, axeAdviceNote } = await import('../../src/services/minebot/utils/toolWear.js');
const { creeperMeleeRefusal } = await import('../../src/services/minebot/utils/creeperFuse.js');
const { approachFurnace } = await import('../../src/services/minebot/utils/furnaceReach.js');
const { default: StairMine } = await import('../../src/services/minebot/instantSkills/stairMine.js');

const registry = minecraftData('1.21.11');
const host = () => Object.assign(new EventEmitter(), {
  executingSkill: false, interruptExecution: false,
  clearControlStates: vi.fn(), stopDigging: vi.fn(), deactivateItem: vi.fn(),
  pathfinder: { stop: vi.fn(), setGoal: vi.fn() },
});

describe('preflight runs for the command itself under common FCA (run 17: no wait-time refusal, no night gate on move-to)', () => {
  it('is command level with no action, or inside the action opened for that very skill; not inside another skill', async () => {
    const bot = host();
    expect(isCommandLevel(bot, 'wait-time')).toBe(true);
    const seen: Record<string, boolean> = {};
    await executeAction(bot as any, 'wait-time', 0, async () => {
      seen.own = isCommandLevel(bot, 'wait-time');
      seen.other = isCommandLevel(bot, 'move-to');
      await executeAction(bot as any, 'move-to', 0, async () => { seen.nested = isCommandLevel(bot, 'move-to'); return { success: true, result: 'ok' }; });
      return { success: true, result: 'ok' };
    });
    expect(seen).toEqual({ own: true, other: false, nested: false });
  });

  it('a wait-time command run the way nativeBody runs it is refused before it waits', async () => {
    const bot: any = Object.assign(host(), {
      entity: { position: new Vec3(0, 64, 0) }, entities: {}, game: { dimension: 'overworld' }, time: { timeOfDay: 6000 }, health: 20, food: 20,
      inventory: { items: () => [{ name: 'stone_pickaxe', count: 1 }], slots: [] }, instantSkills: { getSkill: () => null },
      activeFurnaces: [{ pos: { x: 1, y: 64, z: 0 }, item: 'raw_iron', count: 13, readyAt: Date.now() + 130_000, startedAt: Date.now(), dimension: 'overworld' }],
    });
    const skill = new WaitTime(bot);
    const result: any = await executeAction(bot, 'wait-time', 0, () => skill.run(100_000));
    expect(result).toMatchObject({ success: false, failureType: 'wait_refused' });
    expect(result.result).toContain('raw_iron×13');
  });
});

describe('wait-time is refused in the night shaft too, unless the wait heals (run 17: 190 s at night)', () => {
  const body = (patch: Record<string, unknown>) => ({ entity: { position: new Vec3(0, 64, 0) }, entities: {}, game: { dimension: 'overworld' },
    time: { timeOfDay: 18_000 }, health: 20, food: 20, activeFurnaces: [],
    inventory: { items: () => [{ name: 'iron_pickaxe', count: 1 }, { name: 'iron_ingot', count: 8 }], slots: [] }, ...patch }) as any;
  it('refuses waiting out the night with something definite to do, and says what', () => {
    const refused = (new WaitTime(body({})) as any).preflight(60_000);
    expect(refused).toMatchObject({ failureType: 'wait_refused' });
    expect(refused.result).toContain('夜（明けるまで約');
    expect(refused.result).toContain('iron_chestplate');
    // Nothing definite (only "gather logs"): the night may be waited out. In the End, never refused for a shaft or a night.
    expect((new WaitTime(body({ inventory: { items: () => [], slots: [] } })) as any).preflight(60_000)).toBeNull();
    expect((new WaitTime(body({ game: { dimension: 'the_end' } })) as any).preflight(60_000)).toBeNull();
  });
  it('lets a hurt body that is regenerating wait, and a day without furnaces', () => {
    expect((new WaitTime(body({ health: 6, food: 18 })) as any).preflight(60_000)).toBeNull();
    expect((new WaitTime(body({ health: 6, food: 12 })) as any).preflight(60_000)).not.toBeNull();   // not regenerating: eat instead
    expect((new WaitTime(body({ time: { timeOfDay: 6000 } })) as any).preflight(60_000)).toBeNull();
  });
});

describe('pickaxes: the best one decides, a worn-out one is the last choice, a spare is said (run 17: "durability 1" five times)', () => {
  const stone = registry.blocksByName.stone as any;
  const block = { harvestTools: stone.harvestTools, digTime: (type: number | null) => type === registry.itemsByName.stone_pickaxe.id ? 600 : type === registry.itemsByName.iron_pickaxe.id ? 400 : 7500 };
  const pick = (name: string, used: number, max: number) => ({ name, type: registry.itemsByName[name].id, count: 1, maxDurability: max, durabilityUsed: used });
  it('chooses a sound pickaxe over the cheaper one about to break, and the worn one only when nothing else does', () => {
    expect(nearlyBroken(pick('stone_pickaxe', 130, 131))).toBe(true);
    expect(chooseTool(block as any, [pick('stone_pickaxe', 130, 131), pick('iron_pickaxe', 10, 250)], { requireHarvest: true })?.name).toBe('iron_pickaxe');
    expect(chooseTool(block as any, [pick('stone_pickaxe', 130, 131)], { requireHarvest: true })?.name).toBe('stone_pickaxe');
    expect(chooseTool(block as any, [pick('stone_pickaxe', 10, 131), pick('iron_pickaxe', 10, 250)], { requireHarvest: true })?.name).toBe('stone_pickaxe');
  });
  it('stair-mine goes on while one pickaxe is sound, whatever the others', () => {
    const bot: any = { version: '1.21.11', inventory: { items: () => [pick('stone_pickaxe', 130, 131), pick('iron_pickaxe', 10, 250)] } };
    expect((new StairMine(bot) as any).checkPickaxeAvailable()).toBeNull();
    bot.inventory.items = () => [pick('stone_pickaxe', 130, 131), pick('iron_pickaxe', 248, 250)];
    expect((new StairMine(bot) as any).checkPickaxeAvailable()).toMatchObject({ failureType: 'tool_durability_low' });
  });
  it('says a spare is wanted, and what the pack makes it of', () => {
    const items = (extra: any[]) => ({ inventory: { items: () => [...extra, { name: 'cobblestone', count: 157 }, { name: 'stick', count: 4 }] } });
    expect(spareToolNote(items([pick('iron_pickaxe', 220, 250)]))).toContain('iron_pickaxeの残りは30回');
    expect(spareToolNote(items([pick('iron_pickaxe', 220, 250)]))).toContain('stone_pickaxe（丸石3。手持ちの丸石157個）');
    expect(spareToolNote(items([pick('iron_pickaxe', 10, 250)]))).toBe('');
    expect(spareToolNote(items([pick('iron_pickaxe', 220, 250), pick('stone_pickaxe', 0, 131)]))).toBe('');
  });
});

describe('creepers are not fought hand to hand, and fleeing from one is not cut short (run 17)', () => {
  it('refuses a creeper named for melee; a group leaves creepers out', async () => {
    expect(creeperMeleeRefusal(['creeper'])).toMatchObject({ failureType: 'creeper_melee' });
    expect(creeperMeleeRefusal(['zombie', 'skeleton'])).toBeNull();
    expect((new AttackContinuously({} as any) as any).preflight('zombie,creeper')).toMatchObject({ failureType: 'creeper_melee' });
    const creeper: any = { id: 2, name: 'creeper', position: new Vec3(2, 64, 0), height: 1.7, isValid: true };
    const zombie: any = { id: 3, name: 'zombie', position: new Vec3(3, 64, 0), height: 1.9, isValid: true };
    const struck: string[] = [];
    const bot: any = { registry, entity: { id: 1, position: new Vec3(0.5, 64, 0.5) }, health: 20, minebotControlState: 'idle',
      entities: { 2: creeper, 3: zombie }, inventory: { items: () => [], slots: [] }, heldItem: null,
      equip: async () => {}, setControlState: () => {}, pathfinder: { stop: () => {} },
      nearestEntity: (match: (entity: any) => boolean) => [creeper, zombie].filter(e => e.isValid && match(e))[0] ?? null,
      lookAt: async () => {}, attack: async (entity: any) => { struck.push(entity.name); entity.isValid = false; } };
    const skill: any = new AttackContinuously(bot);
    skill.shouldInterrupt = () => false;
    skill.collectNearbyDrops = async () => [];
    await skill.runImpl('hostile', 10, 24, 1);
    expect(struck).toEqual(['zombie']);
  });
});

describe('flee-from runs straight away from what is close before it plans a route (run 17: 2 m and 1 m from a creeper)', () => {
  const solid = { name: 'stone', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]], diggable: true };
  const air = { name: 'air', boundingBox: 'empty', shapes: [] };
  const flatBot = (creeperAt: Vec3, ground: (pos: Vec3) => boolean = () => true) => {
    const creeper: any = { id: 2, name: 'creeper', type: 'hostile', position: creeperAt, height: 1.7, isValid: true };
    const keys: Record<string, boolean> = {};
    const bot: any = Object.assign(host(), {
      registry, version: '1.21.11', health: 20,
      entity: { id: 1, position: new Vec3(0.5, 64, 0.5), velocity: new Vec3(0, 0, 0), onGround: true, yaw: 0 },
      entities: { 2: creeper }, players: {},
      blockAt: (pos: Vec3) => { const p = pos.floored(); return { ...(p.y < 64 && ground(p) ? solid : air), position: p }; },
      world: { raycast: () => null },
      look: vi.fn(async (yaw: number) => {
        // One tick of sprinting along the heading (mineflayer yaw: north = 0, west = +pi/2).
        if (keys.forward) bot.entity.position = bot.entity.position.offset(-Math.sin(yaw) * 0.28, 0, -Math.cos(yaw) * 0.28);
      }),
      setControlState: vi.fn((key: string, on: boolean) => { keys[key] = on; }),
      pathfinder: { stop: vi.fn(), setGoal: vi.fn(), goal: null, movements: {} },
    });
    return { bot, keys };
  };

  it('on open ground: away from it until the distance asked for, and every key let go', async () => {
    const { default: FleeFrom } = await import('../../src/services/minebot/instantSkills/fleeFrom.js');
    const { bot, keys } = flatBot(new Vec3(3.5, 64, 0.5));
    const result: any = await new FleeFrom(bot).runImpl('creeper', 10, 6000);
    expect(result.success).toBe(true);
    expect(result.result).toContain('走って離れました');
    expect(bot.entity.position.distanceTo(new Vec3(3.5, 64, 0.5))).toBeGreaterThanOrEqual(10);
    expect(bot.entity.position.x).toBeLessThan(0.5);                    // away from the creeper, not past it
    expect(keys.forward).toBe(false);
    expect(keys.sprint).toBe(false);
    expect((bot as any).fleeStraightRun).toBe(false);
  });

  it('does not run over a drop: with a cliff on every side but the creeper\'s, it stops and leaves it to the route search', async () => {
    const { default: FleeFrom } = await import('../../src/services/minebot/instantSkills/fleeFrom.js');
    // Ground only in the 3x3 round the body and toward the creeper: a fall everywhere else.
    const { bot, keys } = flatBot(new Vec3(3.5, 64, 0.5), pos => (Math.abs(pos.x) <= 1 && Math.abs(pos.z) <= 1) || (pos.x >= 0 && Math.abs(pos.z) <= 1));
    await new FleeFrom(bot).runImpl('creeper', 10, 1500);
    expect(bot.entity.position.x).toBeGreaterThan(-2);                   // never ran off the edge to the west
    expect(keys.forward).toBe(false);
  });
});

describe('a furnace out of reach is walked to before it is opened (run 17: "too far" three times)', () => {
  it('moves to a stand within reach, and says why when it cannot', async () => {
    const bot: any = { entity: { position: new Vec3(51.5, 52, 104.5) } };
    const move = vi.fn(async () => { bot.entity.position = new Vec3(51.5, 66, 104.5); return { success: true, result: 'ok' }; });
    expect(await approachFurnace(bot, new Vec3(51, 66, 103), move)).toBeNull();
    expect(move).toHaveBeenCalledWith(51, 66, 103, 4, 'block');
    const stuck = vi.fn(async () => ({ success: false, failureType: 'no_route_from_here', result: 'blocked' }));
    bot.entity.position = new Vec3(51.5, 52, 104.5);
    expect(await approachFurnace(bot, new Vec3(51, 66, 103), stuck)).toMatchObject({ success: false, failureType: 'no_route_from_here' });
    bot.entity.position = new Vec3(51.5, 66, 104.5);
    const never = vi.fn();
    expect(await approachFurnace(bot, new Vec3(51, 66, 103), never as any)).toBeNull();
    expect(never).not.toHaveBeenCalled();
  });
});

describe('logs cut by hand: an axe is said (run 17: seventeen logs in 132 s)', () => {
  it('names the axe the pack makes, after a few logs, and nothing once an axe is carried', () => {
    const pack = (items: any[]) => ({ inventory: { items: () => items } });
    expect(axeAdviceNote(pack([{ name: 'cobblestone', count: 5 }, { name: 'stick', count: 2 }, { name: 'oak_log', count: 6 }]), 6)).toContain('stone_axe');
    expect(axeAdviceNote(pack([{ name: 'oak_log', count: 6 }]), 6)).toContain('wooden_axe');
    expect(axeAdviceNote(pack([{ name: 'oak_log', count: 2 }]), 2)).toBe('');
    expect(axeAdviceNote(pack([{ name: 'stone_axe', count: 1 }, { name: 'oak_log', count: 6 }]), 6)).toBe('');
  });
});
