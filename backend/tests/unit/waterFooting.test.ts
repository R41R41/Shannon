import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeHandsSim, type Ground, type HandsSim } from '../helpers/handsSim.js';
import { makeBlock, makeSim, mcData } from '../helpers/physicsBody.js';
import type { Ground as SimGround } from '../helpers/physicsBody.js';
import { flowingAt } from '../../src/services/minebot/utils/primitives/stanch.js';
import { feetWaterWords, steadyBeforeHand, steadyInWater, waterTrouble } from '../../src/services/minebot/utils/primitives/footing.js';
import { dig, waterBeside } from '../../src/services/minebot/utils/primitives/dig.js';
import { use } from '../../src/services/minebot/utils/primitives/use.js';
import { bestPlan, planFill, blockersFrom, standsNear } from '../../src/services/minebot/utils/primitives/fillStand.js';
import { digSlowed, eyeInWater, installVanillaDigTime, vanillaDigMs } from '../../src/services/minebot/utils/digTimeIn.js';
import { chooseTool } from '../../src/services/minebot/utils/toolChoice.js';
import type { StepContext } from '../../src/services/minebot/utils/primitives/common.js';

// Run 6 (2026-11-11): 400 s of one run to a water bucket in a shaft the body's own dig had flooded: carried by the stream, sunk by its own digs (the floor under the feet is water),
// dig refused fourteen times with the same words, no stream stopped. The body puts itself on its feet before a hand works in water, digs with the game's own times and the quickest tool,
// does not open a lake's wall with a dig, and fills a bucket from a dry floor of its own finding.
beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] }); });
afterEach(() => { vi.useRealTimers(); });

const F = 22;
/** A one-wide shaft at x=0,z=0 two deep in water (y=22 and 23, the stone floor at 21), air above to y=26, walls of stone round it. */
const shaft: Ground = (x, y, z) => {
  if (Math.abs(x) > 30 || Math.abs(z) > 30) return null;
  if (y <= 21) return 'stone';
  if (y > 26) return 'stone';
  if (x === 0 && z === 0) return y <= 23 ? 'water~0' : 'air';
  return 'stone';
};
const ctxOf = (sim: HandsSim, base = { x: 0, y: 23, z: 0 }): StepContext => ({ bot: sim.bot, stop: new AbortController().signal, deadline: Date.now() + 600_000, facing: 'south', base });
async function drive<T>(sim: HandsSim, promise: Promise<T>, each?: (elapsedMs: number) => void, maxMs = 60_000): Promise<T> {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  for (let elapsed = 0; elapsed < maxMs && !settled; elapsed += 50) { sim.tick(); each?.(elapsed); await vi.advanceTimersByTimeAsync(50); }
  return promise;
}

