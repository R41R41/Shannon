import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeHandsSim, type Ground, type HandsSim } from '../helpers/handsSim.js';
import { place } from '../../src/services/minebot/utils/primitives/place.js';
import type { StepContext } from '../../src/services/minebot/utils/primitives/common.js';

// Run 6 (#63): a furnace placed during a 9.5 s save was answered "did not answer within 1500ms" and was reported not placed; it stood there 3 s later and the hand was sent again with no furnace left.
// A place waits for a late answer (go has always done) before it says the block was not placed.
beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] }); });
afterEach(() => { vi.useRealTimers(); });

const FLOOR = 64;
const flat: Ground = (x, y, z) => (Math.abs(x) > 30 || Math.abs(z) > 30 ? null : y < FLOOR ? 'stone' : 'air');
const ctxOf = (sim: HandsSim): StepContext => ({ bot: sim.bot, stop: new AbortController().signal, deadline: Date.now() + 600_000, facing: 'south', base: { x: 0, y: FLOOR, z: 0 } });
async function drive<T>(sim: HandsSim, promise: Promise<T>, maxMs = 30_000): Promise<T> {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  for (let elapsed = 0; elapsed < maxMs && !settled; elapsed += 50) { sim.tick(); await vi.advanceTimersByTimeAsync(50); }
  return promise;
}
const LATE = 'No block has been placed : the server did not answer within 1500ms (something may be standing in that cell)';

describe('place: an answer that is only late', () => {
  it('a block that shows 2 s after the error is a block placed, and says the server was slow', async () => {
    const sim = makeHandsSim(flat, { start: [0.5, FLOOR, 0.5], items: [{ name: 'dirt', count: 3 }] });
    const real = sim.bot.placeBlock;
    let calls = 0;
    sim.bot.placeBlock = async (reference: any, face: any, check: any) => {
      if (calls++ === 0) {
        setTimeout(() => { void real(reference, face, check).catch(() => undefined); }, 2000);
        throw new Error(LATE);
      }
      return real(reference, face, check);
    };
    const out = await drive(sim, place(ctxOf(sim), { block: 'dirt', at: [{ x: 2, y: FLOOR, z: 0 }] }));
    expect(out.ok, out.text).toBe(true);
    expect(out.text).toContain('サーバーの返事が遅れたが置けた');
    expect(sim.world.nameAt(2, FLOOR, 0)).toBe('dirt');
  });
  it('a server that never takes the block: refused after 3.5 s, saying so', async () => {
    const sim = makeHandsSim(flat, { start: [0.5, FLOOR, 0.5], items: [{ name: 'dirt', count: 3 }] });
    sim.bot.placeBlock = async () => { throw new Error(LATE); };
    const began = Date.now();
    const out = await drive(sim, place(ctxOf(sim), { block: 'dirt', at: [{ x: 2, y: FLOOR, z: 0 }] }));
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('not_placed');
    expect(out.text).toContain('3.5 秒待っても dirt が見えない');
    expect(Date.now() - began).toBeGreaterThanOrEqual(3400);
  });
  it('any other refusal is read after 0.3 s as before', async () => {
    const sim = makeHandsSim(flat, { start: [0.5, FLOOR, 0.5], items: [{ name: 'dirt', count: 3 }] });
    sim.bot.placeBlock = async () => { throw new Error('No block has been placed : the block is still air'); };
    const began = Date.now();
    const out = await drive(sim, place(ctxOf(sim), { block: 'dirt', at: [{ x: 2, y: FLOOR, z: 0 }] }));
    expect(out.reason).toBe('not_placed');
    expect(Date.now() - began).toBeLessThan(1500);
  });
});
