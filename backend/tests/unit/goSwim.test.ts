import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSim, type Ground, type Sim } from '../helpers/physicsBody.js';
import { go } from '../../src/services/minebot/utils/primitives/go.js';
import type { StepOutcome } from '../../src/services/minebot/utils/primitives/common.js';
import { swimControls, swimPulse } from '../../src/services/minebot/utils/primitives/swim.js';
import { Vec3 } from 'vec3';

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }));
afterEach(() => vi.useRealTimers());

const pool: Ground = (x, y, z) => Math.abs(x) > 10 || Math.abs(z) > 10 ? null : y < 55 ? 'stone' : y < 67 ? 'water' : 'air';
async function drive(sim: Sim, promise: Promise<StepOutcome>) {
  let finished = false;
  promise.finally(() => { finished = true; }).catch(() => {});
  for (let ms = 0; ms < 20_000 && !finished; ms += 50) {
    sim.tick();
    await vi.advanceTimersByTimeAsync(50);
  }
  return promise;
}
const swim = (sim: Sim, y: number, waterOk = true) => go({ bot: sim.bot, stop: new AbortController().signal,
  deadline: Date.now() + 12_000, facing: 'north', base: { x: 0, y: 63, z: 0 } },
{ goals: [{ x: 0, y, z: 0 }], range: 0, waterOk, seconds: 8 });

describe('go water depth against real client physics', () => {
  it('dives to the requested cell in an open water column without digging or placing', async () => {
    const sim = makeSim(pool, { start: [0.5, 63, 0.5] });
    const result = await drive(sim, swim(sim, 59));
    expect(result.ok).toBe(true);
    expect(Math.floor(sim.bot.entity.position.y)).toBe(59);
    expect(result.data?.work).toMatchObject({ dug: 0, placed: 0 });
    expect(sim.bot.controlState.sneak).toBe(false);
  });
  it('ascends through an open water column to the requested depth', async () => {
    const sim = makeSim(pool, { start: [0.5, 59, 0.5] });
    const result = await drive(sim, swim(sim, 63));
    expect(result.ok).toBe(true);
    expect(Math.floor(sim.bot.entity.position.y)).toBe(63);
    expect(sim.bot.controlState.jump).toBe(false);
  });
  it.each(['ice', 'stone', null])('does not steer through an unpassable or unknown body-width cell: %s', block => {
    const sim = makeSim((x, y, z) => x === 1 && y === 63 && z === 0 ? block : pool(x, y, z), { start: [0.5, 63, 0.5] });
    expect(swimControls(sim.bot, new Vec3(2.5, 62, 0.5))).toBeNull();
    expect(Object.values(sim.bot.controlState).some(Boolean)).toBe(false);
  });
  it('does not steer from dry land or toward a water cell on magma', () => {
    const dry = makeSim((x, y, z) => y < 64 ? 'stone' : 'air');
    expect(swimControls(dry.bot, new Vec3(1.5, 62, 0.5))).toBeNull();
    const magma = makeSim((x, y, z) => y === 58 ? 'magma_block' : pool(x, y, z), { start: [0.5, 63, 0.5] });
    expect(swimControls(magma.bot, new Vec3(0.5, 59, 0.5))).toBeNull();
  });
  it('descends through a narrow opening before moving under ice, and returns horizontally before rising', () => {
    const ice: Ground = (x, y, z) => y === 65 && (x !== 0 || z !== 0) ? 'ice' : pool(x, y, z);
    const down = makeSim(ice, { start: [0.5, 64.5, 0.5] });
    expect(swimControls(down.bot, new Vec3(3.5, 60, 0.5))).toMatchObject({ forward: false, sneak: true });
    const up = makeSim(ice, { start: [3.5, 60, 0.5] });
    expect(swimControls(up.bot, new Vec3(0.5, 64.5, 0.5))).toMatchObject({ forward: true, jump: false });
  });
  it('centres the shoulders before rising through a one-block opening from the recorded 23cm offset', async () => {
    const ice: Ground = (x, y, z) => Math.abs(x) > 12 || Math.abs(z - 24) > 12 ? null
      : y < 55 ? 'stone' : y < 62 ? 'water' : y === 62 && (x !== -5 || z !== 24) ? 'ice' : 'air';
    const sim = makeSim(ice, { start: [-4.616, 60.2, 24.296] });
    const result = await drive(sim, go({ bot: sim.bot, stop: new AbortController().signal,
      deadline: Date.now() + 12_000, facing: 'north', base: { x: -5, y: 60, z: 24 } },
    { goals: [{ x: -5, y: 61, z: 24 }], range: 0, waterOk: true, seconds: 8 }));
    expect(result.ok).toBe(true);
    expect(Math.floor(sim.bot.entity.position.y)).toBe(61);
  });
  it('releases its keys when its action is interrupted during a dive', async () => {
    const sim = makeSim(pool, { start: [0.5, 63, 0.5] });
    const controller = new AbortController();
    const promise = swimPulse({ bot: sim.bot, stop: controller.signal, deadline: Date.now() + 1000,
      facing: 'north', base: { x: 0, y: 63, z: 0 } }, swimControls(sim.bot, new Vec3(0.5, 59, 0.5))!, 500);
    const check = expect(promise).rejects.toThrow();
    controller.abort();
    await vi.advanceTimersByTimeAsync(100);
    await check;
    expect(Object.values(sim.bot.controlState).some(Boolean)).toBe(false);
  });
});
