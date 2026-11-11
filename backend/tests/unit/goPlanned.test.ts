import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSim, type Ground, type Sim, type Stack } from '../helpers/physicsBody.js';
import { goPlannedWith, goWalk, planClearlyFewer, plannedWords, type GoArgs, type GoWalk } from '../../src/services/minebot/utils/primitives/go.js';
import { StepStopped, type StepContext, type StepOutcome } from '../../src/services/minebot/utils/primitives/common.js';
import { followRoute, runsOf, type FollowHands } from '../../src/services/minebot/utils/routeFollow.js';
import { planRoute } from '../../src/services/minebot/utils/routePlan.js';
import type { BlockReader, MapBlock } from '../../src/services/minebot/utils/localMap.js';

// Run 7 (Lai): the plan of utils/routePlan is walked by go when the walk of the route search stops (search_timeout, limit_dig, dead_end) or the plan digs clearly fewer.
// Part one: utils/routeFollow with hands that only record. Part two: go's glue over the real client physics (tests/helpers/physicsBody), the walk of the route search
// given as a stub that stops where a real search would (goPlannedWith), the plan, the tunnel walk and the place hand real.
void StepStopped;
// The tunnel walk asks the server to confirm a dig (a block-change packet); the sim has no packets, so a dig is the sim's own dig.
vi.mock('../../src/services/minebot/utils/digBlockVerified.js', async original => ({ ...(await original<object>()), digBlockVerified: async (bot: any, block: any) => bot.dig(block) }));
const STONE: MapBlock = { name: 'stone', solid: true }, AIR: MapBlock = { name: 'air', solid: false };
const at = (x: number, y: number, z: number) => ({ x, y, z });

describe('planClearlyFewer / plannedWords', () => {
  it('compares only a way that digs enough, and asks for a clear difference', () => {
    expect(planClearlyFewer(5, 0)).toBe(false);          // too short a dig to ask
    expect(planClearlyFewer(12, 10)).toBe(false);        // not clearly fewer
    expect(planClearlyFewer(12, 7)).toBe(true);          // 5 fewer, 42 %
    expect(planClearlyFewer(30, 20)).toBe(false);        // 10 fewer but 33 %
    expect(planClearlyFewer(30, 0)).toBe(true);
  });
  it('says the way walked in one short phrase', () => {
    expect(plannedWords({ steps: 14, digs: 6, places: 2, replans: 0 })).toBe('計画の道: 14 マス・掘 6・置 2');
    expect(plannedWords({ steps: 14, digs: 6, places: 2, replans: 1 })).toContain('出し直し 1 回');
  });
});

/** Hands that record: the body is moved to the end of what it is asked to walk. */
function recordingHands(overrides: Partial<FollowHands> = {}, wet: (cell: { x: number; y: number; z: number }) => boolean = () => false) {
  let feet = at(0, 64, 0);
  const calls: string[] = [];
  const hands: FollowHands = {
    cells: async cells => { calls.push(`cells:${cells.map(c => `${c.x},${c.y},${c.z}`).join(';')}`); const last = cells[cells.length - 1]; feet = at(last.x, last.y, last.z); return { stopped: 'plan_end', steps: cells.length, digs: 0 }; },
    walkTo: async cell => { calls.push(`walk:${cell.x},${cell.y},${cell.z}`); feet = cell; return true; },
    place: async cell => { calls.push(`place:${cell.x},${cell.y},${cell.z}`); return true; },
    dig: async cell => { calls.push(`dig:${cell.x},${cell.y},${cell.z}`); return true; },
    wetAt: cell => wet(cell),
    seal: async cell => { calls.push(`seal:${cell.x},${cell.y},${cell.z}`); return { ok: true, placed: 1, words: '' }; },
    feet: () => feet,
    ...overrides,
  };
  return { hands, calls, setFeet: (cell: { x: number; y: number; z: number }) => { feet = cell; } };
}
const floorTo = (top: number): BlockReader => (_x, y) => (y <= top ? STONE : AIR);