describe('steadyInWater: a body in water without a floor', () => {
  it('reads the trouble: no floor under the feet in a two-deep shaft, none on dry ground', () => {
    const sim = makeHandsSim(shaft, { start: [0.5, 23, 0.5] });
    expect(waterTrouble(sim.bot)).toBe('no_floor');
    const dryAt = makeHandsSim(shaft, { start: [0.5, 24, 0.5] });
    expect(waterTrouble(dryAt.bot)).toBeNull();
  });
  it('lays a block under the feet so the head is in the air, and says it', async () => {
    const sim = makeHandsSim(shaft, { start: [0.5, 23, 0.5], items: [{ name: 'dirt', count: 3 }] });
    const out = await drive(sim, steadyInWater(ctxOf(sim)));
    expect(sim.bot.placedBlocks).toEqual(['dirt@0,22,0']);
    expect(out.acted).toBe(true);
    expect(out.words).toContain('足場');
    expect(out.words.length).toBeLessThanOrEqual(70);
    expect(waterTrouble(sim.bot)).toBeNull();
    expect(eyeInWater(sim.bot)).toBe(false);
  });
  it('builds one level when the body stands on the floor of a two-deep pool with its head under (the shaft of run 6: 1.85 s after a dig it was there)', async () => {
    const sim = makeHandsSim(shaft, { start: [0.5, 22, 0.5], items: [{ name: 'dirt', count: 3 }] });
    sim.tick();
    expect(waterTrouble(sim.bot)).toBe('head_wet');
    const out = await drive(sim, steadyInWater(ctxOf(sim, { x: 0, y: 22, z: 0 })));
    expect(out.words, out.words).toContain('積んで頭を出した');
    expect(sim.bot.placedBlocks).toEqual(['dirt@0,22,0']);
    expect(eyeInWater(sim.bot)).toBe(false);
  });
  it('builds up when the cell two over the feet is water (three deep), and digs a stone there first (a narrow shaft), saying what the dig refused (bedrock) and going on', async () => {
    const column = (over: string): Ground => (x, y, z) => (Math.abs(x) > 30 || Math.abs(z) > 30 ? null : y <= 21 ? 'stone' : y > 27 ? 'stone' : x === 0 && z === 0 ? (y <= 23 ? 'water~0' : y === 24 ? over : 'air') : 'stone');
    const deep = makeHandsSim(column('water~0'), { start: [0.5, 22, 0.5], items: [{ name: 'dirt', count: 4 }] });
    deep.tick();
    expect(waterTrouble(deep.bot)).toBe('head_wet');
    const built = await drive(deep, steadyInWater(ctxOf(deep, { x: 0, y: 22, z: 0 })));
    expect(built.acted, built.words).toBe(true);
    expect(built.words).toContain('積んで頭を出した');
    expect(eyeInWater(deep.bot)).toBe(false);
    const rock = makeHandsSim(column('stone'), { start: [0.5, 22, 0.5], items: [{ name: 'dirt', count: 4 }, { name: 'iron_pickaxe', count: 1 }] });
    rock.tick(); rock.bot.oxygenLevel = 300;
    const dug = await drive(rock, steadyInWater(ctxOf(rock, { x: 0, y: 22, z: 0 })));
    expect(dug.words, dug.words).toContain('を掘って');
    expect(rock.bot.placedBlocks.length).toBeGreaterThan(0);
    const chest = makeHandsSim(column('bedrock'), { start: [0.5, 22, 0.5], items: [{ name: 'dirt', count: 4 }] });
    chest.tick();
    const kept = await drive(chest, steadyInWater(ctxOf(chest, { x: 0, y: 22, z: 0 })));
    expect(kept.words).toContain('を開けられない');
    expect(chest.bot.placedBlocks).toEqual([]);
  });
  it('says what to carry when no cheap block is held, lays nothing, and does not fail', async () => {
    const sim = makeHandsSim(shaft, { start: [0.5, 23, 0.5], items: [{ name: 'oak_planks', count: 9 }] });
    const out = await drive(sim, steadyInWater(ctxOf(sim)));
    expect(sim.bot.placedBlocks).toEqual([]);
    expect(out.words).toContain('dirt か cobblestone');
  });
  it('takes no time and says nothing on dry ground', async () => {
    const sim = makeHandsSim(shaft, { start: [0.5, 24, 0.5], items: [{ name: 'dirt', count: 3 }] });
    expect(await steadyInWater(ctxOf(sim))).toEqual({ acted: false, steady: true, words: '' });
  });
  it('is done before a hand of the planner that works in water, not before a go that may enter water or a fight', async () => {
    const sim = makeHandsSim(shaft, { start: [0.5, 23, 0.5], items: [{ name: 'dirt', count: 3 }] });
    expect(await steadyBeforeHand(ctxOf(sim), { do: 'go', waterOk: true })).toBe('');
    expect(await steadyBeforeHand(ctxOf(sim), { do: 'fight' })).toBe('');
    expect(sim.bot.placedBlocks).toEqual([]);
    const words = await drive(sim, steadyBeforeHand(ctxOf(sim), { do: 'dig' }));
    expect(words).toContain('足場');
    expect(sim.bot.placedBlocks).toEqual(['dirt@0,22,0']);
  });
});

async function driveSim<T>(sim: { tick(): void }, promise: Promise<T>, maxMs = 60_000): Promise<T> {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  for (let elapsed = 0; elapsed < maxMs && !settled; elapsed += 50) { sim.tick(); await vi.advanceTimersByTimeAsync(50); }
  return promise;
}

