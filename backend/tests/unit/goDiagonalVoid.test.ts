import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { makeSim, type Sim } from '../helpers/physicsBody.js';
import { digRuleOf, go, goMovements, type GoState } from '../../src/services/minebot/utils/primitives/go.js';

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] }));
afterEach(() => vi.useRealTimers());
const scene: Record<string, string> = JSON.parse(readFileSync(new URL('../fixtures/go-diagonal-void.json', import.meta.url), 'utf8'));
async function drive(s: Sim, mirrored: boolean) {
  let done = false, low = 19;
  const p = go({ bot: s.bot, stop: new AbortController().signal, deadline: Date.now() + 60_000, facing: 'east', base: { x: 19, y: 19, z: 9 } } as never,
    { goals: [{ x: mirrored ? 16 : 22, y: 23, z: 10 }, { x: mirrored ? 16 : 22, y: 22, z: 9 }], range: 0, maxDig: 30, seconds: 30, canDig: ['stone', 'granite', 'andesite', 'diorite', 'deepslate', 'tuff'] }).finally(() => { done = true; });
  for (let ms = 0; ms < 35_000 && !done; ms += 50) { s.tick(); low = Math.min(low, s.bot.entity.position.y); await vi.advanceTimersByTimeAsync(50); }
  return { result: await p, low };
}
it.each([false, true])('does not walk off a diagonal ascent over an unsupported corner (mirrored=%s)', async mirrored => {
  // Recorded blocks around run 54's pre-approach stance. Only the two observed stone digs were restored.
  // The lower fall shaft is reduced to air and a floor at zero; this is not a complete saved-world replay.
  const s = makeSim((x, y, z) => y <= 0 ? 'stone' : scene[`${mirrored ? 38 - x : x},${y},${z}`] ?? (y < 17 ? 'air' : null),
    { start: [mirrored ? 19.326 : 19.674, 19, 9.5], items: [{ name: 'iron_pickaxe', count: 1 }] });
  const { low, result } = await drive(s, mirrored);
  expect(low).toBeGreaterThanOrEqual(18.9);
  expect(result.ok).toBe(true);
});

it('keeps supported diagonal ascents, cardinal ascents and level diagonals available', () => {
  const s = makeSim((x, y, z) => y < 19 || (x === 1 && z === 1 && y === 19) || (x === -1 && z === 0 && y === 19) ? 'stone' : 'air', { start: [0.5, 19, 0.5] });
  const state: GoState = { steps: 0, dug: 0, placed: 0, redraws: 0, veto: null, refused: 0, exposed: new Map(), avoid: new Set(), dugCells: new Set(), laidCells: new Set() };
  const m = goMovements(s.bot, { maxDrop: 3, waterOk: false, maxDig: 0, maxPlace: 0, sprint: false }, digRuleOf(s.bot.registry, []), [], state);
  const moves = m.getNeighbors({ x: 0, y: 19, z: 0, remainingBlocks: 0 }).map((p: any) => `${p.x},${p.y},${p.z}`);
  expect(moves).toContain('1,20,1');
  expect(moves).toContain('-1,20,0');
  expect(moves).toContain('1,19,-1');
});
