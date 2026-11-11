import { afterEach, describe, expect, it } from 'vitest';
import { createGround, stepContext, type Ground } from '../helpers/practiceGround.js';
import { make } from '../../src/services/minebot/utils/primitives/make.js';

// Run 7 (11/11): the village's hay (13 blocks, "パン39") was the food the planner should take before a cow. Whether `make bread` goes from hay_block alone
// (hay_block -> 9 wheat -> 3 bread, bread being three wheat) was not known: the plan's step filter drops a recipe that undoes another. Stated here so the hand and the head's food words agree.
let ground: Ground | null = null;
afterEach(() => { ground?.stop(); ground = null; });
const open = () => { ground?.stop(); ground = createGround({ pathfinder: true }); ground.start(); return ground; };

describe('bread from hay', () => {
  it('one hay_block makes wheat nine and then bread three (three wheat each) at a table', async () => {
    const g = open();
    g.set(10, 64, 8, 'crafting_table');
    g.give('hay_block', 1);
    const outcome = await make(stepContext(g.bot), { item: 'bread', count: 3 });
    expect(outcome.ok, outcome.text).toBe(true);
    expect(g.countOf('bread')).toBe(3);
    expect(g.countOf('hay_block')).toBe(0);
    expect(g.countOf('wheat')).toBe(0);
  }, 30_000);

  it('wheat from a hay_block alone', async () => {
    const g = open();
    g.give('hay_block', 1);
    const outcome = await make(stepContext(g.bot), { item: 'wheat', count: 9 });
    expect(outcome.ok, outcome.text).toBe(true);
    expect(g.countOf('wheat')).toBe(9);
  }, 30_000);
});
