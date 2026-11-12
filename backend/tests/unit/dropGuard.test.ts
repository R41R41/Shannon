import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import { makeHandsSim, type Ground, type HandsSim, type Stack } from '../helpers/handsSim.js';
import { dig, worthKeeping } from '../../src/services/minebot/utils/primitives/dig.js';
import { blocksKeepDrop, guardDrop } from '../../src/services/minebot/utils/primitives/dropGuard.js';
import { dropRisk } from '../../src/services/minebot/utils/dropFate.js';
import type { StepContext } from '../../src/services/minebot/utils/primitives/common.js';

// Run 8 (11/13): six obsidian lost to lava, one with lava beside the block and five with a lava source right under it ("接している溶岩が流れてきてアイテム化した黒曜石が
//消えちゃう"). Before a block worth its drop is dug: the lava beside or over it is put out with a cheap block, the air the drop would fall through into lava is filled,
// lava right under it is covered by water poured on top (a water bucket carried, taken back at once); without a way, the block is not dug and that is said.
beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] }); });
afterEach(() => { vi.useRealTimers(); });

const FLOOR = 64;
const PICK: Stack = { name: 'diamond_pickaxe', count: 1 };
const DIRT: Stack = { name: 'dirt', count: 8 };
const WATER: Stack = { name: 'water_bucket', count: 1 };
/** Stone under the floor; obsidian in the floor at (3,63,0) and what lies round it. */
const worldWith = (extra: Record<string, string>): Ground => (x, y, z) => {
  if (Math.abs(x) > 30 || Math.abs(z) > 30) return null;
  const named = extra[`${x},${y},${z}`];
  if (named) return named;
  if (x === 3 && y === FLOOR - 1 && z === 0) return 'obsidian';
  return y < FLOOR ? 'stone' : 'air';
};
const OBSIDIAN = { x: 3, y: FLOOR - 1, z: 0 };
const ctxOf = (sim: HandsSim): StepContext => ({ bot: sim.bot, stop: new AbortController().signal, deadline: Date.now() + 600_000, facing: 'south', base: { x: 0, y: FLOOR, z: 0 } });
async function drive<T>(sim: HandsSim, promise: Promise<T>, maxMs = 60_000): Promise<T> {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  for (let elapsed = 0; elapsed < maxMs && !settled; elapsed += 50) { sim.tick(); await vi.advanceTimersByTimeAsync(50); }
  return promise;
}

describe('dropRisk', () => {
  it('splits what burns the drop: lava beside or over, lava right under, lava further down a fall', () => {
    const at = (extra: Record<string, string>) => makeHandsSim(worldWith(extra), { start: [0.5, FLOOR, 0.5] }).bot;
    expect(dropRisk(at({}), new Vec3(3, 63, 0))).toMatchObject({ around: [], under: null });
    expect(dropRisk(at({ '4,63,0': 'lava' }), new Vec3(3, 63, 0)).around.map(v => v.x)).toEqual([4]);
    expect(dropRisk(at({ '3,62,0': 'lava' }), new Vec3(3, 63, 0))).toMatchObject({ around: [], under: 'direct' });
    expect(dropRisk(at({ '3,62,0': 'air', '3,61,0': 'lava' }), new Vec3(3, 63, 0))).toMatchObject({ under: 'fall' });
  });
  it('tells when blocks alone keep the drop (not with lava right under it, not without blocks, not beyond the places left)', () => {
    const sim = makeHandsSim(worldWith({ '4,63,0': 'lava' }), { start: [0.5, FLOOR, 0.5], items: [DIRT] });
    const side = dropRisk(sim.bot, new Vec3(3, 63, 0));
    expect(blocksKeepDrop(sim.bot, side)).toBe(true);
    expect(blocksKeepDrop(sim.bot, side, [])).toBe(false);
    expect(blocksKeepDrop(sim.bot, side, undefined, 0)).toBe(false);
    expect(blocksKeepDrop(sim.bot, { around: [], under: 'direct', below: new Vec3(3, 62, 0) })).toBe(false);
  });
});

