import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import { CombatEventHandler } from '../../src/services/minebot/eventReaction/handlers/CombatEventHandler.js';
import { EventReactionSystem } from '../../src/services/minebot/eventReaction/EventReactionSystem.js';
import { approachSpeed, sampleThreatMotion, sustainedApproachSpeed, type ThreatMotionState } from '../../src/services/minebot/utils/threatTracker.js';

/**
 * Paid run L109 (luna, night, 2026-10-05): after the iron pickaxe, 15 hostile emergencies in 25 minutes, the body at
 * health 20 throughout and never hit. 9 were raised by one mob at 12-18 m "arriving in 6-9 seconds" that had walked
 * a few blocks toward the body and stopped within a second; 5 by two zombies standing 14-16 m off; the planner then
 * only confirmed "nothing within 16 blocks". These fixtures replay those shapes, and the dangers that must stay fast.
 */

const STEP_MS = 250; // the tracker samples every five ticks

interface Mob { id: number; name: string; position: Vec3; height?: number }

function world(mobs: Mob[], extra: Record<string, unknown> = {}) {
  const state: ThreatMotionState = { samples: new Map() };
  const entities: Record<number, Mob> = {};
  for (const mob of mobs) entities[mob.id] = mob;
  const bot: any = {
    entity: { id: 1, position: new Vec3(0, 64, 0) }, entities, threatMotion: state, health: 20,
    registry: { entitiesByName: { zombie: { type: 'hostile' }, skeleton: { type: 'hostile' }, creeper: { type: 'hostile' }, spider: { type: 'hostile' } } },
    ...extra,
  };
  return { bot, state };
}

/** Plays motion up to `seconds` (from `from` seconds): each mob's x at time t is `x(id, t)` (y, z fixed), sampled as the tracker does. */
function play(bot: any, state: ThreatMotionState, seconds: number, x: (id: number, t: number) => number, from = 0): number {
  let at = 0;
  for (let ms = Math.round(from * 1000); ms <= Math.round(seconds * 1000); ms += STEP_MS) {
    at = ms;
    for (const mob of Object.values(bot.entities) as Mob[]) mob.position = new Vec3(x(mob.id, ms / 1000), mob.position.y, mob.position.z);
    sampleThreatMotion(bot, state, at);
  }
  return at;
}

/** Stands at `from` for `stand` seconds, then walks at the body at `speed` for `walk` seconds, then stops. */
const stroll = (from: number, stand: number, walk: number, speed = 2.3) => (_id: number, t: number) =>
  from - speed * Math.min(walk, Math.max(0, t - stand));

