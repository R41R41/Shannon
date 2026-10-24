import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InstantSkill } from '../../src/services/minebot/types/skills.js';
import {
  armourWorn, closeInAdvised, combatOwnerOf, HEAD_COMBAT_GRACE_MS, HEAD_COMBAT_YIELD_HEALTH, isHeadCombatActive, markHeadCombat,
} from '../../src/services/minebot/utils/combatOwner.js';
import { floorConfig, reflexPromptText } from '../../src/services/minebot/utils/floorConfig.js';
import { installFloorReflexes } from '../../src/services/minebot/utils/floorReflexes.js';
import { ensureReflexLedger } from '../../src/services/minebot/utils/reflexLedger.js';

const settle = (ms = 15) => new Promise(resolve => setTimeout(resolve, ms));
const tick = (bot: EventEmitter) => bot.emit('physicsTick');

type Block = { name: string; boundingBox: string };
const STONE: Block = { name: 'stone', boundingBox: 'block' }, AIR: Block = { name: 'air', boundingBox: 'empty' };
/** Stone up to y 64, air above: the body stands at y 65. `solid` limits the stone to a pillar (no way to run anywhere). */
const ground = (solid?: (x: number, z: number) => boolean) => (position: Vec3): Block => {
  const x = Math.floor(position.x), y = Math.floor(position.y), z = Math.floor(position.z);
  if (solid && !solid(x, z)) return AIR;
  return y <= 64 ? STONE : AIR;
};

function fixture(options: { health?: number; food?: number; zombieAt?: number; world?: (position: Vec3) => Block; items?: Array<{ name: string; count: number }>;
  slots?: Record<number, { name: string }> } = {}) {
  const calls: Array<[string, boolean]> = [];
  const slots: any[] = new Array(46).fill(null);
  for (const [index, value] of Object.entries(options.slots ?? {})) slots[Number(index)] = value;
  const bot: any = Object.assign(new EventEmitter(), {
    entity: { id: 1, name: 'player', position: new Vec3(0.5, 65, 0.5), yaw: 0, pitch: 0, onGround: true },
    health: options.health ?? 7, food: options.food ?? 20, oxygenLevel: 20, game: { dimension: 'overworld' }, controlState: {} as Record<string, boolean>,
    entities: { 2: { id: 2, name: 'zombie', position: new Vec3(0.5 + (options.zombieAt ?? 3), 65, 0.5), isValid: true } } as Record<string, any>,
    inventory: { items: () => options.items ?? [], slots }, executingSkill: false, interruptExecution: false,
    clearControlStates: vi.fn(), setControlState: vi.fn((key: string, value: boolean) => { calls.push([key, value]); }),
    look: vi.fn(async () => {}), equip: vi.fn(async () => {}), consume: vi.fn(async () => {}), blockAt: options.world ?? ground() });
  ensureReflexLedger(bot);
  return { bot, calls };
}

