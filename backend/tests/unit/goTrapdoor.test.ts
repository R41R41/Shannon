import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSim, type Ground, type Sim } from '../helpers/physicsBody.js';
import { go } from '../../src/services/minebot/utils/primitives/go.js';
import { plateOnEdge } from '../../src/services/minebot/utils/walkRules.js';

// Run 47 (hold 1): the body stood on a cobblestone block of a village well, the next cell west and one down was free, and over that cell an open spruce trapdoor stood on the
// east edge of its cell, at head height. The search took an open trapdoor for open ground and found the one step; the body's head met the plate: 3 s without a step, a stuck that put
// the destination itself under `avoid`, and a search that ran out its 5 s. The step across a plate is not one the search takes.
beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] }); });
afterEach(() => { vi.useRealTimers(); });

const FLOOR = 64;
const TRAPDOOR = 'spruce_trapdoor[facing=west,half=bottom,open=true,powered=false,waterlogged=false]';
/** Stone below y=64; a cobblestone block at (6,64,0) the body stands on; an open trapdoor at (5,66,0) over the cell west of it (and one down). */
const ground: Ground = (x, y, z) => {
  if (Math.abs(x) > 30 || Math.abs(z) > 30) return null;
  if (x === 6 && y === FLOOR && z === 0) return 'cobblestone';
  if (x === 5 && y === FLOOR + 2 && z === 0) return TRAPDOOR;
  return y < FLOOR ? 'stone' : 'air';
};
const ctxOf = (sim: Sim) => ({ bot: sim.bot, stop: new AbortController().signal, deadline: Date.now() + 600_000, facing: 'west' as const, base: { x: 6, y: FLOOR + 1, z: 0 } });
async function drive<T>(sim: Sim, promise: Promise<T>, maxMs = 120_000): Promise<{ value: T; elapsed: number }> {
  let settled = false, elapsed = 0;
  promise.then(() => { settled = true; }, () => { settled = true; });
  for (; elapsed < maxMs && !settled; elapsed += 50) { sim.tick(); await vi.advanceTimersByTimeAsync(50); }
  return { value: await promise, elapsed };
}

describe('the plate of an open trapdoor', () => {
  it('is on the east edge of its cell when it faces west and is open, and a shut one has none', () => {
    const open = makeSim(ground).world.getBlock({ x: 5, y: FLOOR + 2, z: 0, floored: () => ({ x: 5, y: FLOOR + 2, z: 0 }) } as never);
    expect(plateOnEdge(open.shapes, 'east')).toBe(true);
    expect(plateOnEdge(open.shapes, 'west')).toBe(false);
    expect(plateOnEdge(open.shapes, 'north')).toBe(false);
    expect(plateOnEdge([[0, 0, 0, 1, 1, 1]], 'east')).toBe(false);          // a full block is a wall, not a plate
    expect(plateOnEdge([[0, 0, 0, 1, 0.1875, 1]], 'east')).toBe(false);     // a shut trapdoor is a floor
  });
  it('is not stepped across: the body on the cobblestone goes round to the cell one down and west of it, and arrives', async () => {
    const sim = makeSim(ground, { start: [6.42, FLOOR + 1, 0.5] });
    const { value, elapsed } = await drive(sim, go(ctxOf(sim) as never, { goals: [{ x: 5, y: FLOOR, z: 0 }], seconds: 40 } as never));
    expect(value.ok).toBe(true);
    expect(Math.floor(sim.bot.entity.position.x)).toBe(5);
    expect(sim.bot.entity.position.y).toBeCloseTo(FLOOR, 0);
    expect(elapsed).toBeLessThan(4_000);   // before: 3 s of standing, a redraw, then the way round (7 s and more)
    expect(value.text).toContain("引き直し 0 回");
  });
});
