import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSim, type Ground, type Sim } from '../helpers/physicsBody.js';
import { aheadOf, go } from '../../src/services/minebot/utils/primitives/go.js';
import type { StepContext } from '../../src/services/minebot/utils/primitives/common.js';

// Run 45, hold 2 (2026-10-28; the scene 20261028T021446-act-1x9x5 and its box): q78 go 9 up out of a dip with flowing water in it. The way the
// search drew stepped out of the water against its current; the body was pushed back at the same step for 34 s (five drawings of the same way,
// a mending after each), and the 60 s ran out 6 m short. A cell the body could not get into is avoided by the next drawings.
const FLOOR = 64;
const R = 24;
const flat: Ground = (x, y, z) => (Math.abs(x) > R || Math.abs(z) > R ? null : y < FLOOR ? 'stone' : 'air');
const ctxOf = (sim: Sim): StepContext => ({ bot: sim.bot, stop: new AbortController().signal, deadline: Date.now() + 600_000, facing: 'north', base: { x: 0, y: FLOOR, z: 0 } });
async function drive<T>(sim: Sim, promise: Promise<T>, maxMs = 180_000): Promise<T> {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  for (let elapsed = 0; elapsed < maxMs && !settled; elapsed += 50) { sim.tick(); await vi.advanceTimersByTimeAsync(50); }
  return promise;
}

describe('run 45, hold 2: a cell the body cannot get into', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }); });
  afterEach(() => { vi.useRealTimers(); });

  it('is the next cell of the route after the one the body stands nearest', () => {
    const route = [{ x: 1, y: 64, z: 0 }, { x: 2, y: 64, z: 0 }, { x: 3, y: 64, z: 0 }];
    expect(aheadOf(route, { x: 2.5, y: 64, z: 0.5 })).toEqual({ x: 3, y: 64, z: 0 });
    expect(aheadOf(route, { x: 0.4, y: 64, z: 0.5 })).toEqual({ x: 1, y: 64, z: 0 });
    expect(aheadOf([], { x: 0, y: 64, z: 0 })).toBeNull();
  });

  it('is gone round by the next drawing, where it used to be stuck at the same step to the end', async () => {
    // A short wall only the physics knows (as a current pushes a body back): x=3, two high, z from -2 to 2. The map shows open ground.
    const ghost = (x: number, y: number, z: number) => (x === 3 && Math.abs(z) <= 2 && y >= FLOOR && y <= FLOOR + 1 ? 'stone' : undefined);
    const sim = makeSim(flat, { ghost });
    const outcome = await drive(sim, go(ctxOf(sim), { goals: [{ x: 7, y: FLOOR, z: 0 }], seconds: 120 }));
    expect(outcome.text).toMatch(/^go 着いた/u);
    expect(sim.bot.entity.position.x).toBeGreaterThan(6);
  });
});
