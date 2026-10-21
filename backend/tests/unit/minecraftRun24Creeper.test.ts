import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';

// Run 24: a body in a whole set of iron with an iron sword was cut off from its work three times by "flee from the creeper" (13-15 m away,
// one of them behind a wall); the dig guard refused every wall the creeper could see through, and a walk of 76 m ran out of time.
//   - a body in armour does not flee from an unlit creeper that is not near, and its digs are not held back by one;
//   - a lit creeper, a near one, or a body without armour are as before.

const gotoSafeMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/config/env.js', () => ({ config: {} }));
vi.mock('../../src/services/minebot/config/MinebotConfig.js', () => ({ CONFIG: { SKILL_TIMEOUT_MS: 120_000 } }));
vi.mock('../../src/services/minebot/utils/setMovements.js', () => ({ setMovements: vi.fn() }));
vi.mock('../../src/services/minebot/utils/gotoSafe.js', () => ({ gotoSafe: gotoSafeMock }));
const sim = vi.hoisted(() => ({ delay: (_ms: number) => {} }));
vi.mock('../../src/services/minebot/execution/observedWait.js', async (original) => ({ ...(await original() as object), actionDelay: vi.fn(async (_bot: unknown, ms: number) => { sim.delay(ms); }) }));

const { armourPoints, wellArmoured } = await import('../../src/services/minebot/utils/armourCheck.js');
const { threatExposedBy } = await import('../../src/services/minebot/utils/exposureGuard.js');
const { default: FleeFrom } = await import('../../src/services/minebot/instantSkills/fleeFrom.js');
const { creeperDuelRefusal, duelCreeper, goodArmourPieces, duelWeapon } = await import('../../src/services/minebot/utils/creeperDuel.js');
const { default: AttackContinuously } = await import('../../src/services/minebot/instantSkills/attackContinuously.js');

const wear = (...names: Array<string | null>) => {
  const slots: Array<{ name: string } | null> = Array.from({ length: 46 }, () => null);
  names.forEach((name, index) => { if (name) slots[5 + index] = { name }; });
  return slots;
};
const IRON = ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'];

describe('how well the body is armoured', () => {
  it('counts the points of what is worn, in the slot it belongs to', () => {
    expect(armourPoints({ inventory: { slots: wear(...IRON) } })).toBe(15);
    expect(armourPoints({ inventory: { slots: wear('diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots') } })).toBe(20);
    expect(armourPoints({ inventory: { slots: wear('iron_helmet', null, 'iron_leggings', null) } })).toBe(7);
    expect(armourPoints({ inventory: { slots: wear('iron_boots', null, null, null) } })).toBe(0);      // boots in the head slot count for nothing
    expect(armourPoints({})).toBe(0);
  });

  it('is well armoured from 12 points and 14 health', () => {
    expect(wellArmoured({ inventory: { slots: wear(...IRON) }, health: 20 })).toBe(true);
    expect(wellArmoured({ inventory: { slots: wear(...IRON) }, health: 9 })).toBe(false);
    expect(wellArmoured({ inventory: { slots: wear('iron_helmet', 'iron_chestplate', null, null) }, health: 20 })).toBe(false);
    expect(wellArmoured({ inventory: { slots: wear('chainmail_helmet', 'chainmail_chestplate', 'chainmail_leggings', 'chainmail_boots') }, health: 20 })).toBe(true);
  });
});

describe('the dig guard and a creeper in view (run 24: 76 m of tunnel refused wall after wall)', () => {
  const stone = { name: 'stone', boundingBox: 'block' }, air = { name: 'air', boundingBox: 'empty' };
  /** The body shut in a shaft at (0, 62..63, 0), roofed at y 64; the creeper stands on the ground above. */
  function body(creeper: any, extra: Record<string, unknown> = {}) {
    const open = new Set(['0,62,0', '0,63,0']);
    return { entity: { position: new Vec3(0.5, 62, 0.5), id: 1 }, entities: { 2: creeper }, oxygenLevel: 20,
      blockAt: (pos: Vec3) => (pos.y > 64 || open.has(`${pos.x},${pos.y},${pos.z}`) ? air : stone), ...extra } as any;
  }
  const creeper = (x: number, metadata: unknown[] = []) => ({ id: 2, name: 'creeper', position: new Vec3(x, 65, 0.5), height: 1.7, metadata });

  it('refuses the roof with a creeper above, and not for a body in armour with an unlit creeper not near', () => {
    expect(threatExposedBy(body(creeper(3.5)), new Vec3(0, 64, 0))).toMatchObject({ name: 'creeper' });
    const armoured = { inventory: { slots: wear(...IRON) }, health: 20 };
    expect(threatExposedBy(body(creeper(8.5), armoured), new Vec3(0, 64, 0))).toBeNull();
    // too near, or lit, or the body hurt: as before
    expect(threatExposedBy(body(creeper(3.5), armoured), new Vec3(0, 64, 0))).toMatchObject({ name: 'creeper' });
    expect(threatExposedBy(body(creeper(8.5, Array.from({ length: 19 }, (_, i) => (i === 16 ? 1 : null))), armoured), new Vec3(0, 64, 0))).toMatchObject({ name: 'creeper' });
    expect(threatExposedBy(body(creeper(8.5), { ...armoured, health: 8 }), new Vec3(0, 64, 0))).toMatchObject({ name: 'creeper' });
    // and other mobs are still kept out in armour
    const zombie = { id: 2, name: 'zombie', position: new Vec3(8.5, 65, 0.5), height: 1.95 };
    expect(threatExposedBy(body(zombie, armoured), new Vec3(0, 64, 0))).toMatchObject({ name: 'zombie' });
  });
});

