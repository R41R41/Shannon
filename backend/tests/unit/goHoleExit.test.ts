import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSim, type Ground, type Sim, type Stack } from '../helpers/physicsBody.js';
import { go, type GoArgs } from '../../src/services/minebot/utils/primitives/go.js';
import { inHole } from '../../src/services/minebot/utils/primitives/holeExit.js';
import type { StepContext } from '../../src/services/minebot/utils/primitives/common.js';

// A body at the bottom of a 1x1 hole, held by the limit of digs: it climbs out by itself (a cheap block from the pack, no canPlace), the climb
// is not counted in the way's limits, it is tried once a go, and a hole that can be walked out of is no hole. Real client physics (tests/helpers/physicsBody).
beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] }); });
afterEach(() => { vi.useRealTimers(); });

const FLOOR = 64;
const R = 40;
const flat: Ground = (x, y, z) => (Math.abs(x) > R || Math.abs(z) > R ? null : y < FLOOR ? 'stone' : 'air');
type Layer = (x: number, y: number, z: number) => string | null | undefined;
const over = (base: Ground, ...layers: Layer[]): Ground => (x, y, z) => {
  for (const layer of layers) { const name = layer(x, y, z); if (name !== undefined) return name; }
  return base(x, y, z);
};
const box = (name: string, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): Layer => (x, y, z) =>
  (x >= x0 && x <= x1 && y >= y0 && y <= y1 && z >= z0 && z <= z1 ? name : undefined);
const ctxOf = (sim: Sim): StepContext => ({ bot: sim.bot, stop: new AbortController().signal, deadline: Date.now() + 600_000, facing: 'north', base: { x: 0, y: FLOOR, z: 0 } });
async function drive<T>(sim: Sim, promise: Promise<T>, maxMs = 240_000): Promise<T> {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  for (let elapsed = 0; elapsed < maxMs && !settled; elapsed += 50) { sim.tick(); await vi.advanceTimersByTimeAsync(50); }
  return promise;
}
const PICK: Stack = { name: 'stone_pickaxe', count: 1 };
const DIRT = (count: number): Stack => ({ name: 'dirt', count });
const run = (sim: Sim, args: Omit<GoArgs, 'goals'>, to = { x: 8, y: FLOOR, z: 0 }) => go(ctxOf(sim), { goals: [to], ...args });
/** A 1x1 shaft at (0, 60..63, 0) in stone, open to the sky; the body stands at its bottom. */
const shaft = over(flat, box('air', 0, 0, 60, 63, 0, 0));

describe('go: out of a hole held by the limit of digs', () => {
  it('(a) climbs out with a block of the pack (no canPlace), then goes on and arrives', async () => {
    const sim = makeSim(shaft, { start: [0.5, 60, 0.5], items: [PICK, DIRT(8)] });
    const outcome = await drive(sim, run(sim, { canDig: ['stone'], maxDig: 1 }));
    expect(outcome.ok).toBe(true);
    expect(Math.floor(sim.bot.entity.position.y)).toBeGreaterThanOrEqual(FLOOR);
    expect(sim.bot.placedBlocks.length).toBeGreaterThanOrEqual(4);
    // The climb is not in the way's counts.
    expect(outcome.text).toMatch(/・掘 0・置 0・/u);
  });

  it('(c) with nothing to lay says so, and leaves the stop as it was', async () => {
    const sim = makeSim(shaft, { start: [0.5, 60, 0.5], items: [PICK] });
    const outcome = await drive(sim, run(sim, { canDig: ['stone'], maxDig: 1 }));
    expect(outcome.reason).toBe('limit_dig');
    expect(outcome.text).toContain('積める物が無い');
    expect(sim.bot.placedBlocks).toEqual([]);
  });

  it('(d)(e) is tried once a go and keeps the count of the way: a far place still over the limit says the climb was made', async () => {
    const wall = over(shaft, box('stone', 4, 6, FLOOR, FLOOR + 5, -8, 8));
    const sim = makeSim(wall, { start: [0.5, 60, 0.5], items: [PICK, DIRT(30)] });
    const outcome = await drive(sim, run(sim, { canDig: ['stone'], maxDig: 1 }, { x: 12, y: FLOOR, z: 0 }));
    expect(outcome.text).toContain('穴の底だったので');
    // Laid once for the climb (4 to 6 levels), not again on a second limit_dig.
    expect(sim.bot.placedBlocks.length).toBeLessThanOrEqual(7);
    expect(outcome.text).toMatch(/・掘 \d+・置 0・/u);
  });
});

describe('inHole', () => {
  it('(b) is a hole for a 1x1 shaft and not for a room that can be walked out of', () => {
    const sim = makeSim(shaft, { start: [0.5, 60, 0.5], items: [DIRT(2)] });
    const reading = inHole(sim.bot);
    expect(reading).toMatchObject({ toY: FLOOR, levels: 4, roofDigs: 0 });
    const room = over(flat, box('air', -2, 2, 60, 63, -2, 2));
    expect(inHole(makeSim(room, { start: [0.5, 60, 0.5] }).bot)).toBeNull();
    const step = over(flat, box('air', 0, 0, 60, 63, 0, 0), box('air', 1, 1, 61, 61, 0, 0), box('air', 1, 1, 62, 62, 0, 0));
    expect(inHole(makeSim(step, { start: [0.5, 60, 0.5] }).bot)).toBeNull();
  });

  it('counts a roof of earth to dig, and refuses a roof of ore', () => {
    const roofed = over(shaft, box('dirt', 0, 0, 63, 63, 0, 0));
    expect(inHole(makeSim(roofed, { start: [0.5, 60, 0.5] }).bot)).toMatchObject({ roofDigs: 1 });
    const ore = over(shaft, box('diamond_ore', 0, 0, 63, 63, 0, 0));
    expect(inHole(makeSim(ore, { start: [0.5, 60, 0.5] }).bot)).toBeNull();
  });
});
