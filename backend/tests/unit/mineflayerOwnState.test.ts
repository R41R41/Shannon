import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// patches/mineflayer+4.35.0.patch: the bot's own air supply and "using the held item" flag were overwritten by other entities' packets
// (every entity's air_supply metadata set bot.oxygenLevel; every entity_status, and the bot's own hurt or shield block, cleared
// bot.usingHeldItem). The plugins are loaded from the patched package (MINEFLAYER_PLUGIN_DIR overrides it for a check on a copy).
const require = createRequire(import.meta.url);
const plugins = process.env.MINEFLAYER_PLUGIN_DIR ?? join(require.resolve('mineflayer/package.json'), '..', 'lib', 'plugins');
const registry = require('prismarine-registry')('1.21.4');

function stubBot(version = '1.21.4'): any {
  const data = version === '1.21.4' ? registry : require('prismarine-registry')(version);
  const bot: any = new EventEmitter();
  Object.assign(bot, { registry: data, version, supportFeature: (name: string) => data.supportFeature(name), game: { dimension: 'overworld' },
    world: { getBlock: () => null }, players: {}, settings: {}, physicsEnabled: false, heldItem: null, setQuickBarSlot: () => {} });
  bot._client = Object.assign(new EventEmitter(), { write: () => {} });
  return bot;
}

describe('the bot keeps its own state when other entities report theirs', () => {
  it.each([false, true])('uses the current yaw and pitch for the item packet, matching movement packets (off-hand=%s)', offHand => {
    const bot = stubBot('1.21.11');
    bot.entity = { id: 5, yaw: -Math.PI / 2, pitch: Math.PI / 6 };
    bot._client.write = vi.fn();
    require(join(plugins, 'inventory.js'))(bot, { hideErrors: true });
    bot.activateItem(offHand);
    expect(bot._client.write).toHaveBeenLastCalledWith('use_item', {
      hand: offHand ? 1 : 0, sequence: 1, rotation: { x: expect.closeTo(270), y: expect.closeTo(-30) },
    });
    bot.entity.yaw = Math.PI / 2; bot.entity.pitch = -Math.PI / 4;
    bot.activateItem(offHand);
    expect(bot._client.write).toHaveBeenLastCalledWith('use_item', {
      hand: offHand ? 1 : 0, sequence: 2, rotation: { x: expect.closeTo(90), y: expect.closeTo(45) },
    });
  });

  it('keeps its air supply when another entity reports one', () => {
    const bot = stubBot();
    require(join(plugins, 'entities.js'))(bot);
    const report = (entityId: number, air: number) => bot._client.emit('entity_metadata', { entityId, metadata: [{ key: 1, type: 'varint', value: air }] });
    report(5, 0); bot.entities[5].name = 'player'; bot.entity = bot.entities[5];
    report(9, 0); bot.entities[9].name = 'drowned';
    report(5, 300);
    expect(bot.oxygenLevel).toBe(20);
    report(9, 75);
    expect(bot.oxygenLevel).toBe(20);
    report(5, 150);
    expect(bot.oxygenLevel).toBe(10);
  });

  it('keeps using the held item through other entities\' statuses and its own hurt and shield block, and ends it when the use finishes', () => {
    const bot = stubBot();
    bot.entity = { id: 5 };
    require(join(plugins, 'inventory.js'))(bot, { hideErrors: true });
    bot.usingHeldItem = true;
    for (const [entityId, entityStatus] of [[99, 2], [99, 3], [5, 29], [5, 2]]) {
      bot._client.emit('entity_status', { entityId, entityStatus });
      expect(bot.usingHeldItem).toBe(true);
    }
    bot._client.emit('entity_status', { entityId: 5, entityStatus: 9 });
    expect(bot.usingHeldItem).toBe(false);
  });

  it('starts a new life not using the held item (the server carries no raised shield over a death)', () => {
    const bot = stubBot();
    bot.entity = { id: 5 };
    require(join(plugins, 'inventory.js'))(bot, { hideErrors: true });
    for (const event of ['death', 'respawn']) {
      bot.usingHeldItem = true;
      bot.emit(event);
      expect(bot.usingHeldItem).toBe(false);
    }
  });

  function usingFixture() {
    const bot = stubBot('1.21.11'); bot.entity = { id: 5, yaw: 0, pitch: 0 };
    bot._client.write = vi.fn();
    require(join(plugins, 'inventory.js'))(bot, { hideErrors: true });
    bot.QUICK_BAR_START = 36; bot.quickBarSlot = 0;
    const Item = require('prismarine-item')(bot.registry);
    bot.inventory.slots[45] = new Item(bot.registry.itemsByName.shield.id, 1);
    const flagsKey = bot.registry.entitiesByName.player.metadataKeys.indexOf('living_entity_flags');
    const flags = (value: number, entityId = 5) => bot._client.emit('entity_metadata', { entityId, metadata: [{ key: flagsKey, type: 'byte', value }] });
    const main = (count = 64) => bot._setSlot(36, new Item(bot.registry.itemsByName.cobblestone.id, count));
    return { bot, flags, main };
  }

  it('preserves an acknowledged off-hand use through main-hand equip and consumption, until our flags end it', () => {
    const { bot, flags, main } = usingFixture();
    bot.activateItem(true); flags(3);
    main(64); expect(bot.usingHeldItem).toBe(true);
    main(63); expect(bot.usingHeldItem).toBe(true);
    expect(bot._client.write.mock.calls.map(([name]: [string]) => name)).toEqual(['use_item']);
    flags(0); expect(bot.usingHeldItem).toBe(false);
    main(62); expect(bot.usingHeldItem).toBe(false);
  });

  it('does not preserve a pending use before its own ACK, or manufacture a use from metadata', () => {
    const { bot, flags, main } = usingFixture();
    bot.activateItem(true); main(); expect(bot.usingHeldItem).toBe(false);
    flags(3); expect(bot.usingHeldItem).toBe(false);
    main(63); expect(bot.usingHeldItem).toBe(false);
    bot.activateItem(true); main(62); expect(bot.usingHeldItem).toBe(false); // the prior ACK is not the new use's ACK
    bot.activateItem(true); flags(3); main(61); expect(bot.usingHeldItem).toBe(true);
  });

  it('ignores other entities\' flags both before and after an acknowledged off-hand use', () => {
    const { bot, flags, main } = usingFixture();
    bot.activateItem(true); flags(3, 99); main(); expect(bot.usingHeldItem).toBe(false);
    bot.activateItem(true); flags(3); flags(0, 99); main(63); expect(bot.usingHeldItem).toBe(true);
  });

  it('keeps the original main-hand change behavior, including a stale off-hand ACK', () => {
    const { bot, flags, main } = usingFixture();
    bot.activateItem(false); flags(1); main(); expect(bot.usingHeldItem).toBe(false);
    bot.activateItem(true); flags(3); bot.deactivateItem(); bot.activateItem(false);
    flags(3); main(63); expect(bot.usingHeldItem).toBe(false);
  });

  it.each(['death', 'respawn'])('does not carry acknowledged off-hand use over %s, even with a late old flag', event => {
    const { bot, flags, main } = usingFixture();
    bot.activateItem(true); flags(3); bot.emit(event); expect(bot.usingHeldItem).toBe(false);
    flags(3); expect(bot.usingHeldItem).toBe(false);
    bot.activateItem(true); main(); expect(bot.usingHeldItem).toBe(false);
  });
});