describe('flee-from and a creeper that is not near (run 24: three cuts, 13-15 m away)', () => {
  beforeEach(() => { gotoSafeMock.mockReset(); });
  function fixture(extra: Record<string, unknown>, creeperAt = 13, metadata: unknown[] = []) {
    const bot: any = {
      entity: { id: 1, position: new Vec3(0, 64, 0) },
      entities: { 2: { id: 2, name: 'creeper', position: new Vec3(creeperAt, 64, 0), height: 1.7, metadata } },
      players: {}, blockAt: () => ({ boundingBox: 'empty' }),
      pathfinder: { goal: null, stop: vi.fn(), setGoal: vi.fn() }, ...extra,
    };
    return bot;
  }

  it('a body in iron goes on with its work: no run, no search, and it says why', async () => {
    const bot = fixture({ inventory: { slots: wear(...IRON), items: () => [] }, health: 20 });
    const result: any = await new FleeFrom(bot).runImpl('creeper', 16, 5_000);
    expect(result.success).toBe(true);
    expect(result.result).toContain('逃げずに続けます');
    expect(result.result).toContain('防具15点');
    expect(gotoSafeMock).not.toHaveBeenCalled();
  });

  it('a body without armour, a near creeper and a lit one are fled from as before', async () => {
    gotoSafeMock.mockImplementation(async () => ({ success: true }));
    const bare = fixture({ inventory: { slots: wear(), items: () => [] }, health: 20 });
    await new FleeFrom(bare).runImpl('creeper', 16, 2_000);
    expect(gotoSafeMock).toHaveBeenCalled();
    gotoSafeMock.mockClear();
    const near = fixture({ inventory: { slots: wear(...IRON), items: () => [] }, health: 20 }, 3);
    await new FleeFrom(near).runImpl('creeper', 16, 2_000);
    const lit = fixture({ inventory: { slots: wear(...IRON), items: () => [] }, health: 20 }, 13, Array.from({ length: 19 }, (_, i) => (i === 16 ? 1 : null)));
    const result: any = await new FleeFrom(lit).runImpl('creeper', 16, 2_000);
    expect(String(result.result)).not.toContain('逃げずに続けます');
  });
});

