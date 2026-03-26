import { describe, expect, it } from 'vitest';
import { discordAdapter } from '../../../src/services/common/adapters/discordAdapter';
import { xAdapter } from '../../../src/services/common/adapters/xAdapter';

describe('discordAdapter', () => {
  it('DiscordNativeEvent を RequestEnvelope に変換する', () => {
    const env = discordAdapter.toEnvelope({
      text: 'hello',
      type: 'text',
      guildName: 'G',
      channelId: 'ch1',
      guildId: 'g1',
      channelName: 'general',
      userName: 'User',
      messageId: 'm1',
      userId: 'u1',
      recentMessages: [{ id: 'prev' }],
      isVoiceChannel: true,
      isDM: false,
    });

    expect(env.channel).toBe('discord');
    expect(env.sourceUserId).toBe('u1');
    expect(env.sourceDisplayName).toBe('User');
    expect(env.conversationId).toBe('discord:g1:ch1');
    expect(env.threadId).toBe('discord:ch1');
    expect(env.text).toBe('hello');
    expect(env.tags).toContain('discord');
    expect(env.tags).toContain('G');
    expect(env.tags).toContain('general');
    expect(env.tags).toContain('voice_channel');
    expect(env.discord?.guildId).toBe('g1');
    expect(env.discord?.channelId).toBe('ch1');
    expect(env.discord?.messageId).toBe('m1');
    expect(env.discord?.isVoiceChannel).toBe(true);
    expect(env.metadata?.recentMessages).toEqual([{ id: 'prev' }]);
    expect(env.metadata?.legacyMemoryZone).toBe('G');
    expect(env.metadata?.isDM).toBe(false);
  });

  it('DM タグと isDM を付与する', () => {
    const env = discordAdapter.toEnvelope({
      text: 'dm',
      type: 'text',
      guildName: '',
      channelId: 'dm-ch',
      guildId: 'dm-g',
      channelName: 'dm',
      userName: 'U',
      messageId: 'm',
      userId: 'u',
      isDM: true,
    });
    expect(env.tags).toContain('dm');
    expect(env.discord?.isDM).toBe(true);
    expect(env.metadata?.isDM).toBe(true);
  });
});

describe('xAdapter', () => {
  it('リプライイベントを Envelope に変換する', () => {
    const env = xAdapter.toEnvelope({
      replyId: 't1',
      text: 'reply body',
      authorName: 'Alice',
      authorId: 'aid',
      repliedTweet: 'root',
      repliedTweetAuthorName: 'Bob',
    });

    expect(env.channel).toBe('x');
    expect(env.sourceUserId).toBe('aid');
    expect(env.conversationId).toBe('x:t1');
    expect(env.threadId).toBe('x:t1');
    expect(env.text).toBe('reply body');
    expect(env.tags).toContain('x');
    expect(env.tags).toContain('public_post');
    expect(env.tags).toContain('reply');
    expect(env.x?.tweetId).toBe('t1');
    expect(env.x?.isReply).toBe(true);
    expect(env.x?.isQuote).toBe(false);
    expect(env.metadata?.repliedTweet).toBe('root');
    expect(env.metadata?.legacyMemoryZone).toBe('twitter:post');
  });

  it('authorId 省略時は sourceUserId に authorName を使う', () => {
    const env = xAdapter.toEnvelope({
      replyId: 't2',
      text: 'x',
      authorName: 'NameOnly',
    });
    expect(env.sourceUserId).toBe('NameOnly');
    expect(env.x?.authorId).toBe('NameOnly');
  });

  it('メンバーツイート（引用）を Envelope に変換する', () => {
    const env = xAdapter.toEnvelope({
      tweetId: 'tw99',
      text: 'qt',
      authorName: 'M',
      authorId: 'mid',
      isQuoteRT: true,
    });

    expect(env.tags).toContain('quote_rt');
    expect(env.x?.isReply).toBe(false);
    expect(env.x?.isQuote).toBe(true);
    expect(env.conversationId).toBe('x:tw99');
  });
});
