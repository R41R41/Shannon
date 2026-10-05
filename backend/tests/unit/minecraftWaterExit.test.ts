import { describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';

vi.mock('../../src/config/env.js', () => ({ config: {} }));
vi.mock('../../src/services/minebot/config/MinebotConfig.js', () => ({ CONFIG: { SKILL_TIMEOUT_MS: 120_000, TASK_TIMEOUT: 10_000 } }));

import AutoSwim, { ceilingOverhead, surfacingPossible } from '../../src/services/minebot/constantSkills/autoSwim.js';
import { climbableBank, swimOntoBank } from '../../src/services/minebot/utils/exitWater.js';

const block = (name: string) => ({ name, boundingBox: name === 'air' || name === 'water' ? 'empty' : 'block' });

/** A frozen lake: ice at y=62 over water, air above; `hole` columns are open water at y=62. */
function frozenLake(holes: Array<[number, number]> = []) {
  return (position: Vec3) => {
    if (position.y >= 63) return block('air');
    if (position.y === 62) return block(holes.some(([x, z]) => x === position.x && z === position.z) ? 'water' : 'ice');
    return block(position.y >= 50 ? 'water' : 'stone');
  };
}

describe('surfacing under a ceiling (paid run L25 drowned pressing up against an ice sheet)', () => {
  it('knows the way up is closed when the head cell itself is the ice, and that no open water is in reach', () => {
    const bot: any = { entity: { position: new Vec3(0.5, 60.5, 0.5), isInWater: true }, blockAt: frozenLake(), oxygenLevel: 5 };
    expect(ceilingOverhead(bot, new Vec3(0, 62, 0))).toBe(true);
    expect(ceilingOverhead(bot, new Vec3(0, 60, 0))).toBe(false);
    expect(surfacingPossible(bot)).toBe(false);
    // The surfacing reflex must not take the body where it cannot help: breaking out is someone else's job.
    const swim: any = new AutoSwim(bot);
    expect(swim.wantsPreemption()).toBe(false);
  });

  it('still surfaces through a hole within reach, and in open water', () => {
    const hole: any = { entity: { position: new Vec3(0.5, 60.5, 0.5), isInWater: true }, blockAt: frozenLake([[3, 0]]), oxygenLevel: 5 };
    expect(surfacingPossible(hole)).toBe(true);
    expect(new (AutoSwim as any)(hole).wantsPreemption()).toBe(true);
    const open: any = { entity: { position: new Vec3(0.5, 58, 0.5), isInWater: true }, oxygenLevel: 5,
      blockAt: (position: Vec3) => block(position.y >= 63 ? 'air' : 'water') };
    expect(surfacingPossible(open)).toBe(true);
  });
});

describe('climbing out of the water onto a bank at the waterline', () => {
  function swimmer(holes: Array<[number, number]>, start = new Vec3(0.5, 62.2, 0.5)) {
    const controls: Record<string, boolean> = {};
    const bot: any = { entity: { position: start, isInWater: true, onGround: false }, blockAt: frozenLake(holes), controls,
      executingSkill: false, interruptExecution: false,
      setControlState: (name: string, value: boolean) => { controls[name] = value; },
      lookAt: vi.fn(async () => {}) };
    return bot;
  }

  it('picks the bank most in the direction of travel, and none in open water or under a roof', () => {
    const bot = swimmer([[0, 0]]);
    expect(climbableBank(bot, 20.5, 0.5)).toMatchObject({ x: 1.5, y: 63, z: 0.5 });
    expect(climbableBank(bot, 0.5, -20.5)).toMatchObject({ x: 0.5, y: 63, z: -0.5 });
    const openWater = swimmer([[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 0], [0, 1], [1, -1], [1, 0], [1, 1]]);
    expect(climbableBank(openWater, 20.5, 0.5)).toBeNull();
    const under = swimmer([], new Vec3(0.5, 60.5, 0.5));
    expect(climbableBank(under, 20.5, 0.5)).toBeNull();
  });

  it('swims up and forward at the edge until the body stands on the bank', async () => {
    const bot = swimmer([[0, 0]]);
    let looks = 0;
    bot.lookAt = vi.fn(async (point: Vec3) => {
      expect(bot.controls.forward === undefined || bot.controls.forward === true).toBe(true);
      if (++looks === 4) { bot.entity.position = new Vec3(1.4, 63, 0.5); bot.entity.isInWater = false; bot.entity.onGround = true; }
      expect(point.x).toBeCloseTo(1.5);
    });
    expect(await swimOntoBank(bot, 20.5, 0.5, 2000)).toBe(true);
    expect(bot.controls).toMatchObject({ forward: false, jump: false });
    expect(looks).toBe(4);
  });

  it('still sees the water while bobbing just above it', async () => {
    const bobbing = swimmer([[0, 0]], new Vec3(0.5, 62.85, 0.5)); bobbing.entity.isInWater = false;
    expect(climbableBank(bobbing, 20.5, 0.5)).toMatchObject({ x: 1.5, y: 63, z: 0.5 });
    const popped = swimmer([[0, 0]], new Vec3(0.5, 63.1, 0.5)); popped.entity.isInWater = false;
    expect(climbableBank(popped, 20.5, 0.5)).toMatchObject({ x: 1.5, y: 63, z: 0.5 });
  });

  it('does nothing on land or with no bank beside it', async () => {
    const land = swimmer([[0, 0]], new Vec3(3.5, 63, 0.5)); land.entity.isInWater = false; land.entity.onGround = true;
    expect(await swimOntoBank(land, 20.5, 0.5, 200)).toBe(false);
    const openWater = swimmer([[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 0], [0, 1], [1, -1], [1, 0], [1, 1]]);
    expect(await swimOntoBank(openWater, 20.5, 0.5, 200)).toBe(false);
    expect(openWater.lookAt).not.toHaveBeenCalled();
  });
});

describe('leave-water: the planner asks the body to get onto dry footing', () => {
  it('reports dry footing as already reached, and open water with nothing to stand on as a failure with the way forward', async () => {
    const { default: LeaveWater } = await import('../../src/services/minebot/instantSkills/leaveWater.js');
    const controls: Record<string, boolean> = {};
    const base = { executingSkill: false, interruptExecution: false, lookAt: vi.fn(async () => {}),
      setControlState: (name: string, value: boolean) => { controls[name] = value; }, inventory: { items: () => [] } };
    const dry: any = { ...base, entity: { position: new Vec3(0.5, 64, 0.5), isInWater: false, onGround: true },
      blockAt: (position: Vec3) => block(position.y >= 64 ? 'air' : 'stone'), instantSkills: { getSkill: () => undefined } };
    expect(await new LeaveWater(dry).runImpl()).toMatchObject({ success: true, result: expect.stringContaining('水の中にいません') });

    const moveTo = { run: vi.fn(async () => ({ success: false, result: '経路なし' })) };
    const sea: any = { ...base, entity: { position: new Vec3(0.5, 62.3, 0.5), isInWater: true, onGround: false },
      blockAt: (position: Vec3) => block(position.y >= 63 ? 'air' : position.y >= 40 ? 'water' : 'stone'),
      instantSkills: { getSkill: (name: string) => name === 'move-to' ? moveTo : undefined } };
    const result: any = await new LeaveWater(sea).runImpl();
    expect(result).toMatchObject({ success: false, failureType: 'still_in_water' });
    expect(result.result).toContain('48ブロック以内の読み込み済み範囲に乾いた足場がありません');
    expect(result.result).toContain('足元に積めるブロックを持っていません');
    expect(result.result).toContain('find-dry-footholds');
    expect(moveTo.run).not.toHaveBeenCalled();

    // Blocks in hand do not help over deep water: there is no floor to stand the first one on (the body sank five blocks trying, L32).
    const tower = { run: vi.fn(async () => ({ success: false, result: '足元にブロックがありません' })) };
    const laden: any = { ...sea, inventory: { items: () => [{ name: 'cobblestone', count: 12 }] },
      instantSkills: { getSkill: (name: string) => name === 'tower-up' ? tower : name === 'move-to' ? moveTo : undefined } };
    const deep: any = await new LeaveWater(laden).runImpl();
    expect(deep.result).toContain('水底が深い');
    expect(tower.run).not.toHaveBeenCalled();
  });

  it('goes to the shore the navigator can reach most cheaply, not the nearest ledge, and looks again after each trip', async () => {
    vi.doMock('../../src/services/minebot/utils/setMovements.js', () => ({ setMovements: vi.fn() }));
    vi.resetModules();
    const { default: LeaveWater } = await import('../../src/services/minebot/instantSkills/leaveWater.js');
    // A lake with a cliff top five blocks up on the west side (x=-3) and a low bank on the east (x>=20).
    const world = (position: Vec3) => position.x <= -3 ? block(position.y >= 68 ? 'air' : 'stone')
      : position.x >= 20 ? block(position.y >= 64 ? 'air' : 'stone')
        : block(position.y >= 63 ? 'air' : position.y >= 40 ? 'water' : 'stone');
    const asked: Array<{ x: number; y: number }> = [];
    const trips: Array<{ x: number; y: number }> = [];
    const bot: any = { executingSkill: false, interruptExecution: false, lookAt: vi.fn(async () => {}), setControlState: () => {},
      entity: { position: new Vec3(0.5, 62.3, 0.5), isInWater: true, onGround: false }, inventory: { items: () => [] }, blockAt: world,
      // The navigator: the cliff top has no whole route within its thinking time, the bank costs its distance.
      pathfinder: { movements: {}, getPathFromTo: function* (_movements: unknown, _start: unknown, goal: any) { asked.push({ x: goal.x, y: goal.y });
        yield { result: goal.y >= 68 ? { status: 'timeout', cost: 9 } : { status: 'success', cost: Math.abs(goal.x - bot.entity.position.x) } }; } } };
    const moveTo = { run: vi.fn(async (x: number, y: number, z: number) => {
      trips.push({ x, y });
      // One move does not finish the swim: the first trip gets half way, the second arrives.
      if (trips.length === 1) { bot.entity.position = new Vec3(10.5, 62.3, 0.5); return { success: false, result: '移動タイムアウト' }; }
      bot.entity.position = new Vec3(x, y, z); bot.entity.isInWater = false; bot.entity.onGround = true;
      return { success: true, result: '到着' };
    }) };
    bot.instantSkills = { getSkill: (name: string) => name === 'move-to' ? moveTo : undefined };
    const result: any = await new LeaveWater(bot).runImpl();
    // Banks are put to the navigator before the nearer cliff top, and a direct swim ends the thinking.
    expect(asked[0]).toMatchObject({ y: 64 });
    expect(trips.length).toBe(2);
    expect(trips.every(trip => trip.y === 64 && trip.x >= 20)).toBe(true);
    expect(result).toMatchObject({ success: true, result: expect.stringContaining('乾いた足場') });
    vi.doUnmock('../../src/services/minebot/utils/setMovements.js');
  });

  it('stacks blocks in rounds until the feet are out, measuring the water again after each lift', async () => {
    const { default: LeaveWater } = await import('../../src/services/minebot/instantSkills/leaveWater.js');
    // A flooded 1x1 shaft in stone: water y=60..62, the rim one block above the water.
    const placed = new Set<number>();
    let cobble = 8;
    const bot: any = { executingSkill: false, interruptExecution: false, lookAt: vi.fn(async () => {}), setControlState: () => {},
      entity: { position: new Vec3(0.5, 61.2, 0.5), isInWater: true, onGround: false },
      inventory: { items: () => cobble > 0 ? [{ name: 'cobblestone', count: cobble }] : [] },
      blockAt: (position: Vec3) => position.x === 0 && position.z === 0
        ? block(placed.has(position.y) ? 'cobblestone' : position.y >= 63 ? 'air' : position.y >= 60 ? 'water' : 'stone')
        : block(position.y >= 64 ? 'air' : 'stone') };
    const lifts: number[] = [];
    const tower = { run: vi.fn(async (height: number) => {
      lifts.push(height);
      // The body sinks while placing: the first lift only reaches the top water cell.
      const base = lifts.length === 1 ? 60 : Math.floor(bot.entity.position.y);
      for (let i = 0; i < height; i++) { placed.add(base + i); cobble--; }
      const feet = base + height;
      bot.entity.position = new Vec3(0.5, feet, 0.5); bot.entity.onGround = true;
      bot.entity.isInWater = feet <= 62 && !placed.has(feet);
      return { success: true, result: 'lifted' };
    }) };
    bot.instantSkills = { getSkill: (name: string) => name === 'tower-up' ? tower : name === 'move-to' ? { run: async () => ({ success: false, result: '経路なし' }) } : undefined };
    const result: any = await new LeaveWater(bot).runImpl();
    expect(result.success).toBe(true);
    expect(result.result).toContain('足元にブロックを積んで水面の上へ出ました');
    expect(lifts.length).toBeGreaterThanOrEqual(2);
    expect(bot.entity.isInWater).toBe(false);
  });
});
