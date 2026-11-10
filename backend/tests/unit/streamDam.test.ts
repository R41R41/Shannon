import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSim, type Ground } from '../helpers/physicsBody.js';
import { damBlockHeld, flowingAt, stanchStream, upstreamCells, waterLevel } from '../../src/services/minebot/utils/primitives/stanch.js';

// Run 5 (2026-11-11): held 308 s in shallow flowing water below an underground lake. The body now stops the stream: a cheap block laid in the cell the flow comes from.
beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] }); });
afterEach(() => { vi.useRealTimers(); });

const FLOOR = 64;
/** A tunnel along z at x=0 (walls at x=-1 and x=1, roof at y=67): the lake's water at z<=-3, then a flow of level 1, 2, 3 at z=-2, -1, 0; dry from z=1. */
const tunnel: Ground = (x, y, z) => {
  if (Math.abs(x) > 30 || Math.abs(z) > 30) return null;
  if (y < FLOOR) return 'stone';
  if (y > FLOOR + 2) return 'stone';
  if (Math.abs(x) >= 1) return 'stone';
  if (z <= -3) return 'water[level=0]';
  if (z <= 0 && y === FLOOR) return `water[level=${z + 3}]`;
  return 'air';
};
const ctxOf = (sim: ReturnType<typeof makeSim>) => ({ bot: sim.bot, stop: new AbortController().signal, deadline: Date.now() + 120_000, facing: 'south' as const, base: { x: 0, y: FLOOR, z: 0 } });
/** The flow dries a moment after a block is laid in the cell it came through (the sim has no flow of its own). */
function dryAfterDam(sim: ReturnType<typeof makeSim>, ms = 1200) {
  sim.bot.on('blockPlaced', () => { setTimeout(() => { for (const z of [0, -1, -2]) if (sim.nameAt(0, FLOOR, z)?.startsWith('water')) sim.world.set(0, FLOOR, z, 'air'); }, ms); });
}
const run = async <T>(promise: Promise<T>): Promise<T> => { await vi.runAllTimersAsync(); return promise; };

describe('the water cells a flow comes from', () => {
  it('reads a level, flowing or not, and names the cheap block held', () => {
    const sim = makeSim(tunnel, { start: [0.5, FLOOR, 0.5], items: [{ name: 'oak_planks', count: 9 }, { name: 'dirt', count: 3 }, { name: 'cobblestone', count: 2 }] });
    expect(waterLevel(sim.bot, { x: 0, y: FLOOR, z: 0 })).toBe(3);
    expect(waterLevel(sim.bot, { x: 0, y: FLOOR, z: 1 })).toBeNull();
    expect(flowingAt(sim.bot, { x: 0, y: FLOOR, z: 0 })).toBe(true);
    expect(flowingAt(sim.bot, { x: 0, y: FLOOR, z: -4 })).toBe(false);   // a source
    expect(damBlockHeld(sim.bot)).toBe('dirt');                             // planks are not a dam; dirt before cobblestone (the stuff of tools)
  });
  it('are upstream only: the lower levels toward the source, nearest first', () => {
    const sim = makeSim(tunnel, { start: [0.5, FLOOR, 0.5] });
    const up = upstreamCells(sim.bot, { x: 0, y: FLOOR, z: 0 }).map(cell => `${cell.x},${cell.y},${cell.z}`);
    expect(up.slice(0, 2)).toEqual([`0,${FLOOR},-1`, `0,${FLOOR},-2`]);
    expect(up).not.toContain(`0,${FLOOR},1`);
  });
});

