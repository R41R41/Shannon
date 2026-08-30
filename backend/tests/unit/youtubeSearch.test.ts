import { describe, expect, it, vi } from 'vitest';
import { YouTubeDataApiVideoSearch } from '../../src/services/radar/youtubeSearch.js';
import { YOUTUBE_READONLY_SCOPE, type YouTubeReadGrant } from '../../src/services/radar/youtubeSubscriptionInbox.js';

const NOW = 1787932800000, owner = 'line:' + 'a'.repeat(64), grant: YouTubeReadGrant = {
  owner, bindingId: 'b'.repeat(64), revision: 1, scope: YOUTUBE_READONLY_SCOPE, expiresAt: NOW + 60000,
};
const video = 'd'.repeat(11), channel = 'UC' + 'c'.repeat(22);

describe('YouTube public search adapter', () => {
  it('uses search.list with a bounded query and no access token in the path', async () => {
    const search = vi.fn(async () => ({ items: [{ id: { videoId: video }, snippet: {
      channelId: channel, title: 'New Game', channelTitle: 'Studio', publishedAt: new Date(NOW - 1000).toISOString(), description: 'fun',
    } }] }));
    const result = await new YouTubeDataApiVideoSearch({ search }).list(grant, 'nintendo', 5, new AbortController().signal);
    expect(search.mock.calls[0][1]).toContain('/youtube/v3/search?');
    expect(search.mock.calls[0][1]).toContain('type=video');
    expect(search.mock.calls[0][1]).not.toContain('access_token');
    expect(result).toEqual([{ videoId: video, channelId: channel, title: 'New Game', channelTitle: 'Studio', publishedAt: NOW - 1000, fact: 'fun' }]);
  });
  it('rejects newlines and does not call the broker', async () => {
    const search = vi.fn();
    await expect(new YouTubeDataApiVideoSearch({ search }).list(grant, 'a\nb', 5, new AbortController().signal)).rejects.toThrow('INVALID_POLICY');
    expect(search).not.toHaveBeenCalled();
  });
});
