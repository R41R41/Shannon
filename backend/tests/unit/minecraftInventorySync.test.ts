import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { resyncInventory } from '../../src/services/minebot/utils/inventorySync.js';
import prismarineRegistry from 'prismarine-registry';

const registry = (prismarineRegistry as any)('1.21.4');

/** A body whose copy of its pack can differ from what the "server" holds; the server answers a stale-state click with the whole pack. */
function body(copy: Array<{ name: string; count: number } | null>, server: Array<{ name: string; count: number } | null>, answers = true) {
  const bot: any = new EventEmitter();
  const written: Array<{ name: string; params: any }> = [];
  bot.registry = registry;
  bot.supportFeature = () => true;
  bot.currentWindow = null;
  bot.inventory = { slots: [...copy], selectedItem: { name: 'stale' } };
  bot._client = { write: (name: string, params: any) => {
    written.push({ name, params });
    if (name === 'window_click' && answers) setTimeout(() => { bot.inventory.slots = [...server]; bot.emit('setWindowItems:0'); }, 5);
  } };
  return { bot, written };
}

describe("the body's copy of its pack is made the server's (paid run L64: seventeen crafts failed on a copy that had come apart)", () => {
  const log = { name: 'spruce_log', count: 4 }, stone = { name: 'cobblestone', count: 40 };

  it('closes the pack screen, asks for the whole pack with a click that touches nothing, and takes what comes', async () => {
    // The copy says one log and no stone in the grid; the server has put the grid's contents back in the pack.
    const { bot, written } = body([null, null, { name: 'cobblestone', count: 1 }, null, null, { name: 'spruce_log', count: 1 }], [null, null, null, null, null, log, stone]);
    expect(await resyncInventory(bot, 200)).toBe(true);
    expect(written.map(packet => packet.name)).toEqual(['close_window', 'window_click']);
    expect(written[0].params).toEqual({ windowId: 0 });
    expect(written[1].params).toMatchObject({ windowId: 0, stateId: -1, slot: -1, mouseButton: 0, mode: 0, changedSlots: [] });
    expect(bot.inventory.slots[5]).toEqual(log);
    expect(bot.inventory.selectedItem).toBeNull();
    expect(bot.inventorySync).toMatchObject({ resyncs: 1, corrected: 1 });
    // A copy that was already right: asked again, nothing to correct.
    expect(await resyncInventory(bot, 200)).toBe(true);
    expect(bot.inventorySync).toMatchObject({ resyncs: 2, corrected: 1 });
  });

  it('leaves the copy alone when a container is open, when switched off, and when no answer comes', async () => {
    const open = body([log], [stone]);
    open.bot.currentWindow = { id: 3 };
    expect(await resyncInventory(open.bot, 50)).toBe(false);
    expect(open.written).toHaveLength(0);
    const off = body([log], [stone]);
    off.bot.inventorySync = { enabled: false, resyncs: 0, corrected: 0 };
    expect(await resyncInventory(off.bot, 50)).toBe(false);
    expect(off.written).toHaveLength(0);
    const silent = body([log], [stone], false);
    expect(await resyncInventory(silent.bot, 50)).toBe(false);
    expect(silent.bot.inventory.slots[0]).toEqual(log);
    expect(silent.bot.listenerCount('setWindowItems:0')).toBe(0);
  });
});
