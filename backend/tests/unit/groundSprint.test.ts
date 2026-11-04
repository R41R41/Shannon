import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSim, type Ground, type Sim } from '../helpers/physicsBody.js';
import { watchGroundSprint } from '../../src/services/minebot/utils/groundSprint.js';
import { digRuleOf, go, goMovements, type GoState } from '../../src/services/minebot/utils/primitives/go.js';
import { walk, walkMovements } from '../../src/services/minebot/utils/primitives/walk.js';
import type { StepContext, StepOutcome } from '../../src/services/minebot/utils/primitives/common.js';

const Y = 64;
const flat: Ground = (x, y, z) => Math.abs(x) > 32 || Math.abs(z) > 32 ? null : y < Y ? 'stone' : 'air';
const state = (): GoState => ({ steps: 0, dug: 0, placed: 0, redraws: 0, veto: null, refused: 0,
  exposed: new Map(), avoid: new Set(), dugCells: new Set(), laidCells: new Set() });
const profiles = [
  { name: 'walk', make: (sim: Sim, sprint: boolean, _state: GoState) => walkMovements(sim.bot, sprint) },
  { name: 'go', make: (sim: Sim, sprint: boolean, current: GoState) => goMovements(sim.bot,
    { sprint, maxDrop: 3, waterOk: false, maxDig: 0, maxPlace: 0 }, digRuleOf(sim.bot.registry, []), [], current) },
];
const points = (end = 16) => Array.from({ length: end }, (_, i) => ({ x: i + 1.5, y: Y, z: 0.5, toBreak: [], toPlace: [], parkour: false }));

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] }); });
afterEach(() => { vi.useRealTimers(); });

type Frame = { x: number; sprint: boolean };
async function travel(sim: Sim, kind: string, end = 16, sprint?: boolean): Promise<{ out: StepOutcome; frames: Frame[] }> {
  const controller = new AbortController();
  const ctx: StepContext = { bot: sim.bot, stop: controller.signal, deadline: Date.now() + 30_000,
    facing: 'east', base: { x: 0, y: Y, z: 0 } };
  const to = { x: end, y: Y, z: 0 };
  const promise = kind === 'walk' ? walk(ctx, { to, sprint }) : go(ctx, { goals: [to], seconds: 20, sprint });
  let done = false;
  promise.then(() => { done = true; }, () => { done = true; });
  const frames: Frame[] = [];
  for (let elapsed = 0; elapsed < 30_000 && !done; elapsed += 50) {
    sim.tick();
    frames.push({ x: sim.bot.entity.position.x, sprint: sim.control.sprint! });
    await vi.advanceTimersByTimeAsync(50);
  }
  if (!done) { controller.abort(); await vi.advanceTimersByTimeAsync(50); }
  return { out: await promise, frames };
}

