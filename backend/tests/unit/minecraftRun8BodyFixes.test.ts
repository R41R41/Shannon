import { afterEach, describe, expect, it } from 'vitest';
import { Vec3 } from 'vec3';
import { furnace } from '../../src/services/minebot/utils/primitives/furnace.js';
import { stoppedLine } from '../../src/services/minebot/utils/actReport.js';
import { missingContext } from '../../src/services/minebot/utils/primitives/make.js';
import { placeSpots } from '../../src/services/minebot/utils/primitives/placeSpot.js';
import { stepIntoReach } from '../../src/services/minebot/utils/primitives/getNear.js';
import { facingWords } from '../../src/services/minebot/utils/primitives/use.js';
import { createGround, stepContext, type Ground } from '../helpers/practiceGround.js';

// Run 8: the furnace's fuel slot is swapped for the fuel asked, a take that came out short says what is still burning, a make that stops says the furnaces and the table,
// a hole gets a table on its wall, a cell a step out of reach is stepped to, and the bucket's refusal says the distance and the facing.
let ground: Ground | null = null;
afterEach(() => { ground?.stop(); ground = null; });
const cell = { x: 10, y: 64, z: 8 };

describe('furnace: fuel of another kind is swapped', () => {
  it('takes the planks out of the fuel slot and puts the coal asked in', async () => {
    const g = ground = createGround({ pathfinder: false }); g.bot.activeFurnaces = []; g.start(); g.set(10, 64, 8, 'furnace');
    g.give('coal', 4);
    g.furnaceAt(new Vec3(10, 64, 8)).fuel = { name: 'oak_planks', count: 2, type: g.mcData.itemsByName.oak_planks.id };
    const outcome = await furnace(stepContext(g.bot), { at: cell, fuel: { item: 'coal', count: 3 } });
    expect(outcome.ok).toBe(true);
    expect(outcome.text).toContain('枠の燃料 oak_planks×2 を取り出して入れ替えた');
    expect(outcome.text).toContain('燃料 coal×3 を入れた');
    expect(g.countOf('oak_planks')).toBe(2);
    expect(g.furnaceAt(new Vec3(10, 64, 8)).fuel).toMatchObject({ name: 'coal', count: 3 });
  });
  it('leaves other fuel alone when the pack holds none of the fuel asked', async () => {
    const g = ground = createGround({ pathfinder: false }); g.bot.activeFurnaces = []; g.start(); g.set(10, 64, 8, 'furnace');
    g.furnaceAt(new Vec3(10, 64, 8)).fuel = { name: 'oak_planks', count: 2, type: g.mcData.itemsByName.oak_planks.id };
    const outcome = await furnace(stepContext(g.bot), { at: cell, fuel: { item: 'coal', count: 3 } });
    expect(outcome.ok).toBe(false);   // missing_item: the pack has no coal
  });
});

describe('make: the line of a missing stop', () => {
  it('names the furnaces and the way to a table, and from the second stop at the same place says what to do', () => {
    const bot: any = { entity: { position: new Vec3(0.5, 64, 0.5) }, game: { dimension: 'overworld' }, activeFurnaces: [{ pos: { x: 3, y: 64, z: 0 }, item: 'raw_iron', count: 5, readyAt: Date.now() + 40_000, dimension: 'overworld' }], blockAt: () => null };
    const first = missingContext(bot, 'iron_ingot×3');
    expect(first).toContain('かまど');
    expect(first).toContain('raw_iron×5 あと約');
    expect(first).not.toContain('回目');
    const second = missingContext(bot, 'iron_ingot×3');
    expect(second).toContain('同じ所・同じ理由の 2 回目');
    expect(second).toContain('まで別の作業を進めてから');
    expect(missingContext(bot, 'cobblestone×3')).not.toContain('回目');
  });
  it('what the head acts on survives the 160 characters of a hand line, with the long account of what is held after it', () => {
    const bot: any = { entity: { position: new Vec3(0.5, 64, 0.5) }, game: { dimension: 'overworld' }, activeFurnaces: [{ pos: { x: 3, y: 64, z: 0 }, item: 'raw_iron', count: 5, readyAt: Date.now() + 40_000, dimension: 'overworld' }], blockAt: () => null };
    missingContext(bot, 'iron_ingot×3');
    // The text make builds: what is short, the context, then the account (8 stacks held) and the wood words.
    const held = 'oak_log×12 stick×4 cobblestone×40 raw_iron×5 coal×8 bucket×1 stone_pickaxe×1 bread×3';
    const text = `iron_ingot×3${missingContext(bot, 'iron_ingot×3')}（作る物 iron_pickaxe×1 と途中の物の分。何も作っていない。持っている ${held}）。近くに原木 20 本・木 4 本（16m 以内）`;
    const line = stoppedLine('missing', text, 'air');
    expect(line.length).toBeLessThanOrEqual(160);
    expect(line).toContain('あと約');
    expect(line).toContain('同じ所・同じ理由の 2 回目');
    expect(line).toContain('別の作業を進めてから');
  });
  it('says nothing when there is no furnace and no table', () => {
    expect(missingContext({ entity: { position: new Vec3(0.5, 64, 0.5) }, game: {}, activeFurnaces: [], blockAt: () => null }, 'x×1')).toBe('');
  });
});

