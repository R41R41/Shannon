import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';

// Run 22: a move begun in the water had the rock walk turned off for good ("rockTravel = !isInWater"), so the 56 m walk to the lava went the
// route search's way. The choice is now gotoSafe's, which brings the body out of the water first.
const gotoSafeMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/config/env.js', () => ({ config: {} }));
vi.mock('../../src/services/minebot/config/MinebotConfig.js', () => ({ CONFIG: { SKILL_TIMEOUT_MS: 120_000 } }));
vi.mock('../../src/services/minebot/utils/setMovements.js', () => ({ setMovements: vi.fn() }));
vi.mock('../../src/services/minebot/utils/gotoSafe.js', () => ({ gotoSafe: gotoSafeMock }));

import MoveTo from '../../src/services/minebot/instantSkills/moveTo.js';

const stone = { name: 'stone', boundingBox: 'block', diggable: true, digTime: () => 600 };

function fixture(inWater: boolean) {
  const bot: any = new EventEmitter();
  Object.assign(bot, {
    entity: { position: new Vec3(0.5, 62, 0.5), isInWater: inWater },
    constantSkills: { getSkill: vi.fn(() => null) },
    inventory: { items: vi.fn(() => [{ name: 'iron_pickaxe', type: 1, count: 1 }]) },
    clearControlStates: vi.fn(), stopDigging: vi.fn(),
    blockAt: vi.fn(() => stone),
  });
  return bot;
}

describe('run 22: move-to begun in the water still asks for the rock walk', () => {
  beforeEach(() => gotoSafeMock.mockReset());

  it('passes rockTravel on for a body in the water, as for one on land', async () => {
    gotoSafeMock.mockResolvedValue({ success: false, error: 'timeout' });
    await new MoveTo(fixture(true)).runImpl(-30.5, 25, 20.5, 2, 'near');
    expect(gotoSafeMock.mock.calls[0][2]).toMatchObject({ rockTravel: true });
    gotoSafeMock.mockClear();
    await new MoveTo(fixture(false)).runImpl(-30.5, 25, 20.5, 2, 'near');
    expect(gotoSafeMock.mock.calls[0][2]).toMatchObject({ rockTravel: true });
  });
});
