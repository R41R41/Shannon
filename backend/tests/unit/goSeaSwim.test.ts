import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSim, type Ground, type Sim } from '../helpers/physicsBody.js';
import { go } from '../../src/services/minebot/utils/primitives/go.js';
import type { StepOutcome } from '../../src/services/minebot/utils/primitives/common.js';
import { surfaceSwimControls } from '../../src/services/minebot/utils/primitives/swim.js';
import { Vec3 } from 'vec3';

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }));
afterEach(() => vi.useRealTimers());

// An open sea 100 m long: stone under y55, still water up to y62 (the face), air over it. Land (stone to y62, grass on top) past x=80.
const sea: Ground = (x, y, z) => x < -6 || x > 100 || Math.abs(z) > 12 ? null
  : x > 80 ? (y < 63 ? 'stone' : 'air')
  : y < 55 ? 'stone' : y < 63 ? 'water' : 'air';
// A deep open sea as in the run (the floor 30 under the face, wide on both sides), with kelp standing to the face here and there.
const deep: Ground = (x, y, z) => x < -40 || x > 140 || Math.abs(z) > 80 ? null
  : y < 32 ? 'stone' : y < 63 ? ((x * 7 + z * 13) % 23 === 0 && z !== 0 && y > 40 ? 'kelp_plant' : 'water') : 'air';

async function timed(sim: Sim, promise: Promise<StepOutcome>, limitMs: number) {
  let finished = false;
  promise.finally(() => { finished = true; }).catch(() => {});
  const begun = Date.now();
  for (let ms = 0; ms < limitMs && !finished; ms += 50) {
    sim.tick();
    await vi.advanceTimersByTimeAsync(50);
  }
  return { result: await promise, seconds: (Date.now() - begun) / 1000 };
}
const goTo = (sim: Sim, x: number, y: number, seconds: number) => go({ bot: sim.bot, stop: new AbortController().signal,
  deadline: Date.now() + (seconds + 5) * 1000, facing: 'north', base: { x: 0, y: 62, z: 0 } },
{ goals: [{ x, y, z: 0 }], range: 2, waterOk: true, seconds });

describe('a long swim across an open sea (end1109s09 S9: 0.85 m/s by the route search, 35 redraws in two minutes)', () => {
  it('swims 60 m along the face at about the client\'s swimming speed, without laying or digging', async () => {
    const sim = makeSim(sea, { start: [0.5, 62.2, 0.5] });
    const { result, seconds } = await timed(sim, goTo(sim, 60, 62, 70), 80_000);
    expect(result.ok).toBe(true);
    expect(result.data?.work).toMatchObject({ dug: 0, placed: 0 });
    expect(60 / seconds).toBeGreaterThan(1.5);
  });
  it('swims 100 m over a deep, wide sea at about the swimming speed', async () => {
    const sim = makeSim(deep, { start: [0.5, 62.2, 0.5] });
    const { result, seconds } = await timed(sim, goTo(sim, 100, 62, 110), 120_000);
    expect(result.ok).toBe(true);
    expect(100 / seconds).toBeGreaterThan(1.5);
  });
  it('lands on the far shore after the swim', async () => {
    const sim = makeSim(sea, { start: [0.5, 62.2, 0.5] });
    const { result } = await timed(sim, goTo(sim, 84, 63, 70), 80_000);
    expect(result.ok).toBe(true);
    expect(sim.bot.entity.position.x).toBeGreaterThan(81);
  });
  it('steps off a perch 24 over the sea into the water when told to (the perch line of end1109s10)', async () => {
    const perch: Ground = (x, y, z) => Math.abs(x) > 8 || Math.abs(z) > 8 ? null
      : x === 0 && z === 0 && y <= 86 ? 'dirt' : y < 50 ? 'stone' : y < 63 ? 'water' : 'air';
    const sim = makeSim(perch, { start: [0.5, 87, 0.5] });
    const go1 = go({ bot: sim.bot, stop: new AbortController().signal, deadline: Date.now() + 25_000, facing: 'north', base: { x: 0, y: 87, z: 0 } },
      { goals: [{ x: 1, y: 62, z: 0 }], range: 1, waterOk: true, seconds: 20 });
    const { result } = await timed(sim, go1, 25_000);
    expect(result.ok).toBe(true);
    expect(sim.bot.entity.position.y).toBeLessThan(64);
  });
  it('steers only through still water with open air over it, and leaves a near place or a dry body to the other ways', () => {
    const near = makeSim(sea, { start: [0.5, 62.2, 0.5] });
    expect(surfaceSwimControls(near.bot, new Vec3(8.5, 62, 0.5))).toBeNull();
    expect(surfaceSwimControls(near.bot, new Vec3(60.5, 62, 0.5))).toMatchObject({ forward: true, jump: true, sneak: false });
    const dry = makeSim((x, y, z) => y < 63 ? 'stone' : 'air', { start: [0.5, 63, 0.5] });
    expect(surfaceSwimControls(dry.bot, new Vec3(60.5, 63, 0.5))).toBeNull();
    const roofed = makeSim((x, y, z) => y === 63 && x > 2 ? 'ice' : sea(x, y, z), { start: [0.5, 62.2, 0.5] });
    expect(surfaceSwimControls(roofed.bot, new Vec3(60.5, 62, 0.5))).toBeNull();
  });
});
