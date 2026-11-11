import { afterEach, describe, expect, it } from 'vitest';
import { Vec3 } from 'vec3';
import { createGround, stepContext, type Ground } from '../helpers/practiceGround.js';
import { drop } from '../../src/services/minebot/utils/primitives/body.js';
import { planDumpPit } from '../../src/services/minebot/utils/dumpPit.js';
import { isSelfDropped } from '../../src/services/minebot/utils/selfDropped.js';
import { chooseCap } from '../../src/services/minebot/utils/primitives/dropPit.js';

// Run 7 (11/11): 36 drops, 33 landed within 3 m of the feet, ten heaps were thrown again after a walk picked them up. A drop with no creature or cell asked for digs a hole two cells deep
// beside the body, throws into it, covers it and reads what lies where. The ground has no throw: the stand-in below puts the stack at the bottom of the hole, as a throw 55 degrees down does.
let ground: Ground | null = null;
afterEach(() => { ground?.stop(); ground = null; });
const open = () => { ground?.stop(); ground = createGround({ pathfinder: true }); ground.start(); return ground; };

/** A toss that takes the stack out of the pack and lands it in the cell beside the feet that is open two below (the hole), or level 1.2 m off when there is none. */
function withToss(g: Ground, landsInPit = true) {
  g.bot.toss = async (type: number, _meta: unknown, count: number) => {
    const name = String(g.mcData.items[type].name);
    g.take(name, count);
    const feet = g.bot.entity.position.floored();
    let at = new Vec3(feet.x + 1, feet.y, feet.z);
    if (landsInPit) for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) if (g.nameAt(feet.x + dx, feet.y - 2, feet.z + dz) === 'air') { at = new Vec3(feet.x + dx, feet.y - 2, feet.z + dz); break; }
    g.drop(name, count, at);
  };
}

describe('planDumpPit with a depth', () => {
  it('goes two cells under the feet when asked, three by default', () => {
    const g = open();
    const feet = g.bot.entity.position.floored();
    const two = planDumpPit(g.bot as any, feet, { depthBelowFeet: 2 });
    const three = planDumpPit(g.bot as any, feet);
    expect(two?.dig.length).toBe(2);
    expect(three?.dig.length).toBe(3);
    expect(two?.cap).not.toBeNull();
  });
});

describe('drop into a hole', () => {
  it('digs a hole two deep, throws everything in, covers it, says what lies where, and remembers the heap as its own', async () => {
    const g = open();
    withToss(g);
    g.give('stone_pickaxe', 1); g.give('cobblestone', 40); g.give('dirt', 10);
    const feet = g.bot.entity.position.floored();
    const out = await drop(stepContext(g.bot), { items: [{ item: 'cobblestone', count: 30 }, { item: 'dirt' }] });
    expect(out.ok, out.text).toBe(true);
    expect(out.text).toContain('深さ 2');
    expect(out.text).toContain('穴の中 40 個・手の届く所に 0 個');
    expect(out.text).toContain('cobblestone でふたをした');
    expect(out.text).toContain('拾い直さない');
    expect(g.placeLog.some(placed => placed.name === 'cobblestone' && placed.y === feet.y - 1)).toBe(true);
    expect(g.countOf('dirt')).toBe(0);
    expect(g.countOf('cobblestone')).toBe(9);   // 40 - 30 thrown - 1 that covers the hole
    const lying = g.dropped().filter((entity: any) => entity.getDroppedItem().count >= 10);   // the two heaps (the dug stone's own drops are not the heap)
    expect(lying).toHaveLength(2);
    expect(lying.every(entity => isSelfDropped(g.bot, entity as any))).toBe(true);
    expect(out.text).not.toContain('離れてから続ける');
  }, 30_000);

  it('keeps one of the thrown kind back to cover the hole when nothing else is spare, and says so', async () => {
    const g = open();
    withToss(g);
    g.give('stone_pickaxe', 1); g.give('dirt', 12);
    const out = await drop(stepContext(g.bot), { items: [{ item: 'dirt' }] });
    expect(out.ok, out.text).toBe(true);
    expect(out.text).toContain('dirt×11 を投げた');
    expect(out.text).toContain('最後の 1 個をふたに残した');
    expect(g.countOf('dirt')).toBe(0);
  }, 30_000);

  it('leaves the hole open and says so when no covering kind is held at all', async () => {
    const g = open();
    withToss(g);
    g.give('stone_pickaxe', 1); g.give('oak_sapling', 3);
    const out = await drop(stepContext(g.bot), { items: [{ item: 'oak_sapling' }] });
    expect(out.ok, out.text).toBe(true);
    expect(out.text).toContain('ふたの石を持っていないので穴は開けたまま');
  }, 30_000);

  it('with a creature or a cell asked for, throws as before (no hole is dug)', async () => {
    const g = open();
    withToss(g, false);
    g.give('gold_ingot', 8);
    const out = await drop(stepContext(g.bot), { items: [{ item: 'gold_ingot' }], toward: '3,64,0' });
    expect(out.ok, out.text).toBe(true);
    expect(out.text).not.toContain('穴');
    expect(g.dugLog).toHaveLength(0);
  }, 30_000);

  it('chooseCap: a spare kind first, else one of a thrown cover kind is reserved, else none', () => {
    const bot = { inventory: { items: () => [{ name: 'cobblestone', count: 5 }, { name: 'dirt', count: 3 }] } };
    expect(chooseCap(bot, new Map([['cobblestone', 2]]))).toEqual({ block: 'cobblestone', reserve: false });
    expect(chooseCap(bot, new Map([['cobblestone', 5], ['dirt', 3]]))).toEqual({ block: 'cobblestone', reserve: true });
    expect(chooseCap({ inventory: { items: () => [{ name: 'oak_sapling', count: 3 }] } }, new Map([['oak_sapling', 3]]))).toBeNull();
  });
});
