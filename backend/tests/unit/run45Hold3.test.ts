import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSim, type Ground, type Sim } from '../helpers/physicsBody.js';
import { digRuleOf, go, goMovements, GO_REDO_COST, redoCost, type GoState } from '../../src/services/minebot/utils/primitives/go.js';
import type { StepContext } from '../../src/services/minebot/utils/primitives/common.js';

// Run 45, hold 3 (2026-10-28; the box 20261028T031036-act-e5x2c): q12 go 40 down. The executor walked each part of its way while the search went on,
// and the parts turned between the way down (dig the floor) and the way round over the top (lay a floor): it dug (191,59,188), laid a cobblestone
// there 1.4 s later, dug it again 1.3 s later, fell into the cell, and laid there again with the body in it: refused, and the go stopped.
const require = createRequire(import.meta.url);
const FLOOR = 64;
const R = 24;
const ctxOf = (sim: Sim): StepContext => ({ bot: sim.bot, stop: new AbortController().signal, deadline: Date.now() + 600_000, facing: 'north', base: { x: 0, y: FLOOR, z: 0 } });
async function drive<T>(sim: Sim, promise: Promise<T>, maxMs = 240_000): Promise<T> {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  for (let elapsed = 0; elapsed < maxMs && !settled; elapsed += 50) { sim.tick(); await vi.advanceTimersByTimeAsync(50); }
  return promise;
}
const cellOf = (entry: string) => entry.slice(entry.indexOf('@') + 1);

describe('run 45, hold 3: the way does not undo its own work', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }); });
  afterEach(() => { vi.useRealTimers(); });

  it('costs GO_REDO_COST to lay again in a cell the go dug, or to dig one it laid', () => {
    const cells = new Set(['191,59,188']);
    expect(redoCost(cells, { position: { x: 191, y: 59, z: 188 } })).toBe(GO_REDO_COST);
    expect(redoCost(cells, { position: { x: 191, y: 60, z: 188 } })).toBe(0);
    expect(redoCost(cells, null)).toBe(0);
    // The walk forward onto a laid floor asks of the cell above the floor.
    expect(redoCost(cells, { position: { x: 191, y: 60, z: 188 } }, true)).toBe(GO_REDO_COST);
    expect(GO_REDO_COST).toBeLessThan(100); // the route search never breaks a block at 100: this one is still the way when there is no other
  });

  it('draws the way round rather than lay again in a cell the go dug (and it would lay there before)', () => {
    // A trench two wide (x 1..2) and deep across the way to (4,64,0), with a crossing of floor at z=4: lay two blocks, or go round.
    const ground: Ground = (x, y, z) => {
      if (Math.abs(x) > R || Math.abs(z) > R) return null;
      if (y >= FLOOR) return 'air';
      if (y >= FLOOR - 6 && (x === 1 || x === 2) && z !== 4) return 'air';
      return 'stone';
    };
    const sim = makeSim(ground, { start: [0.5, FLOOR, 0.5], items: [{ name: 'cobblestone', count: 8 }] });
    const state = (dug: string[]): GoState => ({ steps: 0, dug: 0, placed: 0, redraws: 0, veto: null, refused: 0, avoid: new Set(), dugCells: new Set(dug), laidCells: new Set() });
    const placesOf = (dug: string[]) => {
      const movements = goMovements(sim.bot, { maxDrop: 3, waterOk: false, maxDig: 10, maxPlace: 10, sprint: false }, digRuleOf(sim.bot.registry, []), ['cobblestone'], state(dug));
      const result = sim.bot.pathfinder.getPathFromTo(movements, sim.bot.entity.position, new (require('mineflayer-pathfinder').goals.GoalBlock)(4, FLOOR, 0), { timeout: 2000 }).next().value.result;
      return (result.path as any[]).flatMap(node => (node.toPlace ?? []).map((p: any) => `${p.x + p.dx},${p.y + p.dy},${p.z + p.dz}`));
    };
    expect(placesOf([])).toContain('1,63,0');
    expect(placesOf(['1,63,0'])).not.toContain('1,63,0');
  });

  it('down through rock with blocks to lay: no cell is both dug and laid by the go', async () => {
    // Rock under a flat surface, with a pit 3 deep beside the way (a floor to dig, or a hole to bridge, as at (191,59,188)).
    const rock: Ground = (x, y, z) => {
      if (Math.abs(x) > R || Math.abs(z) > R) return null;
      if (y >= FLOOR) return 'air';
      if (x >= 2 && x <= 3 && z >= -1 && z <= 1 && y >= FLOOR - 3) return 'air';
      return 'stone';
    };
    const sim = makeSim(rock, { start: [0.5, FLOOR, 0.5], items: [{ name: 'stone_pickaxe', count: 1 }, { name: 'cobblestone', count: 32 }], digMs: 60 });
    const outcome = await drive(sim, go(ctxOf(sim), { goals: [{ x: 14, y: FLOOR - 14, z: 9 }], canDig: ['stone'], canPlace: ['cobblestone'], maxDig: 150, maxPlace: 20, seconds: 120, range: 3 }));
    const dug = new Set(sim.bot.dugBlocks.map(cellOf)), laid = sim.bot.placedBlocks.map(cellOf);
    expect(laid.filter(cell => dug.has(cell))).toEqual([]);
    expect(outcome.text).not.toMatch(/置いたブロックが世界に現れない/u);
  });
});
