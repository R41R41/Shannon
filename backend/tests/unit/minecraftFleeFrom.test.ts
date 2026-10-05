import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';

const gotoSafeMock = vi.hoisted(() => vi.fn());
const setMovementsMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/config/env.js', () => ({ config: {} }));
vi.mock('../../src/services/minebot/config/MinebotConfig.js', () => ({ CONFIG: { SKILL_TIMEOUT_MS: 120_000 } }));
vi.mock('../../src/services/minebot/utils/setMovements.js', () => ({ setMovements: setMovementsMock }));
vi.mock('../../src/services/minebot/utils/gotoSafe.js', () => ({ gotoSafe: gotoSafeMock }));

import FleeFrom, { routeMeetsPursuer } from '../../src/services/minebot/instantSkills/fleeFrom.js';

function fixture() {
  const bot: any = {
    entity: { id: 1, position: new Vec3(0, 64, 0) },
    entities: {
      2: { id: 2, name: 'zombie', position: new Vec3(40, 64, 0) },
      3: { id: 3, name: 'skeleton', position: new Vec3(4, 64, 0) },
      4: { id: 4, name: 'cow', position: new Vec3(1, 64, 0) },
    },
    players: {},
    pathfinder: { goal: null, stop: vi.fn(), setGoal: vi.fn() },
  };
  bot.pathfinder.setGoal.mockImplementation((goal: any) => { bot.pathfinder.goal = goal; });
  return bot;
}

