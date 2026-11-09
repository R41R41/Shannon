import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import pathfinder from 'mineflayer-pathfinder';
import { makeHandsSim, type Ground, type HandsSim } from '../helpers/handsSim.js';
import { magmaAcrossStep, magmaAtFootprint } from '../../src/services/minebot/utils/magmaFootprint.js';
import { lavaReflexTick, routeOutOfLava, standsOnMagma } from '../../src/services/minebot/utils/lavaSafety.js';
import { pickup } from '../../src/services/minebot/utils/primitives/pickup.js';
import { atGoal, goWith, walk, walkMovements } from '../../src/services/minebot/utils/primitives/walk.js';
import { go } from '../../src/services/minebot/utils/primitives/go.js';
import type { StepContext } from '../../src/services/minebot/utils/primitives/common.js';

const FLOOR = 64;
const flat: Ground = (x, y, z) => Math.abs(x) > 20 || Math.abs(z) > 20 ? null : y < FLOOR ? 'stone' : 'air';
const magma = (x: number, z: number): Ground => (cx, cy, cz) =>
  cx === x && cy === FLOOR - 1 && cz === z ? 'magma_block' : flat(cx, cy, cz);
const ctxOf = (sim: HandsSim): StepContext => ({ bot: sim.bot, stop: new AbortController().signal,
  deadline: Date.now() + 60_000, facing: 'east', base: { x: 0, y: FLOOR, z: 0 } });
const read = (sim: HandsSim) => (x: number, y: number, z: number) => sim.world.nameAt(x, y, z);
const goal = (x: number, z = 0) => new pathfinder.goals.GoalBlock(x, FLOOR, z);

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] }); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

async function drive<T>(sim: HandsSim, promise: Promise<T>, each: () => void = () => {}): Promise<T> {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  for (let elapsed = 0; elapsed < 30_000 && !settled; elapsed += 50) {
    sim.tick(); each(); await vi.advanceTimersByTimeAsync(50);
  }
  if (!settled) throw new Error('MAGMA_SIMULATION_NOT_SETTLED');
  return promise;
}

