import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';

const gotoSafeMock = vi.hoisted(() => vi.fn());
const setMovementsMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/config/env.js', () => ({ config: {} }));
vi.mock('../../src/services/minebot/config/MinebotConfig.js', () => ({ CONFIG: { SKILL_TIMEOUT_MS: 120_000 } }));
vi.mock('../../src/services/minebot/utils/setMovements.js', () => ({ setMovements: setMovementsMock }));
vi.mock('../../src/services/minebot/utils/gotoSafe.js', () => ({ gotoSafe: gotoSafeMock }));

import MoveTo from '../../src/services/minebot/instantSkills/moveTo.js';

function fixture() {
  const bot: any = {
    entity: { position: new Vec3(0.5, 64, 0.5), isInWater: false },
    constantSkills: { getSkill: vi.fn(() => null) },
    inventory: { items: vi.fn(() => []) },
    clearControlStates: vi.fn(),
    stopDigging: vi.fn(),
  };
  return bot;
}

describe('move-to native arrival postcondition', () => {
  beforeEach(() => {
    gotoSafeMock.mockReset();
    setMovementsMock.mockReset();
  });

  it('rejects pathfinder success four metres outside a range-one XYZ goal', async () => {
    const bot = fixture();
    gotoSafeMock.mockImplementation(async () => {
      bot.entity.position = new Vec3(52.5, 66, 31.5);
      return { success: true };
    });

    const result = await new MoveTo(bot).runImpl(48.5, 66, 31.5, 1, 'near');
    expect(result.success).toBe(false);
    expect(result.failureType).toBe('position_verification_failed');
    expect(result.result).toContain('実距離: 4.0m');
  });

  it('rejects the three-metre Y error previously hidden by the fixed five-metre tolerance', async () => {
    const bot = fixture();
    gotoSafeMock.mockImplementation(async () => {
      bot.entity.position = new Vec3(48.5, 69, 31.5);
      return { success: true };
    });

    const result = await new MoveTo(bot).runImpl(48.5, 66, 31.5, 1, 'near');
    expect(result.success).toBe(false);
    expect(result.failureType).toBe('position_verification_failed');
    expect(result.result).toContain('実距離: 3.0m');
  });

  it('preserves success within the native block-coordinate GoalNear radius', async () => {
    const bot = fixture();
    gotoSafeMock.mockImplementation(async () => {
      bot.entity.position = new Vec3(48.2, 66, 31.2);
      return { success: true };
    });

    const result = await new MoveTo(bot).runImpl(48.5, 66, 31.5, 1, 'near');
    expect(result.success).toBe(true);
    expect(gotoSafeMock.mock.calls[0][1].isEnd(bot.entity.position.floored())).toBe(true);
  });

  it('checks only XZ for nearxz, even if the terrain height differs', async () => {
    const bot = fixture();
    gotoSafeMock.mockImplementation(async () => {
      bot.entity.position = new Vec3(48.2, 80, 31.2);
      return { success: true };
    });

    const result = await new MoveTo(bot).runImpl(48.5, 66, 31.5, 1, 'nearxz');
    expect(result.success).toBe(true);
  });

  it.each([
    ['xz', new Vec3(50.2, 66, 31.2)],
    ['y', new Vec3(48.2, 69, 31.2)],
  ] as const)('rejects a prematurely resolved %s goal without the prior five-metre allowance', async (goalType, finalPos) => {
    const bot = fixture();
    gotoSafeMock.mockImplementation(async () => {
      bot.entity.position = finalPos;
      return { success: true };
    });

    const result = await new MoveTo(bot).runImpl(48.5, 66, 31.5, 1, goalType);
    expect(result.success).toBe(false);
    expect(result.failureType).toBe('position_verification_failed');
  });

  it('sizes the time to the distance and reports how far it got when time runs out (paid run L18)', async () => {
    const bot = fixture();
    bot.inventory.items = vi.fn(() => [{ name: 'stone_pickaxe', count: 1 }]);
    gotoSafeMock.mockImplementation(async () => {
      bot.entity.position = new Vec3(45.5, 63, 0.5);
      return { success: false, error: 'timeout' };
    });

    const result: any = await new MoveTo(bot).runImpl(63.5, 64, 0.5, 3, 'nearxz');
    expect(gotoSafeMock.mock.calls[0][2].timeoutMs).toBe(42_000); // 63m at the slowest travel speed
    expect(result.success).toBe(false);
    expect(result.failureType).toBe('movement_incomplete');
    expect(result.result).toContain('目標までの距離: 63.0m → 18.0m（現在: 45.5, 63.0, 0.5）');
    expect(result.result).toContain('同じ目標で再実行すれば続きから進めます');
  });

  it('keeps a short move at thirty seconds and still calls a move that went nowhere a failure', async () => {
    const bot = fixture();
    bot.inventory.items = vi.fn(() => [{ name: 'stone_pickaxe', count: 1 }]);
    gotoSafeMock.mockResolvedValue({ success: false, error: 'timeout' });

    const result: any = await new MoveTo(bot).runImpl(10.5, 64, 0.5, 1, 'nearxz');
    expect(gotoSafeMock.mock.calls[0][2].timeoutMs).toBe(30_000);
    expect(result.failureType).toBe('movement_failed');
    expect(result.result).toContain('目標までの距離: 10.0m → 10.0m');
    expect(result.result).not.toContain('続きから');
  });

  it('without a pickaxe the way may be dug by hand, seconds a block: the move gets all the time a move may take, and says what it is doing', async () => {
    const bot = fixture(); // nothing in the pack
    gotoSafeMock.mockImplementation(async () => {
      bot.entity.position = new Vec3(0.5, 64, 1.5);
      return { success: false, error: 'timeout', activity: 'stone(0, 64, 2)を掘削中' };
    });
    const result: any = await new MoveTo(bot).runImpl(10.5, 64, 0.5, 1, 'nearxz');
    expect(gotoSafeMock.mock.calls[0][2].timeoutMs).toBe(110_000);
    expect(result.result).toContain('素手で掘り進んでいます');
    expect(result.result).toContain('同じ目標で再実行');
  });

  it('never asks for more time than the skill itself is allowed', async () => {
    const bot = fixture();
    gotoSafeMock.mockResolvedValue({ success: false, error: 'no_path' });

    await new MoveTo(bot).runImpl(900.5, 64, 0.5, 3, 'nearxz');
    expect(gotoSafeMock.mock.calls[0][2].timeoutMs).toBe(110_000);
  });

  it('a move that ends where it began says so, and why, instead of "moved but did not arrive" (paid run L73: thirty such answers in a pit)', async () => {
    const bot = fixture();
    // The route planner hands back an empty route: "success", and the body has not moved.
    gotoSafeMock.mockImplementation(async () => ({ success: true }));
    const stuck = await new MoveTo(bot).runImpl(-466, 72, -235, 4, 'nearxz');
    expect(stuck).toMatchObject({ success: false, failureType: 'no_route_from_here' });
    expect(stuck.result).toContain('その場から動けませんでした');
    expect(stuck.result).toContain('つるはしが無い');
    expect(stuck.result).toContain('collect=false');
    // With a dig the body's guards refused on the way, that is the reason given.
    const guarded = fixture();
    guarded.exposureDigGuard = { refused: 0 };
    gotoSafeMock.mockImplementation(async () => { guarded.exposureDigGuard = { refused: 1, last: '掘削中止: stoneを開けると、いまは届かないzombie（約4m）から身体が見える・届くようになります' }; return { success: true }; });
    const refused = await new MoveTo(guarded).runImpl(10, 64, 0, 1, 'near');
    expect(refused.result).toContain('経路上の掘削を断りました');
    expect(refused.result).toContain('zombie');
    // Already there: said as that, not as a journey.
    const here = fixture();
    gotoSafeMock.mockImplementation(async () => ({ success: true }));
    const already = await new MoveTo(here).runImpl(2, 64, 0, 8, 'nearxz');
    expect(already.success).toBe(true);
    expect(already.result).toContain('既に');
  });
});

