import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import { captureFurnaceProperties } from '../../src/services/minebot/utils/primitives/furnaceProperties.js';
import { furnace } from '../../src/services/minebot/utils/primitives/furnace.js';
import { createGround, stepContext, type Ground } from '../helpers/practiceGround.js';

const inject = createRequire(import.meta.url)('mineflayer/lib/plugins/furnace.js');
let ground: Ground | null = null;
afterEach(() => { ground?.stop(); ground = null; });
const packets = (client: EventEmitter, id = 7) => [1500, 1600, 40, 200].forEach((value, property) => client.emit('craft_progress_bar', { windowId: id, property, value }));
describe('run51: initial furnace properties before openBlock resolves', () => {
  it.each([true, false])('reads real SDK properties with early packets=%s', async early => {
    const client = new EventEmitter(), window = Object.assign(new EventEmitter(), { id: 7, type: 'minecraft:furnace', slots: [] });
    const bot = { _client: client, async openBlock() { if (early) packets(client); return window; } };
    inject(bot);
    const capture = captureFurnaceProperties(bot), opened = await (bot as any).openFurnace({});
    if (!early) packets(client);
    client.emit('craft_progress_bar', { windowId: 7, property: 0, value: 1499 });
    client.emit('craft_progress_bar', { windowId: 7, property: 2, value: 41 });
    if (early) expect(opened.fuel).toBe(0); // The actual SDK's incorrect value is the regression trigger.
    expect(capture.read(opened)).toEqual({ burning: true, seconds: 74.95, progress: 0.205 });
    packets(client, 9); expect(capture.read(opened).seconds).toBe(74.95);
    capture.close(); expect(client.listenerCount('craft_progress_bar')).toBe(1); opened.emit('close');
    expect(client.listenerCount('craft_progress_bar')).toBe(0);
  });
  it('keeps missing notifications unknown rather than declaring the furnace stopped', () => {
    const client = new EventEmitter(), capture = captureFurnaceProperties({ _client: client });
    expect(capture.read({ id: 7, totalFuel: null, fuel: 0, progress: null })).toEqual({ burning: null, seconds: null, progress: null });
    client.emit('craft_progress_bar', { windowId: 7, property: 0, value: 0 });
    expect(capture.read({ id: 7 }).burning).toBe(false);
    capture.close(); expect(client.listenerCount('craft_progress_bar')).toBe(0);
  });
  it('reports three irons finishing on already burning coal without requesting extra fuel', async () => {
    const g = ground = createGround({ pathfinder: false }); g.bot.activeFurnaces = []; g.start();
    g.set(10, 64, 8, 'furnace');
    const client = (g.bot as any)._client = new EventEmitter();
    (g.bot as any).openFurnace = async () => {
      packets(client);
      return { id: 7, totalFuel: null, fuel: 0, progress: 0,
        inputItem: () => ({ name: 'raw_iron', count: 3 }), fuelItem: () => null, outputItem: () => null, close() {} };
    };
    const outcome = await furnace(stepContext(g.bot), { at: { x: 10, y: 64, z: 8 } });
    expect(outcome.ok).toBe(true); expect(outcome.text).toContain('焼き上がり 約28秒後');
    expect(outcome.text).toContain('燃えている'); expect(outcome.text).not.toContain('燃料が無く'); expect(outcome.text).not.toContain('燃料が要る');
    expect(g.bot.activeFurnaces).toMatchObject([{ count: 3 }]); expect(client.listenerCount('craft_progress_bar')).toBe(0);
  });
  it('removes the capture listener when opening fails', async () => {
    const g = ground = createGround({ pathfinder: false }); g.start(); g.set(10, 64, 8, 'furnace');
    const client = (g.bot as any)._client = new EventEmitter(); (g.bot as any).openFurnace = async () => { throw new Error('closed'); };
    expect((await furnace(stepContext(g.bot), { at: { x: 10, y: 64, z: 8 } })).ok).toBe(false);
    expect(client.listenerCount('craft_progress_bar')).toBe(0);
  });
});
