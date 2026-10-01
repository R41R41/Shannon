import { describe, expect, it, vi } from 'vitest';
import { searchShannonPlaces } from '../../src/services/maps/shannonPlacesBridge.js';

const configuration = {
  SHANNON_CORE_PLATFORM_URL: 'https://shannon.example/v1/platform/turns',
  SHANNON_CORE_PLATFORM_TOKEN: 'x'.repeat(32),
};

describe('Shannon place bridge', () => {
  it('sends a public query without identity or conversation context', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      reply: '近くの候補です。',
      places: [{ name: 'カフェ', address: '東京都', reason: '駅に近い', mapUrl: 'https://maps.apple.com/?q=%E3%82%AB%E3%83%95%E3%82%A7' }],
      sources: [],
    }), { status: 200 })) as unknown as typeof fetch;
    const result = await searchShannonPlaces('東京のカフェ', configuration, fetcher);
    expect(result?.places).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, options] = (fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://shannon.example/v1/platform/places');
    expect(JSON.parse(options.body)).toEqual({ query: '東京のカフェ' });
    expect(options.headers.authorization).toBe(`Bearer ${configuration.SHANNON_CORE_PLATFORM_TOKEN}`);
  });

  it('rejects unexpected map links', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      reply: '候補です', places: [{ name: '偽', address: '', reason: '', mapUrl: 'https://evil.example' }], sources: [],
    }), { status: 200 })) as unknown as typeof fetch;
    await expect(searchShannonPlaces('カフェ', configuration, fetcher)).rejects.toThrow('invalid place');
  });

  it('returns null when the bridge is not configured', async () => {
    expect(await searchShannonPlaces('カフェ', {})).toBeNull();
  });
});
