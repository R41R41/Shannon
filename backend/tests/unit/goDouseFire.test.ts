import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSim, type Ground } from '../helpers/physicsBody.js';
import { go, type GoArgs } from '../../src/services/minebot/utils/primitives/go.js';
import type { StepContext } from '../../src/services/minebot/utils/primitives/common.js';

// S2 (2026-11-02, S4's c1 trial): a blaze's fireballs light the cells round its camp again and again, `go` refused the camp cell as "beside fire" every time, and each refusal was a dig of the
// planner's own (the camp was lost after five). Fire within the body's reach, in or beside a place, is now put out by the go itself (the dig hand's 0.2 s); out of reach it is still said.
// The dig confirms with the server's packets, which a simulation has none of: the confirmed dig is a stand-in that changes the simulated world.
let simulated: ReturnType<typeof makeSim> | null = null;
vi.mock('../../src/services/minebot/utils/digBlockVerified.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/services/minebot/utils/digBlockVerified.js')>();
  return { ...actual, digBlockVerified: vi.fn(async (_bot: any, block: any) => {
    const p = block.position;
    simulated!.world.set(p.x, p.y, p.z, 'air');
    simulated!.bot.dugBlocks.push(`${block.name}@${p.x},${p.y},${p.z}`);
    simulated!.bot.emit('blockUpdate', block, simulated!.world.getBlock(p));
    return { stateId: 0, blockName: 'air' };
  }) };
});

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] }); });
afterEach(() => { vi.useRealTimers(); simulated = null; });

const FLOOR = 64;
const R = 40;
const flat: Ground = (x, y, z) => (Math.abs(x) > R || Math.abs(z) > R ? null : y < FLOOR ? 'stone' : 'air');
const fireAt = (cells: Array<[number, number, number]>): Ground => (x, y, z) => (cells.some(([cx, cy, cz]) => cx === x && cy === y && cz === z) ? 'fire' : flat(x, y, z));
const ctxOf = (sim: ReturnType<typeof makeSim>): StepContext => ({ bot: sim.bot, stop: new AbortController().signal, deadline: Date.now() + 600_000, facing: 'north', base: { x: 0, y: FLOOR, z: 0 } });
async function drive<T>(sim: ReturnType<typeof makeSim>, promise: Promise<T>, maxMs = 120_000): Promise<T> {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  for (let elapsed = 0; elapsed < maxMs && !settled; elapsed += 50) { sim.tick(); await vi.advanceTimersByTimeAsync(50); }
  return promise;
}
const run = (sim: ReturnType<typeof makeSim>, to: { x: number; y: number; z: number }, args: Partial<GoArgs> = {}) => go(ctxOf(sim), { goals: [to], ...args });

describe('go: fire in or beside a place', () => {
  it('is put out when within reach, and the go goes on (and says how many were put out)', async () => {
    simulated = makeSim(fireAt([[4, FLOOR, 0]]));
    const outcome = await drive(simulated, run(simulated, { x: 3, y: FLOOR, z: 0 }));
    expect(outcome.ok).toBe(true);
    expect(outcome.text).toContain('火を 1 個消した');
    expect(simulated.bot.dugBlocks).toEqual(['fire@4,64,0']);
    expect(Math.floor(simulated.bot.entity.position.x)).toBe(3);
  });

  it('several fires round one place are all put out (up to four a place), the body standing where it is', async () => {
    simulated = makeSim(fireAt([[3, FLOOR, 0], [2, FLOOR, 1], [2, FLOOR, -1]]));
    const outcome = await drive(simulated, run(simulated, { x: 2, y: FLOOR, z: 0 }));
    expect(outcome.ok).toBe(true);
    expect(outcome.text).toContain('火を 3 個消した');
    expect(simulated.bot.dugBlocks.sort()).toEqual(['fire@2,64,-1', 'fire@2,64,1', 'fire@3,64,0']);
  });

  it('beyond the reach of the body it is not walked to or dug: the place is refused, and the line says where the fire is', async () => {
    simulated = makeSim(fireAt([[31, FLOOR, 0]]));
    const outcome = await drive(simulated, run(simulated, { x: 30, y: FLOOR, z: 0 }));
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('unsafe');
    expect(outcome.text).toContain('火 (31,64,0) は dig で消せる');
    expect(simulated.bot.dugBlocks).toEqual([]);
  });

  it('lava is not put out: a place beside lava is refused as before', async () => {
    simulated = makeSim((x, y, z) => (x === 4 && y === FLOOR && z === 0 ? 'lava' : flat(x, y, z)));
    const outcome = await drive(simulated, run(simulated, { x: 3, y: FLOOR, z: 0 }));
    expect(outcome.reason).toBe('unsafe');
    expect(simulated.bot.dugBlocks).toEqual([]);
  });
});
