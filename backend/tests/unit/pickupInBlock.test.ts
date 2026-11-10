import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import { makeHandsSim, type Ground, type HandsSim } from '../helpers/handsSim.js';
import { pickup } from '../../src/services/minebot/utils/primitives/pickup.js';
import type { StepContext } from '../../src/services/minebot/utils/primitives/common.js';

// Run 47 (hold 1): a drop whose coordinates lie inside a wall's block (it clips into the shape of a cobblestone wall) could not be stood in, and the walk to it ran 10 s and ended
// "4 seconds without a step". The body goes to where its box takes the drop from.
beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] }); });
afterEach(() => { vi.useRealTimers(); });
const FLOOR = 64;
const ground: Ground = (x, y, z) => (Math.abs(x) > 30 || Math.abs(z) > 30 ? null : x === 5 && y === FLOOR && z === 0 ? 'cobblestone' : y < FLOOR ? 'stone' : 'air');
const ctxOf = (sim: HandsSim): StepContext => ({ bot: sim.bot, stop: new AbortController().signal, deadline: Date.now() + 120_000, facing: 'east', base: { x: 0, y: FLOOR, z: 0 } });
async function drive<T>(sim: HandsSim, promise: Promise<T>, maxMs = 60_000): Promise<{ value: T; elapsed: number }> {
  let settled = false, elapsed = 0;
  promise.then(() => { settled = true; }, () => { settled = true; });
  for (; elapsed < maxMs && !settled; elapsed += 50) { sim.tick(); await vi.advanceTimersByTimeAsync(50); }
  return { value: await promise, elapsed };
}

describe('pickup: a drop inside a block', () => {
  it('walks to where its box takes the drop from, and takes it', async () => {
    const sim = makeHandsSim(ground, { start: [0.5, FLOOR, 0.5] });
    const id = 900;
    sim.bot.entities[id] = { id, name: 'item', displayName: 'Item', type: 'other', position: new Vec3(5.5, FLOOR + 0.4, 0.5), velocity: new Vec3(0, 0, 0), getDroppedItem: () => ({ name: 'cobblestone', count: 1 }), metadata: [] };
    const { value, elapsed } = await drive(sim, pickup(ctxOf(sim), { ids: [id] }));
    expect(sim.bot.entities[id]).toBeUndefined();
    expect(value.ok).toBe(true);
    expect(elapsed).toBeLessThan(8_000);
    expect(Math.abs(sim.bot.entity.position.x - 5.5)).toBeLessThanOrEqual(1.5);
  });
});

// end1108h7b S7: 「pickup target=blaze_rod」 from 10 m off took the nearest brick, failed on it, and never went for the rod.
describe('pickup by name', () => {
  const groundOpen: Ground = (x, y, z) => (Math.abs(x) > 30 || Math.abs(z) > 30 ? null : y < FLOOR ? 'stone' : 'air');
  it('walks past a nearer drop of another name to the one named, 10 m off', async () => {
    const sim = makeHandsSim(groundOpen, { start: [0.5, FLOOR, 0.5] });
    sim.bot.entities[901] = { id: 901, name: 'item', displayName: 'Item', type: 'other', position: new Vec3(2.5, FLOOR, 0.5), velocity: new Vec3(0, 0, 0), getDroppedItem: () => ({ name: 'nether_bricks', count: 1 }), metadata: [] };
    sim.bot.entities[902] = { id: 902, name: 'item', displayName: 'Item', type: 'other', position: new Vec3(10.5, FLOOR, 0.5), velocity: new Vec3(0, 0, 0), getDroppedItem: () => ({ name: 'blaze_rod', count: 1 }), metadata: [] };
    const { value } = await drive(sim, pickup(ctxOf(sim), { item: 'blaze_rod' }));
    expect(sim.bot.entities[902]).toBeUndefined();
    expect(value.ok).toBe(true);
  });
  it('says none of that name lies near, and that an arrow shot is no drop', async () => {
    const sim = makeHandsSim(groundOpen, { start: [0.5, FLOOR, 0.5] });
    const { value } = await drive(sim, pickup(ctxOf(sim), { item: 'arrow' }));
    expect(value.text).toMatch(/24m 内に落ちている arrow は無い.*射った矢は落とし物ではない/u);
  });
});