describe('a creeper alone is fought with sword and iron: struck, stepped back from, struck (run 24; the mind\'s conditions)', () => {
  const sword = { name: 'iron_sword' };
  /** A body at the origin with the given gear, and a creeper 8 m east that comes at it. */
  function duelBody(extra: Record<string, unknown> = {}, creeperAt = 8, metadata: unknown[] = []) {
    const controls: Record<string, boolean> = {};
    const creeper: any = { id: 7, name: 'creeper', position: new Vec3(creeperAt, 64, 0), height: 1.7, metadata, hp: 20 };
    const log: string[] = [];
    const bot: any = {
      entity: { position: new Vec3(0, 64, 0) }, entities: { 7: creeper }, health: 20, heldItem: sword,
      inventory: { slots: wear(...IRON), items: () => [sword] },
      setControlState: (key: string, value: boolean) => { controls[key] = value; },
      lookAt: vi.fn(async () => {}),
      look: vi.fn(async (yaw: number) => { bot.yaw = yaw; }),
      equip: vi.fn(async () => {}),
      attack: vi.fn((target: any) => { log.push('blow'); target.hp -= 6; target.position = new Vec3(target.position.x + 1.5, 64, 0); if (target.hp <= 0) delete bot.entities[7]; }),
      ...extra,
    };
    // time passes: held forward moves the body along its heading (towards the creeper when it was looked at, away when it was turned from)
    sim.delay = (ms: number) => {
      if (controls.forward) {
        const towards = bot.yaw === undefined || Math.cos(bot.yaw) > -0.5 ? 1 : -1;
        const dir = Math.sign(creeper.position.x - bot.entity.position.x) * (towards < 0 && bot.yawAway ? -1 : 1);
        bot.entity.position = new Vec3(bot.entity.position.x + dir * 0.0055 * ms * (bot.yawAway ? -1 : 1), 64, 0);
      }
    };
    bot.lookAt = vi.fn(async () => { bot.yawAway = false; });
    bot.look = vi.fn(async () => { bot.yawAway = true; log.push('back'); });
    return { bot, creeper, controls, log };
  }

  it('may be fought with a sword, three pieces of iron or better, health 14 and one unlit creeper: and says which is missing', () => {
    expect(goodArmourPieces({ inventory: { slots: wear(...IRON) } })).toBe(4);
    expect(goodArmourPieces({ inventory: { slots: wear('iron_helmet', 'leather_chestplate', 'iron_leggings', null) } })).toBe(2);
    expect(duelWeapon({ inventory: { items: () => [{ name: 'stone_axe' }, { name: 'iron_sword' }] } })?.name).toBe('iron_sword');
    const { bot } = duelBody();
    expect(creeperDuelRefusal(bot)).toBeNull();
    expect(creeperDuelRefusal({ ...bot, inventory: { slots: wear(...IRON), items: () => [] }, heldItem: null })).toContain('剣か斧');
    expect(creeperDuelRefusal({ ...bot, inventory: { slots: wear('iron_helmet', 'iron_chestplate', null, null), items: () => [sword] } })).toContain('2つ');
    expect(creeperDuelRefusal({ ...bot, health: 12 })).toContain('体力');
    expect(creeperDuelRefusal({ ...bot, entities: { 7: bot.entities[7], 8: { id: 8, name: 'creeper', position: new Vec3(5, 64, 5), height: 1.7 } } })).toContain('2匹');
    expect(creeperDuelRefusal({ ...bot, entities: {} })).toContain('見えません');
    expect(creeperDuelRefusal({ ...bot, entities: { 7: { ...bot.entities[7], metadata: Array.from({ length: 19 }, (_, i) => (i === 16 ? 1 : null)) } } })).toContain('点火');
  });

  it('attack-continuously creeper: refused as before bare, allowed in iron with a sword (the refusal says the conditions)', () => {
    const { bot } = duelBody();
    const skill: any = new AttackContinuously(bot);
    expect(skill.preflight('creeper')).toBeNull();
    const bare = new AttackContinuously({ ...bot, inventory: { slots: wear(), items: () => [sword] } } as any) as any;
    const refused = bare.preflight('creeper');
    expect(refused).toMatchObject({ failureType: 'creeper_melee' });
    expect(refused.result).toContain('鉄以上の防具3つ以上');
    // "hostile" and mixed lists are not the duel: creepers are left out of a group
    expect(skill.preflight('creeper,zombie')).toMatchObject({ failureType: 'creeper_melee' });
  });

  it('closes in, strikes, steps back, and is done when the creeper is dead; the floor reflex is told to leave it alone meanwhile', async () => {
    const { bot, log } = duelBody();
    let during = false;
    const original = bot.attack;
    bot.attack = vi.fn((target: any) => { during = during || bot.creeperDuel === true; original(target); });
    const outcome = await duelCreeper(bot, { deadlineMs: 5_000 });
    expect(outcome.outcome).toBe('killed');
    expect(outcome.blows).toBe(4);
    expect(outcome.backOffs).toBeGreaterThanOrEqual(3);
    expect(during).toBe(true);
    expect(bot.creeperDuel).toBe(false);
    expect(log.filter(entry => entry === 'blow')).toHaveLength(4);
  });

  it('a creeper that lights is stepped back from, not struck; and the fight stops below ten health', async () => {
    const lit = Array.from({ length: 19 }, (_, i) => (i === 16 ? 1 : null));
    const { bot, log, creeper } = duelBody({}, 3, lit);
    creeper.position = new Vec3(3, 64, 0);
    const outcome = await duelCreeper(bot, { deadlineMs: 400 });
    expect(outcome.blows).toBe(0);
    expect(outcome.backOffs).toBeGreaterThan(0);
    expect(log).toContain('back');
    const hurt = duelBody({ health: 8 });
    expect((await duelCreeper(hurt.bot, { deadlineMs: 400 })).outcome).toBe('hurt');
  });
});