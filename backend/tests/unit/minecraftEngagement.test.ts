import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import { beginEngagement, engagedWith, engagementOf, isEngaged } from '../../src/services/minebot/utils/engagement.js';
import { CombatEventHandler } from '../../src/services/minebot/eventReaction/handlers/CombatEventHandler.js';
import { InstantSkill } from '../../src/services/minebot/types/skills.js';
import AutoWearArmor, { armourToWear } from '../../src/services/minebot/constantSkills/autoWearArmor.js';

describe('a fight the planner chose is not an emergency for being one (paid runs L77j, L77k: the attack on a blaze was stopped by the emergency for that blaze)', () => {
  it('knows which skills are a fight, and what each call of one sets out to fight', () => {
    expect(engagementOf('attack-continuously', ['blaze', 40, 32, 1])).toEqual(['blaze']);
    expect(engagementOf('attack-continuously', ['blaze, wither_skeleton'])).toEqual(['blaze', 'wither_skeleton']);
    expect(engagementOf('combat', [])).toEqual(['*']);                       // nothing named: whatever is hostile
    expect(engagementOf('attack-nearest', ['hostile'])).toEqual(['*']);
    expect(engagementOf('move-to', [1, 2, 3])).toBeNull();
    expect(engagementOf('flee-from', ['blaze'])).toBeNull();
  });

  it('holds for the kinds named, while the fight is on, and ends once', () => {
    const bot: any = {};
    expect(isEngaged(bot)).toBe(false);
    const end = beginEngagement(bot, ['blaze']);
    expect(isEngaged(bot)).toBe(true);
    expect(engagedWith(bot, 'blaze')).toBe(true);
    expect(engagedWith(bot, 'wither_skeleton')).toBe(false);
    const all = beginEngagement(bot, ['*']);
    expect(engagedWith(bot, 'wither_skeleton')).toBe(true);
    all(); all();
    expect(engagedWith(bot, 'wither_skeleton')).toBe(false);
    end();
    expect(isEngaged(bot)).toBe(false);
    expect(beginEngagement(bot, null)()).toBeUndefined();                    // no fight: nothing to end
    expect(isEngaged(bot)).toBe(false);
  });

  it('a kind being fought is left out of the watch for hostiles; any other kind is watched as ever', () => {
    const bot: any = { entity: { id: 1, position: new Vec3(0, 64, 0) }, entities: {
      2: { id: 2, name: 'blaze', position: new Vec3(6, 65, 0) }, 3: { id: 3, name: 'wither_skeleton', position: new Vec3(0, 64, 30) } } };
    expect(new CombatEventHandler(bot).checkHostileApproach()?.threatLevel).toBe('critical');
    const end = beginEngagement(bot, ['blaze']);
    expect(new CombatEventHandler(bot).checkHostileApproach()).toBeNull();
    bot.entities[3].position = new Vec3(0, 64, 7);                            // something else comes close: still an emergency
    const seen: any = new CombatEventHandler(bot).checkHostileApproach();
    expect(seen?.threatLevel).toBe('critical');
    expect(seen.allHostiles.map((entry: any) => entry.mobType)).toEqual(['wither_skeleton']);
    end();
    expect((new CombatEventHandler(bot).checkHostileApproach() as any).allHostiles.length).toBe(2);
  });

  it('is on for as long as the planner\'s fight skill runs, and over when it returns or throws', async () => {
    const bot: any = Object.assign(new EventEmitter(), { entity: { id: 7, position: new Vec3(0, 64, 0) }, _client: new EventEmitter(),
      inventory: { slots: [], items: () => [] }, executingSkill: false, interruptExecution: false, health: 20, food: 20,
      clearControlStates: vi.fn(), stopDigging: vi.fn(), pathfinder: { stop: vi.fn(), setGoal: vi.fn() } });
    const during: boolean[] = [];
    class Fight extends InstantSkill {
      constructor(host: any) { super(host); this.skillName = 'attack-continuously'; }
      async runImpl(target: string) { during.push(engagedWith(bot, 'blaze'), engagedWith(bot, 'zombie')); if (target === 'ghast') throw new Error('lost it'); return { success: true, result: 'done' }; }
    }
    class Walk extends InstantSkill {
      constructor(host: any) { super(host); this.skillName = 'move-to'; }
      async runImpl() { during.push(isEngaged(bot)); return { success: true, result: 'there' }; }
    }
    await new Fight(bot).run('blaze');
    expect(during).toEqual([true, false]);
    expect(isEngaged(bot)).toBe(false);
    await new Fight(bot).run('ghast').catch(() => undefined);
    expect(isEngaged(bot)).toBe(false);
    await new Walk(bot).run();
    expect(during.at(-1)).toBe(false);
  });
});

