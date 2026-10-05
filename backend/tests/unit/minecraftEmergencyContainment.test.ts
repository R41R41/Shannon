import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import { EventReactionSystem } from '../../src/services/minebot/eventReaction/EventReactionSystem.js';
import { MAX_HOSTILE_CLEAR_RADIUS, validateGoalContract } from '../../src/services/minebot/cognition/GoalVerifier.js';

const settings: any = { reactions: [], hostileDetection: {
  criticalDistance: 8, detectionDistance: 16, multiMobCriticalCount: 2,
} };

function botFixture(): any {
  return Object.assign(new EventEmitter(), {
    entity: { id: 1, position: new Vec3(0, 64, 0) },
    entities: { 2: { id: 2, name: 'zombie', position: new Vec3(7, 64, 0) },
      3: { id: 3, name: 'skeleton', position: new Vec3(0, 64, 12.2) } },
    health: 20, food: 20, game: { dimension: 'overworld' },
    inventory: { items: () => [{ name: 'bread', count: 1 }], slots: [] },
    instantSkills: { getSkill: (name: string) => ['flee-from', 'use-item', 'move-to', 'set-shield'].includes(name) ? {} : undefined,
      getSkills: () => [] },
    constantSkills: { getSkills: () => [] },
    pathfinder: { stop: vi.fn(), setGoal: vi.fn() }, clearControlStates: vi.fn(),
    oxygenLevel: 20, blockAt: () => ({ name: 'air', boundingBox: 'empty' }),
  });
}

