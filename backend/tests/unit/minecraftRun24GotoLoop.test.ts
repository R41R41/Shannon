import { describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import pathfinder from 'mineflayer-pathfinder';

// Run 24: the tunnel walk stopped at the same place for the same reason (gravel over a cell, lava beside one, a bank of water) and was
// planned again a second later, 70 s with nothing dug, because the cells already dug were walked first (steps >= 1) and only "no step at
// all" ended the rounds. A stop that comes a second time leaves its cell out of the plans; a third time it is said and the walk ends.
const walker = vi.hoisted(() => ({ outcomes: [] as any[], calls: 0, avoids: [] as string[][] }));
vi.mock('../../src/config/env.js', () => ({ config: {} }));
vi.mock('../../src/services/minebot/utils/rockTravel.js', () => ({
  chooseRockTravel: (_bot: any, _goal: any, _env: any, options: any) => {
    walker.avoids.push([...(options?.avoid ?? [])]);
    return { mode: 'cells', cells: [new Vec3(1, 40, 0), new Vec3(2, 40, 0)], seconds: 5, source: 'tunnel', digs: 4 };
  },
}));
vi.mock('../../src/services/minebot/utils/tunnelWalk.js', async (original) => ({
  ...(await original() as object),
  walkCells: async () => { walker.calls++; return walker.outcomes.shift() ?? { stopped: 'plan_end', steps: 0, digs: 0 }; },
}));

const { gotoSafe } = await import('../../src/services/minebot/utils/gotoSafe.js');
const { goals } = pathfinder;

function bodyAt(x = 0.5) {
  const stone = (p: Vec3) => ({ name: 'stone', position: p.floored(), boundingBox: 'block' });
  return {
    entity: { position: new Vec3(x, 40, 0.5), yaw: 0, onGround: true },
    blockAt: stone, clearControlStates: vi.fn(), setControlState: vi.fn(), stopDigging: vi.fn(), lookAt: async () => {},
    pathfinder: {
      isMining: () => false, isBuilding: () => false, isMoving: () => true, stop: vi.fn(), setGoal: vi.fn(), setMovements: vi.fn(), movements: {},
      goto: async () => { await new Promise(resolve => setTimeout(resolve, 5)); },
    },
  } as any;
}
const blocked = (reason: string, steps = 4) => ({ stopped: 'blocked', steps, digs: 0, at: { x: 9, y: 40, z: 0 }, reason });

describe('a tunnel walk that stops at the same place for the same reason is not planned again and again (run 24)', () => {
  it('the third identical stop ends the walk and says why: three walks, not five rounds', async () => {
    walker.calls = 0; walker.avoids.length = 0;
    walker.outcomes = Array.from({ length: 8 }, () => blocked('falling_above:gravel(9,40,0)'));
    const result = await gotoSafe(bodyAt(), new goals.GoalNear(30, 40, 0, 1) as any, { timeoutMs: 20_000, rockTravel: true });
    expect(result.success).toBe(false);
    expect(result.error).toBe('stuck');
    expect(result.activity).toContain('falling_above:gravel');
    expect(result.activity).toContain('3回');
    expect(walker.calls).toBe(3);
  });

  it('from the second stop the cell is left out of the plans', async () => {
    walker.calls = 0; walker.avoids.length = 0;
    walker.outcomes = [blocked('lava_beside:lava(9,40,0)'), blocked('lava_beside:lava(9,40,0)'), { stopped: 'reached', steps: 3, digs: 0 }];
    const result = await gotoSafe(bodyAt(), new goals.GoalNear(30, 40, 0, 1) as any, { timeoutMs: 20_000, rockTravel: true });
    expect(result).toEqual({ success: true });
    expect(walker.avoids[0]).toEqual([]);
    expect(walker.avoids[1]).toEqual([]);
    expect(walker.avoids[2]).toContain('9,40,0');
  });

  it('a stop that is not the same (another reason, another cell) is a new one, and walks go on', async () => {
    walker.calls = 0; walker.avoids.length = 0;
    walker.outcomes = [
      blocked('lava_beside:lava(9,40,0)'), { ...blocked('liquid_beside:water(12,40,0)'), at: { x: 12, y: 40, z: 0 } },
      blocked('lava_beside:lava(9,40,0)'), { ...blocked('liquid_beside:water(12,40,0)'), at: { x: 12, y: 40, z: 0 } },
      { stopped: 'reached', steps: 3, digs: 0 }];
    const result = await gotoSafe(bodyAt(), new goals.GoalNear(30, 40, 0, 1) as any, { timeoutMs: 20_000, rockTravel: true });
    expect(result).toEqual({ success: true });
    expect(walker.calls).toBe(5);
  });

  it('a later call of the same body remembers: the third stop may come in a call of its own', async () => {
    walker.calls = 0; walker.avoids.length = 0;
    const body = bodyAt();
    walker.outcomes = [blocked('liquid_beside:water(9,40,0)'), blocked('liquid_beside:water(9,40,0)')];
    // two stops in the first call (the fake ends the rounds with a plan that walks nowhere after them)
    await gotoSafe(body, new goals.GoalNear(30, 40, 0, 1) as any, { timeoutMs: 3_000, rockTravel: true });
    walker.outcomes = [blocked('liquid_beside:water(9,40,0)')];
    const second = await gotoSafe(body, new goals.GoalNear(30, 40, 0, 1) as any, { timeoutMs: 3_000, rockTravel: true });
    expect(second.success).toBe(false);
    expect(second.activity).toContain('liquid_beside:water');
  });
});
