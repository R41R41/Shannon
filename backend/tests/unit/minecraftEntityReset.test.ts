import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { clearOtherEntities, entityResetPlugin } from '../../src/services/minebot/utils/entityReset.js';

function fakeBot() {
  const self = { id: 1, name: 'player' };
  const bot: any = new EventEmitter();
  bot.entity = self;
  bot.entities = { 1: self, 7: { id: 7, name: 'creeper' }, 9: { id: 9, name: 'zombie' } };
  bot._client = new EventEmitter();
  return bot;
}

describe('entities of an old level do not outlive a respawn', () => {
  it('drops every entity but the body\'s own, and tells the listeners', () => {
    const bot = fakeBot(), gone: number[] = [];
    bot.on('entityGone', (e: any) => gone.push(e.id));
    expect(clearOtherEntities(bot)).toBe(2);
    expect(Object.keys(bot.entities)).toEqual(['1']);
    expect(gone.sort()).toEqual([7, 9]);
  });
  it('does so on every respawn packet once the plugin is loaded, and loads once', () => {
    const bot = fakeBot();
    entityResetPlugin(bot); entityResetPlugin(bot);
    expect(bot._client.listenerCount('respawn')).toBe(1);
    bot._client.emit('respawn', {});
    expect(Object.keys(bot.entities)).toEqual(['1']);
    bot.entities[12] = { id: 12, name: 'enderman' };
    bot._client.emit('respawn', {});
    expect(Object.keys(bot.entities)).toEqual(['1']);
  });
  it('survives a list that is missing', () => {
    const bot: any = fakeBot(); delete bot.entities;
    expect(clearOtherEntities(bot)).toBe(0);
  });
});
