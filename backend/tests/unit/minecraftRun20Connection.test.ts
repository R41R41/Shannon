import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';

vi.mock('../../src/config/env.js', () => ({ config: {} }));

import { ReconnectBudget, reconnectKindOfEnd, reconnectKindOfKick } from '../../src/services/minebot/utils/reconnectPolicy.js';
import { FAR_LEG_M, goalTarget, nextLeg, rockShare } from '../../src/services/minebot/utils/farLegs.js';
import { STALL_WORKER_SOURCE, botLoopWatch, installBotLoopWatch, loopWatchOptions } from '../../src/services/minebot/utils/eventLoopWatch.js';
import { installRespawnTracker, settleAfterRespawn, sinceRespawnMs } from '../../src/services/minebot/utils/respawnSettle.js';
import { gotoSafe } from '../../src/services/minebot/utils/gotoSafe.js';
import pathfinder from 'mineflayer-pathfinder';
const { goals } = pathfinder;

describe('run 20: the body goes back in by itself after a connection that ended without anyone stopping it', () => {
  it('answers the silence kick, the chat-signature kick, and a socket that closed; not a kick that says the body is not wanted', () => {
    expect(reconnectKindOfKick('disconnect.timeout')).toBe('timeout');
    expect(reconnectKindOfKick('Timed out')).toBe('timeout');
    expect(reconnectKindOfKick('chat_validation_failed')).toBe('chat_validation');
    expect(reconnectKindOfKick('multiplayer.disconnect.duplicate_login')).toBeNull();
    expect(reconnectKindOfKick('multiplayer.disconnect.banned')).toBeNull();
    expect(reconnectKindOfKick('multiplayer.disconnect.not_whitelisted')).toBeNull();
    expect(reconnectKindOfKick('disconnect.spam')).toBeNull();
    expect(reconnectKindOfKick('')).toBeNull();
    expect(reconnectKindOfEnd('socketClosed')).toBe('connection_lost');
    expect(reconnectKindOfEnd('read ECONNRESET')).toBe('connection_lost');
    expect(reconnectKindOfEnd('disconnect.quitting')).toBeNull();
    expect(reconnectKindOfEnd('isolated progressive trial complete')).toBeNull();
    expect(reconnectKindOfEnd(undefined)).toBeNull();
  });

  it('waits longer each time, gives up after five tries in a window, and forgets them once the body has stayed up', () => {
    const budget = new ReconnectBudget(15 * 60_000, 120_000);
    const delays: number[] = [];
    let now = 1_000_000;
    for (let i = 0; i < 5; i++) { const plan = budget.next(now, 'timeout'); expect(plan.allowed).toBe(true); delays.push(plan.delayMs); now += 1000; }
    expect(delays).toEqual([8000, 15000, 30000, 60000, 90000]);
    expect(budget.next(now, 'timeout').allowed).toBe(false);
    // Joined and stable for two minutes: a fresh start.
    budget.noteSpawned(now); now += 130_000;
    expect(budget.next(now, 'connection_lost')).toMatchObject({ allowed: true, delayMs: 8000, attempt: 1 });
    // The chat-signature kick keeps its short pause.
    const chat = new ReconnectBudget();
    chat.next(0, 'chat_validation'); expect(chat.next(1, 'chat_validation').delayMs).toBe(8000);
  });
});

