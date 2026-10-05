import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';
import { EventReactionSystem } from '../../src/services/minebot/eventReaction/EventReactionSystem.js';
import { counterFor, losingPursuit } from '../../src/services/minebot/utils/losingRace.js';
import { setMovements } from '../../src/services/minebot/utils/setMovements.js';
import { executeAction } from '../../src/services/minebot/execution/ActionExecution.js';
import { isEngaged } from '../../src/services/minebot/utils/engagement.js';
import { chooseWeapon, estimateEncounter, seedCombatStats, wearPerHit } from '../../src/modules/minecraftLearning/encounter.js';
import { wearCostSeconds } from '../../src/services/minebot/utils/toolChoice.js';

/**
 * Paid run L110 (2026-10-06): fleeing a zombie at night by a shore, the native escape's route stopped to lay a
 * bridge block (the body crouching and backing to the edge at about a block a second, x fixed at -244.5 for four
 * seconds) and a creeper closed from 12.2 m to 1 m over thirteen seconds while every tick logged "fleeing". The
 * planner only updated its task tree. Blown up at health 14, no shield.
 */

const settings: any = { reactions: [], hostileDetection: { criticalDistance: 8, detectionDistance: 16, multiMobCriticalCount: 2 } };

/** Distance samples (as the tracker keeps them) of a gap going from `from` to `to` over `spanMs`. */
function gap(from: number, to: number, spanMs: number, now = Date.now()) {
  const steps = Math.max(2, Math.round(spanMs / 250));
  return Array.from({ length: steps + 1 }, (_, index) => ({ at: now - spanMs + (spanMs * index) / steps, distance: from + ((to - from) * index) / steps }));
}

function botFixture(entities: Record<number, any>, samples: Array<[number, ReturnType<typeof gap>]> = []): any {
  return Object.assign(new EventEmitter(), {
    entity: { id: 1, position: new Vec3(0, 63, 0) }, entities,
    threatMotion: { samples: new Map(samples) },
    health: 14, food: 18, game: { dimension: 'overworld' },
    inventory: { items: () => [{ name: 'wooden_pickaxe', count: 1 }, { name: 'cobblestone', count: 20 }], slots: [] },
    instantSkills: { getSkill: () => undefined, getSkills: () => [] },
    constantSkills: { getSkills: () => [] },
    pathfinder: { stop: vi.fn(), setGoal: vi.fn(), isMoving: () => true, setMovements: vi.fn() }, clearControlStates: vi.fn(),
    oxygenLevel: 20, blockAt: () => ({ name: 'air', boundingBox: 'empty' }),
  });
}

afterEach(() => { vi.restoreAllMocks(); });

describe('the body notices an escape that is losing the race (paid run L110)', () => {
  it('a creeper whose gap shrank from 12.2 to 8.2 m in 2.5 s while the body ran is a race being lost', () => {
    const bot = botFixture({ 2: { id: 2, name: 'creeper', position: new Vec3(8.2, 63, 0) } }, [[2, gap(12.2, 8.2, 2500)]]);
    const losing = losingPursuit(bot)!;
    expect(losing).toMatchObject({ name: 'creeper' });
    expect(losing.closing).toBeCloseTo(1.6, 1);
    expect(losing.contactIn).toBeLessThan(4);
  });

  it('a pursuer the run keeps level with, one far off and closing slowly, or one seen closing only briefly is not', () => {
    const level = botFixture({ 2: { id: 2, name: 'zombie', position: new Vec3(11.8, 63, 0) } }, [[2, gap(12, 11.8, 2500)]]);
    expect(losingPursuit(level)).toBeNull();
    const far = botFixture({ 2: { id: 2, name: 'zombie', position: new Vec3(15, 63, 0) } }, [[2, gap(17, 15, 2500)]]);
    expect(losingPursuit(far)).toBeNull();                                   // 0.8 m/s: 16 seconds off
    const brief = botFixture({ 2: { id: 2, name: 'creeper', position: new Vec3(6, 63, 0) } }, [[2, gap(8, 6, 1000)]]);
    expect(losingPursuit(brief)).toBeNull();
    const animal = botFixture({ 2: { id: 2, name: 'cow', position: new Vec3(6, 63, 0) } }, [[2, gap(12, 6, 2500)]]);
    expect(losingPursuit(animal)).toBeNull();
  });

  it('chooses by what is measured: one blow that can take all the health is fended off, an ordinary hitter in reach is fought', () => {
    const stats = seedCombatStats();
    expect(counterFor({ maxHit: stats.mobs.creeper.maxHit, health: 14, armed: true, fightFavoured: false, distance: 3, contactReach: 4 })).toBe('fend');
    expect(counterFor({ maxHit: stats.mobs.zombie.maxHit, health: 14, armed: true, fightFavoured: true, distance: 3.5, contactReach: 4 })).toBe('fight');
    // Not yet in reach: it is kept off rather than walked up to.
    expect(counterFor({ maxHit: stats.mobs.zombie.maxHit, health: 14, armed: true, fightFavoured: true, distance: 6, contactReach: 4 })).toBe('fend');
    // A zombie's blow is a burst for a body at three health.
    expect(counterFor({ maxHit: stats.mobs.zombie.maxHit, health: 3, armed: true, fightFavoured: true, distance: 3, contactReach: 4 })).toBe('fend');
  });
});

