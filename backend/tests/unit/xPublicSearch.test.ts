import { describe, expect, it, vi } from 'vitest';
import { XPublicSearch } from '../../src/services/radar/xPublicSearch.js';

const NOW = 1787932800000;
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

describe('bounded X public search', () => {
  it('performs one read-only request and normalizes minimal public candidates', async () => {
    const http = vi.fn(async () => response({ status: 'success', tweets: [
      { id: '1234567890', text: '旬のゲーム情報', createdAt: new Date(NOW - 1000).toISOString(), likeCount: 12, retweetCount: 3,
        replyCount: 1, quoteCount: 2, isReply: false, author: { userName: 'fixture_user', name: 'Fixture' } },
      { id: '1234567891', text: 'reply', createdAt: new Date(NOW - 1000).toISOString(), isReply: true, author: { userName: 'reply_user' } },
    ] }));
    const result = await new XPublicSearch('fixture-api-key-123456', http as any, () => NOW).list('Nintendo', 10, new AbortController().signal);
    expect(result).toEqual([{ source: 'x', externalId: '1234567890', title: '@fixture_user', fact: '旬のゲーム情報',
      url: 'https://x.com/fixture_user/status/1234567890', publishedAt: NOW - 1000,
      metadata: ['likes 12', 'reposts 3', 'replies 1', 'quotes 2'] }]);
    expect(http).toHaveBeenCalledTimes(1);
    const [url, init] = http.mock.calls[0] as any;
    expect(String(url)).toContain('advanced_search'); expect(init.method).toBe('GET'); expect(init.redirect).toBe('error');
    expect(JSON.stringify(init)).not.toContain('cookie');
  });
  it('rejects malformed queries and oversized or failed responses', async () => {
    const http = vi.fn(async () => response({ tweets: [] }));
    const adapter = new XPublicSearch('fixture-api-key-123456', http as any, () => NOW);
    await expect(adapter.list('a\nb', 10, new AbortController().signal)).rejects.toThrow('X_SEARCH_POLICY_INVALID');
    expect(http).not.toHaveBeenCalled();
    const failed = new XPublicSearch('fixture-api-key-123456', async () => response({ error: true }, 402), () => NOW);
    await expect(failed.list('Nintendo', 10, new AbortController().signal)).rejects.toThrow('X_SEARCH_UNAVAILABLE');
  });
});
