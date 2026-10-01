import { describe, expect, it, vi } from 'vitest';
import SearchPlacesTool from '../../src/services/llm/tools/search/searchPlaces.js';
import { searchShannonPlaces } from '../../src/services/maps/shannonPlacesBridge.js';
import { searchPlaces } from '../../src/services/maps/googleMapsService.js';

vi.mock('../../src/services/maps/shannonPlacesBridge.js', () => ({ searchShannonPlaces: vi.fn() }));
vi.mock('../../src/services/maps/googleMapsService.js', () => ({ searchPlaces: vi.fn() }));

describe('Discord place search tool', () => {
  it('returns Shannon map links when the core bridge is available', async () => {
    vi.mocked(searchShannonPlaces).mockResolvedValueOnce({
      reply: '公園を見つけたよ。',
      places: [{ name: '浜松城公園', address: '浜松市', reason: '散歩向き', mapUrl: 'https://maps.apple.com/?q=hamamatsu' }],
      sources: [],
    });
    const result = JSON.parse(await new SearchPlacesTool().invoke({ query: '浜松の公園', maxResults: 5 }));
    expect(result.provider).toBe('shannon_places');
    expect(result.places[0].mapUrl).toContain('maps.apple.com');
    expect(searchPlaces).not.toHaveBeenCalled();
  });

  it('preserves the existing Google Places provider when the bridge is not configured', async () => {
    vi.mocked(searchShannonPlaces).mockResolvedValueOnce(null);
    vi.mocked(searchPlaces).mockResolvedValueOnce([{ displayName: { text: '公園' } }]);
    const result = JSON.parse(await new SearchPlacesTool().invoke({ query: '公園', maxResults: 5 }));
    expect(result.provider).toBe('google_places');
    expect(result.places).toHaveLength(1);
  });
});
