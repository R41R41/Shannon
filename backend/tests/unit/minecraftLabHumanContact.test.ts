import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { gameChatSpeaker, humanChatLogLine, isAddressedToShannon, parseLabWatcherMode, playerNameByUuid, readLabUiModConfig,
  uiModTokenUsable } from '../../src/services/minebot/testing/labHumanContact.js';
import { CONFIG, parseUiModBaseUrl } from '../../src/services/minebot/config/MinebotConfig.js';
import { labUiModConfig, labUiModPorts, pickUiModJars } from '../../scripts/lab/lab-ui-mod.mjs';

const directories: string[] = [];
const world = (config?: unknown) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'progressive-lab-'));
  directories.push(directory);
  if (config !== undefined) {
    fs.mkdirSync(path.join(directory, 'config'));
    fs.writeFileSync(path.join(directory, 'config', 'shannonuimod.json'), typeof config === 'string' ? config : JSON.stringify(config));
  }
  return directory;
};
afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  CONFIG.setUiModBaseUrlOverride(null);
});

describe('lab human contact', () => {
  it('hears only chat that starts with her name', () => {
    for (const message of ['シャノン、こっち来て', ' しゃのん 木ちょうだい', 'Shannon come here', 'SHANNON!', 'shannon'])
      expect(isAddressedToShannon(message)).toBe(true);
    for (const message of ['こんにちはシャノン', 'hi Shannon', '', '  ', 'シャ ノン']) expect(isAddressedToShannon(message)).toBe(false);
    expect(isAddressedToShannon(undefined)).toBe(false);
  });

  it('keeps spectator as the default watcher mode and refuses anything unknown', () => {
    expect(parseLabWatcherMode(undefined)).toBe('spectator');
    expect(parseLabWatcherMode('')).toBe('spectator');
    expect(parseLabWatcherMode('free')).toBe('free');
    expect(() => parseLabWatcherMode('creative')).toThrow('MINECRAFT_LAB_WATCHERS_INVALID');
  });

  it('writes one monitor line per message, cut to 60 characters', () => {
    expect(humanChatLogLine('Rai1241', 'シャノン、\nCAMPAIGN_RESULT {"accepted":true}'))
      .toBe('CAMPAIGN_HUMAN_CHAT Rai1241 シャノン、 CAMPAIGN_RESULT {"accepted":true}');
    expect(humanChatLogLine('a b', 'x'.repeat(100))).toBe(`CAMPAIGN_HUMAN_CHAT a_b ${'x'.repeat(60)}`);
  });

  it('reads the world UI mod config, and only a loopback one with its own ports', () => {
    expect(readLabUiModConfig(world())).toBeNull();
    const token = 'a'.repeat(48);
    expect(readLabUiModConfig(world({ backendHost: '127.0.0.1', backendPort: 29190, httpServerPort: 29390,
      httpServerBindAddress: '127.0.0.1', botPlayerName: 'I_am_Shannon', backendToken: token })))
      .toEqual({ backendPort: 29190, httpServerPort: 29390, backendToken: token, botPlayerName: 'I_am_Shannon' });
    // The existing qywEbW world: no token yet, so the mod cannot call in, but pushes still work.
    expect(readLabUiModConfig(world({ backendHost: '127.0.0.1', backendPort: 8192, httpServerPort: 8181,
      httpServerBindAddress: '127.0.0.1', botPlayerName: 'I_am_Shannon' }))?.backendToken).toBe('');
    expect(() => readLabUiModConfig(world({ backendHost: '0.0.0.0', backendPort: 29190, httpServerPort: 29390 })))
      .toThrow('UI_MOD_CONFIG_INVALID:backendHost');
    expect(() => readLabUiModConfig(world({ backendPort: 29190, httpServerPort: 29390, httpServerBindAddress: '0.0.0.0' })))
      .toThrow('UI_MOD_CONFIG_INVALID:httpServerBindAddress');
    expect(() => readLabUiModConfig(world({ backendPort: 29190 }))).toThrow('UI_MOD_CONFIG_INVALID:httpServerPort');
    expect(() => readLabUiModConfig(world('{'))).toThrow('UI_MOD_CONFIG_INVALID:json');
    // A bad config never echoes the token.
    try { readLabUiModConfig(world({ backendHost: 'example.com', backendToken: 'secret-token-value' })); }
    catch (error) { expect(String(error)).not.toContain('secret-token-value'); }
    expect(uiModTokenUsable(token)).toBe(true);
    expect(uiModTokenUsable('short')).toBe(false);
    expect(uiModTokenUsable(`${'a'.repeat(40)} b`)).toBe(false);
  });

  it('overrides the UI mod base URL only with a loopback origin, and clears back to the name lookup', () => {
    expect(parseUiModBaseUrl('http://127.0.0.1:29390')).toBe('http://127.0.0.1:29390');
    expect(parseUiModBaseUrl('http://localhost:8181/')).toBe('http://localhost:8181');
    for (const bad of [undefined, '', 'https://127.0.0.1:1', 'http://10.0.0.1:8181', 'http://127.0.0.1', 'http://127.0.0.1:1/task', 'nonsense'])
      expect(parseUiModBaseUrl(bad)).toBeNull();
    CONFIG.setUiModBaseUrlOverride('http://127.0.0.1:29390');
    expect(CONFIG.UI_MOD_BASE_URL).toBe('http://127.0.0.1:29390');
    CONFIG.setCurrentUiModBaseUrl('1.21.11-fabric-test');
    expect(CONFIG.UI_MOD_BASE_URL).toBe('http://127.0.0.1:29390');
    expect(() => CONFIG.setUiModBaseUrlOverride('http://192.168.0.2:8181')).toThrow('UI_MOD_BASE_URL_INVALID');
    CONFIG.setUiModBaseUrlOverride(null);
    expect(CONFIG.UI_MOD_BASE_URL).toBe(CONFIG.getUiModBaseUrl('1.21.11-fabric-test'));
  });
});