describe('followRoute (hands that record)', () => {
  it('walks a plan that digs through a wall: the cells in a run, the numbers counted from the hands', async () => {
    const read: BlockReader = (x, y, z) => (x >= 3 && x <= 4 && y >= 64 && y <= 65 ? STONE : floorTo(63)(x, y, z));
    const plan = planRoute(read, at(0, 64, 0), [at(8, 64, 0)], {});
    expect(plan.status).toBe('success');
    const { hands, calls } = recordingHands();
    const done = await followRoute(plan, hands, { deadline: Date.now() + 60_000 });
    expect(done.stopped).toBe('reached');
    expect(calls.some(line => line.startsWith('cells:'))).toBe(true);
    expect(calls[calls.length - 1]).toContain('8,64,0');
    expect(done.steps).toBe(plan.steps.length);
  });

  it('a run that would dig past the limit that is left is not begun', async () => {
    const read: BlockReader = (x, y, z) => (x >= 3 && x <= 6 && y >= 64 && y <= 70 ? STONE : floorTo(63)(x, y, z));
    const plan = planRoute(read, at(0, 64, 0), [at(10, 64, 0)], {});
    expect(plan.totals.dig).toBeGreaterThanOrEqual(6);
    const { hands, calls } = recordingHands();
    const done = await followRoute(plan, hands, { deadline: Date.now() + 60_000, maxDig: 2 });
    expect(done.stopped).toBe('limit_dig');
    expect(calls.filter(line => line.startsWith('cells:3,') || line.includes('4,64,0')).length).toBe(0);
  });

  it('the water at the side of a cell is sealed first, and a cell whose water cannot be sealed is not dug', async () => {
    const read: BlockReader = (x, y, z) => (x >= 3 && x <= 3 && y >= 64 && y <= 65 ? STONE : floorTo(63)(x, y, z));
    const plan = planRoute(read, at(0, 64, 0), [at(6, 64, 0)], {});
    const wallCells = new Set(['3,64,0', '3,65,0']);
    const sealed = recordingHands({}, cell => wallCells.has(`${cell.x},${cell.y},${cell.z}`));
    const ok = await followRoute(plan, sealed.hands, { deadline: Date.now() + 60_000 });
    expect(ok.places).toBeGreaterThanOrEqual(1);
    const firstSeal = sealed.calls.findIndex(line => line.startsWith('seal:'));
    const firstCut = sealed.calls.findIndex(line => line.startsWith('cells:') && line.includes('3,64,0'));
    expect(firstSeal).toBeGreaterThanOrEqual(0);
    expect(firstCut).toBeGreaterThan(firstSeal);
    const stuck = recordingHands({ seal: async () => ({ ok: false, placed: 0, words: '置く物が無い' }) }, cell => wallCells.has(`${cell.x},${cell.y},${cell.z}`));
    const blocked = await followRoute(plan, stuck.hands, { deadline: Date.now() + 60_000 });
    expect(blocked.stopped).toBe('blocked');
    expect(blocked.reason).toContain('水');
    expect(stuck.calls.some(line => line.startsWith('cells:') && line.includes('3,64,0'))).toBe(false);
  });

  it('a body that is not where the plan said plans again, at most as many times as it is allowed', async () => {
    const plan = planRoute(floorTo(63), at(0, 64, 0), [at(6, 64, 0)], {});
    let replans = 0;
    const { hands } = recordingHands({ cells: async () => ({ stopped: 'plan_end', steps: 1, digs: 0 }), feet: () => at(0, 64, 0) });
    const done = await followRoute(plan, hands, { deadline: Date.now() + 60_000, maxReplans: 2, replan: from => { replans++; return planRoute(floorTo(63), from, [at(6, 64, 0)], {}); } });
    expect(replans).toBe(2);
    expect(done.replans).toBe(2);
    expect(done.stopped).toBe('off_route');
  });

  it('runsOf: a bridge is its own run, a diagonal is walked, steps that are cells go together', () => {
    const open = planRoute(floorTo(63), at(0, 64, 0), [at(3, 64, 3)], {});
    const runs = runsOf(at(0, 64, 0), open.steps);
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.every(run => run.kind === 'walk' || run.kind === 'cells')).toBe(true);
  });
});

// ---- the glue, over the real physics ----

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] }); });
afterEach(() => { vi.useRealTimers(); });

const FLOOR = 64;
const R = 40;
const flat: Ground = (x, y, z) => (Math.abs(x) > R || Math.abs(z) > R ? null : y < FLOOR ? 'stone' : 'air');
type Layer = (x: number, y: number, z: number) => string | null | undefined;
const over = (base: Ground, ...layers: Layer[]): Ground => (x, y, z) => {
  for (const layer of layers) { const name = layer(x, y, z); if (name !== undefined) return name; }
  return base(x, y, z);
};
const box = (name: string, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): Layer => (x, y, z) =>
  (x >= x0 && x <= x1 && y >= y0 && y <= y1 && z >= z0 && z <= z1 ? name : undefined);
