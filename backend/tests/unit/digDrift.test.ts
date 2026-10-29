import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeHandsSim, type Ground, type HandsSim } from '../helpers/handsSim.js';
import { dig } from '../../src/services/minebot/utils/primitives/dig.js';
import type { StepContext } from '../../src/services/minebot/utils/primitives/common.js';

// Run 46 (hold 6): the water poured over the lava carried the body 7 m away while it dug obsidian; the dig waited for its guard (49 s) and the hand stood still.
// A body that has left the reach of the block it digs stops the dig at once (out_of_reach), so that the hand can stand again.
beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] }); });
afterEach(() => { vi.useRealTimers(); });

const FLOOR = 64;
const ground: Ground = (x, y, z) => (Math.abs(x) > 40 || Math.abs(z) > 40 ? null : x === 3 && y === FLOOR && z === 0 ? 'obsidian' : y < FLOOR ? 'stone' : 'air');
const ctxOf = (sim: HandsSim): StepContext => ({ bot: sim.bot, stop: new AbortController().signal, deadline: Date.now() + 600_000, facing: 'east', base: { x: 0, y: FLOOR, z: 0 } });
async function drive<T>(sim: HandsSim, promise: Promise<T>, each?: (elapsedMs: number) => void, maxMs = 120_000): Promise<{ value: T; elapsed: number }> {
  let settled = false, elapsed = 0;
  promise.then(() => { settled = true; }, () => { settled = true; });
  for (; elapsed < maxMs && !settled; elapsed += 50) { sim.tick(); each?.(elapsed); await vi.advanceTimersByTimeAsync(50); }
  return { value: await promise, elapsed };
}

describe('dig: a body carried out of reach while it digs', () => {
  it('stops at once with out_of_reach (not after the dig\'s long guard), and the block is still there', async () => {
    const sim = makeHandsSim(ground, { items: [{ name: 'diamond_pickaxe', count: 1 }] });
    // a server does not break a block from out of reach: the dig never comes back
    sim.bot.dig = () => new Promise(() => undefined);
    const { value, elapsed } = await drive(sim, dig(ctxOf(sim), { at: [{ x: 3, y: FLOOR, z: 0 }], tool: 'diamond_pickaxe', collect: false }), time => {
      if (time === 1000) sim.bot.entity.position.x = 12.5;   // carried away by the water
    });
    expect(value.ok).toBe(false);
    expect(value.reason).toBe('out_of_reach');
    expect(value.text).toContain('流されて届かなくなった');
    expect(elapsed).toBeGreaterThan(12_000);
    expect(elapsed).toBeLessThan(14_000);   // the block's own time (9.4 s) and three seconds over, not the guard of 31 s (the lab's was 49)
    expect(sim.world.nameAt(3, FLOOR, 0)).toBe('obsidian');
  });

  it('a body that stays where it is digs as before', async () => {
    const sim = makeHandsSim(ground, { items: [{ name: 'diamond_pickaxe', count: 1 }] });
    const { value } = await drive(sim, dig(ctxOf(sim), { at: [{ x: 3, y: FLOOR, z: 0 }], tool: 'diamond_pickaxe', collect: false }));
    expect(value.ok).toBe(true);
    expect(sim.world.nameAt(3, FLOOR, 0)).toBe('air');
  });
});