// Review 1110 (G19): a pack with no free slot was "full" for every drop, pearls 5/16 or rods 3/64 in it or not, and the hand ended at the first drop without a step.
describe('pickup with no free slot', () => {
  const groundOpen: Ground = (x, y, z) => (Math.abs(x) > 30 || Math.abs(z) > 30 ? null : y < FLOOR ? 'stone' : 'air');
  const drop = (sim: HandsSim, id: number, name: string, x: number, z: number) => {
    sim.bot.entities[id] = { id, name: 'item', displayName: 'Item', type: 'other', position: new Vec3(x, FLOOR, z), velocity: new Vec3(0, 0, 0), getDroppedItem: () => ({ name, count: 1 }), metadata: [] };
  };
  const fill = (sim: HandsSim) => { for (let slot = 9; slot <= 44; slot++) sim.bot.inventory.slots[slot] = { name: 'cobblestone', count: 64 }; };
  it('takes a drop that stacks onto a stack it holds, past a nearer drop it has no room for', async () => {
    const sim = makeHandsSim(groundOpen, { start: [0.5, FLOOR, 0.5], items: [{ name: 'blaze_rod', count: 3 }] });
    fill(sim);
    drop(sim, 911, 'nether_bricks', 3.5, -3.5);
    drop(sim, 912, 'blaze_rod', 6.5, 0.5);
    const { value } = await drive(sim, pickup(ctxOf(sim), { radius: 8 }));
    expect(sim.bot.entities[912]).toBeUndefined();
    expect(sim.bot.entities[911]).toBeDefined();
    expect(value.ok).toBe(true);
    expect(value.text).toContain('blaze_rod+1');
    expect(value.text).toContain('nether_bricks（持ち物が満杯）');
  });
  it('does not walk to a drop whose stack is full: inventory_full, said once', async () => {
    const sim = makeHandsSim(groundOpen, { start: [0.5, FLOOR, 0.5], items: [{ name: 'ender_pearl', count: 16 }] });
    fill(sim);
    drop(sim, 913, 'ender_pearl', 6.5, 0.5);
    drop(sim, 914, 'ender_pearl', 7.5, 0.5);
    const { value, elapsed } = await drive(sim, pickup(ctxOf(sim), { item: 'ender_pearl' }));
    expect(value.ok).toBe(false);
    expect(value.reason).toBe('inventory_full');
    expect(value.text.match(/ender_pearl（持ち物が満杯）/gu)).toHaveLength(1);
    expect(elapsed).toBeLessThan(500);
    expect(sim.bot.entity.position.x).toBeCloseTo(0.5, 1);
  });
});

