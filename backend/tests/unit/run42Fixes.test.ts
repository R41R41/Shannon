import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import { makeSim, type Ground, type Sim } from '../helpers/physicsBody.js';
import type { StepContext, StepOutcome } from '../../src/services/minebot/utils/primitives/common.js';
import { inWall, lying, wallCells } from '../../src/services/minebot/utils/wallReflex.js';

// The simulated body has no server: the dig's wait for the server's word is the body's own dig here.
vi.mock('../../src/services/minebot/utils/digBlockVerified.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/services/minebot/utils/digBlockVerified.js')>();
  return { ...actual, digBlockVerified: vi.fn(async (bot: any, block: any) => { await bot.dig(block); return { stateId: 0, blockName: 'air' }; }) };
});
const { go } = await import('../../src/services/minebot/utils/primitives/go.js');
const { dig } = await import('../../src/services/minebot/utils/primitives/dig.js');

/** Run 42 (2026-10-27): what the body did wrong in the run, as unit cases. */
const cube = (name: string) => ({ name, boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] });
const air = { name: 'air', boundingBox: 'empty', shapes: [] };

describe('run 42: the wall reflex leaves a body lying in a bed', () => {
  // +711: the bed at (150,-5,229), the tuff of the cave's ceiling at y=-3, the server's sleeping place y=-4.31.
  const world: Record<string, any> = { '150,-5,229': { name: 'red_bed', boundingBox: 'block', shapes: [[0, 0, 0, 1, 0.5625, 1]] }, '150,-3,229': cube('tuff'),
    '150,-4,229': air };
  const body = (y: number, isSleeping = false): any => ({ entity: { position: new Vec3(150.5, y, 229.5) }, isSleeping,
    blockAt: (p: Vec3) => world[`${p.x},${p.y},${p.z}`] ?? air, on: () => undefined });

  it('takes run 42\'s +711 (asleep, or at the bed\'s place before the client hears it) as lying, with its eye in the bed\'s cell', () => {
    expect(lying(body(-4.3125, true))).toBe(true);
    expect(lying(body(-4.3125, false))).toBe(true);
    expect(inWall(body(-4.3125, true))).toBe(false);
    expect(inWall(body(-4.3125, false))).toBe(false);
    expect(wallCells(body(-4.3125))).toEqual([]);
  });
  it('still finds the head of a body standing under the tuff, on the floor above the bed', () => {
    expect(lying(body(-4))).toBe(false);
    expect(inWall(body(-4))).toBe(true);
    expect(wallCells(body(-4)).map(cell => `${cell.at.x},${cell.at.y},${cell.at.z}`)).toEqual(['150,-3,229']);
  });
  it('takes a body standing on the bed (0.56 above its cell) as standing, with a block at its head', () => {
    world['150,-3,229'] = cube('gravel');
    expect(lying(body(-4.4375))).toBe(false);
    expect(inWall(body(-4.4375))).toBe(true);
  });
});

const FLOOR = 64;
const R = 40;
const ctxOf = (sim: Sim, seconds = 600): StepContext => ({ bot: sim.bot, stop: new AbortController().signal, deadline: Date.now() + seconds * 1000, facing: 'north', base: { x: 0, y: FLOOR, z: 0 } });
async function drive<T>(sim: Sim, promise: Promise<T>, maxMs = 240_000): Promise<T> {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  for (let elapsed = 0; elapsed < maxMs && !settled; elapsed += 50) { sim.tick(); await vi.advanceTimersByTimeAsync(50); }
  return promise;
}

describe('run 42: a climb from a moss carpet', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] }); });
  afterEach(() => { vi.useRealTimers(); });
  // +820 q64: the body on a moss carpet over moss blocks (feet 0.06 up the carpet's cell), carpets and grass around it, the place up a cliff.
  const carpeted: Ground = (x, y, z) => (Math.abs(x) > R || Math.abs(z) > R ? null : y < FLOOR ? 'stone'
    : x >= 2 && y <= FLOOR + 3 ? 'stone' : y === FLOOR && x >= -2 && x <= 1 && Math.abs(z) <= 2 ? 'moss_carpet' : 'air');

  it('dig digs the carpet under the feet when asked for the floor (thin), and passes it as open otherwise', async () => {
    const sim = makeSim(carpeted, { start: [0.5, FLOOR + 0.0625, 0.5], items: [{ name: 'cobblestone', count: 16 }] });
    for (let i = 0; i < 20; i++) { sim.tick(); await vi.advanceTimersByTimeAsync(50); }
    const passed = await drive(sim, dig(ctxOf(sim), { at: [{ x: -1, y: FLOOR, z: 0 }], collect: false }));
    expect(passed.text).toContain('は既に moss_carpet（掘らずに次へ）');
    expect(sim.bot.dugBlocks).toEqual([]);
    const thin = await drive(sim, dig(ctxOf(sim), { at: [{ x: -1, y: FLOOR, z: 0 }], collect: false, thin: true }));
    expect(thin.ok).toBe(true);
    expect(sim.bot.dugBlocks.length).toBe(1);
  });

  it('go digs the carpet and climbs, and never stands until its time runs out (it stood 115 s of 120 in run 42)', async () => {
    const sim = makeSim(carpeted, { start: [0.5, FLOOR + 0.0625, 0.5], items: [{ name: 'cobblestone', count: 16 }] });
    for (let i = 0; i < 20; i++) { sim.tick(); await vi.advanceTimersByTimeAsync(50); }
    const started = Date.now();
    const outcome: StepOutcome = await drive(sim, go(ctxOf(sim), { goals: [{ x: 3, y: FLOOR + 4, z: 0 }], canPlace: ['cobblestone'], range: 1, seconds: 60 }));
    expect(outcome.text).not.toMatch(/limit_time/u);
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(outcome.ok).toBe(true);
  });
});
