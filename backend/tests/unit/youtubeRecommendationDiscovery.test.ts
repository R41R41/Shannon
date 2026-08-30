import { describe, expect, it, vi } from 'vitest';
import { YouTubeRecommendationDiscovery } from '../../src/services/radar/youtubeRecommendationDiscovery.js';
import { YOUTUBE_READONLY_SCOPE, type YouTubeReadGrant } from '../../src/services/radar/youtubeSubscriptionInbox.js';

const NOW = 1787932800000, owner = 'line:' + 'a'.repeat(64), bindingId = 'b'.repeat(64);
const subscribed = 'UC' + 's'.repeat(22), fresh = 'UC' + 'f'.repeat(22);
const grant = (patch: Partial<YouTubeReadGrant> = {}): YouTubeReadGrant => ({
  owner, bindingId, revision: 1, scope: YOUTUBE_READONLY_SCOPE, expiresAt: NOW + 60000, ...patch,
});

describe('new YouTube channel discovery', () => {
  it('excludes current subscriptions and returns only recent public candidates', async () => {
    const subscriptions = { list: vi.fn(async () => [{ channelId: subscribed, title: 'Known' }]) };
    const search = { list: vi.fn(async () => [
      { videoId: 'a'.repeat(11), channelId: subscribed, title: 'Known upload', channelTitle: 'Known', publishedAt: NOW - 1000, fact: 'known' },
      { videoId: 'b'.repeat(11), channelId: fresh, title: 'New creator', channelTitle: 'Fresh', publishedAt: NOW - 2000, fact: 'fresh' },
    ]) };
    const service = new YouTubeRecommendationDiscovery(subscriptions as any, search as any, owner, async () => grant(), 500, () => NOW);
    const result = await service.find('nintendo', 8, new AbortController().signal);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(expect.objectContaining({ externalId: 'b'.repeat(11), source: 'youtube', metadata: ['Fresh', '未登録チャンネル候補'] }));
    expect(search.list).toHaveBeenCalledWith(expect.objectContaining({ scope: YOUTUBE_READONLY_SCOPE }), 'nintendo', 8,
      expect.any(AbortSignal), { publishedAfter: NOW - 30 * 86400000, order: 'date' });
  });

  it('fails closed if the account binding changes after search', async () => {
    let calls = 0;
    const service = new YouTubeRecommendationDiscovery({ list: async () => [] } as any, { list: async () => [] } as any,
      owner, async () => grant({ revision: ++calls < 3 ? 1 : 2 }), 500, () => NOW);
    await expect(service.find('science', 4, new AbortController().signal)).rejects.toThrow('YOUTUBE_RECOMMENDATION_DENIED');
  });
});
