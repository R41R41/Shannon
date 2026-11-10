import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { furnace, furnaceBusy } from '../../src/services/minebot/utils/primitives/furnace.js';
import { smeltOutputOf } from '../../src/services/minebot/execution/backgroundJobs.js';
import { createGround, stepContext, type Ground } from '../helpers/practiceGround.js';

// Run 5 (11/11): furnace op=take is a collect (it walks to a furnace out of reach, and a batch not yet due is answered at once, never waited for).
let ground: Ground | null = null;
afterEach(() => { ground?.stop(); ground = null; });
const packets = (client: EventEmitter) => [1500, 1600, 40, 200].forEach((value, property) => client.emit('craft_progress_bar', { windowId: 7, property, value }));

describe('furnace take as a collect', () => {
  it('says "not yet" with the seconds left when nothing is out, and does not wait', async () => {
    const g = ground = createGround({ pathfinder: false }); g.bot.activeFurnaces = []; g.start(); g.set(10, 64, 8, 'furnace');
    const client = (g.bot as any)._client = new EventEmitter();
    (g.bot as any).openFurnace = async () => { packets(client); return { id: 7, totalFuel: null, fuel: 0, progress: 0,
      inputItem: () => ({ name: 'raw_iron', count: 3 }), fuelItem: () => null, outputItem: () => null, close() {} }; };
    const t0 = Date.now();
    const outcome = await furnace(stepContext(g.bot), { at: { x: 10, y: 64, z: 8 }, take: 'output' });
    expect(outcome.ok).toBe(true);
    expect(outcome.text).toContain('まだ出来ていない（あと約28秒');
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(furnaceBusy(g.bot, { x: 10, y: 64, z: 8 })).toBe(true);
  });
  it('tries to walk to a furnace that is out of reach (and says it could not) instead of refusing as out of reach', async () => {
    const g = ground = createGround({ pathfinder: false }); g.bot.activeFurnaces = []; g.start(); g.set(20, 64, 8, 'furnace');
    const outcome = await furnace(stepContext(g.bot), { at: { x: 20, y: 64, z: 8 }, take: 'output' });
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('unreachable');
    expect(outcome.text).toContain('のかまどに近づけない');
    // A put still wants the planner to stand there.
    expect((await furnace(stepContext(g.bot), { at: { x: 20, y: 64, z: 8 }, put: { item: 'raw_iron' } })).reason).toBe('out_of_reach');
  });
  it('walks toward a furnace whose chunk is not loaded until it is read, then to it, and takes', async () => {
    const g = ground = createGround({ pathfinder: true }); g.bot.activeFurnaces = []; g.start(); g.set(28, 64, 8, 'furnace');
    const real = g.bot.blockAt;
    // The cell is not read (null) until the body is within 12 blocks of it: the server's view distance.
    g.bot.blockAt = (position: any, ...rest: any[]) => Math.hypot(position.x + 0.5 - g.bot.entity.position.x, position.z + 0.5 - g.bot.entity.position.z) > 12 && Math.floor(position.x) === 28 ? null : real(position, ...rest);
    const client = (g.bot as any)._client = new EventEmitter();
    (g.bot as any).openFurnace = async () => { packets(client); return { id: 7, totalFuel: null, fuel: 0, progress: 0,
      inputItem: () => null, fuelItem: () => null, outputItem: () => ({ name: 'iron_ingot', count: 4 }), takeOutput: async () => {}, close() {} }; };
    expect(g.bot.blockAt({ x: 28, y: 64, z: 8, floored() { return this; } })).toBeNull();
    const outcome = await furnace(stepContext(g.bot), { at: { x: 28, y: 64, z: 8 }, take: 'output' });
    expect(outcome.reason).not.toBe('unloaded');
    expect(outcome.ok).toBe(true);
    expect(outcome.text).toContain('出来上がりの iron_ingot×4 を取った');
    expect(g.bot.entity.position.x).toBeGreaterThan(18);
  }, 40_000);
  it('keeps the batch when a take reads no burn packet, and forgets it when the cell is no furnace any more', async () => {
    const g = ground = createGround({ pathfinder: false }); g.start(); g.set(10, 64, 8, 'furnace');
    const cell = { x: 10, y: 64, z: 8 };
    g.bot.activeFurnaces = [{ pos: cell, item: 'raw_iron', count: 3, startedAt: 1, readyAt: Date.now() + 30_000, dimension: 'overworld' }];
    // No craft_progress_bar packets: the burn and the progress are unknown.
    (g.bot as any)._client = new EventEmitter();
    (g.bot as any).openFurnace = async () => ({ id: 7, totalFuel: null, fuel: 0, progress: 0, inputItem: () => ({ name: 'raw_iron', count: 3 }), fuelItem: () => null, outputItem: () => null, close() {} });
    await furnace(stepContext(g.bot), { at: cell, take: 'output' });
    expect(furnaceBusy(g.bot, cell)).toBe(true);
    g.set(10, 64, 8, 'air');
    expect((await furnace(stepContext(g.bot), { at: cell, take: 'output' })).reason).toBe('not_furnace');
    expect(furnaceBusy(g.bot, cell)).toBe(false);
  });
  it('furnaceBusy is true for a batch not taken out yet (due or not), false for another cell or dimension', () => {
    const bot = { game: { dimension: 'overworld' }, activeFurnaces: [{ pos: { x: 1, y: 2, z: 3 }, readyAt: 1, dimension: 'overworld' }, { pos: { x: 5, y: 2, z: 3 }, readyAt: 1, dimension: 'the_nether' }] };
    expect(furnaceBusy(bot, { x: 1, y: 2, z: 3 })).toBe(true);
    expect(furnaceBusy(bot, { x: 9, y: 2, z: 3 })).toBe(false);
    expect(furnaceBusy(bot, { x: 5, y: 2, z: 3 })).toBe(false);
    expect(furnaceBusy({}, { x: 1, y: 2, z: 3 })).toBe(false);
  });
  it('smeltOutputOf names what a batch comes out as', () => {
    expect([smeltOutputOf('raw_iron'), smeltOutputOf('iron_ore'), smeltOutputOf('deepslate_iron_ore'), smeltOutputOf('beef'), smeltOutputOf('birch_log'), smeltOutputOf('stick'), smeltOutputOf('warped_stem'), smeltOutputOf('nether_gold_ore')])
      .toEqual(['iron_ingot', 'iron_ingot', 'iron_ingot', 'cooked_beef', 'charcoal', null, null, 'gold_ingot']);
  });
});