describe('the approach that raises an emergency is one the mob keeps up (paid run L109)', () => {
  it('a zombie that walks a few blocks toward the body at chase speed and stops is a stroll, not an emergency', () => {
    // 22:23:49-like: it stood at 26 m, walked 2.5 s at 2.3 m/s, and is at 20.25 m: "on the body in 8 seconds" by the short window.
    const { bot, state } = world([{ id: 2, name: 'zombie', position: new Vec3(26, 64, 0) }]);
    const at = play(bot, state, 5.5, stroll(26, 3, 2.5));
    vi.spyOn(Date, 'now').mockReturnValue(at);
    expect(approachSpeed(bot, 2)).toBeGreaterThan(2);
    expect(sustainedApproachSpeed(bot, 2)!).toBeLessThan(1.3);
    const handler = new CombatEventHandler(bot);
    expect(handler.checkHostileApproach()).toBeNull();
    expect(handler.arrivingBeyond(16)).toEqual([]);
    vi.restoreAllMocks();
  });

  it('the same stroll ending 14 m off is a warning, not an emergency (22:25:21, 22:23:18)', () => {
    const { bot, state } = world([{ id: 2, name: 'creeper', position: new Vec3(20, 64, 0) }]);
    const at = play(bot, state, 5.5, stroll(20, 3, 2.5));
    vi.spyOn(Date, 'now').mockReturnValue(at);
    expect(new CombatEventHandler(bot).checkHostileApproach()).toMatchObject({ threatLevel: 'warning' });
    vi.restoreAllMocks();
  });

  it('a zombie that has been coming the whole time is an emergency nine seconds out, as before (22:17:36 kept the gap while the body ran)', () => {
    const { bot, state } = world([{ id: 2, name: 'zombie', position: new Vec3(34, 64, 0) }]);
    const at = play(bot, state, 6, stroll(34, 0, 6));
    vi.spyOn(Date, 'now').mockReturnValue(at);
    expect(sustainedApproachSpeed(bot, 2)).toBeCloseTo(2.3, 1);
    const event = new CombatEventHandler(bot).checkHostileApproach();
    expect(event).toMatchObject({ threatLevel: 'critical' });
    expect(event!.allHostiles[0].distance).toBeCloseTo(20.2, 1);
    expect(event!.allHostiles[0].arrivesInSeconds).toBe(8);
    vi.restoreAllMocks();
  });

  it('a zombie that sets off from standing close by is not waited on: under five seconds out the short window decides', () => {
    // Stood at 12 m for four seconds, then came: a second and a half later it is 8.55 m off, on the body in under
    // five seconds by the short window; the longer record (standing most of it) would put it at 9.5 seconds.
    const { bot, state } = world([{ id: 2, name: 'zombie', position: new Vec3(12, 64, 0) }]);
    const at = play(bot, state, 5.5, stroll(12, 4, 10));
    vi.spyOn(Date, 'now').mockReturnValue(at);
    expect(sustainedApproachSpeed(bot, 2)!).toBeLessThan(0.75);
    expect(new CombatEventHandler(bot).checkHostileApproach()).toMatchObject({ threatLevel: 'critical' });
    vi.restoreAllMocks();
  });

  it('a zombie within the critical distance is an emergency whatever its motion', () => {
    const { bot, state } = world([{ id: 2, name: 'zombie', position: new Vec3(7, 64, 0) }]);
    const at = play(bot, state, 5, () => 7);
    vi.spyOn(Date, 'now').mockReturnValue(at);
    expect(new CombatEventHandler(bot).checkHostileApproach()).toMatchObject({ threatLevel: 'critical' });
    vi.restoreAllMocks();
  });

  it('a mob that has only just come into range is judged on the short window (no longer record to hold it back)', () => {
    const { bot, state } = world([{ id: 2, name: 'zombie', position: new Vec3(24, 64, 0) }]);
    const at = play(bot, state, 2, stroll(24, 0, 2));
    vi.spyOn(Date, 'now').mockReturnValue(at);
    expect(sustainedApproachSpeed(bot, 2)).toBeCloseTo(approachSpeed(bot, 2)!, 5);
    expect(new CombatEventHandler(bot).checkHostileApproach()).toMatchObject({ threatLevel: 'critical' });
    vi.restoreAllMocks();
  });
});

describe('two hostiles count as an emergency only when they press on the body (paid run L109: five emergencies for two zombies standing 14-16 m off)', () => {
  const pair = () => world([{ id: 2, name: 'zombie', position: new Vec3(14, 64, 0) }, { id: 3, name: 'zombie', position: new Vec3(0, 64, 15) }]);

  it('two zombies measured standing within the detection range are a warning', () => {
    const { bot, state } = pair();
    const at = play(bot, state, 5, id => (id === 2 ? 14 : 0));
    vi.spyOn(Date, 'now').mockReturnValue(at);
    expect(new CombatEventHandler(bot).checkHostileApproach()).toMatchObject({ threatLevel: 'warning', mobCount: 2 });
    vi.restoreAllMocks();
  });

  it('the same two coming at the body are an emergency', () => {
    const { bot, state } = world([{ id: 2, name: 'zombie', position: new Vec3(26, 64, 0) }, { id: 3, name: 'zombie', position: new Vec3(27, 64, 2) }]);
    // Slow enough that neither alone arrives within the lead (about 1 m/s, 12 seconds out), but both keep coming.
    const at = play(bot, state, 12, (id, t) => (id === 2 ? 26 : 27) - t);
    vi.spyOn(Date, 'now').mockReturnValue(at);
    const event = new CombatEventHandler(bot).checkHostileApproach();
    expect(event).toMatchObject({ threatLevel: 'critical', mobCount: 2 });
    expect(event!.allHostiles.every(entry => entry.arrivesInSeconds === undefined)).toBe(true);
    vi.restoreAllMocks();
  });

  it('a body that does not measure motion counts them as before', () => {
    const { bot } = pair();
    delete bot.threatMotion;
    expect(new CombatEventHandler(bot).checkHostileApproach()).toMatchObject({ threatLevel: 'critical' });
  });

  it('at half health or less the body does not wait: standing pairs and strolls are emergencies again', () => {
    const { bot, state } = pair();
    bot.health = 9;
    const at = play(bot, state, 5, id => (id === 2 ? 14 : 0));
    vi.spyOn(Date, 'now').mockReturnValue(at);
    expect(new CombatEventHandler(bot).checkHostileApproach()).toMatchObject({ threatLevel: 'critical' });
    vi.restoreAllMocks();

    const stroller = world([{ id: 2, name: 'zombie', position: new Vec3(26, 64, 0) }], { health: 9 });
    const end = play(stroller.bot, stroller.state, 5.5, stroll(26, 3, 2.5));
    vi.spyOn(Date, 'now').mockReturnValue(end);
    expect(new CombatEventHandler(stroller.bot).checkHostileApproach()).toMatchObject({ threatLevel: 'critical' });
    vi.restoreAllMocks();
  });
});

