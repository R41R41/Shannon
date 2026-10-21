import { describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import pathfinder from 'mineflayer-pathfinder';

// Run 22: a 56 m walk begun in the water (a bucket just filled) went the route search's way, leg by leg, 74 s: the rock walk was never
// chosen. The body is brought out of the water first and the walk is chosen again from land.
const chooser = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock('../../src/config/env.js', () => ({ config: {} }));
vi.mock('../../src/services/minebot/utils/rockTravel.js', () => ({
  chooseRockTravel: (bot: any) => {
    const wet = bot.entity.isInWater === true;
    chooser.calls.push(wet ? 'in_water' : 'walk');
    return wet ? { mode: 'default', why: 'in_water' } : { mode: 'walk', movements: { profile: 'walk' }, seconds: 12 };
  },
}));

const { gotoSafe } = await import('../../src/services/minebot/utils/gotoSafe.js');
const { goals } = pathfinder;

/** A pond whose west half is water (surface y 62, floor y 57) and whose east is stone up to y 61. */
function pondBot(options: { bank?: boolean } = {}) {
  const asked: string[] = [];
  const cell = (x: number, y: number) => {
    if (x <= 2) return y <= 57 ? 'stone' : y <= 62 ? 'water' : 'air';
    return y <= 61 ? 'stone' : 'air';
  };
  const bot: any = {
    entity: { position: new Vec3(0.5, 62, 0.5), yaw: 0, onGround: false, isInWater: true },
    blockAt: (p: Vec3) => { const q = p.floored(); const name = cell(q.x, q.y); return { name, position: q, boundingBox: ['air', 'water'].includes(name) ? 'empty' : 'block' }; },
    clearControlStates: vi.fn(), setControlState: vi.fn(), stopDigging: vi.fn(), lookAt: async () => {},
    pathfinder: {
      isMining: () => false, isBuilding: () => false, isMoving: () => true, stop: vi.fn(), setGoal: vi.fn(),
      movements: { profile: 'swim' }, setMovements(movements: unknown) { this.movements = movements; asked.push(`movements:${(movements as any).profile}`); },
      goto: async (goal: any) => {
        asked.push(`${goal.constructor.name}(${goal.x},${goal.y},${goal.z})`);
        await new Promise(resolve => setTimeout(resolve, 5));
        // The body arrives at the goal it was given; a goal on land takes it out of the water.
        bot.entity.position = new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5);
        bot.entity.isInWater = false; bot.entity.onGround = true;
      },
    },
  };
  void options;
  return { bot, asked };
}

describe('a walk that begins in the water is chosen from land (run 22: 74 s for 56 m)', () => {
  it('brings the body to a dry stand first, then asks for the rock walk again and takes it', async () => {
    chooser.calls.length = 0;
    const { bot, asked } = pondBot();
    const goal = new goals.GoalNear(-80, 15, 32, 2);
    const result = await gotoSafe(bot, goal as any, { timeoutMs: 10_000, rockTravel: true });
    expect(result).toEqual({ success: true });
    // asked for the stand on the east bank first (3 m away or so), then the walk profile, then the real goal
    expect(asked[0]).toMatch(/^GoalNear\(\d+,62,-?\d+\)$/);
    expect(Number(/^GoalNear\((\d+),/.exec(asked[0])![1])).toBeGreaterThanOrEqual(3);
    expect(asked).toContain('movements:walk');
    expect(asked.filter(line => line.startsWith('GoalNear')).at(-1)).toBe('GoalNear(-80,15,32)');
    expect(chooser.calls).toEqual(['in_water', 'walk']);
  });

  it('without rockTravel asked for, the water is left to the route search as before', async () => {
    chooser.calls.length = 0;
    const { bot, asked } = pondBot();
    const result = await gotoSafe(bot, new goals.GoalNear(40, 62, 0, 2) as any, { timeoutMs: 5_000 });
    expect(result.success).toBe(true);
    expect(chooser.calls).toEqual([]);
    expect(asked).toEqual(['GoalNear(40,62,0)']);
  });

  it('a pond with no dry stand near goes on as the route search would, once (it does not try again and again)', async () => {
    chooser.calls.length = 0;
    const { bot, asked } = pondBot();
    bot.blockAt = (p: Vec3) => { const q = p.floored(); return { name: q.y <= 57 ? 'stone' : q.y <= 62 ? 'water' : 'air', position: q, boundingBox: q.y <= 57 ? 'block' : 'empty' }; };
    const result = await gotoSafe(bot, new goals.GoalNear(40, 62, 0, 2) as any, { timeoutMs: 5_000, rockTravel: true });
    expect(result.success).toBe(true);
    expect(chooser.calls).toEqual(['in_water']);
    expect(asked).toEqual(['GoalNear(40,62,0)']);
  });
});
