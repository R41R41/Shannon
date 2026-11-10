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
  it('furnaceBusy is true for a batch not taken out yet (due or not), false for another cell or dimension', () => {
    const bot = { game: { dimension: 'overworld' }, activeFurnaces: [{ pos: { x: 1, y: 2, z: 3 }, readyAt: 1, dimension: 'overworld' }, { pos: { x: 5, y: 2, z: 3 }, readyAt: 1, dimension: 'the_nether' }] };
    expect(furnaceBusy(bot, { x: 1, y: 2, z: 3 })).toBe(true);
    expect(furnaceBusy(bot, { x: 9, y: 2, z: 3 })).toBe(false);
    expect(furnaceBusy(bot, { x: 5, y: 2, z: 3 })).toBe(false);
    expect(furnaceBusy({}, { x: 1, y: 2, z: 3 })).toBe(false);
  });
  it('smeltOutputOf names what a batch comes out as', () => {
    expect([smeltOutputOf('raw_iron'), smeltOutputOf('iron_ore'), smeltOutputOf('deepslate_iron_ore'), smeltOutputOf('beef'), smeltOutputOf('birch_log'), smeltOutputOf('stick')])
      .toEqual(['iron_ingot', 'iron_ingot', 'iron_ingot', 'cooked_beef', 'charcoal', null]);
  });
});
