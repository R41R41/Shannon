import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';

const gotoSafeMock = vi.hoisted(() => vi.fn());
const setMovementsMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/config/env.js', () => ({ config: {} }));
vi.mock('../../src/services/minebot/config/MinebotConfig.js', () => ({ CONFIG: { SKILL_TIMEOUT_MS: 120_000 } }));
vi.mock('../../src/services/minebot/utils/setMovements.js', () => ({ setMovements: setMovementsMock }));
vi.mock('../../src/services/minebot/utils/gotoSafe.js', () => ({ gotoSafe: gotoSafeMock }));

import FleeFrom from '../../src/services/minebot/instantSkills/fleeFrom.js';
import {
  applyFleeSearchLimits, filterSliced, FLEE_SEARCH_RADIUS, FLEE_THINK_TIMEOUT_MS, FLEE_TICK_TIMEOUT_MS,
} from '../../src/services/minebot/utils/fleeSearchLimits.js';
import { threatExposure } from '../../src/services/minebot/utils/threatExposure.js';

function fixture() {
  const bot: any = {
    entity: { id: 1, position: new Vec3(0, 64, 0), onGround: true },
    entities: { 3: { id: 3, name: 'skeleton', position: new Vec3(4, 64, 0), height: 1.99 } },
    players: {},
    pathfinder: { goal: null, stop: vi.fn(), setGoal: vi.fn(), thinkTimeout: 5000, tickTimeout: 40, searchRadius: -1 },
  };
  bot.pathfinder.setGoal.mockImplementation((goal: any) => { bot.pathfinder.goal = goal; });
  return bot;
}