describe('a table in a hole', () => {
  it('finds a cell against the wall when no cell has a floor of its own', () => {
    const g = ground = createGround({ pathfinder: false }); g.start();
    // The body stands at the bottom of a 1x1 shaft in stone: the only air above is in its own column.
    for (let x = 5; x <= 15; x++) for (let z = 3; z <= 13; z++) for (let y = 60; y <= 70; y++) g.set(x, y, z, 'stone');
    g.set(10, 64, 8, 'air'); g.set(10, 65, 8, 'air'); g.set(10, 66, 8, 'air'); g.set(10, 67, 8, 'air');
    g.bot.entity.position = new Vec3(10.5, 64, 8.5);
    const spots = placeSpots(g.bot, [], 4);
    expect(spots.length).toBeGreaterThan(0);
    expect(spots.every(spot => g.nameAt(spot.x, spot.y, spot.z) === 'air')).toBe(true);
  });
});

describe('a cell a step out of reach', () => {
  it('is in reach at once, is refused beyond the slack, and stays out when the body cannot walk', async () => {
    const g = ground = createGround({ pathfinder: false }); g.start();
    const near = { x: 10, y: 64, z: 8 };
    expect(await stepIntoReach(stepContext(g.bot), near, 5)).toBe(true);
    const far = { x: 30, y: 64, z: 8 };
    expect(await stepIntoReach(stepContext(g.bot), far, 5)).toBe(false);
    const justOut = { x: Math.floor(g.bot.entity.position.x) + 6, y: Math.floor(g.bot.entity.position.y), z: Math.floor(g.bot.entity.position.z) };
    expect(await stepIntoReach(stepContext(g.bot), justOut, 5)).toBe(false);   // no pathfinder: it stays out
  });
  it('walks a step or two when the way is open', async () => {
    const g = ground = createGround({ pathfinder: true }); g.start();
    const p = g.bot.entity.position;
    const target = { x: Math.floor(p.x) + 6, y: Math.floor(p.y), z: Math.floor(p.z) };
    const { eyeDistance } = await import('../../src/services/minebot/utils/primitives/common.js');
    expect(eyeDistance(g.bot, target)).toBeGreaterThan(5);
    expect(eyeDistance(g.bot, target)).toBeLessThan(7);
    expect(await stepIntoReach(stepContext(g.bot), target, 5)).toBe(true);
    expect(eyeDistance(g.bot, target)).toBeLessThanOrEqual(5);
  }, 20_000);
});

describe('use: the facing words', () => {
  it('says how far off the target the eyes face', () => {
    const bot: any = { entity: { position: new Vec3(0.5, 64, 0.5), yaw: Math.PI / 2 } };
    // yaw pi/2 faces west (-x): a target to the west is dead ahead, one to the north is a quarter turn off.
    expect(facingWords(bot, { x: -5, y: 64, z: 0 })).toBe('向きは目標どおり');
    // Facing west: the target to the north has the eyes turned to its left; the target to the south, to its right.
    expect(facingWords(bot, { x: 0, y: 64, z: -5 })).toBe('向きは目標から左へ 90°');
    expect(facingWords(bot, { x: 0, y: 64, z: 5 })).toBe('向きは目標から右へ 90°');
  });
});