describe('stanchStream', () => {
  it('lays a block in the nearest cell upstream and says the water at the feet is gone', async () => {
    const sim = makeSim(tunnel, { start: [0.5, FLOOR, 0.5], items: [{ name: 'cobblestone', count: 5 }] });
    dryAfterDam(sim);
    const outcome = await run(stanchStream(ctxOf(sim) as never));
    expect(sim.bot.placedBlocks).toEqual([`cobblestone@0,${FLOOR},-1`]);
    expect(outcome).toMatchObject({ attempted: true, stopped: true });
    expect(outcome.words).toMatch(/^流れを止めた: \(0,64,-1\) に cobblestone（上流）。足元の水は [\d.]+ 秒で消えた$/u);
    expect(outcome.words.length).toBeLessThanOrEqual(70);
    expect(flowingAt(sim.bot, { x: 0, y: FLOOR, z: 0 })).toBe(false);
  });
  it('says when the block closes the way on (a tunnel whose way goes upstream), so the planner goes round or digs', async () => {
    const sim = makeSim(tunnel, { start: [0.5, FLOOR, 0.5], items: [{ name: 'dirt', count: 5 }] });
    dryAfterDam(sim);
    const outcome = await run(stanchStream(ctxOf(sim) as never, { toward: { x: 0, y: FLOOR, z: -5 } }));
    expect(outcome).toMatchObject({ attempted: true, stopped: true, onRoute: true, at: { x: 0, y: FLOOR, z: -1 } });
    expect(outcome.words).toContain('道の上');
    expect(outcome.words).toContain('別の道か掘って');
  });
  it('lays in a cell off the way when there is one (the way on is not closed)', async () => {
    // A flow at (0,0) fed from both sides: (1,0) lies toward the target at x=5, (-1,0) behind the body.
    const world: Ground = (x, y, z) => (Math.abs(x) > 30 || Math.abs(z) > 30 ? null : y < FLOOR ? 'stone' : y === FLOOR && z === 0 && x >= -1 && x <= 1 ? `water[level=${x === 0 ? 3 : 2}]` : 'air');
    const sim = makeSim(world, { start: [0.5, FLOOR, 0.5], items: [{ name: 'dirt', count: 5 }] });
    sim.bot.on('blockPlaced', () => { setTimeout(() => { for (const x of [-1, 0, 1]) if (sim.nameAt(x, FLOOR, 0)?.startsWith('water')) sim.world.set(x, FLOOR, 0, 'air'); }, 1000); });
    const outcome = await run(stanchStream(ctxOf(sim) as never, { toward: { x: 5, y: FLOOR, z: 0 } }));
    expect(sim.bot.placedBlocks).toEqual([`dirt@-1,${FLOOR},0`]);
    expect(outcome).toMatchObject({ stopped: true, onRoute: false });
  });
  it('does not run past the limit of the caller (the seconds of a go), and says it was the time', async () => {
    const sim = makeSim(tunnel, { start: [0.5, FLOOR, 0.5], items: [{ name: 'dirt', count: 5 }] });
    const outcome = await run(stanchStream(ctxOf(sim) as never, { deadline: Date.now() + 1000 }));
    expect(outcome).toMatchObject({ attempted: false, stopped: false });
    expect(outcome.words).toContain('時間が足りない');
    expect(sim.bot.placedBlocks).toEqual([]);
  });
  it('does nothing on dry ground or in a source', async () => {
    const sim = makeSim(tunnel, { start: [0.5, FLOOR, 2.5], items: [{ name: 'cobblestone', count: 5 }] });
    expect(await stanchStream(ctxOf(sim) as never)).toEqual({ attempted: false, stopped: false, words: '' });
    expect(sim.bot.placedBlocks).toEqual([]);
  });
  it('says what to carry when the pack holds no cheap block, and lays nothing', async () => {
    const sim = makeSim(tunnel, { start: [0.5, FLOOR, 0.5], items: [{ name: 'oak_planks', count: 20 }, { name: 'diamond', count: 1 }] });
    const outcome = await stanchStream(ctxOf(sim) as never);
    expect(outcome.attempted).toBe(false);
    expect(outcome.words).toContain('cobblestone');
    expect(sim.bot.placedBlocks).toEqual([]);
  });
  it('says it when the water does not stop (another feed) and does not go on laying without end', async () => {
    const sim = makeSim(tunnel, { start: [0.5, FLOOR, 0.5], items: [{ name: 'dirt', count: 9 }] });
    const outcome = await run(stanchStream(ctxOf(sim) as never));
    expect(outcome).toMatchObject({ attempted: true, stopped: false });
    expect(outcome.words).toMatch(/^上流に dirt を \d 個置いたが足元の水は止まらない/u);
    expect(sim.bot.placedBlocks.length).toBeLessThanOrEqual(2);
  });
  it('lays the next cell of the way to step up onto it when no cell upstream is left (one deep, a floor under it)', async () => {
    // Feet in a flow of level 2 with the stream running on toward z=1 (level 3): nothing upstream of the feet, the way goes downstream.
    const world: Ground = (x, y, z) => (Math.abs(x) > 30 || Math.abs(z) > 30 ? null : y < FLOOR ? 'stone' : y === FLOOR && x === 0 && z >= 0 && z <= 2 ? `water[level=${z + 2}]` : 'air');
    const sim = makeSim(world, { start: [0.5, FLOOR, 0.5], items: [{ name: 'cobblestone', count: 5 }] });
    const outcome = await run(stanchStream(ctxOf(sim) as never, { toward: { x: 0, y: FLOOR, z: 6 } }));
    expect(sim.bot.placedBlocks).toEqual([`cobblestone@0,${FLOOR},1`]);
    expect(outcome.attempted).toBe(true);
    expect(outcome.words).toMatch(/^流れの先 \(0,64,1\) に cobblestone を置いた/u);
  });
  it('does not lay on a two-deep pocket (no floor to stand on): it says there is nowhere to lay', async () => {
    const world: Ground = (x, y, z) => (Math.abs(x) > 30 || Math.abs(z) > 30 ? null : y < FLOOR - 1 ? 'stone' : x === 0 && z >= 0 && z <= 2 && y <= FLOOR ? `water[level=${z + 2}]` : y < FLOOR ? 'stone' : 'air');
    const sim = makeSim(world, { start: [0.5, FLOOR, 0.5], items: [{ name: 'cobblestone', count: 5 }] });
    const outcome = await run(stanchStream(ctxOf(sim) as never, { toward: { x: 0, y: FLOOR, z: 6 } }));
    expect(outcome.attempted).toBe(false);
    expect(outcome.words).toContain('置き場が無い');
    expect(sim.bot.placedBlocks).toEqual([]);
  });
});

