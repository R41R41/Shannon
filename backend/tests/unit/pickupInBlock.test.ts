import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import { makeHandsSim, type Ground, type HandsSim } from '../helpers/handsSim.js';
import { pickup } from '../../src/services/minebot/utils/primitives/pickup.js';
import type { StepContext } from '../../src/services/minebot/utils/primitives/common.js';

// Run 47 (hold 1): a drop whose coordinates lie inside a wall's block (it clips into the shape of a cobblestone wall) could not be stood in, and the walk to it ran 10 s and ended
// "4 seconds without a step". The body goes to where its box takes the drop from.
beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] }); });
afterEach(() => { vi.useRealTimers(); });
const FLOOR = 64;
const ground: Ground = (x, y, z) => (Math.abs(x) > 30 || Math.abs(z) > 30 ? null : x === 5 && y === FLOOR && z === 0 ? 'cobblestone' : y < FLOOR ? 'stone' : 'air');
const ctxOf = (sim: HandsSim): StepContext => ({ bot: sim.bot, stop: new AbortController().signal, deadline: Date.now() + 120_000, facing: 'east', base: { x: 0, y: FLOOR, z: 0 } });
async function drive<T>(sim: HandsSim, promise: Promise<T>, maxMs = 60_000): Promise<{ value: T; elapsed: number }> {
  let settled = false, elapsed = 0;
  promise.then(() => { settled = true; }, () => { settled = true; });
  for (; elapsed < maxMs && !settled; elapsed += 50) { sim.tick(); await vi.advanceTimersByTimeAsync(50); }
  return { value: await promise, elapsed };
}

describe('pickup: a drop inside a block', () => {
  it('walks to where its box takes the drop from, and takes it', async () => {
    const sim = makeHandsSim(ground, { start: [0.5, FLOOR, 0.5] });
    const id = 900;
    sim.bot.entities[id] = { id, name: 'item', displayName: 'Item', type: 'other', position: new Vec3(5.5, FLOOR + 0.4, 0.5), velocity: new Vec3(0, 0, 0), getDroppedItem: () => ({ name: 'cobblestone', count: 1 }), metadata: [] };
    const { value, elapsed } = await drive(sim, pickup(ctxOf(sim), { ids: [id] }));
    expect(sim.bot.entities[id]).toBeUndefined();
    expect(value.ok).toBe(true);
    expect(elapsed).toBeLessThan(8_000);
    expect(Math.abs(sim.bot.entity.position.x - 5.5)).toBeLessThanOrEqual(1.5);
  });
});