describe('armour carried is armour worn (paid run L77k: sixteen minutes under fire with the chestplate in the pack)', () => {
  it('fills each empty place with the best piece carried, and leaves what is worn alone', () => {
    const carried = ['iron_helmet', 'leather_helmet', 'diamond_boots', 'iron_boots', 'iron_chestplate', 'cobblestone', 'golden_leggings'];
    expect(armourToWear({ head: null, torso: null, legs: null, feet: null }, carried)).toEqual([
      { destination: 'head', name: 'iron_helmet' }, { destination: 'torso', name: 'iron_chestplate' },
      { destination: 'legs', name: 'golden_leggings' }, { destination: 'feet', name: 'diamond_boots' }]);
    // A golden helmet the planner put on stays, with an iron one in the pack.
    expect(armourToWear({ head: 'golden_helmet', torso: 'iron_chestplate', legs: 'iron_leggings', feet: null }, carried)).toEqual([{ destination: 'feet', name: 'diamond_boots' }]);
    // A shield goes on the arm, where it is there to be raised; a torch already held there stays.
    expect(armourToWear({ head: null, torso: null, legs: null, feet: null }, ['cobblestone', 'shield'])).toEqual([{ destination: 'off-hand', name: 'shield' }]);
    expect(armourToWear({ 'off-hand': 'torch' }, ['cobblestone', 'shield']).filter(piece => piece.destination === 'off-hand')).toEqual([]);
    expect(armourToWear({ head: null }, ['cobblestone'])).toEqual([]);
  });
});

describe('armour goes on while the body walks, and never across another use of the pack (lab continuation L77m: unworn for the walk into the fortress)', () => {
  const wearer = () => {
    const order: string[] = [];
    const slots: any[] = [];
    const items = [{ name: 'iron_helmet' }, { name: 'shield' }, { name: 'cobblestone' }];
    const bot: any = Object.assign(new EventEmitter(), { entity: { id: 7, position: new Vec3(0, 64, 0) }, currentWindow: null,
      inventory: { slots, items: () => items }, getEquipmentDestSlot: (name: string) => ({ head: 5, torso: 6, legs: 7, feet: 8, 'off-hand': 45 } as any)[name],
      equip: async (item: any, destination: string) => { order.push(`start ${item.name}`); await new Promise(resolve => setTimeout(resolve, 5)); order.push(`end ${item.name}`);
        slots[bot.getEquipmentDestSlot(destination)] = item; } });
    return { bot, order, skill: new AutoWearArmor(bot) };
  };

  it('puts on what is carried without asking for the body, one equip at a time with any other', async () => {
    const { bot, order, skill } = wearer();
    const wearing = skill.run();
    const other = bot.equip({ name: 'iron_pickaxe' }, 'hand');           // a skill equips a tool at the same moment
    await Promise.all([wearing, other]);
    expect(order.filter(entry => entry.startsWith('start')).length).toBe(3);
    // Never two at once: every start is followed by its own end.
    for (let index = 0; index < order.length; index += 2) expect(order[index + 1]).toBe(order[index].replace('start', 'end'));
    expect(bot.inventory.slots[5].name).toBe('iron_helmet');
    expect(bot.inventory.slots[45].name).toBe('shield');
  });

  it('is run when asked, not from the queue the body is handed out by', () => {
    expect(wearer().skill.wantsPreemption()).toBe(true);
  });

  it('holds off while a window is open', async () => {
    const { bot, order, skill } = wearer();
    bot.currentWindow = { type: 'minecraft:crafting' };
    await skill.run();
    expect(order).toEqual([]);
    bot.currentWindow = null;
    await skill.run();
    expect(order.length).toBe(4);
  });
});