describe('magma under the actual body width', () => {
  it('sees a corner over magma even when the centre is over air, including negative coordinates', () => {
    const floor = (x: number, y: number, z: number) => x === 1 && y === FLOOR - 1 && z === 0 ? 'magma_block' : 'air';
    expect(magmaAtFootprint(floor, { x: 0.8, y: FLOOR, z: 0.5 })).toEqual({ x: 1, y: FLOOR - 1, z: 0 });
    expect(magmaAtFootprint(floor, { x: 0.5, y: FLOOR, z: 0.5 })).toBeNull();
    expect(magmaAtFootprint(floor, { x: 0.8, y: FLOOR + 1, z: 0.5 })).toBeNull();
    expect(magmaAtFootprint((x, y, z) => floor(x + 1, y, z), { x: -0.2, y: FLOOR, z: 0.5 }))
      .toEqual({ x: 0, y: FLOOR - 1, z: 0 });
  });

  it('rejects a diagonal corner cut but keeps the safe cardinal step beside the same floor', () => {
    const sim = makeHandsSim(magma(1, 0));
    const start = { x: 0, y: FLOOR, z: 0 };
    expect(magmaAcrossStep(read(sim), start, { x: 1, y: FLOOR, z: 1 })).toEqual({ x: 1, y: FLOOR - 1, z: 0 });
    expect(magmaAcrossStep(read(sim), start, { x: 0, y: FLOOR, z: 1 })).toBeNull();
    const moves = walkMovements(sim.bot, false).getNeighbors(start);
    expect(moves.some((move: Vec3) => move.x === 1 && move.z === 1 && move.y === FLOOR)).toBe(false);
    expect(moves.some((move: Vec3) => move.x === 0 && move.z === 1 && move.y === FLOOR)).toBe(true);
  });

  it('never reports arrival with a corner still on magma, and leaves the existing non-held escape reflex usable', async () => {
    const sim = makeHandsSim(magma(1, 0), { start: [0.8, FLOOR, 0.5] });
    expect(atGoal(sim.bot, goal(0))).toBe(false);
    const outcome = await goWith(ctxOf(sim), goal(0), 5000, { opened: [], leaves: 0 });
    expect(outcome.reached).toBe(false);
    expect(outcome.magma).toEqual({ x: 1, y: FLOOR - 1, z: 0 });
    // The real pathfinder can recenter the body while stopping. A later push puts its corner back on magma;
    // navigation has detached and must not keep cancelling the existing escape reflex.
    const stop = vi.spyOn(sim.bot.pathfinder, 'stop');
    sim.bot.entity.position = new Vec3(0.8, FLOOR, 0.5);
    expect(standsOnMagma(sim.bot)).toBe(true);
    expect(routeOutOfLava(sim.bot, sim.bot.entity.position, { offMagma: true })).not.toBeNull();
    const state: import('../../src/services/minebot/utils/lavaSafety.js').LavaReflexState = { engaged: false, engagements: 0, clearTicks: 0 };
    for (let tick = 0; tick < 10; tick++) lavaReflexTick(sim.bot, state);
    expect(state.engaged).toBe(false);
    expect(state.magma).toMatchObject({ on: true, ticks: 10, steeringSince: 7 });
    expect(sim.control.forward).toBe(true);
    sim.bot.emit('physicsTick');
    expect(stop).not.toHaveBeenCalled();
  });

  it('stops navigation before the next tick overlaps magma and does not keep taking the escape controls', async () => {
    const sim = makeHandsSim(magma(1, 0));
    let finish: (() => void) | undefined;
    vi.spyOn(sim.bot.pathfinder, 'goto').mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    const stop = vi.spyOn(sim.bot.pathfinder, 'stop').mockImplementation(() => { finish?.(); });
    const running = goWith(ctxOf(sim), goal(8), 5000, { opened: [], leaves: 0 });
    sim.bot.entity.position = new Vec3(0.65, FLOOR, 0.5);
    sim.bot.entity.velocity = new Vec3(0.12, -0.08, 0);
    expect(magmaAtFootprint(read(sim), sim.bot.entity.position)).toBeNull();
    sim.bot.emit('physicsTick');
    const outcome = await running;
    expect(outcome.magma).toEqual({ x: 1, y: FLOOR - 1, z: 0 });
    expect(stop).toHaveBeenCalledOnce();
    sim.bot.emit('physicsTick');
    expect(stop).toHaveBeenCalledOnce();
  });
});

describe('the hands on real client physics beside magma', () => {
  it('takes a drop over magma from the safe neighbouring floor without touching the magma', async () => {
    const sim = makeHandsSim(magma(5, 0));
    const id = 900;
    sim.bot.entities[id] = { id, name: 'item', displayName: 'Item', type: 'other', position: new Vec3(5.5, FLOOR + 0.4, 0.5),
      velocity: new Vec3(0, 0, 0), getDroppedItem: () => ({ name: 'cobblestone', count: 1 }), metadata: [] };
    let touched = false;
    const outcome = await drive(sim, pickup(ctxOf(sim), { ids: [id] }), () => { touched ||= !!magmaAtFootprint(read(sim), sim.bot.entity.position); });
    expect(outcome.ok).toBe(true);
    expect(sim.bot.entities[id]).toBeUndefined();
    expect(sim.count('cobblestone')).toBe(1);
    expect(touched).toBe(false);
  });

  it.each(['walk', 'go'] as const)('%s keeps the safe one-block-wide row next to magma available', async hand => {
    const ground: Ground = (x, y, z) => y === FLOOR - 1 && z === 1 && x >= 0 && x <= 9 ? 'magma_block' : flat(x, y, z);
    const sim = makeHandsSim(ground);
    const target = { x: 8, y: FLOOR, z: 0 };
    let touched = false;
    const running = hand === 'walk' ? walk(ctxOf(sim), { to: target, range: 0, sprint: false })
      : go(ctxOf(sim), { goals: [target], range: 0, sprint: false, searchMs: 30_000 });
    const outcome = await drive(sim, running, () => { touched ||= !!magmaAtFootprint(read(sim), sim.bot.entity.position); });
    expect(outcome.ok).toBe(true);
    expect(Math.floor(sim.bot.entity.position.x)).toBe(8);
    expect(touched).toBe(false);
  });
});
