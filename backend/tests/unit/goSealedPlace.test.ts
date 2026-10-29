import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSim, type Ground, type Sim } from '../helpers/physicsBody.js';
import { go } from '../../src/services/minebot/utils/primitives/go.js';

// Run 47 (hold 6): a go to (190,-13,180), where the place and the cell over it were clay and the go could dig stone and deepslate only. No search can end in a block that is not dug: each ran
// its 5 s out, six times, 50 s in all. A place that is a block not on the list is said before any search, with the way out: dig it (canDig) or go to a cell beside it.
beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] }); });
afterEach(() => { vi.useRealTimers(); });

const FLOOR = 64;
const ground: Ground = (x, y, z) => {
  if (Math.abs(x) > 30 || Math.abs(z) > 30) return null;
  if (y < FLOOR) return 'stone';
  if (x === 5 && z === 0 && (y === FLOOR || y === FLOOR + 1)) return 'clay';
  return 'air';
};
const ctxOf = (sim: Sim) => ({ bot: sim.bot, stop: new AbortController().signal, deadline: Date.now() + 600_000, facing: 'east' as const, base: { x: 0, y: FLOOR, z: 0 } });
async function drive<T>(sim: Sim, promise: Promise<T>, maxMs = 60_000): Promise<{ value: T; elapsed: number }> {
  let settled = false, elapsed = 0;
  promise.then(() => { settled = true; }, () => { settled = true; });
  for (; elapsed < maxMs && !settled; elapsed += 50) { sim.tick(); await vi.advanceTimersByTimeAsync(50); }
  return { value: await promise, elapsed };
}

describe('a place that is a block the go may not dig', () => {
  it('is said at once, with the block, the list and a cell beside it', async () => {
    const sim = makeSim(ground, { start: [0.5, FLOOR, 0.5], items: [{ name: 'stone_pickaxe', count: 1 }] });
    const { value, elapsed } = await drive(sim, go(ctxOf(sim) as never, { goals: [{ x: 5, y: FLOOR, z: 0 }], canDig: ['stone', 'deepslate'], seconds: 60 } as never));
    expect(value.ok).toBe(false);
    expect(value.text).toMatch(/^go 止まった dead_end: 行き先 \(5,64,0\) は clay で canDig に無い。隣の立てる所 \(\d+,64,-?\d+\)/u);
    expect(value.text).toContain('canDig に clay を足すか');
    expect(value.text.length).toBeLessThanOrEqual(160);
    expect(elapsed).toBeLessThan(1_000);
  });
  it('is gone to when the block may be dug, and when a cell beside it is the place', async () => {
    const dug = makeSim(ground, { start: [0.5, FLOOR, 0.5], digMs: 100 });
    const first = await drive(dug, go(ctxOf(dug) as never, { goals: [{ x: 5, y: FLOOR, z: 0 }], canDig: ['clay'], seconds: 60 } as never));
    expect(first.value.ok).toBe(true);
    const beside = makeSim(ground, { start: [0.5, FLOOR, 0.5] });
    const second = await drive(beside, go(ctxOf(beside) as never, { goals: [{ x: 4, y: FLOOR, z: 0 }], canDig: ['stone'], seconds: 60 } as never));
    expect(second.value.ok).toBe(true);
  });
  it('is not a block when it is stood on (a slab) or has room over it', async () => {
    const slab: Ground = (x, y, z) => (x === 5 && z === 0 && y === FLOOR ? 'stone_slab[type=bottom]' : ground(x, y, z) === 'clay' ? 'air' : ground(x, y, z));
    const sim = makeSim(slab, { start: [0.5, FLOOR, 0.5] });
    const { value } = await drive(sim, go(ctxOf(sim) as never, { goals: [{ x: 5, y: FLOOR, z: 0 }], canDig: ['stone'], seconds: 60 } as never));
    expect(value.text).not.toMatch(/canDig に無い/u);
  });
});
