import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import { makeSim } from '../helpers/physicsBody.js';
import { attack } from '../../src/services/minebot/utils/primitives/attack.js';

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }));
afterEach(() => vi.useRealTimers());

it('tells the next decision that a swing without a hurt event was not a landed blow', async () => {
  const sim = makeSim((_x, y, _z) => y < 64 ? 'stone' : 'air');
  const fish = { id: 7, name: 'salmon', type: 'mob', position: new Vec3(0.5, 64, 0.5), height: 0.3, width: 0.5 };
  sim.bot.entities[7] = fish;
  sim.bot.pathfinder.setGoal = vi.fn();
  sim.bot.pathfinder.setMovements = vi.fn();
  sim.bot.attack = vi.fn(() => { fish.position = new Vec3(40, 64, 0.5); });
  const promise = attack({ bot: sim.bot, stop: new AbortController().signal, deadline: Date.now() + 8000,
    facing: 'north', base: { x: 0, y: 64, z: 0 } }, { target: 7, maxSeconds: 7 });
  let finished = false;
  promise.finally(() => { finished = true; }).catch(() => {});
  for (let ms = 0; ms < 8000 && !finished; ms += 50) { sim.tick(); await vi.advanceTimersByTimeAsync(50); }
  const result = await promise;
  expect(sim.bot.attack).toHaveBeenCalledTimes(1);
  expect(result.ok).toBe(false);
  expect(result.progress?.done).toBe(0);
  expect(result.text).toContain('1回振って 0回当たった');
});
