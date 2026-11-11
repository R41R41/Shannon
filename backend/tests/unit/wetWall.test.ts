import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeHandsSim, type Ground, type HandsSim } from '../helpers/handsSim.js';
import { sealedBreakCost, sealedAt, sealWetFaces, wetBreakCost, wetCost, wetFaces, SEALED_BREAK_COST } from '../../src/services/minebot/utils/primitives/wetWall.js';
import type { StepContext } from '../../src/services/minebot/utils/primitives/common.js';

// Run 7 (11/11, 02:34): a go dug into a lake's wall, the lake ran in, and the dirt laid in the breach was dug out again by its own route. A wall with water behind it is read (side and top
// faces), priced for a route, sealed before the dig, and the plug is not dug out again.
beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] }); });
afterEach(() => { vi.useRealTimers(); });

const FLOOR = 64;
/** Stone below the floor; a lake at x -3..-2, z -1..1 beside the stone wall cell (-1,64,0) the body stands next to; a lake roof cell at (5,64,0) with water over it. */
const world: Ground = (x, y, z) => {
  if (Math.abs(x) > 30 || Math.abs(z) > 30) return null;
  if (y < FLOOR) return 'stone';
  if (y === FLOOR && x === -1 && z === 0) return 'stone';
  if (y === FLOOR && x <= -2 && x >= -3 && Math.abs(z) <= 1) return 'water~0';
  if (y === FLOOR && x === 5 && z === 0) return 'stone';
  if (y === FLOOR + 1 && x === 5 && z === 0) return 'water~0';
  if (y === FLOOR && x === -1 && z === 1) return 'stone';
  return 'air';
};
const ctxOf = (sim: HandsSim): StepContext => ({ bot: sim.bot, stop: new AbortController().signal, deadline: Date.now() + 600_000, facing: 'south', base: { x: 0, y: FLOOR, z: 0 } });
async function drive<T>(sim: HandsSim, promise: Promise<T>, maxMs = 30_000): Promise<T> {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  for (let elapsed = 0; elapsed < maxMs && !settled; elapsed += 50) { sim.tick(); await vi.advanceTimersByTimeAsync(50); }
  return promise;
}

describe('wetFaces and wetCost', () => {
  it('reads a side face, a top face, and none for a dry cell (a cell the map cannot read is not water)', () => {
    const sim = makeHandsSim(world, { start: [0.5, FLOOR, 0.5], items: [{ name: 'dirt', count: 5 }] });
    expect(wetFaces(sim.bot, { x: -1, y: FLOOR, z: 0 })).toMatchObject([{ at: { x: -2, y: FLOOR, z: 0 }, up: false, source: true }]);
    expect(wetFaces(sim.bot, { x: 5, y: FLOOR, z: 0 })).toMatchObject([{ at: { x: 5, y: FLOOR + 1, z: 0 }, up: true }]);
    expect(wetFaces(sim.bot, { x: 1, y: FLOOR, z: 1 })).toEqual([]);
    expect(wetFaces(sim.bot, { x: 99, y: FLOOR, z: 0 })).toEqual([]);
  });
  it('prices by the faces (a side 4, a top 12), dearer by 40 when fewer blocks are held than faces, and 0 when dry', () => {
    const held = makeHandsSim(world, { start: [0.5, FLOOR, 0.5], items: [{ name: 'dirt', count: 5 }] });
    expect(wetCost(held.bot, { x: -1, y: FLOOR, z: 0 })).toBe(4);
    expect(wetCost(held.bot, { x: 5, y: FLOOR, z: 0 })).toBe(12);
    expect(wetCost(held.bot, { x: 1, y: FLOOR, z: 1 })).toBe(0);
    const none = makeHandsSim(world, { start: [0.5, FLOOR, 0.5] });
    expect(wetCost(none.bot, { x: -1, y: FLOOR, z: 0 })).toBe(44);
    expect(wetBreakCost(held.bot)({ position: { x: -1, y: FLOOR, z: 0 } })).toBe(4);
  });
});

describe('sealWetFaces', () => {
  it('lays a block on the water cell, writes the plug down, and the plug is dear to dig out (a hundred)', async () => {
    const sim = makeHandsSim(world, { start: [0.5, FLOOR, 0.5], items: [{ name: 'dirt', count: 3 }] });
    const out = await drive(sim, sealWetFaces(ctxOf(sim), { x: -1, y: FLOOR, z: 0 }));
    expect(out.sealed).toEqual([{ x: -2, y: FLOOR, z: 0 }]);
    expect(out.left).toEqual([]);
    expect(out.words).toContain('裏の水 1 マスを dirt で塞いでから掘った');
    expect(sim.bot.placedBlocks).toEqual(['dirt@-2,64,0']);
    expect(sealedAt(sim.bot, { x: -2, y: FLOOR, z: 0 })).toBe(true);
    expect(sealedBreakCost(sim.bot)({ position: { x: -2, y: FLOOR, z: 0 } })).toBe(SEALED_BREAK_COST);
    expect(sealedBreakCost(sim.bot)({ position: { x: 3, y: FLOOR, z: 3 } })).toBe(0);
  });
  it('with no block held places nothing and says a dirt or a cobblestone would do', async () => {
    const sim = makeHandsSim(world, { start: [0.5, FLOOR, 0.5] });
    const out = await drive(sim, sealWetFaces(ctxOf(sim), { x: -1, y: FLOOR, z: 0 }));
    expect(out.sealed).toEqual([]);
    expect(out.left).toHaveLength(1);
    expect(out.words).toContain('dirt か cobblestone を 1 個持てば体が塞いで掘る');
    expect(sim.bot.placedBlocks).toEqual([]);
  });
  it('a dry cell has nothing to seal', async () => {
    const sim = makeHandsSim(world, { start: [0.5, FLOOR, 0.5], items: [{ name: 'dirt', count: 3 }] });
    const out = await drive(sim, sealWetFaces(ctxOf(sim), { x: 1, y: FLOOR, z: 1 }));
    expect(out).toEqual({ sealed: [], left: [], block: null, words: '' });
  });
});