function systemFixture(bot = botFixture()): { system: any; bot: any } {
  const runtime: any = {};
  const system: any = new EventReactionSystem(bot, runtime, settings);
  system.reflexPolicy = null;
  return { system, bot };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('hostile emergency containment ownership', () => {
  it('retains multi-threat escape during queries, bread use, or single-target flee; group flee takes over', () => {
    const { system } = systemFixture();
    const containment = new AbortController();
    system.fleeController = containment;
    system.onEmergencyToolStarting('get-position', {}, true);
    system.onEmergencyToolStarting('use-item', { itemName: 'bread' }, true);
    expect(containment.signal.aborted).toBe(false);

    const args = { target: 'zombie' };
    system.onEmergencyToolStarting('flee-from', args, true);
    expect(args.target).toBe('zombie');
    expect(containment.signal.aborted).toBe(false);
    system.onEmergencyToolStarting('flee-from', { target: 'hostile' }, true);
    expect(containment.signal.aborted).toBe(true);
    expect(system.fleeController).toBeNull();
  });

  it('reacquires containment between tools in one batch until a viable next action starts', () => {
    const { system } = systemFixture();
    const restart = vi.spyOn(system, 'startContinuousFlee').mockImplementation(() => {
      system.fleeController = new AbortController();
    });
    system.handedOffTool = 'flee-from';
    system.onEmergencyToolFinished({ tool: 'flee-from', args: { target: 'hostile' }, iteration: 1,
      durationMs: 1, success: true, result: 'retreated' }, true);
    expect(restart).toHaveBeenCalledOnce();
    const containment = system.fleeController as AbortController;
    system.onEmergencyToolStarting('use-item', { itemName: 'bread' }, true);
    expect(containment.signal.aborted).toBe(false);
    system.onEmergencyToolStarting('flee-from', { target: 'hostile' }, true);
    expect(containment.signal.aborted).toBe(true);
  });

  it('takes a hit the server names a mob for as an attack when nothing else would have raised it (paid run L77e: a ghast\'s fireballs were "minor damage")', () => {
    const { system } = systemFixture();
    const now = Date.now();
    system.lastHurt = { at: now, source: 'ghast', from: 27.1 };
    expect(system.attackerBeyondWatch(now + 10)).toBe('ghast');           // listed, but far beyond the watch
    system.lastHurt = { at: now, source: 'zombie', from: 2 };
    expect(system.attackerBeyondWatch(now + 10)).toBeNull();               // the approach watch already has it
    system.lastHurt = { at: now, source: 'piglin', from: 2 };
    expect(system.attackerBeyondWatch(now + 10)).toBe('piglin');          // near, but a kind the list does not know
    expect(system.attackerBeyondWatch(now + 2000)).toBeNull();             // an old hit says nothing of this one
    system.lastHurt = { at: now, source: null };
    expect(system.attackerBeyondWatch(now + 10)).toBeNull();               // a fall, fire: no one to name
  });

  it('leaves the body where it is building while more of the same response is to come (paid run L78 chased its own wall)', () => {
    const { system } = systemFixture();
    const restart = vi.spyOn(system, 'startContinuousFlee').mockImplementation(() => {});
    const placed = { tool: 'place-block-at', args: { blockName: 'cobblestone', x: 1, y: 64, z: 0 }, iteration: 1, durationMs: 1, result: 'placed' };
    system.handedOffTool = 'place-block-at';
    system.onEmergencyToolFinished({ ...placed, success: true, moreInResponse: true }, true);
    expect(restart).not.toHaveBeenCalled();
    expect(system.handedOffTool).toBe('place-block-at');
    // The last of them, or one that failed, gives the body back to the escape.
    system.onEmergencyToolFinished({ ...placed, success: true, moreInResponse: false }, true);
    expect(restart).toHaveBeenCalledTimes(1);
    system.handedOffTool = 'place-block-at';
    system.onEmergencyToolFinished({ ...placed, success: false, moreInResponse: true }, true);
    expect(restart).toHaveBeenCalledTimes(2);
    // An escape that travels is not held: the next action of the response starts from wherever it ended.
    system.handedOffTool = 'flee-from';
    system.onEmergencyToolFinished({ tool: 'flee-from', args: { target: 'hostile' }, iteration: 2, durationMs: 1, success: true, result: 'retreated', moreInResponse: true }, true);
    expect(restart).toHaveBeenCalledTimes(3);
  });

  it('restarts containment after a failed takeover or a successful move that leaves another hostile nearby', () => {
    const { system } = systemFixture();
    const restart = vi.spyOn(system, 'startContinuousFlee').mockImplementation(() => {});
    system.handedOffTool = 'flee-from';
    system.onEmergencyToolFinished({ tool: 'flee-from', args: {}, iteration: 1,
      durationMs: 1, success: false, result: 'no path' }, true);
    expect(restart).toHaveBeenCalledTimes(1);
    system.handedOffTool = 'move-to';
    system.onEmergencyToolFinished({ tool: 'move-to', args: {}, iteration: 2,
      durationMs: 1, success: true, result: 'arrived' }, true);
    expect(restart).toHaveBeenCalledTimes(2);
    system.onEmergencyToolFinished({ tool: 'flee-from', args: { target: 'invalid' }, iteration: 3,
      durationMs: 1, success: false, result: 'target not found' }, true);
    expect(restart).toHaveBeenCalledTimes(3);
  });

  it('requires stable native clearance and has a bounded wait', async () => {
    vi.useFakeTimers();
    const { system, bot } = systemFixture();
    const wait = system.waitForStableHostileClearance(16);
    await vi.advanceTimersByTimeAsync(300);
    bot.entities = {};
    await vi.advanceTimersByTimeAsync(300);
    bot.entities = { 4: { id: 4, name: 'creeper', position: new Vec3(0, 64, 12.2) } };
    await vi.advanceTimersByTimeAsync(300);
    bot.entities = {};
    // Advance past the stability window and the polling boundary. Awaiting
    // the promise exactly at 600ms can strand the test on a pending fake timer.
    await vi.advanceTimersByTimeAsync(800);
    expect(await wait).toBe(true);

    bot.entities = { 5: { id: 5, name: 'skeleton', position: new Vec3(3, 64, 0) } };
    const blocked = system.waitForStableHostileClearance(16);
    await vi.advanceTimersByTimeAsync(2_100);
    expect(await blocked).toBe(false);
  });

  it('renews an expired hostile containment lease at tick cadence, only while danger remains', async () => {
    vi.useFakeTimers();
    const { system, bot } = systemFixture();
    system.hostileContainmentActive = true;
    const restart = vi.spyOn(system, 'startContinuousFlee').mockImplementation(() => {
      system.fleeController = new AbortController();
    });
    system.scheduleHostileContainmentRenewal();
    await vi.advanceTimersByTimeAsync(299);
    expect(restart).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(restart).toHaveBeenCalledOnce();
    system.fleeController = null;
    bot.entities = {};
    system.scheduleHostileContainmentRenewal();
    await vi.advanceTimersByTimeAsync(600);
    expect(restart).toHaveBeenCalledOnce();
  });

  it('does not resume a completed emergency while a 12.2m creeper remains', async () => {
    const bot = botFixture();
    const runtime: any = { isReady: () => true, isRunning: () => true,
      isInEmergencyMode: () => false,
      interruptForEmergency: vi.fn(async () => {}), setEmergencyTask: vi.fn(),
      invoke: vi.fn(async () => ({ taskTree: { status: 'completed' } })),
      resumePreviousTask: vi.fn(async () => {}) };
    const system: any = new EventReactionSystem(bot, runtime, settings);
    system.reflexPolicy = null;
    const flee = vi.spyOn(system, 'startContinuousFlee').mockImplementation(() => {});
    vi.spyOn(system, 'waitForStableHostileClearance').mockResolvedValue(false);

    const result = await system.handleEmergencyEvent({ timestamp: Date.now(), eventType: 'hostile_approach',
      threatLevel: 'critical', mobType: 'zombie', mobCount: 2,
      allHostiles: [{ mobType: 'zombie', distance: 7 }, { mobType: 'skeleton', distance: 12.2 }] });
    const input = runtime.invoke.mock.calls[0][0];
    expect(input.goalContract).toEqual({ goal: input.userMessage,
      predicates: [{ kind: 'hostiles_clear', radius: 16 }] });
    expect(result.handled).toBe(false);
    expect(runtime.resumePreviousTask).not.toHaveBeenCalled();
    expect(flee).toHaveBeenCalledTimes(2);
    system.destroy();
  });

  it('releases a paused main task after mobs depart without a new approach event', async () => {
    vi.useFakeTimers();
    const bot = botFixture();
    let emergencyMode = true;
    const runtime: any = { isInEmergencyMode: () => emergencyMode,
      resumePreviousTask: vi.fn(async () => { emergencyMode = false; }) };
    const system: any = new EventReactionSystem(bot, runtime, settings);
    system.hostileContainmentActive = true;
    vi.spyOn(system, 'startContinuousFlee').mockImplementation(() => {
      system.fleeController = new AbortController();
    });
    system.watchHostileRecovery(16);

    bot.entities = {};
    await vi.advanceTimersByTimeAsync(600);
    expect(runtime.resumePreviousTask).not.toHaveBeenCalled();
    bot.entities = { 4: { id: 4, name: 'creeper', position: new Vec3(0, 64, 12.2) } };
    await vi.advanceTimersByTimeAsync(300);
    expect(runtime.resumePreviousTask).not.toHaveBeenCalled();
    bot.entities = {};
    await vi.advanceTimersByTimeAsync(900);
    expect(runtime.resumePreviousTask).toHaveBeenCalledOnce();
    expect(system.hostileContainmentActive).toBe(false);
    system.destroy();
  });

  it('keeps low-health escape ownership across transient clearance and rearms on a warning', async () => {
    vi.useFakeTimers();
    const bot = botFixture();
    bot.health = 8;
    bot.entities = { 2: { id: 2, name: 'zombie', position: new Vec3(17, 64, 0) } };
    let emergencyMode = true;
    const runtime: any = { isInEmergencyMode: () => emergencyMode,
      currentState: { recoveryStatus: 'idle' },
      resumePreviousTask: vi.fn(async () => { emergencyMode = false; }) };
    const system: any = new EventReactionSystem(bot, runtime, settings);
    system.hostileContainmentActive = true;
    const flee = vi.spyOn(system, 'startContinuousFlee').mockImplementation(() => {
      system.fleeController = new AbortController();
    });
    system.watchHostileRecovery(16);

    await vi.advanceTimersByTimeAsync(900);
    expect(runtime.resumePreviousTask).not.toHaveBeenCalled();
    expect(system.hostileContainmentActive).toBe(true);
    bot.entities[2].position = new Vec3(14.8, 64, 0);
    const reaction = await system.handleHostileApproach({ timestamp: Date.now(),
      eventType: 'hostile_approach', threatLevel: 'warning', mobType: 'zombie', distance: 14.8, mobCount: 1,
      allHostiles: [{ mobType: 'zombie', distance: 14.8 }] });
    expect(reaction.reactionType).toBe('emergency');
    expect(flee).toHaveBeenCalledOnce();
    expect(runtime.resumePreviousTask).not.toHaveBeenCalled();

    bot.health = 20;
    bot.entities = {};
    await vi.advanceTimersByTimeAsync(900);
    expect(runtime.resumePreviousTask).toHaveBeenCalledOnce();
    expect(system.hostileContainmentActive).toBe(false);
    system.destroy();
  });

  it('steers but never restarts a running low-health escape on repeated poison damage ticks', async () => {
    // Paid run 2026-10-01: poison ticks restarted the flee every ~1.25s and
    // cancelled the planner's flee-from, so the bot stood still near a witch.
    const bot = botFixture();
    bot.health = 6;
    const runtime: any = { isReady: () => true, isInEmergencyMode: () => true,
      currentState: { recoveryStatus: 'idle' } };
    const system: any = new EventReactionSystem(bot, runtime, settings);
    const restart = vi.spyOn(system, 'startContinuousFlee').mockImplementation(() => {
      system.fleeController = new AbortController();
    });
    const steer = vi.spyOn(system, 'updateFleeDirection').mockImplementation(() => {});
    const tick = { timestamp: Date.now(), eventType: 'damage', damage: 1, damagePercent: 5, currentHealth: 6,
      consecutiveCount: 3, possibleSource: 'witch（約12m）' };

    const containment = new AbortController();
    system.fleeController = containment;
    for (let i = 0; i < 3; i++) await system.handleEmergencyEvent(tick);
    expect(restart).not.toHaveBeenCalled();
    expect(steer).toHaveBeenCalledTimes(3);
    expect(containment.signal.aborted).toBe(false);
    expect(bot.interruptExecution).toBeFalsy();

    // The planner's own group flee holds the lease: a tick must not cancel it.
    system.fleeController = null;
    system.onEmergencyToolStarting('flee-from', { target: 'hostile' }, true);
    expect(system.handedOffTool).toBe('flee-from');
    await system.handleEmergencyEvent(tick);
    expect(restart).not.toHaveBeenCalled();
    expect(bot.interruptExecution).toBeFalsy();

    // Nothing is escaping (e.g. a status query): restart native escape once.
    system.onEmergencyToolFinished({ tool: 'flee-from', args: { target: 'hostile' }, iteration: 1,
      durationMs: 1, success: false, result: 'interrupted' }, true);
    restart.mockClear();
    system.fleeController = null;
    system.handedOffTool = null;
    await system.handleEmergencyEvent(tick);
    expect(restart).toHaveBeenCalledOnce();
    system.destroy();
  });

  it('takes the body back from a planner escape that is not moving it (paid run L53: ten seconds afloat with no key pressed, a zombie on it)', async () => {
    vi.useFakeTimers();
    const bot = botFixture();
    bot.health = 7;
    const runtime: any = { isReady: () => true, isInEmergencyMode: () => true, currentState: { recoveryStatus: 'idle' } };
    const system: any = new EventReactionSystem(bot, runtime, settings);
    const restart = vi.spyOn(system, 'startContinuousFlee').mockImplementation(() => { system.fleeController = new AbortController(); });
    const hit = { timestamp: Date.now(), eventType: 'damage', damage: 3, damagePercent: 15, currentHealth: 7, consecutiveCount: 1, possibleSource: 'zombie（約2m）' };
    system.onEmergencyToolStarting('flee-from', { target: 'hostile' }, true);
    expect(system.handedOffTool).toBe('flee-from');

    // A hit just after the hand-off: the escape has had no time to get anywhere yet.
    await vi.advanceTimersByTimeAsync(1000);
    await system.handleEmergencyEvent(hit);
    expect(restart).not.toHaveBeenCalled();

    // The escape is travelling: each hit finds the body further on, and the planner keeps it.
    for (let step = 1; step <= 3; step++) {
      await vi.advanceTimersByTimeAsync(2000);
      bot.entity.position = new Vec3(-4 * step, 64, 0);
      await system.handleEmergencyEvent(hit);
    }
    expect(restart).not.toHaveBeenCalled();

    // Then it stops getting anywhere, and the hits go on.
    await vi.advanceTimersByTimeAsync(3000);
    await system.handleEmergencyEvent(hit);
    expect(restart).toHaveBeenCalledOnce();

    // Sealing into a shaft stands still by design: never taken back for lack of travel.
    restart.mockClear(); system.fleeController = null;
    system.handOff('dig-shelter');
    await vi.advanceTimersByTimeAsync(6000);
    await system.handleEmergencyEvent(hit);
    expect(restart).not.toHaveBeenCalled();
    system.destroy();
  });

  it('puts air before a distant pursuer when drowning during a hostile emergency', async () => {
    // Paid run 2026-10-01: a creeper emergency skipped drowning events and at
    // HP 8 restarted the underwater escape; the bot drowned 28m from the creeper.
    const bot = botFixture();
    bot.health = 6; bot.oxygenLevel = 2;
    bot.entity.isInWater = true;
    bot.blockAt = () => ({ name: 'water', boundingBox: 'empty' });
    const runtime: any = { isReady: () => true, isInEmergencyMode: () => true, currentState: { recoveryStatus: 'idle' } };
    const system: any = new EventReactionSystem(bot, runtime, settings);
    const swim = vi.spyOn(system, 'refreshSuffocationContainment').mockImplementation(() => {});
    const containment = new AbortController();
    system.fleeController = containment;
    const { executeAction } = await import('../../src/services/minebot/execution/ActionExecution.js');
    let releaseTask!: () => void;
    const task = executeAction(bot, 'mine-block', 0, () => new Promise(resolve => { releaseTask = () => resolve({ success: true, result: 'dug' }); }));
    await new Promise(resolve => setTimeout(resolve, 5));
    const result = await system.handleEmergencyEvent({ timestamp: Date.now(), eventType: 'suffocation',
      oxygen: 2, health: 6, isInWater: true });
    expect(result).toMatchObject({ handled: true, reactionType: 'emergency' });
    expect(containment.signal.aborted).toBe(true);
    expect(await task).toMatchObject({ success: false, failureType: 'interrupted' }); // the task loses the body
    releaseTask();
    expect(system.suffocationContainmentActive).toBe(true);
    expect(swim).toHaveBeenCalled();
    // A later low-HP damage tick keeps the breathing priority instead of re-fleeing underwater.
    system.startContinuousFlee();
    expect(system.fleeController).toBeNull();
    await system.handleEmergencyEvent({ timestamp: Date.now(), eventType: 'damage', damage: 2, damagePercent: 10,
      currentHealth: 4, consecutiveCount: 2, possibleSource: 'creeper（約28m）' });
    expect(system.fleeController).toBeNull();
    system.destroy();
  });

  it('does not cancel the planner group flee when another threat or warning arrives', async () => {
    // Paid run 2026-10-01: each creeper approach restarted native escape and interrupted flee-from three times.
    const bot = botFixture();
    const runtime: any = { isReady: () => true, isInEmergencyMode: () => true, currentState: { recoveryStatus: 'idle' } };
    const system: any = new EventReactionSystem(bot, runtime, settings);
    const restart = vi.spyOn(system, 'startContinuousFlee').mockImplementation(() => {});
    system.hostileContainmentActive = true;
    system.onEmergencyToolStarting('flee-from', { target: 'hostile' }, true);
    const approach = (threatLevel: string) => ({ timestamp: Date.now(), eventType: 'hostile_approach', threatLevel,
      mobType: 'creeper', distance: 12, mobCount: 2, allHostiles: [{ mobType: 'creeper', distance: 12 }] });
    await system.handleHostileApproach(approach('critical'));
    await system.handleHostileApproach(approach('warning'));
    expect(restart).not.toHaveBeenCalled();
    system.onEmergencyToolFinished({ tool: 'flee-from', args: { target: 'hostile' }, iteration: 1,
      durationMs: 1, success: true, result: 'retreated' }, true);
    restart.mockClear();
    await system.handleHostileApproach(approach('warning'));
    expect(restart).toHaveBeenCalledOnce();
    system.destroy();
  });

  it('retries a native walk to dry footing while stuck in water after the model gives up', async () => {
    // Paid run 2026-10-01: the bot bobbed in a walled pool for 80 minutes with the main task paused.
    vi.useFakeTimers();
    const bot = botFixture();
    bot.entities = {};
    bot.oxygenLevel = 15; bot.entity.isInWater = true;
    bot.blockAt = () => ({ name: 'water', boundingBox: 'empty' });
    let running = false;
    const runtime: any = { isInEmergencyMode: () => true, isRunning: () => running, currentState: { recoveryStatus: 'awaiting_user' } };
    const system: any = new EventReactionSystem(bot, runtime, settings);
    const escape = vi.spyOn(system, 'tryNativeBreathingEscape').mockResolvedValue(undefined);
    system.watchSuffocationRecovery();
    await vi.advanceTimersByTimeAsync(14_000);
    expect(escape).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(escape).toHaveBeenCalledOnce();
    running = true; // a model run owns the body: no native walk
    await vi.advanceTimersByTimeAsync(20_000);
    expect(escape).toHaveBeenCalledOnce();
    running = false; bot.oxygenLevel = 4; // auto-swim owns the body below 10 air
    await vi.advanceTimersByTimeAsync(20_000);
    expect(escape).toHaveBeenCalledOnce();
    bot.oxygenLevel = 20;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(escape).toHaveBeenCalledTimes(2);
    system.destroy();
  });

  it('digs the head block out when buried by falling sand instead of waiting for a swim reflex', async () => {
    // Paid run 2026-10-01: sand fell into the bot's head cell in its shelter; air stayed 20/20 and it suffocated.
    const bot = botFixture();
    bot.oxygenLevel = 20; bot.entity.isInWater = false;
    bot.blockAt = (pos: Vec3) => pos.y === 65 ? { name: 'sand', boundingBox: 'block', diggable: true, position: pos }
      : { name: 'air', boundingBox: 'empty', position: pos };
    const dig = vi.fn(async () => ({ success: true }));
    bot.instantSkills.getSkill = (name: string) => name === 'dig-block-at' ? { run: dig } : undefined;
    const system: any = new EventReactionSystem(bot, { isReady: () => true, isInEmergencyMode: () => true } as any, settings);
    system.suffocationContainmentActive = true;
    system.refreshSuffocationContainment();
    system.refreshSuffocationContainment(); // one dig at a time
    // The dig takes the body through the action lease, on the survival rank, so nothing below can cancel it.
    await vi.waitFor(() => expect(dig).toHaveBeenCalledOnce());
    expect(dig).toHaveBeenCalledWith(0, 65, 0, false);
    // Suffocation damage ticks during the dig must not interrupt it (paid run: buried 16 minutes in gravel).
    bot.interruptExecution = false;
    await system.handleEmergencyEvent({ timestamp: Date.now(), eventType: 'suffocation', oxygen: 20, health: 6, isInWater: false });
    expect(bot.interruptExecution).toBe(false);
    system.destroy();
  });

  it('returns control to the main planner as soon as the bot breathes at the surface, even while it stays in water', async () => {
    vi.useFakeTimers();
    const bot = botFixture();
    bot.oxygenLevel = 20; bot.entity.isInWater = true;
    bot.blockAt = (pos: Vec3) => pos.y >= 65 ? { name: 'air', boundingBox: 'empty' } : { name: 'water', boundingBox: 'empty' };
    const runtime: any = { isInEmergencyMode: () => true, isRunning: () => false,
      resumePreviousTask: vi.fn(async () => {}), currentState: { recoveryStatus: 'awaiting_user' } };
    const system: any = new EventReactionSystem(bot, runtime, settings);
    vi.spyOn(system, 'tryNativeBreathingEscape').mockResolvedValue(undefined);
    system.suffocationContainmentActive = true;
    system.watchSuffocationRecovery();
    // Paid runs waited here for dry footing: up to 80 minutes in a walled pool, and to the death in open water (L21).
    await vi.advanceTimersByTimeAsync(3_000);
    expect(runtime.resumePreviousTask).toHaveBeenCalledOnce();
    expect(system.suffocationContainmentActive).toBe(false);
    system.destroy();
  });

  it('gives an emergency with no pursuer and no drowning an end the body can vouch for (paid run L61 could not complete a hunger emergency)', async () => {
    const bot = botFixture();
    bot.health = 7; bot.food = 4; bot.entities = {};
    const runtime: any = { isReady: () => true, isRunning: () => true, isInEmergencyMode: () => false,
      interruptForEmergency: vi.fn(async () => {}), setEmergencyTask: vi.fn(),
      invoke: vi.fn(async () => ({ taskTree: { status: 'completed' } })),
      resumePreviousTask: vi.fn(async () => {}) };
    const system: any = new EventReactionSystem(bot, runtime, settings);
    system.reflexPolicy = null;
    const result = await system.handleEmergencyEvent({ timestamp: Date.now(), eventType: 'damage', damage: 1, damagePercent: 5,
      currentHealth: 7, consecutiveCount: 1, possibleSource: 'unknown' });
    const input = runtime.invoke.mock.calls[0][0];
    // Nothing harming the body now is what such an emergency can settle; the missing food is the main task's.
    expect(input.goalContract).toEqual({ goal: input.userMessage,
      predicates: [{ kind: 'breathing_safe' }, { kind: 'hostiles_clear', radius: 16 }] });
    expect(result.handled).toBe(true);
    expect(runtime.resumePreviousTask).toHaveBeenCalledOnce();
    system.destroy();
  });

  it('hands a starving low-HP bot back to an available planner after the area stays clear', async () => {
    // Paid run 2026-10-01: HP 0.5 with no food could never exceed 8, and the campaign stayed paused 15+ minutes.
    vi.useFakeTimers();
    const bot = botFixture();
    bot.health = 0.5; bot.entities = {};
    const runtime: any = { isReady: () => true, isInEmergencyMode: () => true, isRunning: () => false,
      currentState: { recoveryStatus: 'idle' }, resumePreviousTask: vi.fn(async () => {}) };
    const system: any = new EventReactionSystem(bot, runtime, settings);
    vi.spyOn(system, 'startContinuousFlee').mockImplementation(() => {});
    system.hostileContainmentActive = true;
    system.watchHostileRecovery(16);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(runtime.resumePreviousTask).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(7_000);
    expect(runtime.resumePreviousTask).toHaveBeenCalledOnce();
    system.destroy();
  });

  it('returns control to the main planner when hostiles loiter for minutes without landing damage', async () => {
    // Paid run 2026-10-01: a creeper outside the shelter kept the campaign paused after the emergency model gave up.
    vi.useFakeTimers();
    const bot = botFixture(); // zombie at 7m, skeleton at 12.2m
    const runtime: any = { isReady: () => true, isInEmergencyMode: () => true, isRunning: () => false,
      currentState: { recoveryStatus: 'awaiting_user' }, resumePreviousTask: vi.fn(async () => {}) };
    const system: any = new EventReactionSystem(bot, runtime, settings);
    vi.spyOn(system, 'startContinuousFlee').mockImplementation(() => { system.fleeController = new AbortController(); });
    system.hostileContainmentActive = true;
    system.watchHostileRecovery(16);
    await vi.advanceTimersByTimeAsync(170_000);
    system.lastDamageAt = Date.now(); // a hit at 170s: needs a quiet minute after it
    await vi.advanceTimersByTimeAsync(30_000);
    expect(runtime.resumePreviousTask).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(35_000);
    expect(runtime.resumePreviousTask).toHaveBeenCalledOnce();
    expect(system.hostileContainmentActive).toBe(false);
    system.destroy();
  });

  it('treats a witch inside its potion range as critical before the melee radius', () => {
    const bot = botFixture();
    bot.entities = { 4: { id: 4, name: 'witch', position: new Vec3(9.5, 64, 0) } };
    const system: any = new EventReactionSystem(bot, {} as any, settings);
    expect(system.combat.checkHostileApproach()?.threatLevel).toBe('critical');
    bot.entities = { 5: { id: 5, name: 'zombie', position: new Vec3(9.5, 64, 0) } };
    const other: any = new EventReactionSystem(bot, {} as any, settings);
    expect(other.combat.checkHostileApproach()?.threatLevel).toBe('warning');
    system.destroy(); other.destroy();
  });

  it('holds containment when the planner is awaiting help, then resumes only after it is available', async () => {
    vi.useFakeTimers();
    const bot = botFixture();
    bot.entities = {};
    let emergencyMode = true;
    const runtime: any = { isInEmergencyMode: () => emergencyMode,
      currentState: { recoveryStatus: 'awaiting_user' },
      resumePreviousTask: vi.fn(async () => { emergencyMode = false; }) };
    const system: any = new EventReactionSystem(bot, runtime, settings);
    system.hostileContainmentActive = true;
    vi.spyOn(system, 'startContinuousFlee').mockImplementation(() => {});
    system.watchHostileRecovery(16);
    await vi.advanceTimersByTimeAsync(900);
    expect(runtime.resumePreviousTask).not.toHaveBeenCalled();
    expect(system.hostileContainmentActive).toBe(true);

    runtime.currentState.recoveryStatus = 'idle';
    await vi.advanceTimersByTimeAsync(900);
    expect(runtime.resumePreviousTask).toHaveBeenCalledOnce();
    system.destroy();
  });

  it('promotes a warning to native emergency when no planner can take it, but keeps healthy warnings as tasks', async () => {
    const bot = botFixture();
    const runtime: any = { currentState: { recoveryStatus: 'awaiting_user' },
      isInEmergencyMode: () => false };
    const system: any = new EventReactionSystem(bot, runtime, settings);
    const emergency = vi.spyOn(system, 'handleEmergencyEvent').mockResolvedValue({
      handled: true, reactionType: 'emergency',
    });
    const task = vi.spyOn(system, 'handleTaskEvent').mockResolvedValue({
      handled: true, reactionType: 'task',
    });
    vi.spyOn(system, 'isIdle').mockReturnValue(true);
    const warning = { timestamp: Date.now(), eventType: 'hostile_approach', threatLevel: 'warning',
      mobType: 'zombie', distance: 14.8, mobCount: 1, allHostiles: [{ mobType: 'zombie', distance: 14.8 }] };
    expect((await system.handleHostileApproach(warning)).reactionType).toBe('emergency');
    expect(emergency).toHaveBeenCalledOnce();
    expect(task).not.toHaveBeenCalled();

    runtime.currentState.recoveryStatus = 'idle';
    expect((await system.handleHostileApproach(warning)).reactionType).toBe('task');
    expect(task).toHaveBeenCalledOnce();
    system.destroy();
  });

  it('keeps native escape after an emergency provider failure instead of idling on a pursuing warning', async () => {
    vi.useFakeTimers();
    const bot = botFixture();
    bot.entities = { 2: { id: 2, name: 'zombie', position: new Vec3(17, 64, 0) } };
    let emergencyMode = false;
    const runtime: any = {
      currentState: { recoveryStatus: 'idle' },
      isReady: () => true, isRunning: () => true, isInEmergencyMode: () => emergencyMode,
      interruptForEmergency: vi.fn(async () => {}),
      setEmergencyTask: vi.fn(() => { emergencyMode = true; }),
      invoke: vi.fn(async () => {
        runtime.currentState.recoveryStatus = 'awaiting_user';
        return { taskTree: { status: 'error' } };
      }),
      resumePreviousTask: vi.fn(async () => {}),
    };
    const system: any = new EventReactionSystem(bot, runtime, settings);
    system.reflexPolicy = null;
    const flee = vi.spyOn(system, 'startContinuousFlee').mockImplementation(() => {});
    const initial = await system.handleEmergencyEvent({ timestamp: Date.now(),
      eventType: 'hostile_approach', threatLevel: 'critical', mobType: 'zombie', distance: 7,
      mobCount: 1, allHostiles: [{ mobType: 'zombie', distance: 7 }] });
    expect(initial.handled).toBe(false);
    expect(bot.minebotControlState).toBe('emergency_reflect');
    expect(system.hostileContainmentActive).toBe(true);
    expect(flee).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(900);
    expect(runtime.resumePreviousTask).not.toHaveBeenCalled();

    bot.entities[2].position = new Vec3(14.8, 64, 0);
    const renewed = await system.handleHostileApproach({ timestamp: Date.now(),
      eventType: 'hostile_approach', threatLevel: 'warning', mobType: 'zombie', distance: 14.8,
      mobCount: 1, allHostiles: [{ mobType: 'zombie', distance: 14.8 }] });
    expect(renewed.reactionType).toBe('emergency');
    expect(flee).toHaveBeenCalledTimes(2);
    expect(runtime.resumePreviousTask).not.toHaveBeenCalled();
    system.destroy();
  });

  it('uses native hostile containment before the planner is connected and releases it after safe handoff', async () => {
    vi.useFakeTimers();
    const bot = botFixture();
    bot.entities = { 2: { id: 2, name: 'zombie', position: new Vec3(7, 64, 0) } };
    let ready = false;
    const runtime: any = { isReady: () => ready, isRunning: () => false,
      isInEmergencyMode: () => false, currentState: null,
      resumePreviousTask: vi.fn(async () => {}) };
    const system: any = new EventReactionSystem(bot, runtime, settings);
    const flee = vi.spyOn(system, 'startContinuousFlee').mockImplementation(() => {
      system.fleeController = new AbortController();
    });
    const result = await system.handleEmergencyEvent({ timestamp: Date.now(),
      eventType: 'hostile_approach', threatLevel: 'critical', mobType: 'zombie', distance: 7,
      mobCount: 1, allHostiles: [{ mobType: 'zombie', distance: 7 }] });
    expect(result.reactionType).toBe('emergency');
    expect(result.handled).toBe(true);
    expect(flee).toHaveBeenCalledOnce();
    expect(bot.minebotControlState).toBe('emergency_reflect');
    bot.entities = {};
    await vi.advanceTimersByTimeAsync(900);
    expect(system.hostileContainmentActive).toBe(true);
    expect(runtime.resumePreviousTask).not.toHaveBeenCalled();

    ready = true;
    await vi.advanceTimersByTimeAsync(900);
    expect(system.hostileContainmentActive).toBe(false);
    expect(bot.minebotControlState).toBe('idle');
    expect(runtime.resumePreviousTask).not.toHaveBeenCalled();
    system.destroy();
  });

  it('resumes without a model task-complete only after stable native hostile clearance', async () => {
    const bot = botFixture();
    bot.entities = {};
    const runtime: any = { isReady: () => true, isRunning: () => true,
      isInEmergencyMode: () => false,
      interruptForEmergency: vi.fn(async () => {}), setEmergencyTask: vi.fn(),
      invoke: vi.fn(async () => ({ taskTree: { status: 'in_progress' } })),
      resumePreviousTask: vi.fn(async () => {}) };
    const system: any = new EventReactionSystem(bot, runtime, settings);
    system.reflexPolicy = null;
    vi.spyOn(system, 'startContinuousFlee').mockImplementation(() => {});
    vi.spyOn(system, 'waitForStableHostileClearance').mockResolvedValue(true);

    const result = await system.handleEmergencyEvent({ timestamp: Date.now(), eventType: 'hostile_approach',
      threatLevel: 'critical', mobType: 'zombie', mobCount: 1,
      allHostiles: [{ mobType: 'zombie', distance: 7 }] });
    expect(result.handled).toBe(true);
    expect(runtime.resumePreviousTask).toHaveBeenCalledOnce();
    expect(system.hostileContainmentActive).toBe(false);
  });

  it('locks suffocation to breathing proof and does not resume at the existing position with oxygen 4/20', async () => {
    const bot = botFixture(); bot.entity.isInWater = false; bot.oxygenLevel = 4;
    const runtime: any = { isReady: () => true, isRunning: () => true, isInEmergencyMode: () => false,
      interruptForEmergency: vi.fn(async () => {}), setEmergencyTask: vi.fn(),
      invoke: vi.fn(async () => ({ taskTree: { status: 'completed' } })),
      resumePreviousTask: vi.fn(async () => {}) };
    const system: any = new EventReactionSystem(bot, runtime, settings);
    system.reflexPolicy = null;
    const flee = vi.spyOn(system, 'startContinuousFlee').mockImplementation(() => {});
    vi.spyOn(system, 'waitForStableBreathingClearance').mockResolvedValue(false);
    const watch = vi.spyOn(system, 'watchSuffocationRecovery').mockImplementation(() => {});

    const result = await system.handleEmergencyEvent({ timestamp: Date.now(), eventType: 'suffocation',
      oxygen: 4, health: 20, isInWater: false });
    const input = runtime.invoke.mock.calls[0][0];
    expect(input.userMessage).toContain('4/20');
    expect(input.goalContract).toEqual({ goal: input.userMessage, predicates: [{ kind: 'breathing_safe' }] });
    expect(result.handled).toBe(false);
    expect(runtime.resumePreviousTask).not.toHaveBeenCalled();
    expect(watch).toHaveBeenCalledOnce();
    expect(flee).not.toHaveBeenCalled();
  });

  it('resumes a suffocation emergency only after stable native recovery, without model task-complete', async () => {
    const bot = botFixture(); bot.entity.isInWater = false; bot.oxygenLevel = 20;
    const runtime: any = { isReady: () => true, isRunning: () => true, isInEmergencyMode: () => false,
      interruptForEmergency: vi.fn(async () => {}), setEmergencyTask: vi.fn(),
      invoke: vi.fn(async () => ({ taskTree: { status: 'in_progress' } })),
      resumePreviousTask: vi.fn(async () => {}) };
    const system: any = new EventReactionSystem(bot, runtime, settings);
    system.reflexPolicy = null;
    vi.spyOn(system, 'startContinuousFlee').mockImplementation(() => {});
    vi.spyOn(system, 'waitForStableBreathingClearance').mockResolvedValue(true);
    const result = await system.handleEmergencyEvent({ timestamp: Date.now(), eventType: 'suffocation',
      oxygen: 4, health: 20, isInWater: true });
    expect(result.handled).toBe(true);
    expect(runtime.resumePreviousTask).toHaveBeenCalledOnce();
  });

  it('native recovery watcher releases a paused suffocation task after sustained dry-land 400 reading', async () => {
    vi.useFakeTimers();
    const bot = botFixture(); bot.entity.isInWater = false; bot.oxygenLevel = 4;
    const runtime: any = { isInEmergencyMode: () => true, resumePreviousTask: vi.fn(async () => {}) };
    const system: any = new EventReactionSystem(bot, runtime, settings);
    system.watchSuffocationRecovery();
    await vi.advanceTimersByTimeAsync(600);
    expect(runtime.resumePreviousTask).not.toHaveBeenCalled();
    bot.oxygenLevel = 400;
    await vi.advanceTimersByTimeAsync(600);
    expect(runtime.resumePreviousTask).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    expect(runtime.resumePreviousTask).toHaveBeenCalledOnce();
    expect(system.suffocationRecoveryTimer).toBeNull();
  });

  it('keeps the breathing latch across queries, missing-item work, and Y-only moves, then promptly rearms a registered critical skill', async () => {
    vi.useFakeTimers();
    const bot = botFixture();
    bot.entity.isInWater = true;
    bot.oxygenLevel = 7;
    const skill: any = { skillName: 'fixture-critical-surface', status: true, isCritical: true,
      isLocked: false, priority: 12, wantsPreemption: () => bot.oxygenLevel < 10 };
    const requestExecution = vi.fn(async () => { skill.isLocked = true; });
    bot.constantSkills = { getSkills: () => [skill], requestExecution };
    bot.instantSkills.getSkill = (name: string) => ['move-to', 'tower-up', 'get-position'].includes(name) ? {} : undefined;
    const { system } = systemFixture(bot);
    system.startSuffocationContainment();
    expect(requestExecution).toHaveBeenCalledOnce();
    expect(system.suffocationContainmentActive).toBe(true);

    bot.oxygenLevel = 20;
    skill.isLocked = false;
    system.onEmergencyToolStarting('get-position', {}, false, true);
    system.onEmergencyToolStarting('tower-up', { height: 2, blockName: 'stone' }, false, true);
    system.onEmergencyToolFinished({ tool: 'tower-up', args: {}, iteration: 1,
      durationMs: 1, success: false, result: 'missing_item' }, false, true);
    system.onEmergencyToolStarting('move-to', { x: 0, y: 70, z: 0, goalType: 'y' }, false, true);
    system.onEmergencyToolFinished({ tool: 'move-to', args: {}, iteration: 2,
      durationMs: 1, success: true, result: 'y reached' }, false, true);
    expect(system._llmHasControl).toBe(false);
    expect(system.suffocationContainmentActive).toBe(true);
    expect(requestExecution).toHaveBeenCalledOnce();

    bot.oxygenLevel = 7;
    await vi.advanceTimersByTimeAsync(100);
    expect(requestExecution).toHaveBeenCalledTimes(2);
    system.destroy();
    expect(system.suffocationContainmentTimer).toBeNull();
  });

  it('lets a model lateral action use the motor after a critical capability yields, without treating temporary full air as clearance', async () => {
    vi.useFakeTimers();
    const bot = botFixture();
    bot.entity.isInWater = true;
    bot.oxygenLevel = 8;
    const skill: any = { skillName: 'fixture-critical-surface', status: true, isCritical: true,
      isLocked: false, priority: 12, wantsPreemption: () => bot.oxygenLevel < 10 };
    bot.constantSkills = { getSkills: () => [skill], requestExecution: vi.fn(async () => { skill.isLocked = true; }) };
    const { system } = systemFixture(bot);
    system.startSuffocationContainment();
    bot.oxygenLevel = 20;
    skill.isLocked = false;
    system.onEmergencyToolStarting('move-to', { x: 8, y: 64, z: 0, goalType: 'nearxz' }, false, true);
    expect(system.suffocationContainmentActive).toBe(true);
    expect(system._llmHasControl).toBe(false);
    expect(bot.constantSkills.requestExecution).toHaveBeenCalledOnce();
    system.destroy();
  });

  it('starts registered survival work before giving Luna nearby native dry-footing candidates, without fixing a route', async () => {
    const bot = botFixture();
    bot.entity.position = new Vec3(0.5, 64, 0.5);
    bot.entity.isInWater = true;
    bot.oxygenLevel = 7;
    bot.blockAt = (position: Vec3) => position.x === 0 && position.y === 63 && position.z === 2
      ? { name: 'sand', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' };
    const skill: any = { skillName: 'fixture-critical-surface', status: true, isCritical: true,
      isLocked: false, priority: 12, wantsPreemption: () => true };
    const requestExecution = vi.fn(async () => { skill.isLocked = true; });
    bot.constantSkills = { getSkills: () => [skill], requestExecution };
    bot.instantSkills.getSkill = (name: string) => name === 'find-dry-footholds' ? {} : undefined;
    const runtime: any = { isReady: () => true, isRunning: () => true, isInEmergencyMode: () => false,
      interruptForEmergency: vi.fn(async () => {}), setEmergencyTask: vi.fn(),
      invoke: vi.fn(async () => ({ taskTree: { status: 'in_progress' } })),
      resumePreviousTask: vi.fn(async () => {}) };
    const system: any = new EventReactionSystem(bot, runtime, settings);
    system.reflexPolicy = null;
    vi.spyOn(system, 'waitForStableBreathingClearance').mockResolvedValue(false);

    await system.handleEmergencyEvent({ timestamp: Date.now(), eventType: 'suffocation',
      oxygen: 7, health: 20, isInWater: true });
    const emergency = runtime.invoke.mock.calls[0][0];
    expect(requestExecution).toHaveBeenCalledOnce();
    expect(requestExecution.mock.invocationCallOrder[0]).toBeLessThan(runtime.invoke.mock.invocationCallOrder[0]);
    expect(emergency.userMessage).toContain('(0.5,64,2.5)');
    expect(emergency.userMessage).toContain('経路到達性');
    expect(emergency.userMessage).toContain('find-dry-footholds');
    expect(emergency.goalContract.predicates).toEqual([{ kind: 'breathing_safe' }]);
    system.destroy();
  });
});

describe('cornered counterattack against a lone melee pursuer', () => {
  function corneredFixture(entities: Record<number, any>, items = [{ name: 'iron_pickaxe' }, { name: 'stone_sword' }]) {
    const bot = botFixture();
    bot.entities = entities;
    bot.inventory = { items: () => items, slots: [] };
    bot.equip = vi.fn(async () => {});
    bot.lookAt = vi.fn(async () => {});
    bot.setControlState = vi.fn();
    bot.attack = vi.fn(() => { delete bot.entities[2]; });
    const { system } = systemFixture(bot);
    system.hostileContainmentActive = true;
    return { system, bot };
  }
  // About one zombie hit per second of contact, as in a real chase (500ms contact samples).
  const hit = (system: any, bot: any, health: number) => {
    system.sampleContact(); system.sampleContact();
    bot.health = health; system.onHealthSample();
  };

  it('decides from measured rates: learned kill times pick the weapon and outweigh the priors', async () => {
    const { estimateEncounter, seedCombatStats, mergeCombatStats } = await import('../../src/modules/minecraftLearning/index.js');
    const stats = seedCombatStats();
    const input = { target: 'zombie', health: 14, threats: [{ name: 'zombie', distance: 2 }], escapeFailing: true };
    expect(estimateEncounter(stats, { ...input, carried: ['iron_pickaxe', 'stone_sword'] })).toMatchObject({ weapon: 'stone_sword', fight: true });
    expect(estimateEncounter(stats, { ...input, carried: ['bread'] })).toMatchObject({ weapon: null, fight: false });
    expect(estimateEncounter(stats, { ...input, carried: ['stone_sword'], escapeFailing: false }).fight).toBe(false);
    // Experience: the pickaxe actually finished zombies fast in this bot's hands.
    const learned = mergeCombatStats(stats, { version: 1, mobs: {},
      weapons: { 'iron_pickaxe|zombie': { fights: 6, kills: 6, killMs: 6 * 1200 } } });
    expect(estimateEncounter(learned, { ...input, carried: ['iron_pickaxe', 'stone_sword'] }).weapon).toBe('iron_pickaxe');
    // Paid run L6: a stone pickaxe (~5.6s) against a lone zombie at 17 HP (~5.7s) while the escape
    // kept failing — fleeing takes the same damage, so the race decides, without a safety margin.
    expect(estimateEncounter(stats, { ...input, health: 17, carried: ['stone_pickaxe'] }).fight).toBe(true);
    expect(estimateEncounter(stats, { ...input, health: 14, carried: ['stone_pickaxe'] }).fight).toBe(false);
    // A burst large enough to kill outright (measured or prior) rules out closing in.
    expect(estimateEncounter(stats, { ...input, target: 'zombie', threats: [{ name: 'zombie', distance: 2 }, { name: 'creeper', distance: 5 }],
      carried: ['stone_sword'] })).toMatchObject({ lethalBurst: true, fight: false });
    // A live probe quit 0.0s from the kill because its opponent's ordinary hit (3) now exceeded the
    // health left (2). The opponent's blows are the race itself once the fight is on; starting one
    // at that health is still refused, and so is carrying on when something else can kill in one hit.
    const late = { ...input, health: 2, carried: ['stone_sword'] };
    expect(estimateEncounter(stats, late)).toMatchObject({ lethalBurst: true, fight: false });
    expect(estimateEncounter(stats, { ...late, elapsedMs: 2400 })).toMatchObject({ lethalBurst: false, fight: true });
    expect(estimateEncounter(stats, { ...late, elapsedMs: 1000 }).fight).toBe(false); // 1.5s to the kill, 0.7s to live
    expect(estimateEncounter(stats, { ...late, elapsedMs: 2400, threats: [{ name: 'zombie', distance: 2 }, { name: 'creeper', distance: 5 }] }))
      .toMatchObject({ lethalBurst: true, fight: false });
  });

  it('strikes back at the first blow from a zombie that has caught it up while escaping, then reports the kill (paid run L77t waited for a second blow and took six)', async () => {
    const { system, bot } = corneredFixture({ 2: { id: 2, name: 'zombie', height: 1.95, position: new Vec3(2, 64, 0) } });
    const flee = vi.spyOn(system, 'startContinuousFlee');
    hit(system, bot, 20);
    expect(system.counterattackRunning).toBe(false);
    hit(system, bot, 17);
    expect(system.counterattackRunning).toBe(true);
    // While it lasts it is a fight the body has taken up: the shield is kept up between blows for one.
    expect(bot.engagements?.some((entry: any) => entry.kinds.includes('zombie'))).toBe(true);
    await vi.waitFor(() => expect(system.counterattackRunning).toBe(false), { timeout: 2000 });
    expect(bot.equip).toHaveBeenCalledWith({ name: 'stone_sword' }, 'hand');
    expect(bot.attack).toHaveBeenCalledOnce();
    expect(flee).not.toHaveBeenCalled();
    expect(bot.engagements ?? []).toEqual([]);
  });

  it('keeps fleeing from a lethal burst, without a weapon, or outside an escape', () => {
    const cases = [
      corneredFixture({ 2: { id: 2, name: 'creeper', position: new Vec3(2, 64, 0) } }),
      corneredFixture({ 2: { id: 2, name: 'zombie', position: new Vec3(2, 64, 0) } }, [{ name: 'bread' }]),
    ];
    const idle = corneredFixture({ 2: { id: 2, name: 'zombie', position: new Vec3(2, 64, 0) } });
    idle.system.hostileContainmentActive = false;
    for (const { system, bot } of [...cases, idle]) {
      hit(system, bot, 20); hit(system, bot, 17); hit(system, bot, 14);
      expect(system.counterattackRunning).toBe(false);
      expect(bot.attack).not.toHaveBeenCalled();
    }
  });

  it('strikes back with a weapon in hand however many there are, once one has caught it up (paid runs L77x and L77y: let go of the fight or never took it up, and were struck dead standing)', () => {
    const crowded = corneredFixture({ 2: { id: 2, name: 'zombie', position: new Vec3(2, 64, 0) },
      3: { id: 3, name: 'skeleton', position: new Vec3(0, 64, 5) }, 4: { id: 4, name: 'zombie', position: new Vec3(-3, 64, 0) },
      5: { id: 5, name: 'skeleton', position: new Vec3(0, 64, -5) } });
    hit(crowded.system, crowded.bot, 20); hit(crowded.system, crowded.bot, 17);
    expect(crowded.system.counterattackRunning).toBe(true);
  });

  it('fights a drowned in the water when the air is plenty, but not when the air will not last (paid run L14)', async () => {
    // Water from y=63 to 66 above the bot: the surface is a few blocks up.
    const water = (p: Vec3) => (p.y <= 66 ? { name: 'water', boundingBox: 'empty' } : { name: 'air', boundingBox: 'empty' });
    const fullAir = corneredFixture({ 2: { id: 2, name: 'drowned', height: 1.95, position: new Vec3(2, 64, 0) } });
    Object.assign(fullAir.bot, { blockAt: water, oxygenLevel: 20 }); fullAir.bot.entity.isInWater = true;
    fullAir.system.suffocationContainmentActive = true; // left on after an earlier low-air episode, as in L14
    hit(fullAir.system, fullAir.bot, 20); hit(fullAir.system, fullAir.bot, 17); hit(fullAir.system, fullAir.bot, 14);
    expect(fullAir.system.counterattackRunning).toBe(true);
    await vi.waitFor(() => expect(fullAir.system.counterattackRunning).toBe(false), { timeout: 2000 });
    expect(fullAir.bot.attack).toHaveBeenCalledOnce();

    const lowAir = corneredFixture({ 2: { id: 2, name: 'drowned', height: 1.95, position: new Vec3(2, 64, 0) } });
    Object.assign(lowAir.bot, { blockAt: (p: Vec3) => (p.y <= 75 ? { name: 'water', boundingBox: 'empty' } : { name: 'air', boundingBox: 'empty' }),
      oxygenLevel: 6 }); lowAir.bot.entity.isInWater = true;
    hit(lowAir.system, lowAir.bot, 20); hit(lowAir.system, lowAir.bot, 17); hit(lowAir.system, lowAir.bot, 14);
    expect(lowAir.system.counterattackRunning).toBe(false);
    expect(lowAir.bot.attack).not.toHaveBeenCalled();
  });

  it('does not treat a hostile hit in the water with full air as a breathing emergency', async () => {
    const { system, bot } = corneredFixture({ 2: { id: 2, name: 'drowned', position: new Vec3(3, 64, 0) } });
    Object.assign(bot, { blockAt: (p: Vec3) => (p.y <= 66 ? { name: 'water', boundingBox: 'empty' } : { name: 'air', boundingBox: 'empty' }), oxygenLevel: 20 });
    bot.entity.isInWater = true;
    system.suffocationContainmentActive = true;
    system.taskRuntime = { isReady: () => true, isInEmergencyMode: () => true };
    const flee = vi.spyOn(system, 'startContinuousFlee');
    bot.health = 6;
    await system.handleEmergencyEvent({ eventType: 'damage', timestamp: Date.now(), damage: 3, damagePercent: 15,
      currentHealth: 6, consecutiveCount: 3, possibleSource: 'drowned（約3m）' });
    expect(flee).toHaveBeenCalled();
  });

  it('does not let a low-HP emergency event restart the flee over a running counterattack', async () => {
    const { system, bot } = corneredFixture({ 2: { id: 2, name: 'zombie', position: new Vec3(2, 64, 0) } });
    system.counterattackRunning = true;
    const flee = vi.spyOn(system, 'startContinuousFlee');
    system.taskRuntime = { isReady: () => true, isInEmergencyMode: () => true };
    bot.health = 6;
    await system.handleEmergencyEvent({ eventType: 'damage', timestamp: Date.now(), damage: 3, damagePercent: 15,
      currentHealth: 6, consecutiveCount: 3, possibleSource: 'zombie（約2m）' });
    expect(bot.interruptExecution).not.toBe(true);
    system.startContinuousFlee();
    expect(system.fleeController).toBeNull();
    expect(flee).toHaveBeenCalledOnce();
  });
});

describe('sealed shelter and counterattack follow-ups (paid run 14b)', () => {
  function shelteredBot(): any {
    const bot = botFixture();
    // Feet at (0,64,0): air in the shaft, solid walls, floor and roof.
    bot.blockAt = (pos: Vec3) => {
      const p = pos.floored();
      const shaft = p.x === 0 && p.z === 0 && (p.y === 64 || p.y === 65);
      return { name: shaft ? 'air' : 'stone', boundingBox: shaft ? 'empty' : 'block', position: p };
    };
    return bot;
  }

  it('holds instead of fleeing (which may dig the walls open) while sealed and unhurt', () => {
    const { system } = systemFixture(shelteredBot());
    system.lastDamageAt = 0;
    system.startContinuousFlee();
    expect(system.fleeController).toBeNull();
    system.lastDamageAt = Date.now(); // a hit means the shelter failed: normal containment resumes
    system.startContinuousFlee();
    expect(system.fleeController).not.toBeNull();
    system.stopContinuousFlee();
  });

  it('keeps striking a cornering zombie when the second mob is still several blocks away', async () => {
    const bot = botFixture();
    let hits = 0;
    bot.entities = { 2: { id: 2, name: 'zombie', height: 1.95, position: new Vec3(2, 64, 0) },
      3: { id: 3, name: 'zombie', position: new Vec3(-7, 64, 0) } };
    bot.inventory = { items: () => [{ name: 'diamond_pickaxe' }], slots: [] };
    bot.equip = vi.fn(async () => {}); bot.lookAt = vi.fn(async () => {}); bot.setControlState = vi.fn();
    bot.attack = vi.fn(() => { if (++hits >= 2) delete bot.entities[2]; });
    const { system } = systemFixture(bot);
    system.swingIntervalMs = 10;
    await system.runCorneredCounterattack(bot.entities[2], 'diamond_pickaxe');
    expect(bot.attack).toHaveBeenCalledTimes(2);
  });
});

describe('survival actions survive emergency cancellation (paid run L5 drowned)', () => {
  it('a breathing emergency cancels the task but not auto-swim on its safety lease, even across repeated ticks', async () => {
    const { executeAction } = await import('../../src/services/minebot/execution/ActionExecution.js');
    const bot = botFixture();
    bot.health = 14; bot.oxygenLevel = 0; bot.entity.isInWater = true;
    bot.blockAt = () => ({ name: 'water', boundingBox: 'empty' });
    const runtime: any = { isReady: () => true, isInEmergencyMode: () => true, currentState: { recoveryStatus: 'idle' } };
    const system: any = new EventReactionSystem(bot, runtime, settings);
    vi.spyOn(system, 'refreshSuffocationContainment').mockImplementation(() => {});
    let finishSwim!: () => void;
    let swimAborted = false;
    const swim = executeAction(bot, 'auto-swim', 0, () => new Promise(resolve => {
      finishSwim = () => resolve({ success: true, result: 'surfaced' });
    }), { safetyLease: true, waitForQuiescence: true }).then(result => { swimAborted = result.success === false; return result; });
    await new Promise(resolve => setTimeout(resolve, 5));
    for (let tick = 0; tick < 5; tick++) {
      await system.handleEmergencyEvent({ timestamp: Date.now(), eventType: 'suffocation', oxygen: 0, health: 14, isInWater: true });
      await new Promise(resolve => setTimeout(resolve, 60)); // longer than the legacy interrupt poll
    }
    expect(swimAborted).toBe(false);
    finishSwim();
    expect(await swim).toMatchObject({ success: true });
    system.destroy();
  });

  it('routes drowning damage with no attacker to the breathing emergency, not "environmental damage, eat food"', async () => {
    const bot = botFixture();
    bot.entities = {}; bot.oxygenLevel = 0; bot.entity.isInWater = true;
    bot.blockAt = () => ({ name: 'water', boundingBox: 'empty' });
    const { system } = systemFixture(bot);
    const suffocation = vi.spyOn(system, 'handleSuffocation').mockResolvedValue(undefined);
    const generic = vi.spyOn(system, 'handleEvent').mockResolvedValue(undefined);
    await system.handleDamage({ damage: 2, damagePercent: 10, currentHealth: 14, consecutiveCount: 3 });
    expect(suffocation).toHaveBeenCalledWith({ oxygen: 0, health: 14, isInWater: true });
    expect(generic).not.toHaveBeenCalled();
  });
});

describe('hits are attributed to the cause the server reports (paid run L7)', () => {
  it('records a sourced hit on that mob, and a fall or drowning on no mob at all', async () => {
    const bot = botFixture();
    bot.entities = { 2: { id: 2, name: 'spider', position: new Vec3(2, 64, 0) } };
    const { system } = systemFixture(bot);
    system.hostileContainmentActive = true;
    vi.spyOn(system, 'updateInitialState').mockImplementation(() => {});
    vi.spyOn(system, 'startEnvironmentCheck').mockImplementation(() => {});
    vi.spyOn(system, 'startHostileCheck').mockImplementation(() => {});
    await system.initialize(); // the real damage_event and health listeners
    const health = (value: number) => { bot.health = value; bot.emit('health'); };
    health(20);
    bot.emit('entityHurt', bot.entity, bot.entities[2]); health(18);
    bot.emit('entityHurt', bot.entity, undefined); health(8); // a 10-damage fall next to the spider
    const spider = system.encounters.stats().mobs.spider;
    expect(spider.maxHit).toBe(2);
    expect(system.recentHits).toHaveLength(1); // the fall is not the pursuer landing a hit
    system.destroy();
  });
});

describe('a planner escape begun with the pursuer just out of range is respected (paid run L9)', () => {
  it('registers the escape, so a following warning tick does not restart native flee over it', async () => {
    const bot = botFixture();
    bot.entities = { 2: { id: 2, name: 'zombie', position: new Vec3(16.5, 64, 0) } }; // just beyond clearance
    bot.health = 6;
    const runtime: any = { isReady: () => true, isInEmergencyMode: () => true, currentState: { recoveryStatus: 'idle' } };
    const system: any = new EventReactionSystem(bot, runtime, settings);
    system.hostileContainmentActive = true;
    const restart = vi.spyOn(system, 'startContinuousFlee').mockImplementation(() => {});
    system.onEmergencyToolStarting('flee-from', { target: 'hostile' }, true);
    expect(system.handedOffTool).toBe('flee-from');
    await system.handleHostileApproach({ timestamp: Date.now(), eventType: 'hostile_approach', threatLevel: 'warning',
      mobType: 'zombie', distance: 16, mobCount: 1, allHostiles: [{ mobType: 'zombie', distance: 16, position: { x: 16, y: 64, z: 0 } }] });
    expect(restart).not.toHaveBeenCalled();
    // A status query out of range is not an escape.
    system.handedOffTool = null;
    system.onEmergencyToolStarting('move-to', { x: 0, y: 64, z: 40 }, true);
    expect(system.handedOffTool).toBeNull();
    system.destroy();
  });
});

describe('native escape path stability', () => {
  it('does not reset the path every flee tick; re-aims only on a real change or when stopped', async () => {
    const { executeAction } = await import('../../src/services/minebot/execution/ActionExecution.js');
    const bot = botFixture();
    let moving = true;
    bot.pathfinder = { stop: vi.fn(), setGoal: vi.fn(), isMoving: () => moving };
    const { system } = systemFixture(bot);
    await executeAction(bot, 'flee-from', 0, async () => {
      for (let tick = 0; tick < 5; tick++) system.updateFleeDirection();
      expect(bot.pathfinder.setGoal).toHaveBeenCalledTimes(1);
      bot.entities = { 2: { id: 2, name: 'zombie', position: new Vec3(0, 64, 7) } }; // threat now from the south
      system.updateFleeDirection();
      expect(bot.pathfinder.setGoal).toHaveBeenCalledTimes(2);
      moving = false; // reached the goal or no path: aim again
      system.updateFleeDirection();
      expect(bot.pathfinder.setGoal).toHaveBeenCalledTimes(3);
      return { success: true, result: 'ok' };
    });
  });
});

describe('what a kind of mob can reach from is measured, and an emergency is over only beyond it (paid run L69: "nothing within 16 blocks" three times, a skeleton at 15.5 still shooting)', () => {
  // The skeleton stands 12.2 blocks off (see the fixture); the zombie 7.
  it('learns the reach from hits the server attributed, and only from those', () => {
    const { system, bot } = systemFixture();
    expect(system.emergencyClearanceRadius()).toBe(16); // nothing has hit from afar yet: the usual radius
    system.lastHealthSample = 20;
    system.lastHurt = { at: Date.now(), source: 'skeleton', from: 12.2 };
    bot.health = 16;
    system.onHealthSample();
    expect(system.encounters.stats().mobs.skeleton.reach).toBeCloseTo(12.2);
    // A hit with no cause named (a fall) is not laid on whatever stands nearest, far off.
    system.lastHurt = null;
    bot.health = 12;
    system.onHealthSample();
    expect(system.encounters.stats().mobs.zombie.reach).toBeUndefined();
  });

  it('asks for more room from a kind that has hit from afar, and says so; a kind that hits in contact keeps the usual radius', () => {
    const { system, bot } = systemFixture();
    system.encounters.recordHit('skeleton', 4, 15.3);
    system.encounters.recordHit('zombie', 3, 2.1);
    expect(system.emergencyClearanceRadius()).toBe(22); // 15.3 and six to spare
    const message = system.buildEmergencyMessage({ eventType: 'hostile_approach', mobCount: 2,
      allHostiles: [{ mobType: 'zombie', distance: 7 }, { mobType: 'skeleton', distance: 12.2 }] });
    expect(message).toContain('skeletonはこれまで最大15m先から当ててきた');
    expect(message).toContain('22m以上離れるか、視線を切る');
    expect(message).not.toContain('zombieはこれまで');
    // The end and the means, not an order to run.
    expect(message).toContain('【目的】相手の攻撃が届かない状態にする');
    expect(message).not.toContain('まず全敵から逃走する');
    // With the skeleton gone, the zombie alone: the usual radius, and nothing said about reach.
    delete bot.entities[3];
    expect(system.emergencyClearanceRadius()).toBe(16);
    expect(system.buildEmergencyMessage({ eventType: 'hostile_approach', mobCount: 1, allHostiles: [{ mobType: 'zombie', distance: 7 }] })).not.toContain('【実測】');
  });

  it('says the same after a hit, with the attacker named', () => {
    const { system } = systemFixture();
    system.encounters.recordHit('skeleton', 4, 15.3);
    const message = system.buildEmergencyMessage({ eventType: 'damage', damage: 4, currentHealth: 11, consecutiveCount: 1, possibleSource: 'skeleton（約12.2m）' });
    expect(message).toContain('攻撃元: skeleton');
    expect(message).toContain('視線を切る');
    expect(message).toContain('【実測】skeletonはこれまで最大15m先から当ててきた');
    expect(message).not.toContain('まず敵から逃走する');
  });
});

describe('the radius an emergency asks for is one the goal check accepts (paid run L77j: 72 asked, 64 accepted, the emergency thrown away and the body left standing)', () => {
  it('never asks for more than the goal check allows, however far the hit came from', () => {
    const { system } = systemFixture();
    system.encounters.recordHit('skeleton', 4, 200);
    system.lastHurt = { at: Date.now(), source: 'ghast', from: 90 };
    const radius = system.emergencyClearanceRadius();
    expect(radius).toBe(MAX_HOSTILE_CLEAR_RADIUS);
    expect(() => validateGoalContract({ goal: 'escape', predicates: [{ kind: 'hostiles_clear', radius }] }, 'escape')).not.toThrow();
    expect(() => validateGoalContract({ goal: 'escape', predicates: [{ kind: 'hostiles_clear', radius: MAX_HOSTILE_CLEAR_RADIUS + 1 }] }, 'escape'))
      .toThrow('GOAL_HOSTILE_RADIUS_INVALID');
  });

  it('a kind whose attack a reflex answers does not widen the radius by standing in range; a hit that got through does, for a moment', () => {
    const { system, bot } = systemFixture();
    delete bot.entities[3];
    bot.entities[2] = { id: 2, name: 'ghast', type: 'hostile', position: new Vec3(40, 70, 0), height: 4 };
    system.encounters.recordHit('ghast', 6, 45);
    expect(system.emergencyClearanceRadius()).toBe(51); // unanswered: out to where it has hit from, and six to spare
    bot.reflexAnswers = new Set(['ghast']);
    expect(system.emergencyClearanceRadius()).toBe(16);
    const now = Date.now();
    system.lastHurt = { at: now, source: 'ghast', from: 40 };
    expect(system.emergencyClearanceRadius()).toBe(46);
    system.lastHurt = { at: now - 6000, source: 'ghast', from: 40 };
    expect(system.emergencyClearanceRadius()).toBe(16);
  });
});

describe('an emergency begun for a hostile still on its way is not over while it is still coming', () => {
  it('the radius an emergency is judged by reaches out to a hostile that will arrive before the body can get safe', () => {
    const { system, bot } = systemFixture();
    delete bot.entities[3];
    bot.entities[2].position = new Vec3(22, 64, 0);
    const now = Date.now();
    bot.threatMotion = { samples: new Map([[2, [{ at: now - 2000, distance: 26.8 }, { at: now, distance: 22 }]]]) };
    expect(system.emergencyClearanceRadius()).toBe(26); // 22 and four to spare
    const message = system.buildEmergencyMessage({ eventType: 'hostile_approach', mobCount: 1,
      allHostiles: [{ mobType: 'zombie', distance: 22, arrivesInSeconds: 8 }] });
    expect(message).toContain('zombie(22m・約8秒で届く)');
    // Not closing: the usual radius.
    bot.threatMotion = { samples: new Map() };
    expect(system.emergencyClearanceRadius()).toBe(16);
  });
});


describe('an emergency says what a fight would come to, and lets the planner take one the measures favour (paid run L77h hid from one skeleton eight times in four minutes)', () => {
  const lone = () => {
    const bot: any = botFixture();
    bot.entities = { 2: { id: 2, name: 'skeleton', position: new Vec3(0, 64, 12) } };
    bot.inventory = { items: () => [{ name: 'iron_sword', count: 1 }], slots: [] };
    bot.instantSkills = { getSkill: (name: string) => ['flee-from', 'attack-nearest', 'move-to'].includes(name) ? {} : undefined, getSkills: () => [] };
    return bot;
  };

  it('gives the race for one mob near, and nothing for a crowd', () => {
    const { system } = systemFixture(lone());
    const text: string = system.describeFightOdds();
    expect(text).toContain('【実測・戦う場合】skeleton');
    expect(text).toMatch(/倒すまで約\d+秒/);
    const crowd: any = lone();
    crowd.entities = { 2: { id: 2, name: 'skeleton', position: new Vec3(0, 64, 12) }, 3: { id: 3, name: 'zombie', position: new Vec3(5, 64, 0) },
      4: { id: 4, name: 'zombie', position: new Vec3(-5, 64, 0) } };
    expect(systemFixture(crowd).system.describeFightOdds()).toBe('');
  });

  it('counts the walk up to a kind that hits from where it stands (paid run L77j: a blaze 29 blocks off was "faster to kill")', () => {
    const far: any = lone();
    far.entities = { 2: { id: 2, name: 'blaze', position: new Vec3(0, 64, 12) } };
    const { system } = systemFixture(far);
    // Not yet known to hit from afar: the race is the one in contact.
    expect(system.fightOdds()[0].closingMs).toBe(0);
    system.encounters.recordHit('blaze', 5, 29);
    far.entities[2].position = new Vec3(0, 64, 29);
    const after = system.fightOdds()[0];
    expect(after.closingMs).toBeGreaterThan(5000);
    expect(after.faster).toBe(false);
    expect(system.describeFightOdds()).toContain('近づくまで約');
    // Nor for a kind whose shots a reflex answers (a shield on the arm): the walk is made behind it.
    far.entities[2].position = new Vec3(0, 64, 12);
    expect(system.fightOdds()[0].closingMs).toBeGreaterThan(1500);
    far.reflexAnswers = new Set(['blaze']);
    expect(system.fightOdds()[0].closingMs).toBe(0);
    far.reflexAnswers = undefined;
    // In contact, nothing is added.
    far.entities[2].position = new Vec3(0, 64, 2);
    expect(system.fightOdds()[0].closingMs).toBe(0);
  });

  it('runs the race against all that are near: the time to kill every one of them, while all of them hit (lab continuation L77q: two wither skeletons, each "faster to kill")', () => {
    const bot: any = lone();
    bot.entities = { 2: { id: 2, name: 'zombie', position: new Vec3(0, 64, 3) } };
    const { system } = systemFixture(bot);
    const alone = system.fightOdds();
    expect(alone.length).toBe(1);
    bot.entities[3] = { id: 3, name: 'zombie', position: new Vec3(3, 64, 0) };
    const pair = system.fightOdds();
    expect(pair.length).toBe(2);
    // The same verdict for both, and never better than for one alone.
    expect(pair[0].faster).toBe(pair[1].faster);
    if (!alone[0].faster) expect(pair[0].faster).toBe(false);
    // With the kill time of both to get through, a pair that hits as hard as it takes to die in the time of one kill is refused.
    const killOne = pair[0].estimate.timeToKillMs;
    vi.spyOn(system.encounters, 'stats').mockReturnValue({ ...system.encounters.stats(),
      mobs: { zombie: { hits: 10, damage: 30, maxHit: 3, contactMs: 10_000, peak3s: 3 * 20 / (2 * (killOne * 2.5) / 1000) } } });
    expect(system.fightOdds().every((entry: any) => entry.faster === false)).toBe(true);
  });

  it('lets go of the body for an attack only when the race is won', () => {
    const { system } = systemFixture(lone());
    const containment = new AbortController();
    system.fleeController = containment;
    const odds = vi.spyOn(system, 'fightOdds');
    odds.mockReturnValue([{ name: 'skeleton', estimate: {} as any, faster: false, distance: 12, closingMs: 0 }]);
    system.onEmergencyToolStarting('attack-nearest', {}, true);
    expect(containment.signal.aborted).toBe(false);          // not favoured: the escape keeps the body
    odds.mockReturnValue([{ name: 'skeleton', estimate: {} as any, faster: true, distance: 12, closingMs: 0 }]);
    system.onEmergencyToolStarting('attack-nearest', {}, true);
    expect(containment.signal.aborted).toBe(true);           // favoured: the attack has it
    expect(system.handedOffTool).toBe('attack-nearest');
  });
});