describe('a losing escape gives way to the answer for what is coming', () => {
  function emergency(bot: any) {
    const runtime: any = { isReady: () => true, isRunning: () => true, isInEmergencyMode: () => true, currentState: { recoveryStatus: 'idle' } };
    const system: any = new EventReactionSystem(bot, runtime, settings);
    system.reflexPolicy = null;
    system.hostileContainmentActive = true;
    system.fleeController = new AbortController();
    return system;
  }

  it('the L110 creeper: the body turns to fend it off instead of running on', () => {
    const bot = botFixture({ 2: { id: 2, name: 'creeper', position: new Vec3(8.2, 63, 0) } }, [[2, gap(12.2, 8.2, 2500)]]);
    const system = emergency(bot);
    const fend = vi.spyOn(system, 'runFendOff').mockResolvedValue(undefined);
    const fight = vi.spyOn(system, 'runCorneredCounterattack').mockResolvedValue(undefined);
    system.checkLosingRace();
    expect(fend).toHaveBeenCalledWith(bot.entities[2], 'wooden_pickaxe', 'keep-off');
    expect(fight).not.toHaveBeenCalled();
    system.destroy();
  });

  it('a zombie catching an armed body is struck before its first blow lands', () => {
    const bot = botFixture({ 2: { id: 2, name: 'zombie', position: new Vec3(3.5, 63, 0) } }, [[2, gap(8, 3.5, 2000)]]);
    const system = emergency(bot);
    const fend = vi.spyOn(system, 'runFendOff').mockResolvedValue(undefined);
    const fight = vi.spyOn(system, 'runCorneredCounterattack').mockResolvedValue(undefined);
    system.checkLosingRace();
    expect(fight).toHaveBeenCalledWith(bot.entities[2], 'wooden_pickaxe', expect.any(String));
    expect(fend).not.toHaveBeenCalled();
    system.destroy();
  });

  it('nothing changes while the run holds the gap, or when the body is not running (sealed in, or the planner holds it)', () => {
    const holding = botFixture({ 2: { id: 2, name: 'creeper', position: new Vec3(9, 63, 0) } }, [[2, gap(9.2, 9, 2500)]]);
    const system = emergency(holding);
    const fend = vi.spyOn(system, 'runFendOff').mockResolvedValue(undefined);
    system.checkLosingRace();
    expect(fend).not.toHaveBeenCalled();
    system.destroy();
    const standing = botFixture({ 2: { id: 2, name: 'creeper', position: new Vec3(8.2, 63, 0) } }, [[2, gap(12.2, 8.2, 2500)]]);
    const still = emergency(standing);
    still.fleeController = null;
    const none = vi.spyOn(still, 'runFendOff').mockResolvedValue(undefined);
    still.checkLosingRace();
    expect(none).not.toHaveBeenCalled();
    still.destroy();
  });

  it('fending off: faces it, backs away, strikes it within a blow (knocking it back), and lets go once it is beyond the fuse', async () => {
    const creeper: any = { id: 2, name: 'creeper', height: 1.7, position: new Vec3(2.8, 63, 0) };
    const bot = botFixture({ 2: creeper });
    const controls = new Map<string, boolean>();
    let backedAway = false;
    bot.setControlState = (control: string, state: boolean) => { controls.set(control, state); if (control === 'back' && state) backedAway = true; };
    bot.clearControlStates = () => controls.clear();
    bot.equip = vi.fn(async () => {});
    bot.lookAt = vi.fn(async () => {
      // Each tick: backing away moves the body 0.25 west; the creeper comes on 0.15.
      if (controls.get('back')) bot.entity.position = bot.entity.position.offset(-0.25, 0, 0);
      creeper.position = creeper.position.offset(-0.15, 0, 0);
    });
    let engagedDuringFend = false;
    bot.attack = vi.fn(() => { engagedDuringFend = isEngaged(bot); creeper.position = creeper.position.offset(3, 0, 0); });
    const system = emergency(bot);
    system.fleeController = null;
    system.swingIntervalMs = 10;
    system.learningNote = vi.fn();
    vi.spyOn(system, 'startContinuousFlee').mockImplementation(() => {});
    await system.runFendOff(creeper, 'wooden_pickaxe');
    expect(bot.attack).toHaveBeenCalled();
    expect(engagedDuringFend).toBe(true);                                    // the shield's guard is on between blows
    expect(backedAway).toBe(true);
    expect(controls.get('back')).toBeUndefined();                            // released at the end
    expect(bot.lookAt).toHaveBeenCalled();
    expect(system.learningNote).toHaveBeenCalledWith('fend_off_outcome', expect.objectContaining({ outcome: 'clear' }), expect.any(String));
    expect(system.fendRunning).toBe(false);
    expect(isEngaged(bot)).toBe(false);
    system.destroy();
  });
});

