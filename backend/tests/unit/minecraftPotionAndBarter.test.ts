import { describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';

vi.mock('../../src/services/minebot/utils/gotoSafe.js', () => ({ gotoSafe: vi.fn(async () => {}) }));
vi.mock('../../src/services/minebot/execution/observedWait.js', () => ({ actionDelay: vi.fn(async () => {}) }));

const { POTIONS, carriesPotion, potionIn } = await import('../../src/services/minebot/utils/potionContents.js');
const { captureWorldObservation } = await import('../../src/services/minebot/cognition/worldFrame.js');
const { default: UseItemOnEntity } = await import('../../src/services/minebot/instantSkills/useItemOnEntity.js');
const { default: AttackContinuously } = await import('../../src/services/minebot/instantSkills/attackContinuously.js');

const potion = (id: unknown, name = 'potion') => ({ name, count: 1, components: [{ type: 'potion_contents', data: { potionId: id, customEffects: [] } }] });

describe('a potion is known by what it is a potion of (a piglin gives a bottle of water and fire resistance as the same item)', () => {
  it('names the potion from the number the client is told, in the game\'s order (checked in the lab for seven of them)', () => {
    expect([0, 11, 13, 24, 31, 34, 40].map(id => potionIn(potion(id)))).toEqual(['water', 'fire_resistance', 'swiftness', 'healing', 'regeneration', 'strength', 'slow_falling']);
    expect(POTIONS.indexOf('fire_resistance')).toBe(11);
    expect(potionIn(potion(11, 'splash_potion'))).toBe('fire_resistance');
    expect(potionIn(potion('minecraft:fire_resistance'))).toBe('fire_resistance');
    expect(potionIn(potion(999))).toBe('unknown_999');                    // a later version's: said, not guessed
    expect(potionIn({ name: 'potion', components: [] })).toBeNull();
    expect(potionIn({ name: 'bread', components: [{ type: 'potion_contents', data: { potionId: 11 } }] })).toBeNull();
    expect(carriesPotion('tipped_arrow')).toBe(true);
  });

  it('is said beside the item in what the planner is shown of the pack', () => {
    const bot: any = { entity: { position: new Vec3(0, 64, 0) }, health: 20, food: 20,
      inventory: { items: () => [potion(0), potion(11), { name: 'bread', count: 3 }] } };
    const pack = (captureWorldObservation(bot) as any).inventory;
    expect(pack).toEqual([{ name: 'bread', count: 3 }, { name: 'potion', count: 1, contents: 'water' }, { name: 'potion', count: 1, contents: 'fire_resistance' }]);
  });
});

describe('an item in the hand is used on a living thing, and what came of it is told (gold to a piglin)', () => {
  const trader = () => {
    const pack: Array<{ name: string; count: number }> = [{ name: 'gold_ingot', count: 3 }];
    const piglin = { id: 2, name: 'piglin', position: new Vec3(2, 64, 0), height: 1.95, isValid: true };
    const given: unknown[] = [];
    const bot: any = { entity: { id: 1, position: new Vec3(0, 64, 0) }, entities: { 2: piglin, 3: { id: 3, name: 'zombified_piglin', position: new Vec3(1, 64, 0), isValid: true } },
      inventory: { items: () => pack.filter(item => item.count > 0) }, equip: async () => {}, lookAt: async () => {}, nearestEntity: () => null,
      activateEntity: async (entity: unknown) => { given.push(entity); pack[0].count--; const back = pack.find(item => item.name === 'ender_pearl'); if (back) back.count += 2; else pack.push({ name: 'ender_pearl', count: 2 }); } };
    return { bot, piglin, given, pack };
  };

  it('gives it to the nearest of the kind named, as often as asked, and reports what the pack gained', async () => {
    const { bot, piglin, given } = trader();
    const skill: any = new UseItemOnEntity(bot);
    skill.shouldInterrupt = () => false;
    Object.assign(skill, { returnWaitMs: 30, takeWaitMs: 30, retryWaitMs: 1 });
    const result = await skill.runImpl('gold_ingot', 'piglin', 2);
    expect(given).toEqual([piglin, piglin]);                              // the piglin, not the zombified one beside it
    expect(result.success).toBe(true);
    expect(result.result).toContain('piglinにgold_ingotを2回使った');
    expect(result.result).toContain('ender_pearl×4');
    expect(result.result).toContain('gold_ingotの残り: 1個');
  });

  it('says so when there is nothing to give, no one to give it to, or it is not taken', async () => {
    const { bot } = trader();
    const skill: any = new UseItemOnEntity(bot);
    skill.shouldInterrupt = () => false;
    Object.assign(skill, { returnWaitMs: 30, takeWaitMs: 30, retryWaitMs: 1 });
    expect((await skill.runImpl('wheat', 'piglin', 1)).failureType).toBe('missing_item');
    expect((await skill.runImpl('gold_ingot', 'cow', 1)).failureType).toBe('target_not_found');
    bot.activateEntity = async () => {};                                  // it does not take it
    const refused = await skill.runImpl('gold_ingot', 'piglin', 2);
    expect(refused).toMatchObject({ success: false, failureType: 'not_accepted' });
    expect(refused.result).toContain('gold_ingotの残り: 3個');
  });
});

describe('attack-continuously can hold its ground (inside a cover, at a hole in a wall)', () => {
  it('strikes only what has come within a blow of the eyes, and does not go after the rest', async () => {
    const { gotoSafe } = await import('../../src/services/minebot/utils/gotoSafe.js');
    (gotoSafe as any).mockClear();
    const near: any = { id: 2, name: 'blaze', position: new Vec3(2, 64, 0), height: 1.8, width: 0.6, isValid: true };
    const far: any = { id: 3, name: 'blaze', position: new Vec3(9, 64, 0), height: 1.8, width: 0.6, isValid: true };
    const struck: unknown[] = [];
    const bot: any = { entity: { id: 1, position: new Vec3(0, 64, 0) }, health: 20, minebotControlState: 'idle', entities: { 2: near, 3: far },
      inventory: { items: () => [{ name: 'stone_sword', count: 1 }], slots: [] }, heldItem: { name: 'stone_sword' }, equip: async () => {}, setControlState: () => {}, pathfinder: { stop: () => {} },
      nearestEntity: (match: (entity: any) => boolean) => [near, far].find(entity => entity.isValid && match(entity)) ?? null,
      lookAt: async () => {}, attack: async (entity: any) => { struck.push(entity.id); if (struck.length === 4) near.isValid = false; } };
    const skill: any = new AttackContinuously(bot);
    let rounds = 0;
    skill.shouldInterrupt = () => ++rounds > 60;
    skill.collectNearbyDrops = async () => [];
    await skill.runImpl('blaze', 30, 24, 0, true);
    expect(struck).toEqual([2, 2, 2, 2]);                                 // the one in reach, until it is dead; never the one nine blocks off
    expect(gotoSafe).not.toHaveBeenCalled();
  });
});