describe('steadyInWater: a stream', () => {
  const FLOOR = 64;
  const tunnel: SimGround = (x, y, z) => {
    if (Math.abs(x) > 30 || Math.abs(z) > 30) return null;
    if (y < FLOOR || y > FLOOR + 2) return 'stone';
    if (Math.abs(x) >= 1) return 'stone';
    if (z <= -3) return 'water[level=0]';
    if (z <= 0 && y === FLOOR) return `water[level=${z + 3}]`;
    return 'air';
  };
  it('stops the stream with a block upstream (the stanch), and the body is on its feet', async () => {
    const sim = makeSim(tunnel, { start: [0.5, FLOOR, 0.5], items: [{ name: 'cobblestone', count: 5 }] });
    sim.bot.on('blockPlaced', () => { setTimeout(() => { for (const z of [0, -1, -2]) if (sim.nameAt(0, FLOOR, z)?.startsWith('water')) sim.world.set(0, FLOOR, z, 'air'); }, 1200); });
    // The stream pushed the body 0.8 m south a moment ago (installWaterPush's reading): that is what makes a shallow stream trouble.
    (sim.bot as any).waterPush = { at: Date.now(), dx: 0, dz: 0.8, meters: 0.8 };
    expect(waterTrouble(sim.bot)).toBe('flow');
    const out = await driveSim(sim, steadyInWater(ctxOf(sim as never, { x: 0, y: FLOOR, z: 0 })));
    expect(out).toMatchObject({ acted: true, steady: true });
    expect(out.words).toContain('流れを止めた');
    expect(flowingAt(sim.bot, { x: 0, y: FLOOR, z: 0 })).toBe(false);
  });
  it('does nothing (and waits for nothing) in a shallow stream that has not moved a body standing on its floor with the head in the air', async () => {
    const sim = makeSim(tunnel, { start: [0.5, FLOOR, 0.5], items: [{ name: 'cobblestone', count: 5 }] });
    expect(flowingAt(sim.bot, { x: 0, y: FLOOR, z: 0 })).toBe(true);
    expect(waterTrouble(sim.bot)).toBeNull();
    const before = Date.now();
    const out = await driveSim(sim, steadyInWater(ctxOf(sim as never, { x: 0, y: FLOOR, z: 0 })));
    expect(out).toEqual({ acted: false, steady: true, words: '' });
    expect(Date.now() - before).toBeLessThan(100);
    // A push older than three seconds is not a push.
    (sim.bot as any).waterPush = { at: Date.now() - 4000, dx: 0, dz: 0.8, meters: 0.8 };
    expect(waterTrouble(sim.bot)).toBeNull();
    (sim.bot as any).waterPush = { at: Date.now() - 1000, dx: 0, dz: 0.2, meters: 0.2 };
    expect(waterTrouble(sim.bot)).toBeNull();
  });
  it('says the feet in a line: flowing water, the push, the head, the feet; nothing when dry and unpushed', () => {
    const sim = makeSim(tunnel, { start: [0.5, FLOOR, 0.5] });
    (sim.bot as any).waterPush = { at: Date.now() - 2000, dx: 0, dz: 1.1, meters: 1.1 };
    const words = feetWaterWords(sim.bot) ?? '';
    expect(words).toContain('足元: 流れる水・直近');
    expect(words).toContain('2 秒で 南へ 1.1m 押された');
    expect(words).toContain('頭は水の外');
    const dryBot = makeSim(tunnel, { start: [0.5, FLOOR, 2.5] });
    expect(feetWaterWords(dryBot.bot)).toBeNull();
  });
});

