import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeHandsSim, type Ground, type HandsSim } from '../helpers/handsSim.js';
import { harmfulWetFaces, routeFeetFor, sealedBreakCost, sealedAt, sealWetFaces, waterReachesBody, wetBreakCost, wetCost, wetFaces, SEALED_BREAK_COST } from '../../src/services/minebot/utils/primitives/wetWall.js';
import { bodyEnclosed, dig } from '../../src/services/minebot/utils/primitives/dig.js';
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
  // A wall at the head's height with a lake behind it (run 7's lake, its water at the head).
  if (y === FLOOR + 1 && x === -1 && z === 0) return 'stone';
  if (y === FLOOR + 1 && x <= -2 && x >= -3 && Math.abs(z) <= 1) return 'water~0';
  // Run 8: a thin flow over a block in the floor beside the body (obsidian under a flow: the cell is under the feet's level).
  if (y === FLOOR - 1 && x === 3 && z === 0) return 'obsidian';
  if (y === FLOOR && x === 3 && z === 0) return 'water~3';
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
    const out = await drive(sim, sealWetFaces(ctxOf(sim), { x: -1, y: FLOOR + 1, z: 0 }));
    expect(out.sealed).toEqual([{ x: -2, y: FLOOR + 1, z: 0 }]);
    expect(out.left).toEqual([]);
    expect(out.words).toContain('裏の水 1 マスを dirt で塞いでから掘った');
    expect(sim.bot.placedBlocks).toEqual(['dirt@-2,65,0']);
    expect(sealedAt(sim.bot, { x: -2, y: FLOOR + 1, z: 0 })).toBe(true);
    expect(sealedBreakCost(sim.bot)({ position: { x: -2, y: FLOOR + 1, z: 0 } })).toBe(SEALED_BREAK_COST);
    expect(sealedBreakCost(sim.bot)({ position: { x: 3, y: FLOOR, z: 3 } })).toBe(0);
  });
  it('with no block held places nothing and says a dirt or a cobblestone would do', async () => {
    const sim = makeHandsSim(world, { start: [0.5, FLOOR, 0.5] });
    const out = await drive(sim, sealWetFaces(ctxOf(sim), { x: -1, y: FLOOR + 1, z: 0 }));
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

// Run 8 (11/13): 28 blocks laid on water over obsidian dug from above it, none needed. Water runs down and sideways, never up: only the water that reaches the body is sealed.
describe('the water that reaches the body (run 8)', () => {
  /** A tunnel one wide: stone round the feet and head at (0,64,0)..(0,65,0), a wall cell east of the feet, water behind it. */
  const tunnel = (water: string): Ground => (x, y, z) => {
    if (Math.abs(x) > 30 || Math.abs(z) > 30) return null;
    if (y < FLOOR || y > FLOOR + 1) return 'stone';
    if (x === 0 && z === 0) return 'air';
    if (x === 2 && z === 0 && y === FLOOR) return water;
    return 'stone';
  };
  it('a cell under the feet lets no water onto the body: none of its faces is to seal, nothing is laid', async () => {
    const sim = makeHandsSim(world, { start: [0.5, FLOOR, 0.5], items: [{ name: 'dirt', count: 5 }] });
    const cell = { x: 3, y: FLOOR - 1, z: 0 };
    expect(wetFaces(sim.bot, cell)).toHaveLength(1);
    expect(harmfulWetFaces(sim.bot, cell)).toEqual([]);
    const out = await drive(sim, sealWetFaces(ctxOf(sim), cell));
    expect(out).toEqual({ sealed: [], left: [], block: null, words: '' });
    expect(sim.bot.placedBlocks).toEqual([]);
  });
  it('the dig of obsidian under a flow lays nothing on the water and leaves its hole open', async () => {
    const sim = makeHandsSim(world, { start: [1.5, FLOOR, 0.5], items: [{ name: 'dirt', count: 5 }, { name: 'diamond_pickaxe', count: 1 }] });
    const out = await drive(sim, dig(ctxOf(sim), { at: [{ x: 3, y: FLOOR - 1, z: 0 }], collect: false }));
    expect(out.ok).toBe(true);
    expect(out.text).not.toContain('裏の水');
    expect(out.text).not.toContain('穴を塞いだ');
    expect(sim.bot.placedBlocks).toEqual([]);
  });
  it("a cell at the head's height lets it onto the head: its water is sealed, as before", () => {
    const sim = makeHandsSim(world, { start: [0.5, FLOOR, 0.5], items: [{ name: 'dirt', count: 5 }] });
    expect(harmfulWetFaces(sim.bot, { x: -1, y: FLOOR + 1, z: 0 })).toHaveLength(1);
  });
  it("at the feet's height: a source sealed in a tunnel, not on an open shore; a thin flow not even in a tunnel", () => {
    const shut = makeHandsSim(tunnel('water~0'), { start: [0.5, FLOOR, 0.5] });
    expect(bodyEnclosed(shut.bot, { x: 0, y: FLOOR, z: 0 })).toBe(true);
    expect(harmfulWetFaces(shut.bot, { x: 1, y: FLOOR, z: 0 })).toHaveLength(1);
    const flow = makeHandsSim(tunnel('water~3'), { start: [0.5, FLOOR, 0.5] });
    expect(harmfulWetFaces(flow.bot, { x: 1, y: FLOOR, z: 0 })).toEqual([]);
    const shore = makeHandsSim(world, { start: [0.5, FLOOR, 0.5] });
    expect(harmfulWetFaces(shore.bot, { x: -1, y: FLOOR, z: 0 })).toEqual([]);
    expect(waterReachesBody(shore.bot, { x: -1, y: FLOOR, z: 0 }, null, 3)).toBe(true);   // a body not placed: as before
  });
  // Review of run 8's fix: a route's cell under the feet is one the body goes into (go digs down, steps down an aquifer's wall), so it is judged as the body standing in it.
  it("a route's dig down a shaft beside a source seals it (run 7's flooded stairs); a thin flow there is let be; dig's own cell under the feet still lays nothing", async () => {
    /** A shaft one wide at (0,·,0) down to y 62, a cell of water beside its next cell down (1,63,0). */
    const shaft = (water: string): Ground => (x, y, z) => {
      if (Math.abs(x) > 30 || Math.abs(z) > 30) return null;
      if (x === 0 && z === 0 && y >= FLOOR) return 'air';
      if (x === 1 && z === 0 && y === FLOOR - 1) return water;
      return y > FLOOR + 1 ? 'air' : 'stone';
    };
    const sim = makeHandsSim(shaft('water~0'), { start: [0.5, FLOOR, 0.5], items: [{ name: 'dirt', count: 5 }] });
    const down = { x: 0, y: FLOOR - 1, z: 0 };
    expect(routeFeetFor(sim.bot, down)).toEqual(down);
    expect(routeFeetFor(sim.bot, { x: 1, y: FLOOR, z: 0 })).toEqual({ x: 0, y: FLOOR, z: 0 });
    expect(harmfulWetFaces(sim.bot, down)).toEqual([]);                                  // from the feet as they are: under them
    expect(harmfulWetFaces(sim.bot, down, routeFeetFor(sim.bot, down))).toHaveLength(1);  // the body about to stand in it
    const out = await drive(sim, sealWetFaces(ctxOf(sim), down, routeFeetFor(sim.bot, down)));
    expect(out.sealed).toEqual([{ x: 1, y: FLOOR - 1, z: 0 }]);
    const thin = makeHandsSim(shaft('water~3'), { start: [0.5, FLOOR, 0.5], items: [{ name: 'dirt', count: 5 }] });
    expect(harmfulWetFaces(thin.bot, down, routeFeetFor(thin.bot, down))).toEqual([]);
    expect((await drive(thin, sealWetFaces(ctxOf(thin), down, routeFeetFor(thin.bot, down)))).sealed).toEqual([]);
  });
});
