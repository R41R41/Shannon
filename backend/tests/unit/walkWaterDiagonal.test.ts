import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSim, type Ground } from '../helpers/physicsBody.js';
import { walkMovements } from '../../src/services/minebot/utils/primitives/walk.js';
import pathfinder from 'mineflayer-pathfinder';

// Run 47 (hold 7): in flowing water a step round a corner (a diagonal one) left the body against the wall and under the ceiling for 4 s, over and over, while the route search found a way each time.
// Water has no diagonal steps: the way is made of straight ones.
beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] }); });
afterEach(() => { vi.useRealTimers(); });

const FLOOR = 64;
/** Stone floor; a pool of water x 2..6, z 0..4 at y 64..65 (the floor of the pool at y 63); a stone wall at x=1. */
const ground: Ground = (x, y, z) => {
  if (Math.abs(x) > 30 || Math.abs(z) > 30) return null;
  if (y < FLOOR) return 'stone';
  if (x >= 2 && x <= 6 && z >= 0 && z <= 4 && y <= FLOOR + 1) return 'water';
  return 'air';
};

describe('a route through water', () => {
  it('has no diagonal step in water, and has them on dry ground', () => {
    const sim = makeSim(ground, { start: [0.5, FLOOR, 0.5] });
    const movements = walkMovements(sim.bot, true);
    const dry = { x: 10, y: FLOOR, z: 10 };
    const diagonals = (node: { x: number; y: number; z: number }) => (movements.getNeighbors(node) as Array<{ x: number; y: number; z: number }>).filter(move => Math.abs(move.x - node.x) === 1 && Math.abs(move.z - node.z) === 1);
    expect(diagonals(dry).length).toBeGreaterThan(0);
    expect(diagonals({ x: 4, y: FLOOR, z: 2 })).toEqual([]);       // in the pool
    expect(diagonals({ x: 1, y: FLOOR, z: 2 }).filter(move => move.x === 2)).toEqual([]);   // on dry ground beside it: toward the water
  });
  it('crosses the pool by straight steps', () => {
    const sim = makeSim(ground, { start: [0.5, FLOOR, 2.5] });
    const movements = walkMovements(sim.bot, true);
    const goal = new (pathfinder as never as { goals: { GoalBlock: new (x: number, y: number, z: number) => unknown } }).goals.GoalBlock(8, FLOOR, 3);
    const found = sim.bot.pathfinder.getPathFromTo(movements, sim.bot.entity.position, goal, { timeout: 2000 }).next().value.result;
    expect(found.status).toBe('success');
    let previous = { x: 0, z: 2 };
    for (const node of found.path as Array<{ x: number; z: number }>) {
      const x = Math.floor(node.x), z = Math.floor(node.z);
      const inPool = (px: number, pz: number) => px >= 2 && px <= 6 && pz >= 0 && pz <= 4;
      if (inPool(x, z) || inPool(previous.x, previous.z)) expect(Math.abs(x - previous.x) + Math.abs(z - previous.z)).toBeLessThanOrEqual(1);
      previous = { x, z };
    }
  });
});