describe('a ranged kind is critical within its reach where it can see the body', () => {
  // A wall across x=7 (y 63-67, z -3..3) on a stone floor: the skeleton at 14 m can walk round it but cannot see through it.
  const blockAt = (wall: boolean) => (pos: Vec3) => ({ boundingBox: pos.y < 64 || (wall && pos.x === 7 && pos.y <= 67 && Math.abs(pos.z) <= 3) ? 'block' : 'empty' });

  it('a skeleton 14 m off in the open is critical once its reach is known; behind a wall it can walk round, a warning', () => {
    const open = world([{ id: 2, name: 'skeleton', position: new Vec3(14.5, 64, 0.5), height: 1.99 }], { blockAt: blockAt(false) });
    open.bot.entity.position = new Vec3(0.5, 64, 0.5);
    const seen = new CombatEventHandler(open.bot);
    seen.setReachProvider(name => (name === 'skeleton' ? 15.3 : 0));
    expect(seen.checkHostileApproach()).toMatchObject({ threatLevel: 'critical' });

    const walled = world([{ id: 2, name: 'skeleton', position: new Vec3(14.5, 64, 0.5), height: 1.99 }], { blockAt: blockAt(true) });
    walled.bot.entity.position = new Vec3(0.5, 64, 0.5);
    const hidden = new CombatEventHandler(walled.bot);
    hidden.setReachProvider(name => (name === 'skeleton' ? 15.3 : 0));
    expect(hidden.checkHostileApproach()).toMatchObject({ threatLevel: 'warning' });
  });
});

describe('the threat an emergency settled does not raise the next one unchanged (paid run L109: five emergencies in two minutes for the same zombies)', () => {
  it('the same mobs loitering where they were are tracked, not raised; closer by the margin, hurt, or in reach, they are', () => {
    // No motion measured: the plain count of two within 16 m would make this critical.
    const bot: any = { entity: { id: 1, position: new Vec3(0, 64, 0) }, health: 20, entities: {
      2: { id: 2, name: 'zombie', position: new Vec3(16.5, 64, 0) }, 3: { id: 3, name: 'zombie', position: new Vec3(0, 64, 17) } } };
    const handler = new CombatEventHandler(bot);
    handler.noteThreatsSettled();
    bot.entities[2].position = new Vec3(15, 64, 0);
    bot.entities[3].position = new Vec3(0, 64, 15.6);
    expect(new CombatEventHandler(bot).checkHostileApproach()).toMatchObject({ threatLevel: 'critical' }); // without the settlement
    expect(handler.checkHostileApproach()).toBeNull();
    // Hurt since: both count again.
    bot.health = 18;
    expect(handler.checkHostileApproach()).toMatchObject({ threatLevel: 'critical', mobCount: 2 });
    bot.health = 20;
    handler.noteThreatsSettled();                                 // settled again at 15 and 15.6
    expect(handler.checkHostileApproach()).toBeNull();
    // Both come three and a half blocks closer than they were settled at: new threats, and two of them.
    bot.entities[2].position = new Vec3(11.5, 64, 0);
    bot.entities[3].position = new Vec3(0, 64, 12);
    expect(handler.checkHostileApproach()).toMatchObject({ threatLevel: 'critical', mobCount: 2 });
  });

  it('a settled hostile within the critical distance is an emergency all the same', () => {
    const bot: any = { entity: { id: 1, position: new Vec3(0, 64, 0) }, health: 20, entities: {
      2: { id: 2, name: 'zombie', position: new Vec3(16.5, 64, 0) } } };
    const handler = new CombatEventHandler(bot);
    handler.noteThreatsSettled();
    expect(handler.checkHostileApproach()).toBeNull();
    bot.entities[2].position = new Vec3(7.5, 64, 0);
    expect(handler.checkHostileApproach()).toMatchObject({ threatLevel: 'critical' });
  });

  it('a settled zombie that comes on is held only within the margin (about 1.3 s of a chase)', () => {
    const { bot, state } = world([{ id: 2, name: 'zombie', position: new Vec3(30, 64, 0) }]);
    const chase = (_id: number, t: number) => 30 - 2.3 * t;
    const handler = new CombatEventHandler(bot);
    let at = play(bot, state, 5.75, chase);                       // 16.8 m off when the emergency is settled
    handler.noteThreatsSettled();
    at = play(bot, state, 6.5, chase, 6);                          // 15 m: within three of where it was settled
    vi.spyOn(Date, 'now').mockReturnValue(at);
    expect(new CombatEventHandler(bot).checkHostileApproach()).toMatchObject({ threatLevel: 'critical' }); // unsettled: an emergency
    expect(handler.checkHostileApproach()).toBeNull();
    vi.restoreAllMocks();
    at = play(bot, state, 7.25, chase, 6.75);                      // 13.3 m: past the margin
    vi.spyOn(Date, 'now').mockReturnValue(at);
    expect(handler.checkHostileApproach()).toMatchObject({ threatLevel: 'critical' });
    vi.restoreAllMocks();
  });

  it('a hostile that was out of sight when the emergency ended is not settled by it', () => {
    // Underground: the body in a corridor running north (x 0-1, z 0-16), one zombie in it, the other in a pocket of its own.
    const open = (pos: Vec3) => pos.y >= 64 && pos.y <= 65 && ((pos.x >= 0 && pos.x <= 1 && pos.z >= 0 && pos.z <= 16)
      || (pos.x >= 15 && pos.x <= 16 && pos.z >= 0 && pos.z <= 1));
    const bot: any = { entity: { id: 1, position: new Vec3(0.5, 64, 0.5) }, health: 20,
      blockAt: (pos: Vec3) => ({ boundingBox: open(pos) ? 'empty' : 'block' }),
      entities: { 2: { id: 2, name: 'zombie', position: new Vec3(15.5, 64, 0.5) }, 3: { id: 3, name: 'zombie', position: new Vec3(0.5, 64, 15.5) } } };
    const handler = new CombatEventHandler(bot);
    handler.noteThreatsSettled();                                  // id 2 is sealed off in its pocket
    bot.blockAt = (pos: Vec3) => ({ boundingBox: pos.y < 64 ? 'block' : 'empty' });   // the rock between is dug away
    bot.entities[2] = { ...bot.entities[2] };                     // a fresh object: the exposure cache is per entity
    expect(handler.checkHostileApproach()).toMatchObject({ threatLevel: 'warning' });
    expect((handler as any).settled.has(2)).toBe(false);
    expect((handler as any).settled.has(3)).toBe(true);
  });
});