describe('flee-from target and safety postconditions', () => {
  beforeEach(() => {
    gotoSafeMock.mockReset();
    setMovementsMock.mockReset();
  });

  it.each(['hostile', 'all-hostiles', 'ALL-HOSTILES'])('treats %s as every classified hostile', async target => {
    const bot = fixture();
    gotoSafeMock.mockImplementation(async () => {
      bot.entity.position = new Vec3(0, 64, 40);
      return { success: true };
    });

    const result = await new FleeFrom(bot).runImpl(target, 10, 2_500);
    expect(result.success).toBe(true);
    expect(gotoSafeMock).toHaveBeenCalledTimes(1);
    const [, goal, opts] = gotoSafeMock.mock.calls[0];
    expect(goal.constructor.name).toBe('GoalNearXZ');
    expect(goal.isEnd({ x: 0, y: 64, z: 0 })).toBe(false);
    expect(goal.isEnd({ x: goal.x, y: 64, z: goal.z })).toBe(true);
    expect(goal.x).toBeLessThan(0); // both hostile mobs are east; cow is ignored
    expect(opts.timeoutMs).toBe(2_500);
  });

  it('does not flee from hostiles sealed off behind solid blocks, and says the work can go on (six orders moved 0 m, L33)', async () => {
    const bot = fixture();
    // Underground: the body in a small chamber, rock everywhere else. The skeleton 4 m away is in another pocket.
    bot.blockAt = (p: Vec3) => ({ boundingBox: (Math.abs(p.x) <= 1 && Math.abs(p.z) <= 1 && p.y >= 64 && p.y <= 65)
      || (Math.abs(p.x - 4) <= 0 && p.z === 0 && p.y >= 64 && p.y <= 65) ? 'empty' : 'block' });
    delete bot.entities[2];
    bot.entities[3].height = 1.99;
    const result = await new FleeFrom(bot).runImpl('hostile', 24);
    expect(result.success).toBe(true);
    expect(result.result).toContain('逃げる必要はありません');
    expect(result.result).toContain('skeleton');
    expect(gotoSafeMock).not.toHaveBeenCalled();
    // The same skeleton with the rock between them dug away is fled from as before.
    bot.blockAt = () => ({ boundingBox: 'empty' });
    bot.entities[3] = { id: 3, name: 'skeleton', position: new Vec3(4, 64, 0), height: 1.99 };
    gotoSafeMock.mockImplementation(async () => { bot.entity.position = new Vec3(-30, 64, 0); return { success: true }; });
    expect((await new FleeFrom(bot).runImpl('hostile', 24)).success).toBe(true);
    expect(gotoSafeMock).toHaveBeenCalledTimes(1);
  });

  it('rejects empty-path success without physical movement and tries bounded alternate goals', async () => {
    const bot = fixture();
    gotoSafeMock.mockResolvedValue({ success: true });

    const result = await new FleeFrom(bot).runImpl('hostile', 10);
    expect(result.success).toBe(false);
    expect(result.result).toContain('4.0m → 4.0m');
    expect(result.result).toContain('実際には移動していません');
    expect(result.result).toContain('近くの対象: 1体');
    expect(gotoSafeMock).toHaveBeenCalledTimes(16);
    expect(new Set(gotoSafeMock.mock.calls.map(([, goal]) => `${goal.x},${goal.z}`)).size).toBe(16);
    expect(gotoSafeMock.mock.calls[0][2].timeoutMs).toBe(5_000);
  });

  it('recovers from an empty path by selecting a different reachable retreat point', async () => {
    const bot = fixture();
    gotoSafeMock.mockResolvedValueOnce({ success: true }); // native pathfinder can resolve an empty path
    gotoSafeMock.mockImplementationOnce(async () => {
      bot.entity.position = new Vec3(-30, 64, 0);
      return { success: true };
    });

    const result = await new FleeFrom(bot).runImpl('hostile', 10);
    expect(result.success).toBe(true);
    expect(gotoSafeMock).toHaveBeenCalledTimes(2);
    const first = gotoSafeMock.mock.calls[0][1];
    const second = gotoSafeMock.mock.calls[1][1];
    expect([first.x, first.z]).not.toEqual([second.x, second.z]);
  });

  it('clears a prematurely resolved path before replanning and before returning', async () => {
    const bot = fixture();
    gotoSafeMock.mockImplementationOnce(async (_bot: any, goal: any) => {
      bot.pathfinder.setGoal(goal);
      return { success: true }; // goto() can resolve while its path remains active
    });
    gotoSafeMock.mockImplementationOnce(async (_bot: any, goal: any) => {
      expect(bot.pathfinder.goal).toBeNull();
      bot.pathfinder.setGoal(goal);
      bot.entity.position = new Vec3(-30, 64, 0);
      return { success: true };
    });

    const result = await new FleeFrom(bot).runImpl('hostile', 10);
    expect(result.success).toBe(true);
    expect(bot.pathfinder.goal).toBeNull();
    expect(bot.pathfinder.stop).toHaveBeenCalledTimes(2);
    expect(bot.pathfinder.setGoal.mock.calls.filter(([goal]: any[]) => goal === null)).toHaveLength(2);
  });

  it('does not cancel a goal acquired by another controller while flee awaited', async () => {
    const bot = fixture();
    const otherGoal = { name: 'new-owner' };
    gotoSafeMock.mockImplementationOnce(async (_bot: any, goal: any) => {
      bot.pathfinder.setGoal(goal);
      bot.pathfinder.setGoal(otherGoal);
      bot.entity.position = new Vec3(-30, 64, 0);
      return { success: true };
    });

    const result = await new FleeFrom(bot).runImpl('hostile', 10);
    expect(result.success).toBe(true);
    expect(bot.pathfinder.goal).toBe(otherGoal);
    expect(bot.pathfinder.stop).not.toHaveBeenCalled();
  });

  it.each(['zombie', '8,64,0'])('recovers from empty-path success for the %s target', async target => {
    const bot = fixture();
    bot.entities[2].position = new Vec3(8, 64, 0);
    gotoSafeMock.mockResolvedValueOnce({ success: true });
    gotoSafeMock.mockImplementationOnce(async () => {
      bot.entity.position = new Vec3(-20, 64, 0);
      return { success: true };
    });

    const result = await new FleeFrom(bot).runImpl(target, 12);
    expect(result.success).toBe(true);
    expect(gotoSafeMock).toHaveBeenCalledTimes(2);
    expect(gotoSafeMock.mock.calls[0][1].constructor.name).toBe('GoalNearXZ');
    expect(gotoSafeMock.mock.calls[1][1].constructor.name).toBe('GoalNearXZ');
  });

  it('does not accept a path result while a newly approaching hostile remains close', async () => {
    const bot = fixture();
    gotoSafeMock.mockImplementationOnce(async () => {
      bot.entity.position = new Vec3(0, 64, 40);
      bot.entities[5] = { id: 5, name: 'creeper', position: new Vec3(0, 64, 43) };
      return { success: true };
    });
    gotoSafeMock.mockResolvedValue({ success: false, error: 'no_path' });

    const result = await new FleeFrom(bot).runImpl('all-hostiles', 10);
    expect(result.success).toBe(false);
    expect(result.result).toContain('近くの対象: 1体');
  });

  it('replans from the current position when a hostile moves during navigation', async () => {
    const bot = fixture();
    gotoSafeMock.mockImplementationOnce(async () => {
      bot.entities[3].position = new Vec3(8, 64, 0);
      bot.entity.position = new Vec3(-2, 64, 0);
      return { success: true };
    });
    gotoSafeMock.mockImplementationOnce(async (_bot: any, goal: any) => {
      expect(goal.constructor.name).toBe('GoalNearXZ');
      expect(goal.x).toBeLessThan(bot.entity.position.x);
      bot.entity.position = new Vec3(-20, 64, 0);
      return { success: true };
    });

    const result = await new FleeFrom(bot).runImpl('hostile', 16);
    expect(result.success).toBe(true);
    expect(gotoSafeMock).toHaveBeenCalledTimes(2);
  });

  it('replans within the same timeout when a new hostile appears at completion', async () => {
    const bot = fixture();
    gotoSafeMock.mockImplementationOnce(async () => {
      bot.entity.position = new Vec3(0, 64, 40);
      bot.entities[5] = { id: 5, name: 'creeper', position: new Vec3(0, 64, 43) };
      return { success: true };
    });
    gotoSafeMock.mockImplementationOnce(async (_bot: any, goal: any, opts: any) => {
      expect(goal.constructor.name).toBe('GoalNearXZ');
      expect(opts.timeoutMs).toBeLessThanOrEqual(2_500);
      bot.entity.position = new Vec3(0, 64, 80);
      return { success: true };
    });

    const result = await new FleeFrom(bot).runImpl('all-hostiles', 10, 2_500);
    expect(result.success).toBe(true);
    expect(gotoSafeMock).toHaveBeenCalledTimes(2);
  });

  it('says so when the pursuers were left behind and another hostile walked up meanwhile', async () => {
    const bot = fixture();
    delete bot.entities[2];
    gotoSafeMock.mockImplementation(async () => {
      bot.entity.position = new Vec3(-30, 64, 0);
      bot.entities[9] = { id: 9, name: 'zombie', position: new Vec3(-36, 64, 0) };
      return { success: false, error: 'timeout' };
    });

    const result = await new FleeFrom(bot).runImpl('hostile', 32, 5);
    expect(result.success).toBe(false);
    expect(result.result).toContain('自分の移動: 30m');
    expect(result.result).toContain('当初の対象からは4.0m → 34.0mに離れたが、逃走中に別のzombieが6.0mに現れた');
  });

  it('chooses a lateral corridor when enemies are on opposite sides', async () => {
    const bot = fixture();
    bot.entities[2].position = new Vec3(-4, 64, 0);
    gotoSafeMock.mockImplementationOnce(async () => {
      bot.entity.position = new Vec3(0, 64, 20);
      return { success: true };
    });

    const result = await new FleeFrom(bot).runImpl('hostile', 10);
    expect(result.success).toBe(true);
    const goal = gotoSafeMock.mock.calls[0][1];
    expect(Math.abs(goal.z)).toBeGreaterThan(Math.abs(goal.x));
  });

  it('preserves partial progress as failure after a navigation timeout', async () => {
    const bot = fixture();
    bot.entities[2].position = new Vec3(8, 64, 0);
    delete bot.entities[3];
    gotoSafeMock.mockImplementation(async () => {
      bot.entity.position = new Vec3(-2, 64, 0);
      return { success: false, error: 'timeout' };
    });

    const result = await new FleeFrom(bot).runImpl('zombie', 12, 1_500);
    expect(result.success).toBe(false);
    expect(result.result).toContain('タイムアウト');
    expect(result.result).toContain('8.0m → 10.0m');
  });

  it('does not treat a thrown timeout with incomplete distance as success', async () => {
    const bot = fixture();
    bot.entities[2].position = new Vec3(8, 64, 0);
    delete bot.entities[3];
    gotoSafeMock.mockImplementationOnce(async (_bot: any, goal: any) => {
      bot.pathfinder.setGoal(goal);
      bot.entity.position = new Vec3(-2, 64, 0);
      throw new Error('timeout');
    });

    const result = await new FleeFrom(bot).runImpl('zombie', 12);
    expect(result.success).toBe(false);
    expect(result.result).toContain('タイムアウト');
    expect(result.result).toContain('8.0m → 10.0m');
    expect(bot.pathfinder.stop).toHaveBeenCalledTimes(1);
    expect(bot.pathfinder.goal).toBeNull();
  });

  it('checks a named mob at its current position after movement', async () => {
    const bot = fixture();
    bot.entities[2].position = new Vec3(4, 64, 0);
    delete bot.entities[3];
    gotoSafeMock.mockImplementation(async () => {
      bot.entity.position = new Vec3(20, 64, 0);
      bot.entities[2].position = new Vec3(18, 64, 0);
      return { success: true };
    });

    const result = await new FleeFrom(bot).runImpl('zombie', 10);
    expect(result.success).toBe(false);
    expect(result.result).toContain('4.0m → 2.0m');
  });

  it('keeps entityName fallback and coordinate targets', async () => {
    const bot = fixture();
    bot.entities[2].position = new Vec3(4, 64, 0);
    delete bot.entities[3];
    gotoSafeMock.mockImplementationOnce(async () => {
      bot.entity.position = new Vec3(-12, 64, 0);
      return { success: true };
    });
    const named = await new FleeFrom(bot).runImpl('', 10, 1_000, 'zombie');
    expect(named.success).toBe(true);
    expect(gotoSafeMock.mock.calls[0][1].constructor.name).toBe('GoalNearXZ');

    bot.entity.position = new Vec3(0, 64, 0);
    gotoSafeMock.mockImplementationOnce(async () => {
      bot.entity.position = new Vec3(-2, 64, 0);
      return { success: true };
    });
    const coordinate = await new FleeFrom(bot).runImpl('8,64,0', 10);
    expect(coordinate.success).toBe(true);
    expect(gotoSafeMock.mock.calls[1][1].constructor.name).toBe('GoalNearXZ');
  });

  it('retains named player lookup and the existing already-safe shortcut', async () => {
    const bot = fixture();
    bot.players.Player123 = { entity: { username: 'Player123', position: new Vec3(30, 64, 0) } };

    const result = await new FleeFrom(bot).runImpl('Player123', 10);
    expect(result.success).toBe(true);
    expect(result.result).toContain('Player123');
    expect(gotoSafeMock).not.toHaveBeenCalled();
  });

  it('returns safely when no classified hostile is visible', async () => {
    const bot = fixture();
    delete bot.entities[2];
    delete bot.entities[3];

    const result = await new FleeFrom(bot).runImpl('hostile', 10);
    expect(result.success).toBe(true);
    expect(gotoSafeMock).not.toHaveBeenCalled();
  });

  it('does not run a way out that passes where the pursuer gets first, and says there is none in a dead end (paid run L84: sprinted back down the gallery into a creeper)', async () => {
    const bot = fixture();
    delete bot.entities[2];
    bot.entities[3] = { id: 3, name: 'creeper', position: new Vec3(8, 64, 0), height: 1.7 };
    // A gallery running east: whatever the goal, the only way out is back past the creeper.
    const east = Array.from({ length: 30 }, (_, i) => ({ x: i + 1, y: 64, z: 0 }));
    bot.pathfinder.getPathTo = vi.fn(() => ({ status: 'success', path: east }));
    const result: any = await new FleeFrom(bot).runImpl('hostile', 24);
    expect(result.success).toBe(false);
    expect(result.failureType).toBe('no_escape_route');
    expect(result.result).toContain('逃げ道がありません');
    expect(result.result).toContain('creeper');
    expect(result.result).toContain('slit_shelter');
    expect(gotoSafeMock).not.toHaveBeenCalled();
    expect(bot.pathfinder.getPathTo.mock.calls.length).toBeLessThanOrEqual(6);
    // Open ground the other way: the route away is run as before.
    const west = Array.from({ length: 30 }, (_, i) => ({ x: -i - 1, y: 64, z: 0 }));
    bot.pathfinder.getPathTo = vi.fn(() => ({ status: 'success', path: west }));
    gotoSafeMock.mockImplementation(async () => { bot.entity.position = new Vec3(-30, 64, 0); return { success: true }; });
    expect((await new FleeFrom(bot).runImpl('hostile', 24)).success).toBe(true);
    expect(gotoSafeMock).toHaveBeenCalledTimes(1);
  });

  it('a route is met where the pursuer could reach it first: straight at it, not beside it at the same distance', () => {
    const start = new Vec3(0, 64, 0);
    const creeper = [{ position: new Vec3(15, 64, 0), name: 'creeper' }];
    const toward = Array.from({ length: 20 }, (_, i) => ({ x: i + 1, y: 64, z: 0 }));
    const across = Array.from({ length: 20 }, (_, i) => ({ x: 0, y: 64, z: i + 1 }));
    expect(routeMeetsPursuer(start, toward, creeper)?.name).toBe('creeper');
    expect(routeMeetsPursuer(start, across, creeper)).toBeNull();
    // Already beside the body: any step that does not go nearer still counts as away.
    expect(routeMeetsPursuer(start, across, [{ position: new Vec3(1.5, 64, 0), name: 'zombie' }])).toBeNull();
  });

  it('fleeing one named mob, does not run a way past another hostile (paid run L88b: away from a hoglin, into two piglins)', async () => {
    const bot = fixture();
    bot.entities = { 2: { id: 2, name: 'hoglin', position: new Vec3(-6, 64, 0), height: 1.4 }, 3: { id: 3, name: 'zombie', position: new Vec3(8, 64, 0), height: 1.95 } };
    const east = Array.from({ length: 30 }, (_, i) => ({ x: i + 1, y: 64, z: 0 }));
    bot.pathfinder.getPathTo = vi.fn(() => ({ status: 'success', path: east }));
    const result: any = await new FleeFrom(bot).runImpl('hoglin', 24);
    expect(result.failureType).toBe('no_escape_route');
    expect(result.result).toContain('zombie');
    expect(gotoSafeMock).not.toHaveBeenCalled();
  });
});

