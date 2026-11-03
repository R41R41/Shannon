import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { makeSim } from '../helpers/physicsBody.js';
import { installEdgeGuard } from '../../src/services/minebot/utils/edgeGuard.js';
import { diagonalFooting, digRuleOf, go, goMovements, laysIn, type GoState } from '../../src/services/minebot/utils/primitives/go.js';

// Run 59 leg 2, task 4 holds 2 and 3 (boxes 20261102T145349-act-nszd6 and 20261102T151932-act-aza3n): the Nether, the body on a cobblestone at the edge of the lava sea at
// (25,65,4), basalt at (26,65..66,4) and no floor at (25,64,5). The blocks of x 19..48, y 60..69, z -3..12 from the world saved at the hold; under the box, air down to the
// lava sea (its top at 31, as in the run); above it and beside it, not loaded.
const scene: Record<string, string> = JSON.parse(readFileSync(new URL('../fixtures/go-diagonal-wall-void.json', import.meta.url), 'utf8'));
const ground = (x: number, y: number, z: number): string | null => {
  const block = scene[`${x},${y},${z}`];
  if (block) return block;
  if (x < 19 || x > 48 || z < -3 || z > 12 || y > 69) return null;
  return y > 31 ? 'air' : 'lava';
};
const STANCE: [number, number, number] = [25.527, 65, 4.402];
const fresh = (): GoState => ({ steps: 0, dug: 0, placed: 0, redraws: 0, veto: null, refused: 0, exposed: new Map(), avoid: new Set(), dugCells: new Set(), laidCells: new Set() });
const keys = (moves: any[]) => moves.map(move => `${move.x},${move.y},${move.z}`);

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] }));
afterEach(() => vi.useRealTimers());

it('goes on from the edge of the lava sea to the leg the run drew (45,65,11), and does not fall', async () => {
  const s = makeSim(ground, { start: STANCE, items: [{ name: 'diamond_pickaxe', count: 1 }, { name: 'cobblestone', count: 173 }] });
  // The body's edge guard, as in the run: it held the body's middle back from over the lava sea, where the diagonal past the wall took it.
  installEdgeGuard(s.bot);
  let done = false, low = STANCE[1];
  const p = go({ bot: s.bot, stop: new AbortController().signal, deadline: Date.now() + 120_000, facing: 'south', base: { x: 25, y: 65, z: 4 } } as never,
    { goals: [{ x: 45, y: 65, z: 11 }], range: 2, maxDig: 150, maxPlace: 80, seconds: 110, canDig: ['netherrack', 'basalt', 'blackstone'], canPlace: ['cobblestone'] })
    .finally(() => { done = true; });
  for (let ms = 0; ms < 115_000 && !done; ms += 50) { s.tick(); low = Math.min(low, s.bot.entity.position.y); await vi.advanceTimersByTimeAsync(50); }
  const result = await p;
  expect(low).toBeGreaterThanOrEqual(63.9);
  expect(result.ok, JSON.stringify(result).slice(0, 400)).toBe(true);
  // The way drawn is one the body walks: the guard never holds it back at the edge, and it is not drawn again (without the rule, in this box: 184 holds and 4 drawings
  // again; in the run, a stop after 12).
  expect((s.bot as any).edgeGuard.stops).toBe(0);
  expect((result as any).data?.work?.redraws).toBe(0);
}, 60_000);

it('draws no level diagonal past a wall corner into a corner with no floor; with a floor there, or with both corners open, it stays', () => {
  const s = makeSim(ground, { start: STANCE });
  const movementsNow = () => goMovements(s.bot, { maxDrop: 3, waterOk: false, maxDig: 0, maxPlace: 0, sprint: false }, digRuleOf(s.bot.registry, []), [], fresh());
  const at = { x: 25, y: 65, z: 4, remainingBlocks: 0 };
  expect(diagonalFooting(movementsNow(), at, 1, 1)).toBe(false);
  expect(keys(movementsNow().getNeighbors(at))).not.toContain('26,65,5');
  // A floor in the open corner: the body goes through it on that floor.
  s.world.set(25, 64, 5, 'cobblestone');
  expect(keys(movementsNow().getNeighbors(at))).toContain('26,65,5');
  // No wall either: both corners open, the body is over its floor or its landing all the way (the corner's floor does not matter).
  s.world.set(25, 64, 5, 'air');
  s.world.set(26, 65, 4, 'air');
  s.world.set(26, 66, 4, 'air');
  expect(keys(movementsNow().getNeighbors(at))).toContain('26,65,5');
});

it('draws no move that lays a block in the cell the body is in, and draws it when the body is elsewhere', () => {
  const s = makeSim(ground, { start: STANCE, items: [{ name: 'cobblestone', count: 64 }] });
  const movementsNow = () => goMovements(s.bot, { maxDrop: 3, waterOk: false, maxDig: 0, maxPlace: 80, sprint: false }, digRuleOf(s.bot.registry, []), ['cobblestone'], fresh());
  // The run's way: back to (25,65,3), a block laid in (25,65,4) where the body stands, up onto it to (25,66,4).
  const back = { x: 25, y: 65, z: 3, remainingBlocks: 64 };
  expect(keys(movementsNow().getNeighbors(back))).not.toContain('25,66,4');
  s.bot.entity.position.set(25.5, 65, 3.5);
  const moves = movementsNow().getNeighbors(back);
  expect(keys(moves)).toContain('25,66,4');
  expect(laysIn(moves.find((move: any) => move.x === 25 && move.y === 66 && move.z === 4), ['25,65,4'])).toBe(true);
});
