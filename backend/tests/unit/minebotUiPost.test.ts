import { describe, expect, it } from 'vitest';
import { canPostMinebotUiFromBot, canPostMinebotUiFromEnvelope } from '../../src/services/minebot/runtime/minebotUiPost.js';
import { bindMinecraftMemory, revokeMinecraftMemory } from '../../src/services/minebot/runtime/memoryContext.js';

describe('minebotUiPost', () => {
  it('requires minecraft envelope scope', () => {
    expect(canPostMinebotUiFromEnvelope(undefined)).toBe(false);
    expect(canPostMinebotUiFromEnvelope({ channel: 'minecraft', requestId: 'r1', tags: [] } as any)).toBe(false);
    expect(canPostMinebotUiFromEnvelope({
      channel: 'minecraft',
      requestId: 'r1',
      tags: [],
      minecraft: { serverId: 'dev:server-a', worldId: 'world-a' },
    } as any)).toBe(true);
  });

  it('requires bound bot memory context', () => {
    const bot = { game: { dimension: 'overworld' } };
    expect(canPostMinebotUiFromBot(bot)).toBe(false);
    bindMinecraftMemory(bot, {
      serverId: 'dev:server-a',
      worldId: 'world-a',
    });
    expect(canPostMinebotUiFromBot(bot)).toBe(true);
    revokeMinecraftMemory(bot);
    expect(canPostMinebotUiFromBot(bot)).toBe(false);
  });
});