describe('an escape with a pursuer near does not stop to lay blocks', () => {
  const registry = minecraftData('1.21.11');
  const movementsBot = (entities: Record<number, any>) => {
    const installed: any[] = [];
    const bot = botFixture(entities);
    Object.assign(bot, { version: '1.21.11', registry, pathfinder: { stop: vi.fn(), setGoal: vi.fn(), isMoving: () => true, setMovements: (m: any) => installed.push(m) } });
    return { bot, installed };
  };

  it('setMovements can close block-laying to a route', () => {
    const { bot, installed } = movementsBot({});
    setMovements(bot);
    expect(installed[0].scafoldingBlocks.length).toBeGreaterThan(0);
    setMovements(bot, false, true, true, true, true, true, 1, false, true, 4, 10, false);
    expect(installed[1].scafoldingBlocks).toEqual([]);
  });

  it('the native escape judges it again as the pursuer comes: allowed at 14 m, closed at 6 m (L110 began at 14 m and bridged with a creeper at 5 m)', async () => {
    const zombie: any = { id: 2, name: 'zombie', position: new Vec3(14, 63, 0) };
    const { bot, installed } = movementsBot({ 2: zombie });
    const system: any = new EventReactionSystem(bot, { isReady: () => true, isInEmergencyMode: () => true } as any, settings);
    await executeAction(bot, 'flee-from', 5_000, async () => {
      system.updateFleeDirection();
      zombie.position = new Vec3(13, 63, 0);
      system.updateFleeDirection();
      zombie.position = new Vec3(6, 63, 0);
      system.updateFleeDirection();
      return { success: true, result: 'done' };
    }, { priority: 200 });
    expect(installed).toHaveLength(2);
    expect(installed[0].scafoldingBlocks.length).toBeGreaterThan(0);
    expect(installed[0].canDig).toBe(true);
    expect(installed[1].scafoldingBlocks).toEqual([]);
    expect(installed[1].canDig).toBe(false);
    expect(bot.pathfinder.setGoal).toHaveBeenCalledTimes(2);                // the route is planned again on the change
    system.destroy();
  });
});