const ctxOf = (sim: Sim): StepContext => ({ bot: sim.bot, stop: new AbortController().signal, deadline: Date.now() + 600_000, facing: 'north', base: { x: 0, y: FLOOR, z: 0 } });
async function drive<T>(sim: Sim, promise: Promise<T>, each?: (elapsedMs: number) => void, maxMs = 240_000): Promise<T> {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  for (let elapsed = 0; elapsed < maxMs && !settled; elapsed += 50) { sim.tick(); each?.(elapsed); await vi.advanceTimersByTimeAsync(50); }
  return promise;
}
const PICK: Stack = { name: 'stone_pickaxe', count: 1 };
const stacks = (...list: Stack[]) => list;
const stops = (reason: string): StepOutcome => ({ ok: false, reason, text: `go 止まった ${reason}: 道探しが終わらない`, data: { work: { dug: 0, placed: 0, steps: 0, redraws: 0 } } });
/** A walk of the route search that stops the first time it is asked (as a real one would) and is the real one after. */
function stopsOnce(reason: string): { walk: GoWalk; asked: () => number } {
  let calls = 0;
  return { walk: (ctx, args, hooks) => (++calls === 1 ? Promise.resolve(stops(reason)) : goWalk(ctx, args, hooks)), asked: () => calls };
}
const goalAt = (x: number, y: number, z: number) => ({ x, y, z });

describe('go: the plan walks when the walk of the route search stopped', () => {
  const wall = over(flat, box('stone', 3, 5, FLOOR, FLOOR + 6, -R - 1, R + 1));

  it('search_timeout: the plan digs the cells of its way through the wall, with canDig as the leave, and the line says the way', async () => {
    const sim = makeSim(wall, { items: stacks(PICK) });
    const { walk } = stopsOnce('search_timeout');
    const args: GoArgs = { goals: [goalAt(8, FLOOR, 0)], canDig: ['stone'] };
    const outcome = await drive(sim, goPlannedWith(ctxOf(sim), args, walk));
    expect(outcome.ok).toBe(true);
    expect(outcome.text).toMatch(/計画の道: \d+ マス・掘 [1-9]\d*・置 0/u);
    expect(Math.floor(sim.bot.entity.position.x)).toBe(8);
    expect(sim.bot.dugBlocks.length).toBeGreaterThanOrEqual(3);
    expect(sim.bot.dugBlocks.every((line: string) => line.startsWith('stone@'))).toBe(true);
    expect(sim.world.nameAt(4, FLOOR, 8)).toBe('stone');   // the wall away from the way stands
  });

  it('digs nothing it was not told to dig: with no canDig the plan has no way through and the stop stands as it was', async () => {
    const sim = makeSim(wall, { items: stacks(PICK) });
    const { walk } = stopsOnce('dead_end');
    const outcome = await drive(sim, goPlannedWith(ctxOf(sim), { goals: [goalAt(8, FLOOR, 0)] }, walk));
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('dead_end');
    expect(sim.bot.dugBlocks).toEqual([]);
  });

  it('limit_dig: a plan that digs more than maxDig is not walked (the limit is not raised)', async () => {
    const sim = makeSim(wall, { items: stacks(PICK) });
    const { walk } = stopsOnce('limit_dig');
    const outcome = await drive(sim, goPlannedWith(ctxOf(sim), { goals: [goalAt(8, FLOOR, 0)], canDig: ['stone'], maxDig: 2 }, walk));
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('limit_dig');
    expect(sim.bot.dugBlocks).toEqual([]);
  });

  it('other stops (stuck, lava, unsafe) are not the plan\'s: the stop is returned as it is', async () => {
    const sim = makeSim(wall, { items: stacks(PICK) });
    const { walk, asked } = stopsOnce('stuck');
    const outcome = await drive(sim, goPlannedWith(ctxOf(sim), { goals: [goalAt(8, FLOOR, 0)], canDig: ['stone'] }, walk));
    expect(outcome.reason).toBe('stuck');
    expect(asked()).toBe(1);
    expect(sim.bot.dugBlocks).toEqual([]);
  });

  it('with the dragon about in the End the plan is not used (the breath and the perch are the walk of the route search)', async () => {
    const sim = makeSim(wall, { items: stacks(PICK) });
    sim.bot.game.dimension = 'the_end';
    sim.bot.entities = { 1: { name: 'ender_dragon', position: { x: 30, y: 80, z: 0, distanceTo: () => 30 } } };
    const { walk, asked } = stopsOnce('dead_end');
    const outcome = await drive(sim, goPlannedWith(ctxOf(sim), { goals: [goalAt(8, FLOOR, 0)], canDig: ['stone'] }, walk));
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('dead_end');
    expect(outcome.text).not.toContain('計画の道');
    expect(asked()).toBe(1);
    expect(sim.bot.dugBlocks).toEqual([]);
  });

  it('keeps out of the water: the plan goes round a pond, and the body is never in it', async () => {
    const pond = over(flat, box('water', 3, 5, FLOOR - 3, FLOOR - 1, -3, 3));
    const sim = makeSim(pond, { items: stacks(PICK) });
    const { walk } = stopsOnce('search_timeout');
    let swam = false;
    const outcome = await drive(sim, goPlannedWith(ctxOf(sim), { goals: [goalAt(9, FLOOR, 0)], canDig: ['stone'] }, walk), () => {
      const p = sim.bot.entity.position;
      if (sim.world.nameAt(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) === 'water') swam = true;
    });
    expect(outcome.ok).toBe(true);
    expect(swam).toBe(false);
    expect(Math.floor(sim.bot.entity.position.x)).toBe(9);
    expect(outcome.text).toContain('計画の道');
  });
});