// Issue 3 (run 5, task e0672cd9): a raw_iron one stone away cost 3 minutes. The hand takes a drop just outside its box by a step, and digs 1-3 blocks of rock
// to one it cannot walk to (the guards of go and dig), and says what it dug.
describe('pickup that digs to reach a drop', () => {
  const PICK = [{ name: 'stone_pickaxe', count: 1 }];
  const world = (extra: (x: number, y: number, z: number) => string | null | undefined): Ground => (x, y, z) => {
    if (Math.abs(x) > 30 || Math.abs(z) > 30) return null;
    const more = extra(x, y, z);
    if (more !== undefined) return more;
    return y < FLOOR ? 'stone' : 'air';
  };
  const drop = (sim: HandsSim, id: number, at: [number, number, number], name = 'raw_iron') => {
    sim.bot.entities[id] = { id, name: 'item', displayName: 'Item', type: 'other', position: new Vec3(...at), velocity: new Vec3(0, 0, 0), getDroppedItem: () => ({ name, count: 1 }), metadata: [] };
  };

  it('steps inside its own cell to a drop a hair outside the box (a low ceiling over the drop), digging nothing', async () => {
    const sim = makeHandsSim(world((x, y, z) => (x === 0 && y === FLOOR + 1 && z >= 1 && z <= 3 ? 'stone' : undefined)), { start: [0.5, FLOOR, 0.5], items: PICK });
    drop(sim, 920, [0.5, FLOOR + 0.1, 1.95]);
    const { value, elapsed } = await drive(sim, pickup(ctxOf(sim), { ids: [920] }));
    expect(sim.bot.entities[920]).toBeUndefined();
    expect(value.ok).toBe(true);
    expect(sim.bot.dugBlocks).toEqual([]);
    expect(value.data?.dug).toBeUndefined();
    expect(elapsed).toBeLessThan(3_000);
    expect(Math.floor(sim.bot.entity.position.z)).toBe(0);
  });

  it('digs the one stone over a drop it cannot walk to, takes it, and says which cell it dug', async () => {
    const sim = makeHandsSim(world((x, y, z) => (x === 0 && y === FLOOR + 1 && z === 3 ? 'stone' : undefined)), { start: [0.5, FLOOR, 0.5], items: PICK });
    drop(sim, 921, [0.5, FLOOR + 0.1, 3.5]);
    const { value } = await drive(sim, pickup(ctxOf(sim), { ids: [921] }));
    expect(sim.bot.entities[921]).toBeUndefined();
    expect(value.ok).toBe(true);
    expect(sim.bot.dugBlocks).toEqual([`stone@0,${FLOOR + 1},3`]);
    expect(value.data?.dug).toEqual([{ at: { x: 0, y: FLOOR + 1, z: 3 }, name: 'stone' }]);
    expect(value.text).toContain(`途中で(0,${FLOOR + 1},3) stone を 1 マス掘った`);
  });

  it('digs nothing beside lava: the drop stays, with the reason', async () => {
    const sim = makeHandsSim(world((x, y, z) => (x === 0 && y === FLOOR + 1 && z === 3 ? 'stone' : x === 0 && y === FLOOR + 2 && z === 3 ? 'lava' : undefined)), { start: [0.5, FLOOR, 0.5], items: PICK });
    drop(sim, 922, [0.5, FLOOR + 0.1, 3.5]);
    const { value } = await drive(sim, pickup(ctxOf(sim), { ids: [922] }));
    expect(sim.bot.dugBlocks).toEqual([]);
    expect(sim.bot.entities[922]).toBeDefined();
    expect(value.ok).toBe(false);
    expect(value.reason).toBe('not_picked');
    expect(value.text).toContain('掘って近づこうとして止まった');
  });

  it('digs nothing under gravel (it would fall onto the body)', async () => {
    const sim = makeHandsSim(world((x, y, z) => (x === 0 && y === FLOOR + 1 && z === 3 ? 'stone' : x === 0 && y === FLOOR + 2 && z === 3 ? 'gravel' : undefined)), { start: [0.5, FLOOR, 0.5], items: PICK });
    drop(sim, 923, [0.5, FLOOR + 0.1, 3.5]);
    const { value } = await drive(sim, pickup(ctxOf(sim), { ids: [923] }));
    expect(sim.bot.dugBlocks).toEqual([]);
    expect(value.ok).toBe(false);
    expect(value.reason).toBe('not_picked');
  });

  it('keeps to 3 blocks a drop: a way of 4 is refused up front, nothing dug, and the hand ends without a loop', async () => {
    const sim = makeHandsSim(world((x, y, z) => (y >= FLOOR && z >= 1 && z <= 3 ? 'stone' : undefined)), { start: [0.5, FLOOR, 0.5], items: PICK });
    drop(sim, 924, [0.5, FLOOR + 0.1, 5.5]);
    const { value, elapsed } = await drive(sim, pickup(ctxOf(sim), { ids: [924] }));
    expect(sim.bot.dugBlocks).toEqual([]);
    expect(sim.bot.entities[924]).toBeDefined();
    expect(value.ok).toBe(false);
    expect(value.reason).toBe('not_picked');
    expect(value.text).toContain('limit_dig');
    expect(elapsed).toBeLessThan(40_000);
  });

  it('digs only what an explicit canDig names: dirt does not let it through stone', async () => {
    const sim = makeHandsSim(world((x, y, z) => (x === 0 && y === FLOOR + 1 && z === 3 ? 'stone' : undefined)), { start: [0.5, FLOOR, 0.5], items: PICK });
    drop(sim, 925, [0.5, FLOOR + 0.1, 3.5]);
    const { value } = await drive(sim, pickup(ctxOf(sim), { ids: [925], canDig: ['dirt'] }));
    expect(sim.bot.dugBlocks).toEqual([]);
    expect(sim.bot.entities[925]).toBeDefined();
    expect(value.ok).toBe(false);
  });
  it('digs an ordinary ore that stands on the line to the drop (iron_ore), as it digs rock', async () => {
    const sim = makeHandsSim(world((x, y, z) => (z !== 2 || y < FLOOR || y > FLOOR + 3 ? undefined : x !== 0 ? 'bedrock' : y === FLOOR ? 'iron_ore' : y === FLOOR + 1 ? 'stone' : 'bedrock')), { start: [0.5, FLOOR, 0.5], items: PICK });
    drop(sim, 926, [0.5, FLOOR + 0.1, 3.5]);
    const { value } = await drive(sim, pickup(ctxOf(sim), { ids: [926] }));
    expect(sim.bot.dugBlocks.sort()).toEqual([`iron_ore@0,${FLOOR},2`, `stone@0,${FLOOR + 1},2`]);
    expect(sim.bot.entities[926]).toBeUndefined();
    expect(value.ok).toBe(true);
    expect(value.data?.dugCount).toBe(2);
  });

  it('digs nothing for a radius alone (it takes every drop in reach: no tunnel, no shelter wall opened)', async () => {
    const sim = makeHandsSim(world((x, y, z) => (x === 0 && y === FLOOR + 1 && z === 3 ? 'stone' : undefined)), { start: [0.5, FLOOR, 0.5], items: PICK });
    drop(sim, 927, [0.5, FLOOR + 0.1, 3.5]);
    const { value } = await drive(sim, pickup(ctxOf(sim), { radius: 6 }));
    expect(sim.bot.dugBlocks).toEqual([]);
    expect(sim.bot.entities[927]).toBeDefined();
    expect(value.ok).toBe(false);
    expect(value.text).not.toContain('掘って近づこうとして止まった');
  });

  it('digs nothing when the caller says canDig is empty (mine with no road, the dig hand, barter), even by id', async () => {
    const sim = makeHandsSim(world((x, y, z) => (x === 0 && y === FLOOR + 1 && z === 3 ? 'stone' : undefined)), { start: [0.5, FLOOR, 0.5], items: PICK });
    drop(sim, 928, [0.5, FLOOR + 0.1, 3.5]);
    await drive(sim, pickup(ctxOf(sim), { ids: [928], canDig: [] }));
    expect(sim.bot.dugBlocks).toEqual([]);
  });
});