describe.each(profiles)('$name sprint on open ground (real local physics and pathfinder, no server)', ({ name, make }) => {
  it('allows default sprint on an open straight and returns to walking before the goal', async () => {
    const sim = makeSim(flat), listeners = sim.bot.listenerCount('physicsTick');
    const { out, frames } = await travel(sim, name);
    expect(out.ok, out.text).toBe(true);
    expect(frames.some(f => f.sprint)).toBe(true);
    const near = frames.filter(f => f.x >= 14);
    expect(near.length).toBeGreaterThan(0);
    expect(near.every(f => !f.sprint)).toBe(true);
    expect(sim.bot.listenerCount('physicsTick')).toBe(listeners);
    expect(sim.control.sprint).toBe(false);
  });

  it('walks beside a water edge and can run again on the dry open stretch', async () => {
    const sim = makeSim((x, y, z) => x >= 6 && x <= 9 && z >= 1 && z <= 3 && y >= Y - 4 && y < Y ? 'water' : flat(x, y, z));
    const { out, frames } = await travel(sim, name, 20);
    expect(out.ok, out.text).toBe(true);
    const shore = frames.filter(f => f.x >= 5 && f.x <= 10);
    expect(shore.length).toBeGreaterThan(0);
    expect(shore.every(f => !f.sprint)).toBe(true);
    expect(frames.some(f => f.x > 12 && f.sprint)).toBe(true);
    expect(sim.bot.entity.isInWater).toBe(false);
  });

  it('returns to walking before an edge, while still on its supported approach', async () => {
    const sim = makeSim((x, y, z) => x >= 12 && y >= Y - 8 && y < Y ? 'air' : flat(x, y, z));
    const { out, frames } = await travel(sim, name, 10);
    expect(out.ok, out.text).toBe(true);
    expect(frames.some(f => f.x < 6 && f.sprint)).toBe(true);
    const approach = frames.filter(f => f.x >= 8);
    expect(approach.length).toBeGreaterThan(0);
    expect(approach.every(f => !f.sprint)).toBe(true);
    expect(sim.bot.entity.position.y).toBeCloseTo(Y, 2);
  });

  it('respects explicit sprint:false on an open straight', async () => {
    const sim = makeSim(flat);
    const { out, frames } = await travel(sim, name, 16, false);
    expect(out.ok, out.text).toBe(true);
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every(f => !f.sprint)).toBe(true);
  });

  it('keeps walking gap jumps but never plans a sprint-only jump across a three-wide river', () => {
    const river = makeSim((x, y, z) => x >= 1 && x <= 3 && y >= Y - 4 && y < Y ? 'water' : flat(x, y, z));
    const movements = make(river, true, state()), moves: any[] = [];
    movements.getMoveParkourForward({ x: 0, y: Y, z: 0, remainingBlocks: 0 }, { x: 1, z: 0 }, moves);
    expect(moves).toEqual([]);
    expect(movements.allowSprinting).toBe(true);

    const dip = makeSim((x, y, z) => x === 1 && y === Y - 1 ? 'air' : flat(x, y, z));
    const shortMoves: any[] = [];
    make(dip, true, state()).getMoveParkourForward({ x: 0, y: Y, z: 0, remainingBlocks: 0 }, { x: 1, z: 0 }, shortMoves);
    expect(shortMoves.some(m => m.x === 2 && m.y === Y && m.parkour)).toBe(true);
  });

  it('updates before the executor, latches a real collision, and removes its listener on close', () => {
    const sim = makeSim(flat), movements = make(sim, true, state());
    sim.bot.pathfinder.setMovements(movements);
    const listeners = sim.bot.listenerCount('physicsTick');
    const watch = watchGroundSprint(sim.bot);
    try {
      expect(movements.allowSprinting).toBe(false); // no route yet
      watch.route(points());
      expect(movements.allowSprinting).toBe(true);
      sim.control.sprint = true;
      sim.bot.emit('path_reset', 'block_updated');
      expect(sim.control.sprint).toBe(false); // a reset cannot carry sprint onto an unknown route
      expect(movements.allowSprinting).toBe(false);
      watch.route(points());
      watch.route([]);
      expect(movements.allowSprinting).toBe(false);
      watch.route(points());
      sim.bot.entity.isCollidedHorizontally = true;
      sim.bot.emit('physicsTick');
      expect(movements.allowSprinting).toBe(false);
      sim.bot.entity.isCollidedHorizontally = false;
      watch.route(points());
      expect(movements.allowSprinting).toBe(false); // a redraw near the collision stays slow
      sim.bot.entity.position.x = 6.5;
      watch.route(points().map(point => ({ ...point, x: point.x + 6 })));
      expect(movements.allowSprinting).toBe(true); // open ground well clear of it can run again
    } finally { watch.close(); watch.close(); }
    expect(movements.allowSprinting).toBe(true);
    expect(sim.bot.listenerCount('physicsTick')).toBe(listeners);
  });

  it.each(['turn', 'climb', 'drop', 'dig', 'place', 'parkour'])('walks before upcoming %s', work => {
    const sim = makeSim(flat), movements = make(sim, true, state());
    sim.bot.pathfinder.setMovements(movements);
    const watch = watchGroundSprint(sim.bot);
    const route: any[] = points();
    if (work === 'turn') route[1].z++;
    if (work === 'climb') route[1].y++;
    if (work === 'drop') route[1].y--;
    if (work === 'dig') route[1].toBreak.push({ x: 2, y: Y, z: 0 });
    if (work === 'place') route[1].toPlace.push({ x: 2, y: Y - 1, z: 0 });
    if (work === 'parkour') route[1].parkour = true;
    try {
      watch.route(route);
      expect(movements.allowSprinting).toBe(false);
    } finally { watch.close(); }
  });

  it.each(['lava', 'air', null, 'oak_door', 'water'])('walks when a neighboring cell of the upcoming rim is %s', obstacle => {
    const sim = makeSim(flat), movements = make(sim, true, state());
    sim.bot.pathfinder.setMovements(movements);
    const watch = watchGroundSprint(sim.bot);
    try {
      watch.route(points()); expect(movements.allowSprinting).toBe(true);
      // A side cell three metres ahead; air/water/lava replace its floor, a door its headroom.
      sim.world.set(3, obstacle === 'oak_door' ? Y : Y - 1, 1, obstacle);
      sim.bot.emit('physicsTick');
      expect(movements.allowSprinting).toBe(false);
    } finally { watch.close(); }
  });
});

it('go walks near a previously stuck cell on subsequent drawings', () => {
  const sim = makeSim(flat), current = state();
  current.avoid.add(`3,${Y},0`);
  sim.bot.pathfinder.setMovements(profiles[1]!.make(sim, true, current));
  const watch = watchGroundSprint(sim.bot);
  try {
    watch.route(points());
    expect(sim.bot.pathfinder.movements.allowSprinting).toBe(false);
    current.avoid.clear();
    sim.bot.emit('physicsTick');
    expect(sim.bot.pathfinder.movements.allowSprinting).toBe(true);
  } finally { watch.close(); }
});