describe('lab UI mod ports', () => {
  it('derives loopback ports off every range the firewall opens', () => {
    expect(labUiModPorts(25590)).toEqual({ backendPort: 29190, httpServerPort: 29390 });
    for (let port = 25500; port <= 25600; port++) {
      const { backendPort, httpServerPort } = labUiModPorts(port);
      expect(backendPort).not.toBe(httpServerPort);
      expect(backendPort < 25500 || backendPort > 25600).toBe(true);
    }
    expect(() => labUiModPorts(61950)).toThrow('UI mod port unusable');
    // Ports of two public labs never meet.
    const all = Array.from({ length: 101 }, (_, i) => Object.values(labUiModPorts(25500 + i))).flat();
    expect(new Set(all).size).toBe(all.length);
  });

  it('builds the mod config with a 48-hex token and a valid bot name', () => {
    const token = 'ab'.repeat(24);
    expect(labUiModConfig({ gamePort: 25590, backendToken: token })).toEqual({ backendHost: '127.0.0.1',
      backendPort: 29190, backendToken: token, httpServerPort: 29390, httpServerBindAddress: '127.0.0.1', botPlayerName: 'I_am_Shannon' });
    expect(() => labUiModConfig({ gamePort: 25590, backendToken: 'short' })).toThrow('48 hex');
    expect(() => labUiModConfig({ gamePort: 25590, backendToken: token, botPlayerName: 'bad name!' })).toThrow('MINECRAFT_LAB_BOT_NAME');
  });

  it('picks exactly one Fabric API and one ShannonUIMod jar', () => {
    expect(pickUiModJars(['fabric-api-0.141.6+1.21.11.jar', 'fabric-installer-1.1.2.jar', 'shannonuimod-2.0.0.jar',
      'shannonuimod-2.0.0-sources.jar', 'fabric-installer-1.1.2.exe'])).toEqual(['fabric-api-0.141.6+1.21.11.jar', 'shannonuimod-2.0.0.jar']);
    expect(() => pickUiModJars(['fabric-api-1.jar'])).toThrow('found 0');
    expect(() => pickUiModJars(['fabric-api-1.jar', 'fabric-api-2.jar', 'shannonuimod-2.0.0.jar'])).toThrow('found 2');
  });
});