describe('the drop kept before the dig (run 8)', () => {
  it('puts out the lava beside the obsidian with a dirt, then digs it and takes the drop', async () => {
    const sim = makeHandsSim(worldWith({ '4,63,0': 'lava' }), { start: [0.5, FLOOR, 0.5], items: [PICK, DIRT] });
    const out = await drive(sim, dig(ctxOf(sim), { at: [OBSIDIAN] }));
    expect(out.ok).toBe(true);
    expect(sim.bot.placedBlocks).toEqual(['dirt@4,63,0']);
    expect(out.text).toContain('溶岩で焼けないよう 1 マス（横 1）を dirt で埋めた');
    expect(sim.nameAt(3, 63, 0)).not.toBe('obsidian');
  });
  it('fills the air under the obsidian when the drop would fall into lava further down', async () => {
    const sim = makeHandsSim(worldWith({ '3,62,0': 'air', '3,61,0': 'lava' }), { start: [0.5, FLOOR, 0.5], items: [PICK, DIRT] });
    const out = await drive(sim, dig(ctxOf(sim), { at: [OBSIDIAN] }));
    expect(out.ok).toBe(true);
    expect(sim.bot.placedBlocks).toEqual(['dirt@3,62,0']);
    expect(out.text).toContain('下の空き 1');
  });
  it('with lava right under it and no water bucket, does not dig it and says why (drop_would_burn), laying nothing', async () => {
    const sim = makeHandsSim(worldWith({ '3,62,0': 'lava' }), { start: [0.5, FLOOR, 0.5], items: [PICK, DIRT] });
    const out = await drive(sim, dig(ctxOf(sim), { at: [OBSIDIAN] }));
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('drop_would_burn');
    expect(out.text).toContain('下 (3,62,0) が溶岩で落とし物が焼ける');
    expect(sim.nameAt(3, 63, 0)).toBe('obsidian');
    expect(sim.bot.placedBlocks).toEqual([]);
  });
  it('with lava right under it and a water bucket, pours water on top, digs, and takes the water back at once', async () => {
    const sim = makeHandsSim(worldWith({ '3,62,0': 'lava' }), { start: [0.5, FLOOR, 0.5], items: [PICK, WATER] });
    const out = await drive(sim, dig(ctxOf(sim), { at: [OBSIDIAN] }));
    expect(out.ok).toBe(true);
    expect(sim.bot.poured).toContain('3,64,0');
    expect(sim.bot.scooped.length).toBeGreaterThan(0);
    expect(sim.count('water_bucket')).toBe(1);
    expect(out.text).toContain('上に水をかけてから掘る');
    expect(out.text).toContain('上の水はバケツに戻した');
  });
  it('in the Nether pours no water (it boils away and the bucket is lost): the ore over lava is not dug, the bucket kept', async () => {
    const sim = makeHandsSim(worldWith({ '3,63,0': 'nether_quartz_ore', '3,62,0': 'lava' }), { start: [0.5, FLOOR, 0.5], items: [PICK, WATER] });
    sim.bot.game.dimension = 'the_nether';
    const out = await drive(sim, dig(ctxOf(sim), { at: [OBSIDIAN] }));
    expect(out.reason).toBe('drop_would_burn');
    expect(out.text).toContain('ネザーでは水が蒸発する');
    expect(sim.bot.poured).toEqual([]);
    expect(sim.count('water_bucket')).toBe(1);
  });
  it("pours no water that would run onto the head (the lake face at the feet's height), and says to dig it from a step higher", async () => {
    const sim = makeHandsSim(worldWith({ '3,64,0': 'obsidian', '3,63,0': 'lava' }), { start: [0.5, FLOOR, 0.5], items: [PICK, WATER] });
    const out = await drive(sim, dig(ctxOf(sim), { at: [{ x: 3, y: FLOOR, z: 0 }] }));
    expect(out.reason).toBe('drop_would_burn');
    expect(out.text).toContain('上に水をかけると頭に流れる（1 段上から掘れば水をかけられる）');
    expect(sim.bot.poured).toEqual([]);
    expect(sim.nameAt(3, FLOOR, 0)).toBe('obsidian');
  });
  it('digs as before when the drop is not wanted (collect:false), and lays nothing', async () => {
    const sim = makeHandsSim(worldWith({ '4,63,0': 'lava' }), { start: [0.5, FLOOR, 0.5], items: [PICK, DIRT] });
    const out = await drive(sim, dig(ctxOf(sim), { at: [OBSIDIAN], collect: false }));
    expect(out.ok).toBe(true);
    expect(sim.bot.placedBlocks).toEqual([]);
  });
  it('lays only the blocks it may (none: the cell is not dug), and counts each laid', async () => {
    const none = makeHandsSim(worldWith({ '4,63,0': 'lava' }), { start: [0.5, FLOOR, 0.5], items: [PICK, DIRT] });
    const refused = await drive(none, dig(ctxOf(none), { at: [OBSIDIAN], collect: false, keepDrop: 'require', guardBlocks: [] }));
    expect(refused.reason).toBe('drop_would_burn');
    expect(none.bot.placedBlocks).toEqual([]);
    const counted: number[] = [];
    const some = makeHandsSim(worldWith({ '4,63,0': 'lava' }), { start: [0.5, FLOOR, 0.5], items: [PICK, DIRT] });
    const ok = await drive(some, dig(ctxOf(some), { at: [OBSIDIAN], collect: false, keepDrop: 'require', guardBlocks: ['dirt'], guardMaxPlace: 2, onGuardPlaced: n => counted.push(n) }));
    expect(ok.ok).toBe(true);
    expect(counted).toEqual([1]);
  });
  it("a lava cell out of the hand's reach is left and said, the body not moved", async () => {
    const sim = makeHandsSim(worldWith({ '3,62,0': 'air', '3,61,0': 'lava' }), { start: [-3.5, FLOOR, 0.5], items: [DIRT] });
    const before = sim.bot.entity.position.clone();
    const out = await drive(sim, guardDrop(ctxOf(sim), OBSIDIAN));
    expect(out.placed).toEqual([]);
    expect(out.left?.where).toBe('fall');
    expect(out.words).toContain('届かない');
    expect(sim.bot.entity.position.distanceTo(before)).toBeLessThan(0.5);
  });
  it('keeps the drop of obsidian and ore only', () => {
    expect(worthKeeping('obsidian')).toBe(true);
    expect(worthKeeping('deepslate_diamond_ore')).toBe(true);
    expect(worthKeeping('ancient_debris')).toBe(false);
    expect(worthKeeping('stone')).toBe(false);
  });
});