describe('an emergency that ends safe settles what is still in sight', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('after the planner settles "nothing within 16" with zombies at 16.5 and 17 m, their loitering at 15 m raises nothing (22:25:01 -> 22:25:03)', async () => {
    const bot: any = Object.assign(new EventEmitter(), {
      entity: { id: 1, position: new Vec3(0, 64, 0) },
      entities: { 2: { id: 2, name: 'zombie', position: new Vec3(16.5, 64, 0) }, 3: { id: 3, name: 'zombie', position: new Vec3(0, 64, 17) } },
      health: 20, food: 20, game: { dimension: 'overworld' },
      inventory: { items: () => [], slots: [] },
      instantSkills: { getSkill: () => undefined, getSkills: () => [] },
      constantSkills: { getSkills: () => [] },
      pathfinder: { stop: vi.fn(), setGoal: vi.fn() }, clearControlStates: vi.fn(),
      oxygenLevel: 20, blockAt: () => ({ name: 'air', boundingBox: 'empty' }),
    });
    const runtime: any = { isReady: () => true, isRunning: () => true, isInEmergencyMode: () => false,
      interruptForEmergency: vi.fn(async () => {}), setEmergencyTask: vi.fn(),
      invoke: vi.fn(async () => ({ taskTree: { status: 'completed' } })), resumePreviousTask: vi.fn(async () => {}) };
    const settings: any = { reactions: [], hostileDetection: { criticalDistance: 8, detectionDistance: 16, multiMobCriticalCount: 2 } };
    const system: any = new EventReactionSystem(bot, runtime, settings);
    system.reflexPolicy = null;
    vi.spyOn(system, 'startContinuousFlee').mockImplementation(() => {});
    vi.spyOn(system, 'waitForStableHostileClearance').mockResolvedValue(true);
    vi.spyOn(system, 'giveTaskBack').mockResolvedValue(undefined);

    const result = await system.handleEmergencyEvent({ timestamp: Date.now(), eventType: 'hostile_approach',
      threatLevel: 'critical', mobType: 'zombie', mobCount: 2,
      allHostiles: [{ mobType: 'zombie', distance: 13.6 }, { mobType: 'zombie', distance: 15.8 }] });
    expect(result.handled).toBe(true);
    bot.entities[2].position = new Vec3(15, 64, 0);
    bot.entities[3].position = new Vec3(0, 64, 15.6);
    expect(system.combat.checkHostileApproach()).toBeNull();
    bot.entities[2].position = new Vec3(6, 64, 0);
    expect(system.combat.checkHostileApproach()).toMatchObject({ threatLevel: 'critical' });
    system.destroy();
  });
});
