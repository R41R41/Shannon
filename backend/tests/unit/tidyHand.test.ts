import { afterEach, describe, expect, it } from 'vitest';
import { Vec3 } from 'vec3';
import { createGround, stepContext, type Ground } from '../helpers/practiceGround.js';
import { tidy } from '../../src/services/minebot/utils/primitives/tidy.js';
import { freeSlots } from '../../src/services/minebot/utils/primitives/common.js';

// Design flow-1111 A: the tidy hand on a practice ground: the line says "空き A→B", throws into the hole, keeps what is needed, and stops with a reason.
let ground: Ground | null = null;
afterEach(() => { ground?.stop(); ground = null; });
const open = () => { ground?.stop(); ground = createGround({ pathfinder: true }); ground.start(); return ground; };
function withToss(g: Ground) {
  g.bot.toss = async (type: number, _meta: unknown, count: number) => {
    const name = String(g.mcData.items[type].name);
    g.take(name, count);
    const feet = g.bot.entity.position.floored();
    let at = new Vec3(feet.x + 1, feet.y, feet.z);
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) if (g.nameAt(feet.x + dx, feet.y - 2, feet.z + dz) === 'air') { at = new Vec3(feet.x + dx, feet.y - 2, feet.z + dz); break; }
    g.drop(name, count, at);
  };
}

/** Fills the pack with one of each of n things tidy never throws, so that room is short. */
const FILLERS = ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'bone', 'string', 'feather', 'gunpowder', 'leather', 'paper', 'book', 'slime_ball', 'sugar', 'diamond', 'lapis_lazuli', 'redstone', 'quartz', 'glowstone_dust', 'blaze_rod', 'ender_pearl', 'clay_ball', 'brick', 'coal_block', 'iron_nugget', 'melon_slice', 'carrot', 'potato'];
const fill = (g: Ground, free: number) => { for (const name of FILLERS) { if (freeSlots(g.bot) <= free) break; g.give(name, 1); } };

describe('tidy', () => {
  it('throws scraps and loose rock into the hole, says the free slots before and after, and keeps what is needed', async () => {
    const g = open();
    withToss(g);
    g.give('stone_pickaxe', 1); g.give('cobblestone', 64); g.give('diorite', 64); g.give('andesite', 64); g.give('rotten_flesh', 9); g.give('raw_iron', 4); g.give('bread', 6);
    fill(g, 3);
    const before = freeSlots(g.bot);
    const out = await tidy(stepContext(g.bot), { room: before + 2, smelt: false });
    expect(out.ok, out.text).toBe(true);
    expect(out.text).toMatch(/空き \d+→\d+ マス/u);
    expect(out.text).toContain(`空き ${before}→`);
    expect(out.text).toContain('捨てた');
    expect(out.text).toContain('預けず');
    expect(out.text).toContain('穴の中');
    expect(freeSlots(g.bot)).toBeGreaterThanOrEqual(before + 2);
    expect(g.countOf('raw_iron')).toBe(4);
    expect(g.countOf('bread')).toBe(6);
    expect(g.countOf('stone_pickaxe')).toBe(1);
  }, 40_000);

  it('stops at room: nothing more is thrown once the room is there', async () => {
    const g = open();
    withToss(g);
    g.give('stone_pickaxe', 1); g.give('diorite', 64); g.give('andesite', 64); g.give('granite', 64);
    fill(g, 2);
    const before = freeSlots(g.bot);
    const out = await tidy(stepContext(g.bot), { room: before + 1 });
    expect(out.ok, out.text).toBe(true);
    expect(g.countOf('diorite') + g.countOf('andesite') + g.countOf('granite')).toBeGreaterThanOrEqual(126)   // one slot thrown (64), one stone covers the hole;
  }, 40_000);

  it('says no_room with what takes the space when there is nothing to throw', async () => {
    const g = open();
    withToss(g);
    g.give('stone_pickaxe', 1); g.give('iron_ingot', 20); g.give('oak_planks', 30); g.give('coal', 10);
    fill(g, 3);
    const before = freeSlots(g.bot);
    const out = await tidy(stepContext(g.bot), { room: before + 3 });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('no_room');
    expect(out.text).toContain(`空き ${before}→${before}`);
    expect(out.text).toContain('場所を取る物');
  }, 40_000);

  it('does not smelt raw iron when no furnace stands near (and says so)', async () => {
    const g = open();
    withToss(g);
    g.give('stone_pickaxe', 1); g.give('raw_iron', 8); g.give('coal', 4); g.give('diorite', 20);
    fill(g, 2);
    const out = await tidy(stepContext(g.bot), { room: freeSlots(g.bot) + 1 });
    expect(out.ok, out.text).toBe(true);
    expect(out.text).toContain('炉が遠い');
    expect(g.countOf('raw_iron')).toBe(8);
  }, 40_000);

  it('does nothing and says so when the room is already there', async () => {
    const g = open();
    g.give('stone_pickaxe', 1);
    const out = await tidy(stepContext(g.bot), { room: 4 });
    expect(out.ok, out.text).toBe(true);
    expect(out.text).toContain('足りている');
  }, 20_000);
});
