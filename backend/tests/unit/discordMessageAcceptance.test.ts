import { describe, expect, it } from 'vitest';
import { acceptsDiscordMessage } from '../../src/services/discord/messageAcceptance.js';

const designatedChannels = [
  { guildId: 'toyama', channelId: 'toyama-home' },
  { guildId: 'douki', channelId: 'douki-home' },
  { guildId: 'colab', channelId: 'colab-home' },
];

describe('acceptsDiscordMessage', () => {
  it('keeps ordinary messages enabled in the designated channel', () => {
    expect(acceptsDiscordMessage({
      guildId: 'toyama',
      parentChannelId: 'toyama-home',
      isBotMentioned: false,
      designatedChannels,
    })).toBe(true);
  });

  it('rejects an ordinary message in another channel of a configured guild', () => {
    expect(acceptsDiscordMessage({
      guildId: 'toyama',
      parentChannelId: 'off-topic',
      isBotMentioned: false,
      designatedChannels,
    })).toBe(false);
  });

  it('accepts a direct bot mention in another channel of a configured guild', () => {
    expect(acceptsDiscordMessage({
      guildId: 'toyama',
      parentChannelId: 'off-topic',
      isBotMentioned: true,
      designatedChannels,
    })).toBe(true);
  });

  it('uses the parent channel when applying the same policy to threads', () => {
    expect(acceptsDiscordMessage({
      guildId: 'douki',
      parentChannelId: 'douki-home',
      isBotMentioned: false,
      designatedChannels,
    })).toBe(true);
    expect(acceptsDiscordMessage({
      guildId: 'douki',
      parentChannelId: 'another-parent',
      isBotMentioned: true,
      designatedChannels,
    })).toBe(true);
  });

  it('leaves guilds without a designated channel to their existing policy', () => {
    expect(acceptsDiscordMessage({
      guildId: 'aiminelab',
      parentChannelId: 'general',
      isBotMentioned: false,
      designatedChannels,
    })).toBe(true);
  });
});