describe('run 21: flee-from keeps its route search light', () => {
  beforeEach(() => { gotoSafeMock.mockReset(); setMovementsMock.mockReset(); });
  afterEach(() => { delete process.env.MINEBOT_FLEE_SEARCH_LIMIT; });

  it('searches with a short think time, a short tick and a bounded radius, and puts the defaults back afterwards', async () => {
    const bot = fixture();
    const seen: Array<Record<string, number>> = [];
    gotoSafeMock.mockImplementation(async () => {
      seen.push({ think: bot.pathfinder.thinkTimeout, tick: bot.pathfinder.tickTimeout, radius: bot.pathfinder.searchRadius });
      bot.entity.position = new Vec3(-30, 64, 0);
      return { success: true };
    });
    const result = await new FleeFrom(bot).runImpl('hostile', 10);
    expect(result.success).toBe(true);
    expect(seen).toEqual([{ think: FLEE_THINK_TIMEOUT_MS, tick: FLEE_TICK_TIMEOUT_MS, radius: FLEE_SEARCH_RADIUS }]);
    expect(FLEE_THINK_TIMEOUT_MS).toBeLessThanOrEqual(1000);
    expect(FLEE_SEARCH_RADIUS).toBeGreaterThan(0);
    // move-to and the rest get the library's own limits back.
    expect(bot.pathfinder).toMatchObject({ thinkTimeout: 5000, tickTimeout: 40, searchRadius: -1 });
  });

  it('puts the limits back also when the skill throws, and never loosens a tighter one', async () => {
    const bot = fixture();
    bot.pathfinder.thinkTimeout = 200;
    gotoSafeMock.mockImplementation(async () => {
      expect(bot.pathfinder.thinkTimeout).toBe(200);
      expect(bot.pathfinder.tickTimeout).toBe(FLEE_TICK_TIMEOUT_MS);
      throw new Error('boom');
    });
    const result = await new FleeFrom(bot).runImpl('hostile', 10);
    expect(result.success).toBe(false);
    expect(bot.pathfinder).toMatchObject({ thinkTimeout: 200, tickTimeout: 40, searchRadius: -1 });
  });

  it('is switched off by MINEBOT_FLEE_SEARCH_LIMIT=off', () => {
    process.env.MINEBOT_FLEE_SEARCH_LIMIT = 'off';
    const bot = fixture();
    const restore = applyFleeSearchLimits(bot);
    expect(bot.pathfinder).toMatchObject({ thinkTimeout: 5000, tickTimeout: 40, searchRadius: -1 });
    restore();
  });

  it('leaves a limit alone that another controller has changed meanwhile', () => {
    const bot = fixture();
    const restore = applyFleeSearchLimits(bot);
    bot.pathfinder.thinkTimeout = 1234;
    restore();
    expect(bot.pathfinder.thinkTimeout).toBe(1234);
    expect(bot.pathfinder.tickTimeout).toBe(40);
  });

  it('stops searching after two searches in a row that found nothing, and runs straight away instead of trying sixteen points', async () => {
    const bot = fixture();
    bot.entities[3].position = new Vec3(14, 64, 0); // outside the direct-run range: the route search comes first
    // A flat floor, open air above it: the straight run has somewhere to go.
    bot.blockAt = (p: Vec3) => p.y <= 63 ? { name: 'stone', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' };
    bot.look = vi.fn(async () => undefined);
    const controls: Array<[string, boolean]> = [];
    bot.setControlState = (key: string, on: boolean) => { controls.push([key, on]); };
    gotoSafeMock.mockImplementation(async () => ({ success: false, error: 'no_path' }));

    const result: any = await new FleeFrom(bot).runImpl('hostile', 32, 600);
    expect(result.success).toBe(false);
    expect(gotoSafeMock).toHaveBeenCalledTimes(2);
    expect(controls.some(([key, on]) => key === 'forward' && on)).toBe(true);
    // The keys are let go at the end.
    expect(controls.filter(([key]) => key === 'forward').pop()).toEqual(['forward', false]);
    expect(bot.pathfinder).toMatchObject({ thinkTimeout: 5000, tickTimeout: 40, searchRadius: -1 });
  });

  it('a search that got the body somewhere starts the count again', async () => {
    const bot = fixture();
    let call = 0;
    gotoSafeMock.mockImplementation(async () => {
      call++;
      // Fails, moves, fails, moves ...: never two empty searches in a row.
      if (call % 2 === 0) bot.entity.position = bot.entity.position.offset(-1, 0, 0);
      return call % 2 === 0 ? { success: true } : { success: false, error: 'no_path' };
    });
    await new FleeFrom(bot).runImpl('hostile', 40, 2_000);
    expect(gotoSafeMock.mock.calls.length).toBeGreaterThan(4);
  });
});

describe('run 21: scans give the event loop back', () => {
  it('filterSliced keeps the order and the filter, and yields to the event loop when a slice has run too long', async () => {
    let ticked = false;
    setImmediate(() => { ticked = true; });
    const slow = (n: number) => { const until = performance.now() + 3; while (performance.now() < until) { /* busy */ } return n % 2 === 0; };
    const kept = await filterSliced([1, 2, 3, 4, 5, 6], slow, 4);
    expect(kept).toEqual([2, 4, 6]);
    expect(ticked).toBe(true);
  });

  it('filterSliced does not wait on a timer while the work is quick', async () => {
    const kept = await filterSliced([1, 2, 3], n => n > 1);
    expect(kept).toEqual([2, 3]);
  });

  it('the exposure flood fill stops at its time budget and calls the space open', () => {
    // A huge empty cave and a mob in a sealed closet cannot be told apart in the time: the answer is "reachable" (never wrongly sealed).
    let reads = 0;
    const blockAt = (p: Vec3) => {
      reads++;
      // Make every read cost time so the budget is the thing that ends the fill.
      const until = performance.now() + 0.05; while (performance.now() < until) { /* busy */ }
      const closet = Math.abs(p.x - 30) <= 1 && Math.abs(p.z) <= 1 && p.y >= 64 && p.y <= 66;
      return { boundingBox: (!closet && (p.x < 31 && p.x > -30 && Math.abs(p.z) < 30 && p.y >= 60 && p.y <= 70) ? 'empty' : 'block') as string };
    };
    const bot: any = { entity: { position: new Vec3(0, 64, 0) }, blockAt };
    const mob: any = { position: new Vec3(30, 64, 0), height: 1.8 };
    const started = performance.now();
    const value = threatExposure(bot, mob, 1);
    const took = performance.now() - started;
    expect(value).not.toBe('sealed');
    expect(took).toBeLessThan(400);
    expect(reads).toBeGreaterThan(0);
  });
});