describe('the answer to a losing race holds until the gap has really opened, and a pursuer that keeps coming is met (paid run L111)', () => {
  function emergency(bot: any) {
    const runtime: any = { isReady: () => true, isRunning: () => true, isInEmergencyMode: () => true, currentState: { recoveryStatus: 'idle' } };
    const system: any = new EventReactionSystem(bot, runtime, settings);
    system.reflexPolicy = null;
    system.hostileContainmentActive = true;
    system.fleeController = new AbortController();
    return system;
  }
  const armed = () => [{ name: 'stone_sword', count: 1 }, { name: 'iron_pickaxe', count: 1 }];

  it('a zombie fended off at 8.3 m is left alone at that distance for a while; nearer, it is answered again, and met this time', async () => {
    const zombie: any = { id: 2, name: 'zombie', position: new Vec3(8.3, 63, 0) };
    const bot = botFixture({ 2: zombie }, [[2, gap(15.8, 8.3, 2500)]]);
    bot.health = 20;
    bot.inventory = { items: armed, slots: [] };
    const system = emergency(bot);
    const fend = vi.spyOn(system, 'runFendOff').mockResolvedValue(undefined);
    system.checkLosingRace();
    expect(fend).toHaveBeenLastCalledWith(zombie, 'stone_sword', 'keep-off');
    await new Promise(resolve => setTimeout(resolve, 0));
    system.fendRunning = false;
    // L111 01:03:16: the run lost again 0.3 s later at 8.3 m. Not an answer again yet.
    system.checkLosingRace();
    expect(fend).toHaveBeenCalledTimes(1);
    // It comes nearer than it was when it was answered: this pursuer is not shaken off by running, and the race favours the body.
    zombie.position = new Vec3(6, 63, 0);
    bot.threatMotion.samples.set(2, gap(9, 6, 2500));
    system.checkLosingRace();
    expect(fend).toHaveBeenCalledTimes(2);
    expect(fend).toHaveBeenLastCalledWith(zombie, 'stone_sword', 'meet');
    system.destroy();
  });

  it('a hit since the last answer ends the pause', async () => {
    const zombie: any = { id: 2, name: 'zombie', position: new Vec3(8.3, 63, 0) };
    const bot = botFixture({ 2: zombie }, [[2, gap(15.8, 8.3, 2500)]]);
    bot.health = 20;
    const system = emergency(bot);
    const fend = vi.spyOn(system, 'runFendOff').mockResolvedValue(undefined);
    system.checkLosingRace();
    await new Promise(resolve => setTimeout(resolve, 0));
    bot.health = 17;
    system.checkLosingRace();
    expect(fend).toHaveBeenCalledTimes(2);
    system.destroy();
  });

  it('a fend-off begun at 8.3 m does not end at once: only past 11.3 m and with the gap opening', async () => {
    const zombie: any = { id: 2, name: 'zombie', height: 1.95, position: new Vec3(8.3, 63, 0) };
    const bot = botFixture({ 2: zombie });
    const controls = new Map<string, boolean>();
    bot.setControlState = (control: string, state: boolean) => controls.set(control, state);
    bot.clearControlStates = () => controls.clear();
    bot.equip = vi.fn(async () => {});
    bot.attack = vi.fn();
    bot.lookAt = vi.fn(async () => {
      if (controls.get('back')) bot.entity.position = bot.entity.position.offset(-0.25, 0, 0);
      zombie.position = zombie.position.offset(-0.12, 0, 0);
    });
    const system = emergency(bot);
    system.fleeController = null;
    system.learningNote = vi.fn();
    vi.spyOn(system, 'startContinuousFlee').mockImplementation(() => {});
    await system.runFendOff(zombie, 'stone_sword');
    const [, record] = system.learningNote.mock.calls.find((call: any[]) => call[0] === 'fend_off_outcome');
    expect(record.outcome).toBe('clear');
    expect(bot.entity.position.distanceTo(zombie.position)).toBeGreaterThanOrEqual(11.3);
    expect(record.elapsedMs).toBeGreaterThan(1000);
    system.destroy();
  });

  it('meeting a pursuer: the body stands (no backing away), lets it come, and strikes it in reach', async () => {
    const zombie: any = { id: 2, name: 'zombie', height: 1.95, position: new Vec3(5, 63, 0) };
    const bot = botFixture({ 2: zombie });
    let backedAway = false;
    bot.setControlState = (control: string, state: boolean) => { if (control === 'back' && state) backedAway = true; };
    bot.equip = vi.fn(async () => {});
    let hits = 0;
    bot.attack = vi.fn(() => { if (++hits >= 3) delete bot.entities[2]; });
    bot.lookAt = vi.fn(async () => { if (zombie.position.x > 2) zombie.position = zombie.position.offset(-0.3, 0, 0); });
    const system = emergency(bot);
    system.fleeController = null;
    system.swingIntervalMs = 10;
    system.learningNote = vi.fn();
    vi.spyOn(system, 'startContinuousFlee').mockImplementation(() => {});
    await system.runFendOff(zombie, 'stone_sword', 'meet');
    expect(backedAway).toBe(false);
    expect(bot.attack).toHaveBeenCalledTimes(3);
    expect(system.learningNote).toHaveBeenCalledWith('fend_off_outcome', expect.objectContaining({ outcome: 'defeated_or_gone' }), expect.any(String));
    system.destroy();
  });
});

