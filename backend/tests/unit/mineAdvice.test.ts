import { afterEach, describe, expect, it } from 'vitest';
import { createGround, stepContext, type Ground } from '../helpers/practiceGround.js';
import { mine } from '../../src/services/minebot/utils/primitives/mine.js';
import { noteMapStop, peekMapStop } from '../../src/services/minebot/utils/localMap.js';
import { closedWord } from '../../src/services/minebot/utils/actReport.js';

// What mine says when its way hits the dig limit: the number it names is always above the limit just reached (so lowering to it can never be the answer),
// it is at the start of the line, and the second stop at the same place names no number. Practice ground (tests/helpers/practiceGround), no API.
let ground: Ground | null = null;
afterEach(() => { ground?.stop(); ground = null; });
const cell = (x: number, y: number, z: number) => ({ x, y, z });
const build = () => {
  ground?.stop();
  const g = createGround({ pathfinder: true }); g.bot.activeFurnaces = []; g.start(); ground = g;
  g.fill([11, 64, 5], [19, 68, 12], 'stone');
  g.set(17, 64, 8, 'iron_ore');
  g.give('stone_pickaxe', 1); g.give('iron_pickaxe', 1);
  return g;
};
const ORE = cell(17, 64, 8);

describe('mine: the advice at the way\'s dig limit', () => {
  it('names a maxDig above the limit just reached, at the start of the line', async () => {
    const g = build();
    const outcome = await mine(stepContext(g.bot, undefined, 100), { block: 'iron_ore', at: [ORE], count: 1, canDig: ['stone'], maxDig: 3, seconds: 90 });
    expect(outcome.reason).toBe('limit_dig');
    const said = Number(/maxDig=(\d+)/u.exec(outcome.text)?.[1]);
    expect(said).toBeGreaterThan(3 + 1);
    const total = Number(/合計 (\d+)/u.exec(outcome.text)?.[1]);
    expect(said).toBeGreaterThanOrEqual(total + 2);
    expect(outcome.text.indexOf('maxDig=')).toBeLessThan(100);
  }, 200_000);

  it('the second stop at the same place says no number, but go near it or dig from above', async () => {
    const g = build();
    noteMapStop(g.bot, { kind: 'mine', at: ORE, reason: closedWord('limit_dig') });
    expect(peekMapStop(g.bot, { kind: 'mine', at: ORE, reason: closedWord('limit_dig') })).toBe(1);
    const outcome = await mine(stepContext(g.bot, undefined, 100), { block: 'iron_ore', at: [ORE], count: 1, canDig: ['stone'], maxDig: 3, seconds: 90 });
    expect(outcome.reason).toBe('limit_dig');
    expect(outcome.text).toContain('同じ所で maxDig を変えても止まった');
    expect(outcome.text).toContain('(17,65,8)');
    expect(outcome.text).not.toMatch(/maxDig=\d/u);
    // The peek only reads.
    expect(peekMapStop(g.bot, { kind: 'mine', at: ORE, reason: closedWord('limit_dig') })).toBe(1);
  }, 200_000);
});
