import { afterEach, describe, expect, it, vi } from 'vitest';

const outbound = vi.hoisted(() => ({ postMessage: vi.fn(async () => undefined) }));

vi.mock('../../src/services/runtime/discordOutboundGateway.js', () => ({
  getDiscordOutboundPort: () => outbound,
}));
vi.mock('../../src/utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
  authorizeDiscordVoiceOutbound,
  clearDiscordVoiceSessionsForTests,
  registerDiscordVoiceSession,
} from '../../src/services/discord/discordVoiceSession.js';
import { discordDispatcher } from '../../src/services/common/adapters/discordDispatcher.js';

const session = {
  guildId: 'guild-1',
  textChannelId: 'channel-1',
  userId: 'user-1',
  requestId: 'voice-request-1',
  expiresAt: Date.now() + 60_000,
};

const voiceEnvelope = {
  channel: 'discord',
  requestId: 'graph-request',
  sourceUserId: 'user-1',
  conversationId: 'discord:guild-1:channel-1',
  threadId: 'discord:guild-1:channel-1',
  tags: [],
  timestampIso: '2026-08-28T00:00:00Z',
  discord: { channelId: 'channel-1', guildId: 'guild-1', isVoiceChannel: true },
};

afterEach(() => {
  clearDiscordVoiceSessionsForTests();
  vi.clearAllMocks();
});

describe('discord voice session registry', () => {
  it('authorizes outbound posts only for the active guild/channel pair', () => {
    registerDiscordVoiceSession(session);
    expect(authorizeDiscordVoiceOutbound({ guildId: 'guild-1', channelId: 'channel-1' })?.requestId).toBe('voice-request-1');
    expect(authorizeDiscordVoiceOutbound({ guildId: 'guild-2', channelId: 'channel-1' })).toBeUndefined();
    expect(authorizeDiscordVoiceOutbound({ guildId: 'guild-1', channelId: 'channel-2' })).toBeUndefined();
  });
});

describe('discord voice dispatcher guard', () => {
  it('does not dispatch voice envelopes when no active session is registered', async () => {
    await discordDispatcher.dispatch(voiceEnvelope as any, { channel: 'discord', message: 'voice answer' } as any);
    expect(outbound.postMessage).not.toHaveBeenCalled();
  });

  it('dispatches voice envelopes only while the matching session is active', async () => {
    registerDiscordVoiceSession(session);
    await discordDispatcher.dispatch(voiceEnvelope as any, { channel: 'discord', message: 'voice answer' } as any);
    expect(outbound.postMessage).toHaveBeenCalledOnce();
    expect(outbound.postMessage.mock.calls[0][0]).toMatchObject({ guildId: 'guild-1', channelId: 'channel-1' });
  });
});
