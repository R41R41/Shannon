import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// patches/mineflayer+4.35.0.patch: the bot's own air supply and "using the held item" flag were overwritten by other entities' packets
// (every entity's air_supply metadata set bot.oxygenLevel; every entity_status, and the bot's own hurt or shield block, cleared
// bot.usingHeldItem). The plugins are loaded from the patched package (MINEFLAYER_PLUGIN_DIR overrides it for a check on a copy).
const require = createRequire(import.meta.url);
const plugins = process.env.MINEFLAYER_PLUGIN_DIR ?? join(require.resolve('mineflayer/package.json'), '..', 'lib', 'plugins');
const registry = require('prismarine-registry')('1.21.4');

function stubBot(): any {
  const bot: any = new EventEmitter();
  Object.assign(bot, { registry, version: '1.21.4', supportFeature: (name: string) => registry.supportFeature(name), game: { dimension: 'overworld' },
    world: { getBlock: () => null }, players: {}, settings: {}, physicsEnabled: false, heldItem: null, setQuickBarSlot: () => {} });
  bot._client = Object.assign(new EventEmitter(), { write: () => {} });
  return bot;
}

describe('the bot keeps its own state when other entities report theirs', () => {
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
});
