import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  installPlayerLoadedHandshake,
  needsPlayerLoadedHandshake,
} from '../../src/services/minebot/utils/playerLoadedHandshake.js';

function fixture(version: string) {
  const bot: any = Object.assign(new EventEmitter(), {
    version,
    _client: { write: vi.fn() },
  });
  return bot;
}

describe('player-loaded compatibility handshake', () => {
  it('targets only 1.21.4+ on Mineflayer versions missing the upstream fix', () => {
    expect(needsPlayerLoadedHandshake('1.21.1', '4.35.0')).toBe(false);
    expect(needsPlayerLoadedHandshake('1.21.4', '4.35.0')).toBe(true);
    expect(needsPlayerLoadedHandshake('1.21.11', '4.35.0')).toBe(true);
    expect(needsPlayerLoadedHandshake('26.1', '4.35.0')).toBe(true);
    expect(needsPlayerLoadedHandshake('1.21.11', '4.38.0')).toBe(false);
  });

  it('sends once on each spawn before later spawn listeners can start work', () => {
    const bot = fixture('1.21.11');
    installPlayerLoadedHandshake(bot, '4.35.0');
    bot.on('spawn', () => expect(bot._client.write).toHaveBeenCalledWith('player_loaded', {}));
    bot.emit('spawn');
    bot.emit('spawn');
    expect(bot._client.write).toHaveBeenCalledTimes(2);
  });

  it('checks the negotiated Minecraft version at spawn, not at createBot return', () => {
    const bot = fixture('');
    installPlayerLoadedHandshake(bot, '4.35.0');
    bot.version = '1.21.11';
    bot.emit('spawn');
    expect(bot._client.write).toHaveBeenCalledWith('player_loaded', {});
  });

  it('does not duplicate a newer Mineflayer handshake or send to an older server', () => {
    const current = fixture('1.21.11');
    const oldServer = fixture('1.21.1');
    installPlayerLoadedHandshake(current, '4.38.0');
    installPlayerLoadedHandshake(oldServer, '4.35.0');
    current.emit('spawn');
    oldServer.emit('spawn');
    expect(current._client.write).not.toHaveBeenCalled();
    expect(oldServer._client.write).not.toHaveBeenCalled();
  });
});
