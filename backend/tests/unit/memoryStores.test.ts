import { describe, expect, it } from 'vitest';
import { deriveMemoryScope } from '../../src/modules/memory/index.js';
import { bindPersonRequest } from '../../src/modules/memory/personMemory.js';
import { legacyPersonMemoryAllowed, pathMayUseStore, storesForPath } from '../../src/modules/memory/stores.js';

describe('memory store isolation', () => {
  it('does not let LINE or Radar touch Discord/Minecraft durable stores', () => {
    expect(storesForPath('line_chat')).toEqual(['line_ephemeral']);
    expect(storesForPath('line_group')).toEqual(['line_ephemeral']);
    expect(storesForPath('radar_personal')).toEqual(['radar_owner']);
    expect(pathMayUseStore('line_chat', 'scoped_shannon')).toBe(false);
    expect(pathMayUseStore('line_chat', 'scoped_person_quote')).toBe(false);
    expect(pathMayUseStore('radar_personal', 'scoped_shannon')).toBe(false);
    expect(pathMayUseStore('discord_text', 'radar_owner')).toBe(false);
    expect(pathMayUseStore('discord_text', 'line_ephemeral')).toBe(false);
    expect(pathMayUseStore('minecraft', 'scoped_person_quote')).toBe(false);
  });

  it('forbids legacy PersonMemory on every path', () => {
    for (const path of ['discord_text', 'minecraft', 'line_chat', 'radar_personal', 'web'] as const) {
      expect(legacyPersonMemoryAllowed(path)).toBe(false);
    }
  });

  it('does not issue a Shannon scope for web or unknown channels', () => {
    expect(deriveMemoryScope({
      channel: 'web', sourceUserId: 'uid', conversationId: 'c', threadId: 't',
    })).toBeNull();
    expect(deriveMemoryScope({
      channel: 'line', sourceUserId: 'U123', conversationId: 'c', threadId: 't',
    })).toBeNull();
  });

  it('does not bind person quotes outside Discord text', () => {
    expect(bindPersonRequest({
      channel: 'minecraft', sourceUserId: 'player', conversationId: 'c', threadId: 't',
      minecraft: { serverId: 's', worldId: 'w', dimension: 'overworld' },
    })).toBeNull();
    expect(bindPersonRequest({
      channel: 'discord', sourceUserId: '100', conversationId: 'c', threadId: 't',
      discord: { channelId: '300', isDM: true },
    })).toBeTruthy();
  });
});
