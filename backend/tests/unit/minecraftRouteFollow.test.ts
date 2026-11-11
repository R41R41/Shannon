import { describe, expect, it } from 'vitest';
import type { Vec3 } from 'vec3';
import { followRoute, runsOf, type FollowHands } from '../../src/services/minebot/utils/routeFollow.js';
import { planRoute, type RoutePlan } from '../../src/services/minebot/utils/routePlan.js';
import type { BlockReader, Cell, MapBlock } from '../../src/services/minebot/utils/localMap.js';
import type { TunnelOutcome } from '../../src/services/minebot/utils/tunnelWalk.js';

// Run 7 (Lai): a plan is run with the hands the body has. The hands here are fakes over a world of fixed blocks: a cell dug becomes air, a block laid becomes stone.
const STONE: MapBlock = { name: 'stone', solid: true }, AIR: MapBlock = { name: 'air', solid: false };
const at = (x: number, y: number, z: number): Cell => ({ x, y, z });

/** A world the hands change: the dug and laid cells are kept; `slip` makes the first cell run end one cell short of the plan (a body pushed off). */
function sim(rule: (x: number, y: number, z: number) => MapBlock, start: Cell, options: { slipOnce?: boolean } = {}) {
  const changed = new Map<string, MapBlock>();
  const dug: string[] = [], laid: string[] = [];
  let feet = start, slipped = false;
  const read: BlockReader = (x, y, z) => changed.get(`${x},${y},${z}`) ?? rule(x, y, z);
  const hands: FollowHands = {
    feet: () => feet,
    async cells(cells: Vec3[]): Promise<TunnelOutcome> {
      let digs = 0, steps = 0;
      for (const cell of cells) {
        for (const [dx, dy] of [[0, 1], [0, 0]]) {
          const key = `${cell.x},${cell.y + dy},${cell.z}`;
          if (read(cell.x, cell.y + dy, cell.z)?.solid) { changed.set(key, AIR); dug.push(key); digs++; }
          void dx;
        }
        if (options.slipOnce && !slipped && steps === 1) { slipped = true; feet = at(cell.x - 1, cell.y, cell.z); return { stopped: 'off_line', steps, digs, at: feet }; }
        feet = at(cell.x, cell.y, cell.z); steps++;
      }
      return { stopped: 'plan_end', steps, digs };
    },
    async walkTo(cell) { feet = cell; return true; },
    async place(cell) { changed.set(`${cell.x},${cell.y},${cell.z}`, STONE); laid.push(`${cell.x},${cell.y},${cell.z}`); return true; },
  };
  return { read, hands, dug, laid, feet: () => feet };
}

const corridorWorld = (x: number, y: number, z: number): MapBlock => (y <= 63 ? STONE : x === 5 && y <= 65 && Math.abs(z) < 60 ? STONE : AIR);

describe('followRoute: a plan is run in runs', () => {
  it('walk, cut, walk: the walked steps and the cut steps are one run of cells, a diagonal its own', () => {
    const world = sim(corridorWorld, at(0, 64, 0));
    const plan = planRoute(world.read, at(0, 64, 0), [at(10, 64, 0)]);
    expect(plan.status).toBe('success');
    const runs = runsOf(at(0, 64, 0), plan.steps);
    // Every step that is not one cell (a diagonal, a fall, a ladder) is a walk of its own; the rest are runs of cells.
    for (const run of runs) expect(run.kind === 'walk' ? ['diagonal', 'drop', 'ladder'].includes(run.step.kind) : run.kind === 'cells').toBe(true);
    expect(runs.filter(run => run.kind === 'cells').length).toBeGreaterThanOrEqual(1);
  });

  it('runs the plan to its end: the body stands in the goal and the blocks cut are the plan\'s', async () => {
    const world = sim(corridorWorld, at(0, 64, 0));
    const plan = planRoute(world.read, at(0, 64, 0), [at(10, 64, 0)]);
    const outcome = await followRoute(plan, world.hands, { deadline: Date.now() + 5000 });
    expect(outcome).toMatchObject({ stopped: 'reached', replans: 0 });
    expect(world.feet()).toEqual(at(10, 64, 0));
    expect(outcome.digs).toBe(plan.totals.dig);
    expect(world.dug).toHaveLength(plan.totals.dig);
  });

  it('a bridge lays its floor then steps onto it (a hand of its own, not a cell run)', async () => {
    const gap = (x: number, y: number) => (x >= 3 && x <= 5 ? (y <= 0 ? STONE : AIR) : y <= 63 ? STONE : AIR);
    const world = sim(gap, at(0, 64, 0));
    const plan = planRoute(world.read, at(0, 64, 0), [at(9, 64, 0)], { placeBlocks: 10 });
    expect(plan.status).toBe('success');
    const runs = runsOf(at(0, 64, 0), plan.steps);
    expect(runs.filter(run => run.kind === 'laid')).toHaveLength(3);
    const outcome = await followRoute(plan, world.hands, { deadline: Date.now() + 5000 });
    expect(outcome.stopped).toBe('reached');
    expect(outcome.places).toBe(3);
    expect(world.laid).toEqual(['3,63,0', '4,63,0', '5,63,0']);
  });
});

describe('followRoute: off the plan', () => {
  it('a body not where the plan said plans again from where it stands, and the cells already dug are not dug twice', async () => {
    const world = sim(corridorWorld, at(0, 64, 0), { slipOnce: true });
    const plan = planRoute(world.read, at(0, 64, 0), [at(10, 64, 0)]);
    let asked = 0;
    const outcome = await followRoute(plan, world.hands, { deadline: Date.now() + 5000, replan: from => { asked++; return planRoute(world.read, from, [at(10, 64, 0)]); } });
    expect(asked).toBe(1);
    expect(outcome).toMatchObject({ stopped: 'reached', replans: 1 });
    expect(new Set(world.dug).size).toBe(world.dug.length);
  });

  it('without a replan the stop is off_route, with where the body is', async () => {
    const world = sim(corridorWorld, at(0, 64, 0), { slipOnce: true });
    const plan = planRoute(world.read, at(0, 64, 0), [at(10, 64, 0)]);
    const outcome = await followRoute(plan, world.hands, { deadline: Date.now() + 5000 });
    expect(outcome.stopped).toBe('off_route');
    expect(outcome.at).toBeDefined();
  });

  it('a block the hands cannot cut ends it as blocked, with the walk\'s own reason', async () => {
    const world = sim(corridorWorld, at(0, 64, 0));
    world.hands.cells = async () => ({ stopped: 'blocked', steps: 0, digs: 0, at: at(5, 64, 0), reason: 'lava_beside:lava(5,64,0)' });
    const plan = planRoute(world.read, at(0, 64, 0), [at(10, 64, 0)]);
    const outcome = await followRoute(plan, world.hands, { deadline: Date.now() + 5000 });
    expect(outcome).toMatchObject({ stopped: 'blocked', reason: 'lava_beside:lava(5,64,0)' });
  });

  it('past the deadline it stops as timeout before the next run', async () => {
    const world = sim(corridorWorld, at(0, 64, 0));
    const plan: RoutePlan = planRoute(world.read, at(0, 64, 0), [at(10, 64, 0)]);
    const outcome = await followRoute(plan, world.hands, { deadline: Date.now() - 1 });
    expect(outcome.stopped).toBe('timeout');
  });
});