describe('dig under water', () => {
  it('reads a block\'s time by the game\'s two conditions: five times slower only with the eyes in water, five times more off the ground', () => {
    const sim = makeHandsSim(shaft, { start: [0.5, 22.9, 0.5] });
    const stone = makeBlock('stone');
    const base = vanillaDigMs(sim.bot, stone);           // eyes at 24.5 over a shaft whose water ends at 24: in the air
    expect(eyeInWater(sim.bot)).toBe(false);
    sim.bot.entity.position.y = 22.1;                       // eyes at 23.7: in the water
    expect(eyeInWater(sim.bot)).toBe(true);
    expect(vanillaDigMs(sim.bot, stone)).toBeCloseTo(base * 5, 0);
    sim.bot.entity.onGround = false;
    expect(vanillaDigMs(sim.bot, stone)).toBeCloseTo(base * 25, 0);
  });
  it('corrects mineflayer\'s estimate for a body whose feet are wet and head is dry (it counted five times what the game does)', () => {
    const sim = makeHandsSim(shaft, { start: [0.5, 23, 0.5] });
    const stone = makeBlock('stone');
    sim.bot.entity.isInWater = true; sim.bot.entity.onGround = true;
    sim.bot.digTime = (block: any) => block.digTime(null, false, sim.bot.entity.isInWater, !sim.bot.entity.onGround, [], {});
    const old = sim.bot.digTime(stone);
    installVanillaDigTime(sim.bot);
    installVanillaDigTime(sim.bot);
    const fixed = sim.bot.digTime(stone);
    expect(fixed).toBeLessThan(old / 4);
    expect(fixed).toBeGreaterThan(old / 5);   // a tick over the game's own count: a finish is never sent before the server's
  });
  it('is slowed (the quickest tool is worth it) only with the eyes in water or the feet off the ground, not when the feet only wade', () => {
    const sim = makeHandsSim(shaft, { start: [0.5, 22.9, 0.5] });
    sim.bot.entity.isInWater = true; sim.bot.entity.onGround = true;
    expect(digSlowed(sim.bot)).toBe(false);
    sim.bot.entity.onGround = false;
    expect(digSlowed(sim.bot)).toBe(true);
    sim.bot.entity.onGround = true; sim.bot.entity.position.y = 22.1;
    expect(digSlowed(sim.bot)).toBe(true);
  });
  it('picks the quickest tool when every second is breath (the wooden pickaxe was 26 s, the iron one 9.4), the cheapest in wear otherwise', () => {
    const stone = makeBlock('stone');
    const tool = (name: string) => ({ name, type: mcData.itemsByName[name]!.id, maxDurability: mcData.itemsByName[name]!.maxDurability, durabilityUsed: 0 });
    const tools = [tool('wooden_pickaxe'), tool('iron_pickaxe')];
    expect(chooseTool(stone, tools, { requireHarvest: true })?.name).toBe('wooden_pickaxe');
    expect(chooseTool(stone, tools, { requireHarvest: true, fastest: true })?.name).toBe('iron_pickaxe');
  });
  it('is put on its feet where the breathing gate would refuse the dig, and the dig then goes on (it refused fourteen times with the same words)', async () => {
    // Standing on the floor of the two-deep shaft, the head under (eyes at 23.6), 3 s of breath, a stone beside the shaft's dry upper part to dig with an iron pickaxe.
    const world: Ground = (x, y, z) => (Math.abs(x) > 30 || Math.abs(z) > 30 ? null : y <= 21 ? 'stone' : y > 26 ? 'stone' : x === 0 && z === 0 ? (y <= 23 ? 'water~0' : 'air') : 'stone');
    const sim = makeHandsSim(world, { start: [0.5, 22, 0.5], items: [{ name: 'dirt', count: 3 }, { name: 'iron_pickaxe', count: 1 }] });
    sim.tick();
    sim.bot.oxygenLevel = 4;
    const out = await drive(sim, dig(ctxOf(sim, { x: 0, y: 22, z: 0 }), { at: [{ x: 1, y: 25, z: 0 }], collect: false }));
    expect(out.text).toContain('足場');
    expect(out.reason, out.text).not.toBe('breathing_work');
    expect(sim.bot.placedBlocks).toEqual(['dirt@0,22,0']);
  });
  it('does not dig the wall between a dry tunnel and a lake without a block to seal it with (water_behind, saying a dirt would do), but does where use has opened it for a bucket', async () => {
    const FLOOR = 64;
    const shore: Ground = (x, y, z) => (Math.abs(x) > 30 || Math.abs(z) > 30 ? null : y < FLOOR ? 'stone' : x === 0 && y === FLOOR && z === -2 ? 'stone' : x === 0 && y === FLOOR && z === -3 ? 'water~0' : 'air');
    // A tunnel along z (side walls and a roof): the body is enclosed, so water let in has only its own cell to run to.
    const world: Ground = (x, y, z) => (shore(x, y, z) === 'air' && (Math.abs(x) >= 1 || y >= FLOOR + 2) ? 'stone' : shore(x, y, z));
    const sim = makeHandsSim(world, { start: [0.5, FLOOR, 0.5], items: [{ name: 'iron_pickaxe', count: 1 }] });
    expect(waterBeside(sim.bot, { x: 0, y: FLOOR, z: -2 })).toEqual({ x: 0, y: FLOOR, z: -3 });
    const refused = await drive(sim, dig(ctxOf(sim, { x: 0, y: FLOOR, z: 0 }), { at: [{ x: 0, y: FLOOR, z: -2 }], openSight: true }));
    expect(refused).toMatchObject({ ok: false, reason: 'water_behind' });
    expect(refused.text).toContain('use bucket');
    expect(refused.text).toContain('dirt か cobblestone を 1 個持てば体が塞いで掘る');
    expect(sim.world.nameAt(0, FLOOR, -2)).toBe('stone');
    // Every dig reads the water behind its cell now (a go's and a mine's own digs seal in their own way): without openSight it is held back the same.
    const plain = await drive(sim, dig(ctxOf(sim, { x: 0, y: FLOOR, z: 0 }), { at: [{ x: 0, y: FLOOR, z: -2 }], collect: false }));
    expect(plain).toMatchObject({ ok: false, reason: 'water_behind' });
  });
  it('seals the water behind the wall with a block it holds and then digs the wall dry (run 7: a go dug into a lake and was carried 1.4 m)', async () => {
    const FLOOR = 64;
    const shore: Ground = (x, y, z) => (Math.abs(x) > 30 || Math.abs(z) > 30 ? null : y < FLOOR ? 'stone' : x === 0 && y === FLOOR && z === -2 ? 'stone' : x === 0 && y === FLOOR && z === -3 ? 'water~0' : 'air');
    const world: Ground = (x, y, z) => (shore(x, y, z) === 'air' && (Math.abs(x) >= 1 || y >= FLOOR + 2) ? 'stone' : shore(x, y, z));
    const sim = makeHandsSim(world, { start: [0.5, FLOOR, 0.5], items: [{ name: 'iron_pickaxe', count: 1 }, { name: 'dirt', count: 4 }] });
    const out = await drive(sim, dig(ctxOf(sim, { x: 0, y: FLOOR, z: 0 }), { at: [{ x: 0, y: FLOOR, z: -2 }], collect: false }));
    expect(out.ok, out.text).toBe(true);
    expect(out.text).toContain('裏の水 1 マスを dirt で塞いでから掘った');
    expect(sim.bot.placedBlocks).toEqual(['dirt@0,64,-3']);
    expect(sim.world.nameAt(0, FLOOR, -2)).toBe('air');
    expect(sim.world.nameAt(0, FLOOR, -3)).toBe('dirt');
  });
  it('does not refuse a dig beside water on an open shore (air round the body: the flow harms nothing)', async () => {
    const FLOOR = 64;
    const open: Ground = (x, y, z) => (Math.abs(x) > 30 || Math.abs(z) > 30 ? null : y < FLOOR ? 'stone' : x === 0 && y === FLOOR && z === -2 ? 'stone' : x === 0 && y === FLOOR && z === -3 ? 'water~0' : 'air');
    const sim = makeHandsSim(open, { start: [0.5, FLOOR, 0.5], items: [{ name: 'iron_pickaxe', count: 1 }] });
    const out = await drive(sim, dig(ctxOf(sim, { x: 0, y: FLOOR, z: 0 }), { at: [{ x: 0, y: FLOOR, z: -2 }], openSight: true }));
    expect(out.reason).not.toBe('water_behind');
    expect(out.ok, out.text).toBe(true);
  });
});

