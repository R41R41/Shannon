import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/config/env.js', () => ({
  config: {
    discord: {
      guilds: {
        test: { guildId: 'guild-test' },
        aimine: { guildId: 'guild-aimine' },
        toyama: { guildId: 'guild-toyama' },
        douki: { guildId: 'guild-douki' },
        colab: { guildId: 'guild-colab' },
      },
    },
  },
}));

const voiceAuth = vi.hoisted(() => vi.fn((_input: { guildId: string; channelId: string }) => null as { requestId: string } | null));

vi.mock('../../src/services/discord/discordVoiceSession.js', () => ({
  authorizeDiscordVoiceOutbound: (input: { guildId: string; channelId: string }) => voiceAuth(input),
}));

import {
  authorizeDiscordOutboundGuildAction,
  authorizeDiscordOutboundGuildRead,
  authorizeDiscordOutboundPostMessage,
} from '../../src/services/discord/discordOutboundAuth.js';

afterEach(() => {
  voiceAuth.mockReset();
});

describe('discordOutboundAuth', () => {
  it('rejects postMessage without an active voice session', () => {
    expect(authorizeDiscordOutboundPostMessage({ guildId: 'guild-test', channelId: 'ch-1', text: 'hi', imageUrl: '' })).toBe(false);
  });

  it('allows postMessage when voice session is active', () => {
    voiceAuth.mockReturnValue({ requestId: 'voice-1' });
    expect(authorizeDiscordOutboundPostMessage({ guildId: 'guild-test', channelId: 'ch-1', text: 'hi', imageUrl: '' })).toBe(true);
  });

  it('allows guild read only for configured guild ids', () => {
    expect(authorizeDiscordOutboundGuildRead('guild-test')).toBe(true);
    expect(authorizeDiscordOutboundGuildRead('guild-unknown')).toBe(false);
  });

  it('rejects guild write without voice session even on configured guild', () => {
    expect(authorizeDiscordOutboundGuildAction({ guildId: 'guild-test', channelId: 'ch-1' })).toBe(false);
    voiceAuth.mockReturnValue({ requestId: 'voice-1' });
    expect(authorizeDiscordOutboundGuildAction({ guildId: 'guild-test', channelId: 'ch-1' })).toBe(true);
  });
});