describe('go: the plan walks when it digs clearly fewer than the way the walk of the route search drew', () => {
  const tall = over(flat, box('stone', 3, 5, FLOOR, FLOOR + 6, -R - 1, R + 1));
  // A wall eight thick and two high across the whole ground: one cut and the top of it is walked (the plan and the pathfinder both find it: no compare asked).
  const low = over(flat, box('stone', 3, 10, FLOOR, FLOOR + 1, -R - 1, R + 1));

  it('goWalk asks once a go, after drawing a way of six cuts or more, and stops before it digs a block when the answer is yes', async () => {
    const sim = makeSim(tall, { items: stacks(PICK) });
    const asked: number[] = [];
    const outcome = await drive(sim, goWalk(ctxOf(sim), { goals: [goalAt(8, FLOOR, 0)], canDig: ['stone'] }, { cheaper: pathDigs => { asked.push(pathDigs); return true; } }));
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('plan_cheaper');
    expect(asked).toHaveLength(1);
    expect(asked[0]).toBeGreaterThanOrEqual(6);
    expect(sim.bot.dugBlocks).toEqual([]);
  });

  it('goWalk goes on with its own way when the answer is no, and asks nothing of a way that digs few', async () => {
    const sim = makeSim(tall, { items: stacks(PICK) });
    const asked: number[] = [];
    const outcome = await drive(sim, goWalk(ctxOf(sim), { goals: [goalAt(8, FLOOR, 0)], canDig: ['stone'] }, { cheaper: pathDigs => { asked.push(pathDigs); return false; } }));
    expect(outcome.ok).toBe(true);
    expect(asked).toHaveLength(1);
    const few = makeSim(low, { items: stacks(PICK) });
    const askedFew: number[] = [];
    const walked = await drive(few, goWalk(ctxOf(few), { goals: [goalAt(14, FLOOR, 0)], canDig: ['stone'] }, { cheaper: pathDigs => { askedFew.push(pathDigs); return true; } }));
    expect(walked.ok).toBe(true);
    expect(askedFew).toEqual([]);
  });

  it('the plan way is walked after the compare said yes, with the limits left, and the line says it', async () => {
    const sim = makeSim(tall, { items: stacks(PICK) });
    let calls = 0;
    // The first walk is the real one asked with a compare that says yes (the plan here digs the same, so the real compare would say no: the answer is forced).
    const walk: GoWalk = (ctx, args, hooks) => (++calls === 1 ? goWalk(ctx, args, hooks && { cheaper: () => true }) : goWalk(ctx, args, hooks));
    const outcome = await drive(sim, goPlannedWith(ctxOf(sim), { goals: [goalAt(8, FLOOR, 0)], canDig: ['stone'], maxDig: 20 }, walk));
    expect(outcome.ok).toBe(true);
    expect(outcome.text).toMatch(/計画の道: [0-9]+ マス・掘 [1-9][0-9]*/u);
    expect(Math.floor(sim.bot.entity.position.x)).toBe(8);
    expect(calls).toBe(2);
  });

  it('a plan that cannot be walked after the compare leaves the walk of the route search as it was (nothing is lost)', async () => {
    const sim = makeSim(tall, { items: stacks(PICK) });
    let calls = 0;
    const walk: GoWalk = (ctx, args, hooks) => (++calls === 1 ? goWalk(ctx, args, hooks && { cheaper: () => true }) : goWalk(ctx, args, hooks));
    // maxDig 4 is less than the way needs: the plan is not usable, so the walk runs again with the limit as given and says its own stop.
    const outcome = await drive(sim, goPlannedWith(ctxOf(sim), { goals: [goalAt(8, FLOOR, 0)], canDig: ['stone'], maxDig: 4 }, walk));
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('limit_dig');
    expect(sim.bot.dugBlocks).toEqual([]);
  });
});
