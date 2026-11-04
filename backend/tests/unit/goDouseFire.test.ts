import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSim, type Ground } from '../helpers/physicsBody.js';
import { go, type GoArgs } from '../../src/services/minebot/utils/primitives/go.js';
import { StepStopped, type StepContext } from '../../src/services/minebot/utils/primitives/common.js';

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
/** A two-high passage with no way round the fire, and a safe place beyond it. */
const passage: Ground = (x, y, z) => (x < -1 || x > 10 || Math.abs(z) > 2 || y < FLOOR - 2 || y > FLOOR + 3 ? null
  : x < 0 || x > 9 || z !== 0 || y < FLOOR || y >= FLOOR + 2 ? 'stone' : 'air');
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

describe('go: fire shutting the way to a place', () => {
  it.each(['fire', 'soul_fire'])('puts out reachable %s, searches with the hazards kept, and arrives', async name => {
    simulated = makeSim((x, y, z) => (x === 3 && y === FLOOR && z === 0 ? name : passage(x, y, z)));
    const outcome = await drive(simulated, run(simulated, { x: 8, y: FLOOR, z: 0 }));
    expect(outcome.ok).toBe(true);
    expect(outcome.text).toContain('火を 1 個消した');
    expect(simulated.bot.dugBlocks).toEqual([`${name}@3,64,0`]);
    expect(Math.floor(simulated.bot.entity.position.x)).toBe(8);
  });

  it('keeps a way through lava shut and digs nothing', async () => {
    simulated = makeSim((x, y, z) => (x === 3 && y === FLOOR && z === 0 ? 'lava' : passage(x, y, z)));
    const outcome = await drive(simulated, run(simulated, { x: 8, y: FLOOR, z: 0 }));
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('lava');
    expect(simulated.bot.dugBlocks).toEqual([]);
  });

  it.each(['lava', 'magma_block', 'cactus'])('does not douse a way with fire and %s, even when fire hides the other hazard', async name => {
    simulated = makeSim((x, y, z) => (x === 3 && y === FLOOR && z === 0 ? 'fire'
      : x === 3 && y === (name === 'magma_block' ? FLOOR - 1 : FLOOR) && z === (name === 'magma_block' ? 0 : 1) ? name : passage(x, y, z)));
    const outcome = await drive(simulated, run(simulated, { x: 8, y: FLOOR, z: 0 }));
    expect(outcome.reason).toBe('lava');
    expect(simulated.bot.dugBlocks).toEqual([]);
    expect(Math.floor(simulated.bot.entity.position.x)).toBe(0);
  });

  it('puts out all reachable fires in and beside the way, counting each only once', async () => {
    const fires = ['3,64,0', '3,65,0', '3,64,1'];
    simulated = makeSim((x, y, z) => (fires.includes(`${x},${y},${z}`) ? 'fire' : passage(x, y, z)));
    const outcome = await drive(simulated, run(simulated, { x: 8, y: FLOOR, z: 0 }));
    expect(outcome.ok).toBe(true);
    expect(outcome.text).toContain('火を 3 個消した');
    expect(simulated.bot.dugBlocks.sort()).toEqual(fires.map(cell => `fire@${cell}`).sort());
  });

  it('names the fire shutting the way when it is beyond reach, without walking toward it', async () => {
    simulated = makeSim((x, y, z) => (x === 6 && y === FLOOR && z === 0 ? 'fire' : passage(x, y, z)));
    const outcome = await drive(simulated, run(simulated, { x: 8, y: FLOOR, z: 0 }));
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('lava');
    expect(outcome.text).toContain('火 (6,64,0) が道を塞いでいる（届かない）');
    expect(simulated.bot.dugBlocks).toEqual([]);
    expect(Math.floor(simulated.bot.entity.position.x)).toBe(0);
  });

  it('stops after two dousing rounds when the same way keeps catching fire', async () => {
    simulated = makeSim((x, y, z) => (x === 3 && y === FLOOR && z === 0 ? 'fire' : passage(x, y, z)));
    simulated.bot.on('blockUpdate', (before: any) => { if (before.name === 'fire') simulated!.world.set(3, FLOOR, 0, 'fire'); });
    const outcome = await drive(simulated, run(simulated, { x: 8, y: FLOOR, z: 0 }));
    expect(outcome.reason).toBe('lava');
    expect(outcome.text).toContain('火 (3,64,0) が道を塞いでいる（消しても道が開かない）');
    expect(outcome.text).toContain('火を 2 個消した');
    expect(simulated.bot.dugBlocks).toEqual(['fire@3,64,0', 'fire@3,64,0']);
    expect(Math.floor(simulated.bot.entity.position.x)).toBe(0);
  });

  it('shares the eight-fire limit with fires put out beside the original places', async () => {
    // Two places in the starting room share a fire that keeps relighting (four digs each); the way beyond has another fire.
    simulated = makeSim((x, y, z) => (y === FLOOR && ((x === 1 && z === 1) || (x === 3 && z === 0)) ? 'fire'
      : x >= 0 && x <= 2 && z >= 0 && z <= 2 && (y === FLOOR || y === FLOOR + 1) ? 'air' : passage(x, y, z)));
    simulated.bot.on('blockUpdate', (before: any) => { if (before.position.x === 1) simulated!.world.set(1, FLOOR, 1, 'fire'); });
    const outcome = await drive(simulated, go(ctxOf(simulated), { goals: [{ x: 1, y: FLOOR, z: 0 }, { x: 1, y: FLOOR, z: 2 }, { x: 8, y: FLOOR, z: 0 }] }));
    expect(outcome.reason).toBe('lava');
    expect(outcome.text).toContain('火を 8 個消した');
    expect(simulated.bot.dugBlocks).toHaveLength(8);
    expect(simulated.bot.dugBlocks.every((block: string) => block === 'fire@1,64,1')).toBe(true);
    expect(Math.floor(simulated.bot.entity.position.x)).toBe(0);
  });

  it('stops dousing when the act is aborted', async () => {
    const controller = new AbortController();
    simulated = makeSim((x, y, z) => (x === 3 && (y === FLOOR || y === FLOOR + 1) && z === 0 ? 'fire' : passage(x, y, z)));
    simulated.bot.on('blockUpdate', () => controller.abort());
    await expect(drive(simulated, go({ ...ctxOf(simulated), stop: controller.signal }, { goals: [{ x: 8, y: FLOOR, z: 0 }] }))).rejects.toBeInstanceOf(StepStopped);
    expect(simulated.bot.dugBlocks).toEqual(['fire@3,64,0']);
    expect(Math.floor(simulated.bot.entity.position.x)).toBe(0);
  });
});