describe('go held in a stream', () => {
  it('stops the stream with a block and goes on to the place it was held from', async () => {
    const { go } = await import('../../src/services/minebot/utils/primitives/go.js');
    // A flow along x at z=0: level 3 at x=0 (the feet), 2 at x=1 and 1 at x=2 (upstream is east, where the way goes); dry from x=3.
    const world: Ground = (x, y, z) => (Math.abs(x) > 30 || Math.abs(z) > 30 ? null : y < FLOOR ? 'stone' : y === FLOOR && z === 0 && x >= 0 && x <= 2 ? `water[level=${3 - x}]` : 'air');
    const sim = makeSim(world, { start: [0.5, FLOOR, 0.5], items: [{ name: 'cobblestone', count: 8 }] });
    sim.bot.on('blockPlaced', () => { setTimeout(() => { for (const x of [0, 1, 2]) if (sim.nameAt(x, FLOOR, 0)?.startsWith('water')) sim.world.set(x, FLOOR, 0, 'air'); }, 1000); });
    const ctx = { bot: sim.bot, stop: new AbortController().signal, deadline: Date.now() + 600_000, facing: 'east' as const, base: { x: 0, y: FLOOR, z: 0 } };
    const promise = go(ctx as never, { goals: [{ x: 6, y: FLOOR, z: 0 }], seconds: 30 } as never);
    let settled = false; promise.then(() => { settled = true; }, () => { settled = true; });
    // The current holds the body in its cell while the water there flows.
    for (let t = 0; t < 40_000 && !settled; t += 50) {
      if (flowingAt(sim.bot, { x: 0, y: FLOOR, z: 0 })) { sim.bot.entity.position.x = 0.5; sim.bot.entity.position.z = 0.5; sim.bot.entity.velocity.x = 0; }
      sim.tick();
      await vi.advanceTimersByTimeAsync(50);
    }
    const outcome = await promise;
    expect(sim.bot.placedBlocks.some(line => /^cobblestone@[012],64,0$/u.test(line))).toBe(true);
    expect(outcome.ok, outcome.text).toBe(true);
    expect(outcome.text).toContain('流れを止めた');
  });
});

describe('walk held in a stream', () => {
  it('stops the stream with a block upstream and then walks on (the stuck is flagged in 1.5 s in a stream, not 4)', async () => {
    const { walk } = await import('../../src/services/minebot/utils/primitives/walk.js');
    const world: Ground = (x, y, z) => (Math.abs(x) > 30 || Math.abs(z) > 30 ? null : y < FLOOR ? 'stone' : y === FLOOR && z === 0 && x >= 0 && x <= 2 ? `water[level=${3 - x}]` : 'air');
    const sim = makeSim(world, { start: [0.5, FLOOR, 0.5], items: [{ name: 'cobblestone', count: 8 }] });
    sim.bot.on('blockPlaced', () => { setTimeout(() => { for (const x of [0, 1, 2]) if (sim.nameAt(x, FLOOR, 0)?.startsWith('water')) sim.world.set(x, FLOOR, 0, 'air'); }, 1000); });
    const ctx = { bot: sim.bot, stop: new AbortController().signal, deadline: Date.now() + 600_000, facing: 'east' as const, base: { x: 0, y: FLOOR, z: 0 } };
    const promise = walk(ctx as never, { to: { x: 5, y: FLOOR, z: 0 } } as never);
    let settled = false; promise.then(() => { settled = true; }, () => { settled = true; });
    for (let t = 0; t < 40_000 && !settled; t += 50) {
      if (flowingAt(sim.bot, { x: 0, y: FLOOR, z: 0 })) { sim.bot.entity.position.x = 0.5; sim.bot.entity.position.z = 0.5; sim.bot.entity.velocity.x = 0; }
      sim.tick();
      await vi.advanceTimersByTimeAsync(50);
    }
    const outcome = await promise;
    expect(sim.bot.placedBlocks.some(line => /^cobblestone@[012],64,0$/u.test(line))).toBe(true);
    expect(outcome.ok, outcome.text).toBe(true);
  });
});
