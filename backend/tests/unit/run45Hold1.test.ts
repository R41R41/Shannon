import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSim, type Ground, type Sim } from '../helpers/physicsBody.js';
import { floorlessAt, go, type GoArgs } from '../../src/services/minebot/utils/primitives/go.js';
import type { StepContext } from '../../src/services/minebot/utils/primitives/common.js';

// Run 45, hold 1 (2026-10-28; the scene 20261028T003828-act-kwin5 and its box): q15 go to (163,10,229), 56 down from the surface, maxDig 80, no
// canPlace. The place was in the air of a lush cave (air under it for more than 12); the go dug 61 in 85 s and stopped search_timeout at y=33,
// where the part of the way found would have broken more than the 19 left of maxDig. Small worlds, the real physics and route search.
const FLOOR = 64;
const R = 24;
// A cave: air from y=40 to y=59 in x,z -6..6, a floor of stone at y<40; rock above up to the surface at 64.
const cave: Ground = (x, y, z) => {
  if (Math.abs(x) > R || Math.abs(z) > R) return null;
  if (y >= FLOOR) return 'air';
  if (Math.abs(x) <= 6 && Math.abs(z) <= 6 && y >= 40 && y < 60) return 'air';
  return 'stone';
};
const ctxOf = (sim: Sim): StepContext => ({ bot: sim.bot, stop: new AbortController().signal, deadline: Date.now() + 600_000, facing: 'north', base: { x: 0, y: FLOOR, z: 0 } });
async function drive<T>(sim: Sim, promise: Promise<T>, maxMs = 120_000): Promise<T> {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  for (let elapsed = 0; elapsed < maxMs && !settled; elapsed += 50) { sim.tick(); await vi.advanceTimersByTimeAsync(50); }
  return promise;
}

describe('run 45, hold 1: a place in the air of a cave', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }); });
  afterEach(() => { vi.useRealTimers(); });

  it('says at once that nobody stands there without blocks to lay, where its floor is, and a cell near it one stands in', async () => {
    // Stand on the surface above the cave's middle; a ledge of stone at (6,47,0) is inside the cave's edge.
    const ledge: Ground = (x, y, z) => (x === 6 && y === 46 && z === 0 ? 'stone' : cave(x, y, z));
    const sim = makeSim(ledge, { start: [0.5, FLOOR, 0.5], items: [{ name: 'stone_pickaxe', count: 1 }] });
    const why = floorlessAt(sim.bot, { x: 0, y: 50, z: 0 }, { names: new Set(['stone']) }, false)!;
    expect(why).toMatch(/^行き先 \(0,50,0\) は宙（足元 \(0,49,0\) から下が空気、床は y=39（10 段下））。置く物（canPlace）が無いので立てない/u);
    expect(why).toContain('床の上なら (0,40,0)');
    expect(floorlessAt(sim.bot, { x: 0, y: 50, z: 0 }, { names: new Set(['stone']) }, true)).toBeNull();
    const nearLedge = floorlessAt(sim.bot, { x: 5, y: 48, z: 0 }, { names: new Set() }, false)!;
    expect(nearLedge).toContain('近くの立てる所 (6,47,0)');
    const started = Date.now();
    const args: GoArgs = { goals: [{ x: 0, y: 50, z: 0 }], canDig: ['stone'], maxDig: 80, seconds: 120 };
    const outcome = await drive(sim, go(ctxOf(sim), args));
    expect(outcome.ok).toBe(false);
    expect(outcome.text).toMatch(/^go 止まった no_floor: 行き先 \(0,50,0\) は宙/u);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(sim.bot.dugBlocks).toEqual([]);
  });

  it('says limit_dig, not search_timeout, when the part of the way found breaks more than the limit left', async () => {
    // Solid stone down to y=20 under a flat surface; the place is 30 down, maxDig 1: the first part of any way found is over it (a search of 30 ms never finds the whole way).
    const rock: Ground = (x, y, z) => (Math.abs(x) > R || Math.abs(z) > R ? null : y < FLOOR ? 'stone' : 'air');
    const sim = makeSim(rock, { start: [0.5, FLOOR, 0.5], items: [{ name: 'stone_pickaxe', count: 1 }], digMs: 50 });
    const outcome = await drive(sim, go(ctxOf(sim), { goals: [{ x: 3, y: FLOOR - 30, z: 3 }], canDig: ['stone'], maxDig: 1, seconds: 120, searchMs: 30 }));
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('limit_dig');
    expect(outcome.text).not.toMatch(/search_timeout/u);
    expect(outcome.text).toMatch(/^go 止まった limit_dig: 道探しは 0\.03 秒で終わらず、見つかった途中までの道（\(-?\d+,-?\d+,-?\d+\) まで）でも掘る所が \d+ あり、上限 1 の残り 1 を超える/u);
  });
});