describe('run 20: a far walk is planned a leg at a time', () => {
  const loadedAround = (limit: number) => (position: { x: number; z: number }) => Math.hypot(position.x, position.z) <= limit ? { name: 'stone' } : null;
  const botAt = (x: number, z: number, limit = 80) => ({ entity: { position: { x, y: 70, z } }, blockAt: loadedAround(limit) as any });

  it('reads the ground position out of the goals that have one', () => {
    expect(goalTarget(new goals.GoalNear(10, 5, 20, 2) as any)).toEqual({ x: 10, y: 5, z: 20 });
    expect(goalTarget(new goals.GoalNearXZ(10, 20, 2) as any)).toMatchObject({ x: 10, z: 20 });
    expect(goalTarget(new goals.GoalY(40) as any)).toBeNull();
  });

  it('leaves a near goal alone (up to a leg and a half) and legs a far one on the line, on ground that is loaded', () => {
    const bot = botAt(0, 0, 80);
    const near = new goals.GoalNearXZ(90, 0, 3) as any;
    expect(nextLeg(bot, near).final).toBe(true);
    const far = new goals.GoalNear(400, 70, 0, 2) as any;
    const leg = nextLeg(bot, far);
    expect(leg.final).toBe(false);
    // The full leg (64 m) is inside the loaded ring (80 m): the point is 64 m along the line.
    expect(leg.via).toEqual({ x: FAR_LEG_M, z: 0 });
    expect((leg.goal as any).constructor.name).toBe('GoalNearXZ');
    // Ground loaded only 40 m out: the point comes back to ground that is.
    expect(nextLeg(botAt(0, 0, 40), far).via!.x).toBeLessThanOrEqual(40);
    // Another try at the same place turns the line a little.
    const turned = nextLeg(bot, far, 1);
    expect(turned.via!.z).not.toBe(0);
    // Nothing a leg can be: the goal as asked (a height goal is about no ground position).
    expect(nextLeg(bot, new goals.GoalY(10) as any).final).toBe(true);
    expect(nextLeg(bot, far, 0, 0).final).toBe(true);
  });

  it('through rock the legs are 20 m, keep the height of the line, and the real goal is only the last', () => {
    const solid = { name: 'deepslate', boundingBox: 'block' };
    const rockBot: any = { entity: { position: { x: 0.5, y: -58, z: 0.5 } }, blockAt: () => solid };
    const goal = new goals.GoalNear(90, -21, 0, 2) as any;
    const leg = nextLeg(rockBot, goal);
    expect(leg).toMatchObject({ final: false, rock: true });
    expect((leg.goal as any).constructor.name).toBe('GoalNear');
    // 20 m along a line 90 m long and 37 m up: about 18 m across and 8 m up.
    expect(leg.via!.x).toBeGreaterThan(15); expect(leg.via!.x).toBeLessThan(21);
    expect(leg.via!.y).toBeGreaterThan(-54); expect(leg.via!.y).toBeLessThan(-48);
    // Within 30 m of the goal it is the goal itself.
    rockBot.entity.position = { x: 70.5, y: -30, z: 0.5 };
    expect(nextLeg(rockBot, goal).final).toBe(true);
    // A goal about no height (an XZ goal) keeps to the level.
    rockBot.entity.position = { x: 0.5, y: -58, z: 0.5 };
    const level = nextLeg(rockBot, new goals.GoalNearXZ(90, 0, 3) as any);
    expect(level.rock).toBe(true);
    expect((level.goal as any).constructor.name).toBe('GoalNearXZ');
    // Open ground (nothing to dig): the longer legs.
    expect(nextLeg({ entity: rockBot.entity, blockAt: () => ({ name: 'air', boundingBox: 'empty' }) }, goal).rock).toBe(false);
    // The rock share counts a cell as dug when the feet or the head cell is solid.
    expect(rockShare(rockBot, { x: 0, y: -58, z: 0 }, { x: 10, y: -58, z: 0 })).toBe(1);
    expect(rockShare({ entity: rockBot.entity, blockAt: () => null }, { x: 0, y: -58, z: 0 }, { x: 10, y: -58, z: 0 })).toBe(0);
  });

  function walker(position: Vec3) {
    const asked: string[] = [];
    const bot: any = {
      entity: { position, yaw: 0, onGround: true },
      blockAt: loadedAround(100),
      clearControlStates: vi.fn(), setControlState: vi.fn(), stopDigging: vi.fn(),
      pathfinder: {
        isMining: () => false, isBuilding: () => false, isMoving: () => true, stop: vi.fn(), setGoal: vi.fn(),
        goto: async (goal: any) => {
          asked.push(`${goal.constructor.name}(${goal.x},${goal.z})`);
          await new Promise(resolve => setTimeout(resolve, 5));
          // The body arrives at the goal it was given (the middle of its range).
          bot.entity.position = new Vec3(goal.x + 0.5, position.y, goal.z + 0.5);
        },
      },
    };
    return { bot, asked };
  }

  it('gotoSafe walks a 300 m goal as legs and ends on the goal itself', async () => {
    const { bot, asked } = walker(new Vec3(0.5, 70, 0.5));
    const result = await gotoSafe(bot, new goals.GoalNearXZ(300, 0, 3) as any, { timeoutMs: 10_000 });
    expect(result.success).toBe(true);
    expect(asked.length).toBeGreaterThanOrEqual(4);
    expect(asked.slice(0, -1).every(line => line.startsWith('GoalNearXZ('))).toBe(true);
    expect(asked[asked.length - 1]).toBe('GoalNearXZ(300,0)');
    // No leg is longer than the legs' length (plus the reach of the point); the last may be a leg and a half.
    let previous = 0;
    asked.forEach((line, index) => {
      const x = Number(/\((-?\d+),/.exec(line)![1]);
      expect(x - previous).toBeLessThanOrEqual(index === asked.length - 1 ? FAR_LEG_M * 1.5 + 7 : FAR_LEG_M + 7);
      previous = x;
    });
  });

  it('gotoSafe asks for a near goal as one goal, as before', async () => {
    const { bot, asked } = walker(new Vec3(0.5, 70, 0.5));
    expect((await gotoSafe(bot, new goals.GoalNear(50, 70, 0, 2) as any, { timeoutMs: 5000 })).success).toBe(true);
    expect(asked).toEqual(['GoalNear(50,0)']);
  });

  it('gotoSafe asks the search again from where the body stands when it gave up after the body had got on (run 20: "no path" after 26 m)', async () => {
    const { bot, asked } = walker(new Vec3(0.5, 70, 0.5));
    const original = bot.pathfinder.goto;
    let gaveUp = 0;
    bot.pathfinder.goto = async (goal: any) => {
      if (gaveUp++ < 2) { bot.entity.position = new Vec3(bot.entity.position.x + 5, 70, bot.entity.position.z); asked.push('moved-then-gave-up'); throw new Error('Took to long to decide path to goal!'); }
      return original(goal);
    };
    const result = await gotoSafe(bot, new goals.GoalNear(40, 70, 0, 2) as any, { timeoutMs: 10_000 });
    expect(result.success).toBe(true);
    expect(asked.filter(line => line === 'moved-then-gave-up')).toHaveLength(2);
    // Without getting on, the first answer stands.
    const still = walker(new Vec3(0.5, 70, 0.5));
    still.bot.pathfinder.goto = async () => { throw new Error('No path to the goal!'); };
    expect(await gotoSafe(still.bot, new goals.GoalNear(40, 70, 0, 2) as any, { timeoutMs: 10_000 })).toMatchObject({ success: false, error: 'no_path' });
  });

  it('gotoSafe tries a line turned away when the first leg has no path, then gives the search\'s answer', async () => {
    const { bot, asked } = walker(new Vec3(0.5, 70, 0.5));
    let refusals = 2;
    const original = bot.pathfinder.goto;
    bot.pathfinder.goto = async (goal: any) => {
      if (refusals-- > 0) { asked.push('refused'); throw new Error('No path'); }
      return original(goal);
    };
    const result = await gotoSafe(bot, new goals.GoalNearXZ(300, 0, 3) as any, { timeoutMs: 10_000 });
    expect(result.success).toBe(true);
    expect(asked.filter(line => line === 'refused')).toHaveLength(2);
    // A walk that nothing allows ends with "no path", after five different lines.
    const stuckWalker = walker(new Vec3(0.5, 70, 0.5));
    stuckWalker.bot.pathfinder.goto = async () => { stuckWalker.asked.push('refused'); throw new Error('No path'); };
    const failed = await gotoSafe(stuckWalker.bot, new goals.GoalNearXZ(300, 0, 3) as any, { timeoutMs: 10_000 });
    expect(failed).toMatchObject({ success: false, error: 'no_path' });
    expect(stuckWalker.asked).toHaveLength(5);
  });
});

describe('run 20: the event loop is watched, and the worker that samples a stuck thread is valid', () => {
  it('reads the switches, and turns everything off with MINEBOT_LOOP_WATCH=off', () => {
    expect(loopWatchOptions({ MINEBOT_LOOP_WATCH: 'off' } as any)).toBeNull();
    expect(loopWatchOptions({} as any)).toMatchObject({ warnMs: 1000, stallSampleMs: 1200, stallFile: null });
    expect(loopWatchOptions({ MINEBOT_LOOP_LAG_WARN_MS: '1500', MINEBOT_LOOP_STALL_SAMPLE_MS: '0' } as any)).toMatchObject({ warnMs: 1500, stallSampleMs: 0 });
  });

  it('the worker source compiles', () => {
    expect(() => new vm.Script(STALL_WORKER_SOURCE)).not.toThrow();
  });

  it('keeps the longest gap between physics ticks and the chunks, names a slow handler, and undoes itself', () => {
    const bot: any = new EventEmitter();
    bot._client = new EventEmitter();
    bot.entity = { position: new Vec3(1, 2, 3) };
    const watch = installBotLoopWatch(bot, { warnMs: 100000, stallSampleMs: 0, stallFile: null })!;
    expect(botLoopWatch(bot)).toBe(watch);
    bot.emit('physicsTick');
    const spin = (ms: number) => { const end = performance.now() + ms; while (performance.now() < end); };
    bot.on('physicsTick', () => spin(130));
    bot.emit('physicsTick');
    bot.emit('chunkColumnLoad', {}); bot.emit('chunkColumnLoad', {});
    bot._client.on('packet', () => spin(120));
    bot._client.emit('packet', {}, { name: 'map_chunk' });
    const taken = watch.take();
    expect(taken.chunkLoads).toBe(2);
    expect(taken.slow.some(([name, ms]) => name === 'physicsTick' && ms >= 100)).toBe(true);
    expect(taken.slow.some(([name]) => name === 'packet:map_chunk')).toBe(true);
    expect(watch.take()).toMatchObject({ chunkLoads: 0, slow: [] });
    // Ending the connection removes the watch and the wrappers.
    bot.emit('end');
    expect(botLoopWatch(bot)).toBeUndefined();
    expect(bot.emit.toString()).not.toContain('performance');
  });
});

describe('run 20: a walk asked for just after a respawn waits for the chunks to settle', () => {
  beforeEach(() => { vi.useRealTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('does not wait when nothing respawned, or a long time ago', async () => {
    const bot: any = new EventEmitter();
    expect(await settleAfterRespawn(bot)).toBeNull();
    installRespawnTracker(bot);
    expect(await settleAfterRespawn(bot)).toBeNull();
    expect(sinceRespawnMs(bot)).toBeNull();
  });

  it('waits until the chunks have been quiet, but never longer than the cap', async () => {
    const bot: any = new EventEmitter();
    installRespawnTracker(bot);
    bot.emit('respawn');
    const timer = setInterval(() => bot.emit('chunkColumnLoad', {}), 30);
    const started = Date.now();
    const busy = await settleAfterRespawn(bot, { minAfterMs: 50, quietMs: 200, maxWaitMs: 500 });
    clearInterval(timer);
    expect(busy!.waitedMs).toBeGreaterThanOrEqual(450);
    expect(Date.now() - started).toBeLessThan(900);
    // Quiet chunks: the wait ends once the quiet time and the minimum have passed.
    const quiet = await settleAfterRespawn(bot, { minAfterMs: 50, quietMs: 150, maxWaitMs: 2000 });
    expect(quiet!.waitedMs).toBeLessThan(400);
    expect(sinceRespawnMs(bot)).toBeGreaterThan(0);
  });
});
