import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSim, type Ground, type Sim } from '../helpers/physicsBody.js';
import { go } from '../../src/services/minebot/utils/primitives/go.js';

// Run 47 (hold 2): the body stood in a one-cell hollow of a village house (cobblestone floor, spruce log to the north, a chest to the east). To the south the floor went on but a glass pane
// stood at head height; to the west the cell was free and one down, with an open spruce trapdoor over it (its plate on the east edge); the south-west cell was free. The only
// steps out were the west one and the diagonal one, and the diagonal one passes the corner of the trapdoor's plate at head height with the body's width 0.6: the route search
// counted it, and the body jumped against the plate for 40 s ("go_stuck" with the search a success each time).
beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] }); });
afterEach(() => { vi.useRealTimers(); });

const TRAPDOOR = 'spruce_trapdoor[facing=west,half=bottom,open=true,powered=false,waterlogged=false]';
const PANE = 'glass_pane[east=false,north=false,south=true,waterlogged=false,west=false]';
const house = (withPane: boolean, withDoor: boolean): Ground => (x, y, z) => {
  if (Math.abs(x - 156) > 20 || Math.abs(z - 200) > 20) return null;
  if (y <= 65) return 'coarse_dirt';
  if (y === 66 && x >= 156 && x <= 158 && z >= 199 && z <= 202) return 'cobblestone';
  if (y === 67 && x === 156 && z === 199) return 'spruce_log';
  if (y === 68 && x === 156 && z === 199) return 'spruce_log';
  if (y === 67 && x === 157 && z >= 199 && z <= 202) return z === 200 ? 'chest' : 'cobblestone';
  if (y === 68 && x === 157 && z >= 199 && z <= 202) return 'cobblestone';
  if (y === 67 && x === 156 && z === 202) return 'cobblestone';
  if (y === 68 && x === 156 && z === 202) return 'cobblestone';
  if (withPane && y === 68 && x === 156 && z === 201) return PANE;
  if (withDoor && y === 68 && x === 155 && (z === 200 || z === 202)) return TRAPDOOR;
  if (y === 69 && x >= 155 && x <= 157 && z >= 199 && z <= 202) return 'spruce_log';
  return 'air';
};
const ctxOf = (sim: Sim) => ({ bot: sim.bot, stop: new AbortController().signal, deadline: Date.now() + 600_000, facing: 'west' as const, base: { x: 156, y: 67, z: 200 } });
async function drive<T>(sim: Sim, promise: Promise<T>, maxMs = 60_000): Promise<{ value: T; elapsed: number }> {
  let settled = false, elapsed = 0;
  promise.then(() => { settled = true; }, () => { settled = true; });
  for (; elapsed < maxMs && !settled; elapsed += 50) { sim.tick(); await vi.advanceTimersByTimeAsync(50); }
  return { value: await promise, elapsed };
}

describe('a diagonal step past the plate of an open trapdoor', () => {
  it('is not taken: the hollow with a pane to the south and an open trapdoor to the west is a closed room, and go says so quickly', async () => {
    const sim = makeSim(house(true, true), { start: [156.5, 67, 200.5] });
    const { value, elapsed } = await drive(sim, go(ctxOf(sim) as never, { goals: [{ x: 155, y: 66, z: 200 }], seconds: 40 } as never));
    expect((value as any).ok).toBe(false);
    expect(elapsed).toBeLessThan(5_000);                       // before: 22 s of jumping against the plate and five redraws
    expect((value as any).text).toContain('glass_pane');         // the way out it names: the pane (dug if canDig allows it)
    expect((value as any).text).not.toContain('stuck');
  });
  it('is dug through when the trapdoor may be dug', async () => {
    const sim = makeSim(house(true, true), { start: [156.5, 67, 200.5] });
    const { value } = await drive(sim, go(ctxOf(sim) as never, { goals: [{ x: 155, y: 66, z: 200 }], canDig: ['spruce_trapdoor', 'glass_pane'], seconds: 40 } as never));
    expect((value as any).ok).toBe(true);
    expect(sim.bot.dugBlocks.length).toBeGreaterThan(0);
    expect(Math.floor(sim.bot.entity.position.x)).toBe(155);
  });
  it('is no matter without the trapdoor and the pane: the open way out is taken', async () => {
    const sim = makeSim(house(false, false), { start: [156.5, 67, 200.5] });
    const { value, elapsed } = await drive(sim, go(ctxOf(sim) as never, { goals: [{ x: 155, y: 66, z: 200 }], seconds: 40 } as never));
    expect((value as any).ok).toBe(true);
    expect(elapsed).toBeLessThan(6_000);
    expect(sim.bot.dugBlocks).toEqual([]);
  });
});
