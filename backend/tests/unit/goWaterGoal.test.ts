import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSim, type Ground, type Sim } from '../helpers/physicsBody.js';
import { go, sealedGoalWords } from '../../src/services/minebot/utils/primitives/go.js';

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] }));
afterEach(() => vi.useRealTimers());
const floor = 64;
const ctx = (s: Sim) => ({ bot: s.bot, stop: new AbortController().signal, deadline: Date.now() + 60_000, facing: 'east' as const, base: { x: 0, y: floor, z: 0 } });
async function drive(s: Sim, args: Parameters<typeof go>[1]) {
  let done = false;
  const p = go(ctx(s) as never, args).finally(() => { done = true; });
  for (let ms = 0; ms < 40_000 && !done; ms += 50) { s.tick(); await vi.advanceTimersByTimeAsync(50); }
  return p;
}
const pool: Ground = (x, y, z) => Math.abs(x) > 15 || Math.abs(z) > 15 ? null : y < floor ? 'stone' : x >= 4 && x <= 6 && Math.abs(z) <= 1 && y <= floor + 2 ? 'water' : 'air';

describe('arrival cells obey the same water permission as movement', () => {
  it.each([0, 1])('rejects water at body height %i before any search or excavation', async dy => {
    const s = makeSim((x, y, z) => y === floor + dy && x === 5 && z === 0 ? 'water' : pool(x, y, z) === 'water' ? 'air' : pool(x, y, z), { start: [0.5, floor, 0.5] });
    const search = vi.spyOn(s.bot.pathfinder, 'getPathFromTo');
    const r = await drive(s, { goals: [{ x: 5, y: floor, z: 0 }], canDig: ['stone'], seconds: 30 });
    expect(r.reason).toBe('dead_end');
    expect(r.text).toContain('waterOk');
    expect(search).not.toHaveBeenCalled();
    expect(s.bot.dugBlocks).toEqual([]);
  });
  it('rejects a wholly wet radius but preserves dry boundary and unknown alternatives', () => {
    const s = makeSim(pool);
    expect(sealedGoalWords(s.bot, { x: 5, y: floor, z: 0 }, 1, { names: new Set() }, false)).toContain('waterOk');
    for (const name of ['air', null] as const) {
      const edge = makeSim((x, y, z) => x === 4 && z === 0 && y >= floor ? name : pool(x, y, z));
      expect(sealedGoalWords(edge.bot, { x: 5, y: floor, z: 0 }, 1, { names: new Set() }, false)).toBeNull();
    }
  });
  it('retains another dry goal and a dry radius boundary', async () => {
    const s = makeSim(pool, { start: [0.5, floor, 0.5] });
    expect((await drive(s, { goals: [{ x: 5, y: floor, z: 0 }, { x: 0, y: floor, z: 3 }], seconds: 30 })).ok).toBe(true);
    const edge = makeSim((x, y, z) => x === 4 && z === 0 && y >= floor ? 'air' : pool(x, y, z), { start: [0.5, floor, 0.5] });
    expect((await drive(edge, { goals: [{ x: 5, y: floor, z: 0 }], range: 1, seconds: 30 })).ok).toBe(true);
  });
  it('allows explicit swimming and preserves the already-in-water exception', async () => {
    const s = makeSim(pool, { start: [0.5, floor, 0.5] });
    expect((await drive(s, { goals: [{ x: 5, y: floor, z: 0 }], waterOk: true, seconds: 30 })).text).not.toContain('waterOk');
    const wet = makeSim(pool, { start: [5.5, floor, 0.5] });
    expect((await drive(wet, { goals: [{ x: 5, y: floor, z: 0 }], seconds: 30 })).ok).toBe(true);
  });
});