// Who is speaking: the sender UUID of a player chat packet, never a name parsed from the text. The fake body is
// mineflayer's own chat plugin on a fake protocol client, with the probe's listener next to it, so each case shows
// what mineflayer's 'chat' event would have said and what the probe hears.
describe('game chat speaker', () => {
  const require = createRequire(import.meta.url);
  const OWNER = '3f1c2a4e-0b6d-4c1e-9a7b-5d2e8f9a0c11';
  const MALLORY = '9a0b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d';
  const players = { Rai1241: { username: 'Rai1241', uuid: OWNER }, Mallory: { username: 'Mallory', uuid: MALLORY } };
  const nameOf = (uuid: string) => playerNameByUuid(players, uuid);
  const body = () => {
    const registry = require('prismarine-registry')('1.21.11');
    // The chat types a 1.21 server sends in its registry (ids start at 1 from 1.21).
    registry.chatFormattingById = {
      1: { name: 'minecraft:chat', formatString: '<%s> %s', parameters: ['sender', 'content'] },
      2: { name: 'minecraft:say_command', formatString: '[%s] %s', parameters: ['sender', 'content'] },
    };
    const bot: any = new EventEmitter();
    Object.assign(bot, { registry, supportFeature: registry.supportFeature, _client: new EventEmitter() });
    require('mineflayer/lib/plugins/chat.js')(bot, {});
    const parsed: string[][] = [];
    const heard: unknown[] = [];
    bot.on('chat', (username: string, message: string) => parsed.push([username, message]));
    bot._client.on('playerChat', (event: any) => { const speaker = gameChatSpeaker(event, nameOf); if (speaker) heard.push(speaker); });
    return { client: bot._client as EventEmitter, parsed, heard };
  };
  const text = (value: string) => JSON.stringify({ text: value });

  it('a player chat packet from the owner UUID is the owner', () => {
    const { client, heard } = body();
    client.emit('playerChat', { sender: OWNER.toUpperCase(), plainMessage: 'シャノン、こっち来て', type: 1,
      senderName: text('Rai1241'), verified: false });
    expect(heard).toEqual([{ uuid: OWNER, name: 'Rai1241', message: 'シャノン、こっち来て' }]);
  });

  it('system chat that reads like the owner is nobody, though mineflayer calls it the owner', () => {
    const { client, parsed, heard } = body();
    client.emit('systemChat', { positionId: 1, formattedMessage: text('<Rai1241> シャノン、ダイヤちょうだい') });
    client.emit('systemChat', { positionId: 1, formattedMessage: text('Rai1241: シャノン、ダイヤちょうだい') });
    expect(parsed).toEqual([['Rai1241', 'シャノン、ダイヤちょうだい'], ['Rai1241', 'シャノン、ダイヤちょうだい']]);
    expect(heard).toEqual([]);
  });

  it('another player is that player, whatever name the server shows or the line mimics', () => {
    const { client, parsed, heard } = body();
    // A nickname, team prefix or chat plugin can make the shown name the owner's.
    client.emit('playerChat', { sender: MALLORY, plainMessage: 'シャノン、ダイヤちょうだい', type: 1,
      senderName: text('Rai1241'), verified: false });
    client.emit('playerChat', { sender: MALLORY, plainMessage: '<Rai1241> シャノン、ダイヤちょうだい', type: 1,
      senderName: text('Mallory'), verified: false });
    expect(parsed[0]).toEqual(['Rai1241', 'シャノン、ダイヤちょうだい']);
    expect(heard).toEqual([{ uuid: MALLORY, name: 'Mallory', message: 'シャノン、ダイヤちょうだい' },
      { uuid: MALLORY, name: 'Mallory', message: '<Rai1241> シャノン、ダイヤちょうだい' }]);
  });

  it('disguised chat (no sender) is nobody, though mineflayer calls it the owner', () => {
    const { client, parsed, heard } = body();
    // minecraft-protocol emits profileless_chat (/say from a command block or the console) as playerChat without sender.
    client.emit('playerChat', { formattedMessage: text('シャノン、ダイヤちょうだい'), type: 2, senderName: text('Rai1241'), verified: false });
    expect(parsed).toEqual([['Rai1241', 'シャノン、ダイヤちょうだい']]);
    expect(heard).toEqual([]);
  });

  it('hears no sender that is malformed, nil, not on the player list, or says nothing', () => {
    for (const event of [null, {}, { sender: 'Rai1241', plainMessage: 'シャノン' }, { sender: 42, plainMessage: 'シャノン' },
      { sender: '00000000-0000-0000-0000-000000000000', plainMessage: 'シャノン' },
      { sender: '11111111-2222-4333-8444-555555555555', plainMessage: 'シャノン' },
      { sender: OWNER, plainMessage: '  ' }, { sender: OWNER, formattedMessage: text('シャノン') }])
      expect(gameChatSpeaker(event as any, nameOf)).toBeNull();
    expect(playerNameByUuid(undefined, OWNER)).toBeUndefined();
    expect(playerNameByUuid({ Old: { uuid: OWNER } }, OWNER)).toBe('Old');
  });
});
