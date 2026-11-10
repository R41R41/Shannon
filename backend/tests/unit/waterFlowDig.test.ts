import { describe, expect, it } from 'vitest';
import { makeSim, type Ground } from '../helpers/physicsBody.js';
import { digRuleOf, goMovements, type GoState } from '../../src/services/minebot/utils/primitives/go.js';

// Run 6 (2026-11-11): a rock a lake touches was never a way for a go: the planner's default shuts every block with liquid beside it. Water beside a block is let in now (the body's footing and
// dam hold it); lava beside or over a block still shuts it.
const FLOOR = 64;
const world = (liquid: string): Ground => (x, y, z) => {
  if (Math.abs(x) > 30 || Math.abs(z) > 30) return null;
  if (y < FLOOR) return 'stone';
  if (x === 5 && z === 0 && y === FLOOR) return 'stone';
  if (x === 6 && z === 0 && y === FLOOR) return liquid;
  return 'air';
};
const state = (): GoState => ({ steps: 0, dug: 0, placed: 0, redraws: 0, veto: null, refused: 0, exposed: new Map(), avoid: new Set(), dugCells: new Set(), laidCells: new Set() });

describe('the route planner and a block beside water', () => {
  for (const [liquid, may] of [['water', true], ['lava', false]] as const) {
    it(`${liquid} beside a stone: may the planner break it? ${may}`, () => {
      const sim = makeSim(world(liquid), { start: [0.5, FLOOR, 0.5], items: [{ name: 'stone_pickaxe', count: 1 }] });
      const movements = goMovements(sim.bot, { maxDrop: 3, waterOk: false, maxDig: 8, maxPlace: 0, sprint: false }, digRuleOf(sim.bot.registry, ['stone']), [], state());
      const block = sim.bot.blockAt({ x: 5, y: FLOOR, z: 0 } as never);
      expect(block?.name).toBe('stone');
      expect(movements.safeToBreak(block)).toBe(may);
    });
  }
});
