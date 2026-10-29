import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import { makeSim, type Ground, type Sim } from '../helpers/physicsBody.js';
import { go } from '../../src/services/minebot/utils/primitives/go.js';
import { fullPackWatch } from '../../src/services/minebot/utils/primitives/common.js';
import { packStops } from '../../src/services/minebot/instantSkills/act.js';

// Run 47 (hold 5): a go that dug through deepslate for 69 s was stopped 2.5 m short by the act's watch ("the pack is full") because the stones it dug filled the 36 slots. A go arrives
// without room in the pack; what it digs lies unpicked and the line says so. Only the hands whose aim is to take things stop for a full pack.
beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] }); });
afterEach(() => { vi.useRealTimers(); });

describe('which hands stop for a full pack', () => {
  it('only those that take things: pickup, mine, obsidian, chest, furnace, smelt, make, craft and a dig that collects', () => {
    for (const hand of ['pickup', 'mine', 'obsidian', 'chest', 'furnace', 'smelt', 'make', 'craft']) expect(packStops({ do: hand } as never), hand).toBe(true);
    expect(packStops({ do: 'dig' } as never)).toBe(true);
    expect(packStops({ do: 'dig', collect: false } as never)).toBe(false);
    for (const hand of ['go', 'vertical', 'walk', 'portal', 'place', 'pillarUp', 'use', 'look', 'jump', 'sneak', 'equip', 'attack', 'fight', 'shoot', 'eat', 'drop', 'wait']) expect(packStops({ do: hand } as never), hand).toBe(false);
    expect(packStops(null)).toBe(false);
  });
});

const FLOOR = 64;
/** Stone from y=64 up inside a block 12 long, 3 wide: a tunnel to dig; air round it. */
const ground: Ground = (x, y, z) => {
  if (Math.abs(x) > 30 || Math.abs(z) > 30) return null;
  if (y < FLOOR) return 'stone';
  if (x >= 1 && x <= 8 && y >= FLOOR && y <= FLOOR + 2) return 'stone';
  return 'air';
};
const fillPack = (sim: Sim) => { const slots = sim.bot.inventory.slots; for (let slot = 9; slot <= 44; slot++) slots[slot] = slot === 36 && sim.items[0] ? sim.items[0] : { name: 'cobblestone', count: 64, slot }; };
const dropsOnDig = (sim: Sim) => {
  let id = 100;
  sim.bot.on('diggingCompleted', (block: any) => {
    const at = block.position;
    sim.bot.entities[++id] = { id, name: 'item', displayName: 'Item', type: 'other', position: new Vec3(at.x + 0.5, at.y + 0.4, at.z + 0.5), getDroppedItem: () => ({ name: 'cobblestone', count: 1 }) };
  });
};
const ctxOf = (sim: Sim) => ({ bot: sim.bot, stop: new AbortController().signal, deadline: Date.now() + 600_000, facing: 'east' as const, base: { x: 0, y: FLOOR, z: 0 } });
async function drive<T>(sim: Sim, promise: Promise<T>, maxMs = 120_000): Promise<T> {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  for (let elapsed = 0; elapsed < maxMs && !settled; elapsed += 50) { sim.tick(); await vi.advanceTimersByTimeAsync(50); }
  return promise;
}

describe('a go with a full pack', () => {
  it('tells what lies unpicked once the pack is full, and nothing while there is room', () => {
    const sim = makeSim(ground, { start: [0.5, FLOOR, 0.5] });
    const watch = fullPackWatch(sim.bot);
    expect(watch()).toBe('');
    fillPack(sim);
    expect(watch()).toBe('持ち物が満杯（拾えずに落ちた物は無い）');
    sim.bot.entities[7] = { id: 7, name: 'item', getDroppedItem: () => ({ name: 'cobbled_deepslate', count: 3 }) };
    sim.bot.entities[8] = { id: 8, name: 'item', getDroppedItem: () => ({ name: 'cobblestone', count: 2 }) };
    expect(watch()).toBe('持ち物が満杯（掘った cobbled_deepslate・cobblestone は拾えずに落ちた 5 個）');
  });
  it('digs through the tunnel and arrives, and its line says the pack is full and how many dug things lie', async () => {
    const sim = makeSim(ground, { start: [0.5, FLOOR, 0.5], digMs: 150, items: [{ name: 'iron_pickaxe', count: 1 }] });
    fillPack(sim); dropsOnDig(sim);
    const outcome = await drive(sim, go(ctxOf(sim) as never, { goals: [{ x: 9, y: FLOOR, z: 0 }], canDig: ['stone'], maxDig: 60, seconds: 100 } as never));
    expect(outcome.text).toMatch(/^go 着いた /u);
    expect(outcome.text).toMatch(/。持ち物が満杯（掘った cobblestone は拾えずに落ちた \d+ 個）/u);
    expect(outcome.text.length).toBeLessThanOrEqual(160);
  });
});