describe('the weapon is chosen by time and wear, as tools are (paid run L111: the iron pickaxe swung at zombies with a stone sword carried)', () => {
  const wear = (item: string) => wearCostSeconds({ name: item, maxDurability: 1 });

  it('a stone sword that kills nearly as fast is used before the iron pickaxe; without wear the fastest wins as before', () => {
    const options = [{ name: 'iron_pickaxe', killMs: 3300 }, { name: 'stone_sword', killMs: 3500 }];
    expect(chooseWeapon(options, { timeToDieMs: Infinity, wearCost: wear })!.name).toBe('stone_sword');
    expect(chooseWeapon(options, { timeToDieMs: Infinity })!.name).toBe('iron_pickaxe');
    expect(wearPerHit('stone_sword')).toBe(1);
    expect(wearPerHit('iron_pickaxe')).toBe(2);
  });

  it('when the race is tight, the fastest is used whatever it costs', () => {
    const options = [{ name: 'iron_pickaxe', killMs: 3300 }, { name: 'stone_sword', killMs: 3500 }];
    expect(chooseWeapon(options, { timeToDieMs: 5100, wearCost: wear })!.name).toBe('iron_pickaxe');
    // Much slower is not "nearly as fast": a wooden sword at 9 s is not chosen over an iron pickaxe at 3.3 s.
    expect(chooseWeapon([{ name: 'iron_pickaxe', killMs: 3300 }, { name: 'wooden_sword', killMs: 9000 }], { timeToDieMs: Infinity, wearCost: wear })!.name).toBe('iron_pickaxe');
  });

  it('the encounter estimate (the counterattack, the fend-off, the emergency odds) chooses the same way', () => {
    const stats = seedCombatStats();
    // Measured as in L111: iron pickaxe about 3.3 s on a zombie, stone sword about 3.5 s.
    stats.weapons['iron_pickaxe|zombie'] = { fights: 4, kills: 4, killMs: 12_320 };
    stats.weapons['stone_sword|zombie'] = { fights: 4, kills: 4, killMs: 15_000 };
    const input = { target: 'zombie', health: 20, threats: [{ name: 'zombie', distance: 7 }], carried: ['iron_pickaxe', 'stone_sword'], escapeFailing: true };
    expect(estimateEncounter(stats, input).weapon).toBe('iron_pickaxe');
    const worn = estimateEncounter(stats, { ...input, wearCost: wear });
    expect(worn.weapon).toBe('stone_sword');
    expect(worn.timeToKillMs).toBeCloseTo(3500, -1);
  });
});