describe('combat owner: when the planner\'s fight holds the body', () => {
  afterEach(() => { delete process.env.MINEBOT_HEAD_COMBAT_OWNER; });

  it('holds while a fight skill runs, and not for a skill that is no fight', () => {
    const { bot } = fixture();
    expect(isHeadCombatActive(bot)).toBe(false);
    markHeadCombat(bot, 'move-to', null)();
    markHeadCombat(bot, 'build-around-self', ['*']);
    expect(isHeadCombatActive(bot)).toBe(false);
    for (const skill of ['combat', 'combat-engage', 'attack-nearest', 'attack-continuously']) {
      const fresh = fixture().bot;
      const end = markHeadCombat(fresh, skill, ['*']);
      expect(isHeadCombatActive(fresh), skill).toBe(true);
      expect(combatOwnerOf(fresh)).toBe('head');
      end();
    }
  });

  it('holds for 20 s after the fight began while its target is alive and near, and not after it dies, goes far or the time is up', () => {
    const { bot } = fixture({ zombieAt: 5 });
    const began = 1_000_000;
    const end = markHeadCombat(bot, 'attack-nearest', ['*'], began);
    end();
    expect(isHeadCombatActive(bot, began + 5_000)).toBe(true);
    expect(isHeadCombatActive(bot, began + HEAD_COMBAT_GRACE_MS)).toBe(true);
    expect(isHeadCombatActive(bot, began + HEAD_COMBAT_GRACE_MS + 1)).toBe(false);
    // The marks are pruned once they are over: a later check at an earlier time finds none.
    expect(isHeadCombatActive(bot, began + 5_000)).toBe(false);
    const again = markHeadCombat(bot, 'attack-nearest', ['*'], began); again();
    bot.entities[2].isValid = false;                                   // dead
    expect(isHeadCombatActive(bot, began + 5_000)).toBe(false);
    bot.entities[2].isValid = true; bot.entities[2].position = new Vec3(40, 65, 0);   // far
    expect(isHeadCombatActive(bot, began + 5_000)).toBe(false);
  });

  it('a fight named for one kind holds only for that kind', () => {
    const { bot } = fixture({ zombieAt: 5 });
    const end = markHeadCombat(bot, 'attack-continuously', ['skeleton'], 1_000_000); end();
    expect(isHeadCombatActive(bot, 1_002_000)).toBe(false);             // only a zombie is near
    bot.entities[3] = { id: 3, name: 'skeleton', position: new Vec3(8, 65, 0), isValid: true };
    expect(isHeadCombatActive(bot, 1_002_000)).toBe(true);
  });

  it('gives way at health 5 or less (the body\'s own limit), and is switched off by MINEBOT_HEAD_COMBAT_OWNER=off', () => {
    const { bot } = fixture({ health: HEAD_COMBAT_YIELD_HEALTH });
    markHeadCombat(bot, 'combat', ['*']);
    expect(isHeadCombatActive(bot)).toBe(false);
    bot.health = HEAD_COMBAT_YIELD_HEALTH + 1;
    expect(isHeadCombatActive(bot)).toBe(true);
    process.env.MINEBOT_HEAD_COMBAT_OWNER = 'off';
    expect(isHeadCombatActive(bot)).toBe(false);
    expect(markHeadCombat(fixture().bot, 'combat', ['*'])).toBeTypeOf('function');
    const fresh = fixture().bot; markHeadCombat(fresh, 'combat', ['*']); expect(fresh.headCombat).toBeUndefined();
    expect(reflexPromptText(floorConfig({}))).not.toContain('あなたが選んだ戦闘');
    delete process.env.MINEBOT_HEAD_COMBAT_OWNER;
    expect(reflexPromptText(floorConfig({}))).toContain('あなたが選んだ戦闘');
  });

  it('the fight skill marks itself while it runs (types/skills.ts), and clears the mark when it returns or throws', async () => {
    const makeHost = (): any => Object.assign(new EventEmitter(), { entity: { id: 7, position: new Vec3(0, 64, 0) }, _client: new EventEmitter(),
      inventory: { slots: [], items: () => [] }, executingSkill: false, interruptExecution: false, health: 20, food: 20,
      entities: { 9: { id: 9, name: 'zombie', position: new Vec3(3, 64, 0), isValid: true } },
      clearControlStates: vi.fn(), stopDigging: vi.fn(), pathfinder: { stop: vi.fn(), setGoal: vi.fn() } });
    const host = makeHost();
    const during: boolean[] = [];
    class Fight extends InstantSkill {
      constructor(bot: any, name = 'attack-nearest') { super(bot); this.skillName = name; }
      async runImpl(throwIt?: boolean) { during.push(isHeadCombatActive(this.rootBot)); if (throwIt) throw new Error('lost it'); return { success: true, result: 'done' }; }
    }
    await new Fight(host).run();
    await new Fight(host).run(true).catch(() => undefined);
    expect(during).toEqual([true, true]);
    const walker = makeHost();
    await new Fight(walker, 'move-to').run();
    expect(during.at(-1)).toBe(false);
    expect(walker.headCombat).toBeUndefined();
    // Over, but within the 20 s with the zombie near: still the planner's fight; once the zombie is gone, it is not.
    expect(host.headCombat.every((mark: any) => mark.endedAt !== undefined)).toBe(true);
    expect(isHeadCombatActive(host)).toBe(true);
    delete host.entities[9];
    expect(isHeadCombatActive(host)).toBe(false);
  });
});