// Run 6 (11/11): the head wrote `wait 30, take` and a take sent early took 5 of 8. A take with a short remainder waits it out in the body (exact), a long one answers "not yet".
describe('furnace take with waitDue', () => {
  const open = (g: Ground, client: EventEmitter, output: { name: string; count: number } | null) => {
    (g.bot as any).openFurnace = async () => { packets(client); return { id: 7, totalFuel: null, fuel: 0, progress: 0,
      inputItem: () => output ? null : ({ name: 'raw_iron', count: 3 }), fuelItem: () => null, outputItem: () => output, takeOutput: async () => {}, close() {} }; };
  };
  it('waits the exact remainder (<= 15 s) and then takes', async () => {
    const g = ground = createGround({ pathfinder: false }); g.start(); g.set(10, 64, 8, 'furnace');
    const cell = { x: 10, y: 64, z: 8 };
    g.bot.activeFurnaces = [{ pos: cell, item: 'raw_iron', count: 3, startedAt: 1, readyAt: Date.now() + 1500, dimension: String((g.bot as any).game?.dimension ?? '') }];
    const client = (g.bot as any)._client = new EventEmitter();
    open(g, client, { name: 'iron_ingot', count: 3 });
    const t0 = Date.now();
    const outcome = await furnace(stepContext(g.bot), { at: cell, take: 'output', waitDue: 15 });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(2000);
    expect(outcome.ok).toBe(true);
    expect(outcome.text).toContain('体が待って取りに来た');
    expect(outcome.text).toContain('iron_ingot×3 を取った');
  });
  it('a remainder past waitDue is answered "not yet" at once', async () => {
    const g = ground = createGround({ pathfinder: false }); g.start(); g.set(10, 64, 8, 'furnace');
    const cell = { x: 10, y: 64, z: 8 };
    g.bot.activeFurnaces = [{ pos: cell, item: 'raw_iron', count: 3, startedAt: 1, readyAt: Date.now() + 40_000, dimension: String((g.bot as any).game?.dimension ?? '') }];
    const client = (g.bot as any)._client = new EventEmitter();
    open(g, client, null);
    const t0 = Date.now();
    const outcome = await furnace(stepContext(g.bot), { at: cell, take: 'output', waitDue: 15 });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(outcome.text).toContain('まだ出来ていない');
    expect(outcome.text).not.toContain('体が待って');
  });
});
