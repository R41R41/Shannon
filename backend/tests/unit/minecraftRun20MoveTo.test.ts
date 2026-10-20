import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';

const gotoSafeMock = vi.hoisted(() => vi.fn());
const setMovementsMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/config/env.js', () => ({ config: {} }));
vi.mock('../../src/services/minebot/config/MinebotConfig.js', () => ({ CONFIG: { SKILL_TIMEOUT_MS: 120_000 } }));
vi.mock('../../src/services/minebot/utils/setMovements.js', () => ({ setMovements: setMovementsMock }));
vi.mock('../../src/services/minebot/utils/gotoSafe.js', () => ({ gotoSafe: gotoSafeMock }));

import MoveTo from '../../src/services/minebot/instantSkills/moveTo.js';
import { installRespawnTracker } from '../../src/services/minebot/utils/respawnSettle.js';

const rock = { name: 'deepslate', boundingBox: 'block', diggable: true, digTime: () => 600 };

function fixture(solid: boolean) {
  const bot: any = new EventEmitter();
  Object.assign(bot, {
    entity: { position: new Vec3(0.5, -58, 0.5), isInWater: false },
    constantSkills: { getSkill: vi.fn(() => null) },
    inventory: { items: vi.fn(() => [{ name: 'diamond_pickaxe', type: 1, count: 1 }]) },
    clearControlStates: vi.fn(), stopDigging: vi.fn(),
    blockAt: vi.fn(() => (solid ? rock : { name: 'air', boundingBox: 'empty' })),
  });
  return bot;
}

describe('run 20: move-to through rock', () => {
  beforeEach(() => { gotoSafeMock.mockReset(); setMovementsMock.mockReset(); });

  it('refuses at once, with the figures, a goal so far through rock that the digging alone needs more than two calls', async () => {
    const bot = fixture(true);
    const result: any = await new MoveTo(bot).runImpl(150.5, -58, 0.5, 2, 'near');
    expect(gotoSafeMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: false, failureType: 'tunnel_too_long', recoverable: true });
    expect(result.result).toContain('岩の中を約150m掘り進む');
    expect(result.result).toContain('秒');
  });

  it('goes on with a goal that rock makes slow but that one or two calls can reach, and with a caller that bounds the time itself', async () => {
    const bot = fixture(true);
    gotoSafeMock.mockResolvedValue({ success: false, error: 'timeout' });
    const near: any = await new MoveTo(bot).runImpl(40.5, -58, 0.5, 2, 'near');
    expect(gotoSafeMock).toHaveBeenCalledTimes(1);
    expect(near.failureType).not.toBe('tunnel_too_long');
    gotoSafeMock.mockClear();
    await new MoveTo(bot).runImpl(150.5, -58, 0.5, 2, 'block', 100_000);
    expect(gotoSafeMock).toHaveBeenCalledTimes(1);
  });

  it('open ground is not refused however far, and keeps the words the head reads (movement_incomplete, "同じ目標で再実行すれば続きから進めます")', async () => {
    const bot = fixture(false);
    gotoSafeMock.mockImplementation(async () => { bot.entity.position = new Vec3(100.5, -58, 0.5); return { success: false, error: 'timeout' }; });
    const result: any = await new MoveTo(bot).runImpl(300.5, -58, 0.5, 2, 'near');
    expect(result.failureType).toBe('movement_incomplete');
    expect(result.result).toContain('同じ目標で再実行すれば続きから進めます');
  });

  it('waits for the chunks to settle when the body respawned a moment ago, and only for a far walk', async () => {
    const bot = fixture(false);
    installRespawnTracker(bot);
    bot.emit('respawn');
    gotoSafeMock.mockResolvedValue({ success: true });
    const started = Date.now();
    await new MoveTo(bot).runImpl(5.5, -58, 0.5, 2, 'nearxz');
    expect(Date.now() - started).toBeLessThan(500);
    const far = Date.now();
    await new MoveTo(bot).runImpl(300.5, -58, 0.5, 2, 'nearxz');
    expect(Date.now() - far).toBeGreaterThanOrEqual(1400);
    expect(Date.now() - far).toBeLessThan(4000);
  });
});