describe('a bucket filled from a dry floor the body finds', () => {
  const FLOOR = 64;
  /** A tunnel along z (walls at x=-1 and 1, roof at y=66), a stone block in its floor line at z=-2 between the body (z=0) and a source of water at z=-3. */
  const corridor: Ground = (x, y, z) => {
    if (Math.abs(x) > 30 || Math.abs(z) > 30) return null;
    if (y < FLOOR) return 'stone';
    if (y >= FLOOR + 2 || Math.abs(x) >= 1) return 'stone';
    if (x === 0 && z === -2 && y === FLOOR) return 'dirt';
    // A block over the water: its top is not seen over the wall (the line to the water's side is, through the wall only).
    if (x === 0 && z === -3 && y === FLOOR + 1) return 'stone';
    if (x === 0 && z === -3 && y === FLOOR) return 'water~0';
    return 'air';
  };
  it('plans the one wall block to open when no stand has a clear line (and none when no block is held to close it)', () => {
    const sim = makeHandsSim(corridor, { start: [0.5, FLOOR, 0.5], items: [{ name: 'bucket', count: 1 }, { name: 'dirt', count: 2 }] });
    const eye = { x: 0.5, y: FLOOR + 1.62, z: 0.5 };
    expect(blockersFrom(sim.bot, eye, { x: 0, y: FLOOR, z: -3 }).map(b => `${b.cell.x},${b.cell.y},${b.cell.z}`)).toEqual([`0,${FLOOR},-2`]);
    expect(planFill(sim.bot, { x: 0, y: FLOOR, z: -3 })).toMatchObject({ wall: { x: 0, y: FLOOR, z: -2 }, wallName: 'dirt' });
    const none = makeHandsSim(corridor, { start: [0.5, FLOOR, 0.5], items: [{ name: 'bucket', count: 1 }] });
    expect(planFill(none.bot, { x: 0, y: FLOOR, z: -3 })).toBeNull();
  });
  it('opens the wall, fills at once and closes the wall again, in one use hand', async () => {
    const sim = makeHandsSim(corridor, { start: [0.5, FLOOR, 0.5], items: [{ name: 'bucket', count: 1 }, { name: 'dirt', count: 2 }, { name: 'iron_pickaxe', count: 1 }] });
    const out = await drive(sim, use(ctxOf(sim, { x: 0, y: FLOOR, z: 0 }), { item: 'bucket', at: { x: 0, y: FLOOR, z: -3 } }));
    expect(out.ok, out.text).toBe(true);
    expect(out.text).toContain('を開けて');
    expect(out.text).toContain('壁を dirt で塞いだ');
    expect(sim.bot.inventory.items().some((item: any) => item.name === 'water_bucket')).toBe(true);
    expect(sim.world.nameAt(0, FLOOR, -2)).toBe('dirt');            // the wall is back
    expect(sim.bot.dugBlocks.length).toBe(1);
  });
  it('says which block to carry when one wall block is all that is in the way and nothing is held to close it', async () => {
    const sim = makeHandsSim(corridor, { start: [0.5, FLOOR, 0.5], items: [{ name: 'bucket', count: 1 }, { name: 'iron_pickaxe', count: 1 }] });
    const out = await drive(sim, use(ctxOf(sim, { x: 0, y: FLOOR, z: 0 }), { item: 'bucket', at: { x: 0, y: FLOOR, z: -3 } }));
    expect(out).toMatchObject({ ok: false, reason: 'no_wall_block' });
    expect(out.text).toContain('dirt か cobblestone');
    expect(sim.world.nameAt(0, FLOOR, -2)).toBe('dirt');
  });
  it('a stone wall is dug with the pickaxe and the bucket is taken back into the hand before the fill', async () => {
    const stoneWall: Ground = (x, y, z) => (x === 0 && z === -2 && y === FLOOR ? 'stone' : corridor(x, y, z));
    const sim = makeHandsSim(stoneWall, { start: [0.5, FLOOR, 0.5], items: [{ name: 'bucket', count: 1 }, { name: 'cobblestone', count: 2 }, { name: 'iron_pickaxe', count: 1 }] });
    const out = await drive(sim, use(ctxOf(sim, { x: 0, y: FLOOR, z: 0 }), { item: 'bucket', at: { x: 0, y: FLOOR, z: -3 } }));
    expect(out.ok, out.text).toBe(true);
    expect(sim.bot.inventory.items().some((item: any) => item.name === 'water_bucket')).toBe(true);
    expect(sim.world.nameAt(0, FLOOR, -2)).toBe('cobblestone');
  });
  it('looks from the shore when the body itself is in the water (a pool two deep): the stands are found, not none', () => {
    const pool: Ground = (x, y, z) => (Math.abs(x) > 30 || Math.abs(z) > 30 ? null : y <= 21 ? 'stone' : Math.abs(x) <= 1 && Math.abs(z) <= 1 && y <= 23 ? 'water~0' : 'air');
    const sim = makeHandsSim(pool, { start: [0.5, 22, 0.5], items: [{ name: 'bucket', count: 1 }] });
    const stands = standsNear(sim.bot, { x: 0, y: 22, z: 0 });
    expect(stands.length).toBeGreaterThan(0);
    expect(planFill(sim.bot, { x: 0, y: 22, z: 0 })).not.toBeNull();
  });
  it('takes the source of the pool that is seen when the one asked is walled in rock (no wall opened)', () => {
    const walled: Ground = (x, y, z) => {
      if (Math.abs(x) > 30 || Math.abs(z) > 30) return null;
      if (y < FLOOR) return 'stone';
      if (x === 0 && y === FLOOR && z === -3) return 'water~0';
      if (x === 4 && y === FLOOR && z === -3) return 'water~0';
      // A box of stone two thick round the first source (the cell itself left).
      if (Math.abs(x) <= 2 && z >= -5 && z <= -1 && y <= FLOOR + 1) return 'stone';
      return 'air';
    };
    const sim = makeHandsSim(walled, { start: [0.5, FLOOR, 0.5], items: [{ name: 'bucket', count: 1 }] });
    const found = bestPlan(sim.bot, { x: 0, y: FLOOR, z: -3 });
    expect(found?.source).toEqual({ x: 4, y: FLOOR, z: -3 });
    expect(found?.plan.wall).toBeUndefined();
    expect(found?.plan.aim).toBeDefined();
  });
  it('sees a source whose middle is hidden behind a corner but whose face is not (five aims, not one line)', () => {
    // A stone at the corner cuts the line to the middle of the source from the stand but not the line to the face's corner.
    const corner: Ground = (x, y, z) => {
      if (Math.abs(x) > 30 || Math.abs(z) > 30) return null;
      if (y < FLOOR) return 'stone';
      if (x === 3 && y === FLOOR && z === -3) return 'water~0';
      if (x === 1 && y === FLOOR + 1 && z === -1) return 'stone';
      return 'air';
    };
    const sim = makeHandsSim(corner, { start: [0.5, FLOOR, 0.5], items: [{ name: 'bucket', count: 1 }] });
    const plan = planFill(sim.bot, { x: 3, y: FLOOR, z: -3 }, false);
    expect(plan).not.toBeNull();
    expect(plan?.wall).toBeUndefined();
  });
  it('fills straight when a stand with a clear line exists (no wall opened)', async () => {
    const open: Ground = (x, y, z) => (Math.abs(x) > 30 || Math.abs(z) > 30 ? null : y < FLOOR ? 'stone' : x === 0 && y === FLOOR && z === -9 ? 'water~0' : 'air');
    const sim = makeHandsSim(open, { start: [0.5, FLOOR, 0.5], items: [{ name: 'bucket', count: 1 }] });
    const out = await drive(sim, use(ctxOf(sim, { x: 0, y: FLOOR, z: 0 }), { item: 'bucket', at: { x: 0, y: FLOOR, z: -9 } }));
    expect(out.ok, out.text).toBe(true);
    expect(out.text).toContain('乾いた');
    expect(out.text).not.toContain('壁');
    expect(sim.bot.dugBlocks).toEqual([]);
  });
});