describe('combat owner: the floor leaves the planner\'s fight alone', () => {
  afterEach(() => { delete process.env.MINEBOT_HEAD_COMBAT_OWNER; });

  it('without the mark, a body at health 7 with a zombie 3 m away runs (as before)', async () => {
    const { bot, calls } = fixture();
    installFloorReflexes(bot, floorConfig({}), { fleeTickMs: 1 });
    tick(bot);
    expect(bot.floorReflexes.busy).toBe('flee');
    await settle(40);
    expect(calls.some(([key, value]) => key === 'forward' && value)).toBe(true);
  });

  it('with the planner\'s fight running it does not run, and no key is touched', async () => {
    const { bot, calls } = fixture();
    installFloorReflexes(bot, floorConfig({}), { fleeTickMs: 1 });
    markHeadCombat(bot, 'attack-nearest', ['*']);
    for (let i = 0; i < 10; i++) { tick(bot); await settle(2); }
    expect(bot.floorReflexes.busy).toBeNull();
    expect(bot.floorReflexes.engagements.flee ?? 0).toBe(0);
    expect(calls).toEqual([]);
  });

  it('with the planner\'s fight over but within 20 s and the zombie still near, it still does not run; when the zombie is dead, it does', async () => {
    const { bot, calls } = fixture();
    installFloorReflexes(bot, floorConfig({}), { fleeTickMs: 1 });
    const end = markHeadCombat(bot, 'combat', ['zombie']); end();
    tick(bot); await settle(5);
    expect(bot.floorReflexes.busy).toBeNull(); expect(calls).toEqual([]);
    // The zombie it was after is dead, and something else is at the body: the fight is over, the floor is its own again.
    delete bot.entities[2];
    bot.entities[3] = { id: 3, name: 'spider', position: new Vec3(3.5, 65, 0.5), isValid: true };
    tick(bot);
    expect(bot.floorReflexes.busy).toBe('flee');
  });

  it('at health 5 it runs whatever the planner chose', () => {
    const { bot } = fixture({ health: 5 });
    installFloorReflexes(bot, floorConfig({}), { fleeTickMs: 1 });
    markHeadCombat(bot, 'attack-continuously', ['*']);
    tick(bot);
    expect(bot.floorReflexes.busy).toBe('flee');
  });

  it('a flee under way when the fight is chosen is ended, not carried on', async () => {
    const { bot } = fixture();
    installFloorReflexes(bot, floorConfig({}), { fleeTickMs: 1 });
    tick(bot);
    expect(bot.floorReflexes.fleeEpisode).toBeDefined();
    await vi.waitFor(() => expect(bot.floorReflexes.busy).toBeNull(), { timeout: 3000, interval: 2 });
    markHeadCombat(bot, 'combat-engage', ['*']);
    tick(bot);
    expect(bot.floorReflexes.fleeEpisode).toBeUndefined();
    expect(bot.floorReflexes.busy).toBeNull();
  });

  it('eating at health 6 or less still happens while the planner fights', async () => {
    const eat = fixture({ health: 6, food: 10, zombieAt: 9, items: [{ name: 'bread', count: 3 }] });
    installFloorReflexes(eat.bot, floorConfig({}));
    markHeadCombat(eat.bot, 'attack-nearest', ['*']);
    tick(eat.bot); await settle(10);
    expect(eat.bot.consume).toHaveBeenCalledTimes(1);
  });

  it('the observation says who owns the fight: head, reflex (while the floor runs the body away), or null', async () => {
    const { bot } = fixture();
    expect(combatOwnerOf(bot)).toBeNull();
    installFloorReflexes(bot, floorConfig({}), { fleeTickMs: 1 });
    tick(bot);
    expect(combatOwnerOf(bot)).toBe('reflex');
    await vi.waitFor(() => expect(bot.floorReflexes.busy).toBeNull(), { timeout: 3000, interval: 2 });
    bot.floorReflexes.fleeEpisode = undefined;
    expect(combatOwnerOf(bot)).toBeNull();
    markHeadCombat(bot, 'attack-nearest', ['*']);
    expect(combatOwnerOf(bot)).toBe('head');
  });
});

describe('close in on a lone archer rather than run', () => {
  const iron = { 5: { name: 'iron_helmet' }, 6: { name: 'iron_chestplate' }, 7: { name: 'iron_leggings' }, 8: { name: 'iron_boots' } };
  const skeletonBody = (patch: Record<string, unknown> = {}, slots: Record<number, { name: string }> = iron) => {
    const { bot } = fixture({ health: 12, slots });
    bot.entities = { 2: { id: 2, name: 'skeleton', position: new Vec3(9.5, 65, 0.5), isValid: true } };
    bot.heldItem = { name: 'iron_sword' };
    return Object.assign(bot, patch);
  };

  it('counts the armour worn', () => {
    expect(armourWorn(skeletonBody())).toEqual({ ironPieces: 4, points: 15 });
    expect(armourWorn(skeletonBody({}, { 6: { name: 'diamond_chestplate' }, 5: { name: 'turtle_helmet' } }))).toEqual({ ironPieces: 1, points: 10 });
  });

  it('is advised for a lone skeleton, three pieces of iron (or ten armour points), a sword and health 10', () => {
    expect(closeInAdvised(skeletonBody())).toBe(true);
    expect(closeInAdvised(skeletonBody({}, { 5: { name: 'iron_helmet' }, 6: { name: 'iron_chestplate' }, 7: { name: 'iron_leggings' } }))).toBe(true);
    expect(closeInAdvised(skeletonBody({}, { 6: { name: 'diamond_chestplate' }, 5: { name: 'turtle_helmet' } }))).toBe(true);      // 10 points
    expect(closeInAdvised(skeletonBody({}, { 5: { name: 'iron_helmet' }, 6: { name: 'iron_chestplate' } }))).toBe(false);          // 2 pieces, 8 points
    expect(closeInAdvised(skeletonBody({ health: 9 }))).toBe(false);
    expect(closeInAdvised(skeletonBody({ heldItem: null }))).toBe(false);
    expect(closeInAdvised(skeletonBody({ heldItem: null, inventory: { slots: new Array(46).fill(null), items: () => [{ name: 'stone_sword' }] } }, {}))).toBe(false);   // no armour
    const bot = skeletonBody({ heldItem: null }); bot.inventory.items = () => [{ name: 'stone_sword' }];
    expect(closeInAdvised(bot)).toBe(true);
    const two = skeletonBody(); two.entities[3] = { id: 3, name: 'creeper', position: new Vec3(6, 65, 0), isValid: true };
    expect(closeInAdvised(two)).toBe(false);
    const zombie = skeletonBody(); zombie.entities[2].name = 'zombie';
    expect(closeInAdvised(zombie)).toBe(false);
  });
});
