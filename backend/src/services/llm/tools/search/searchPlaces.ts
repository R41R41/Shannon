import { StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { searchPlaces } from '../../../maps/googleMapsService.js';
import { searchShannonPlaces } from '../../../maps/shannonPlacesBridge.js';

export default class SearchPlacesTool extends StructuredTool {
  name = 'search-places';
  description = '施設・観光地・飲食店を最新情報から探し、地図で開けるリンクと候補の理由を返す。場所やお店の提案ではこのツールを使う。';
  schema = z.object({
    query: z.string().min(1).max(300).describe('地名を含む具体的な検索。例: 浜松駅 うなぎ ランチ'),
    maxResults: z.number().int().min(1).max(12).default(8),
  });

  async _call(data: z.infer<typeof this.schema>): Promise<string> {
    try {
      try {
        const result = await searchShannonPlaces(data.query);
        if (result) return JSON.stringify({ query: data.query, provider: 'shannon_places', ...result });
      } catch (error) {
        if (!process.env.GOOGLE_MAPS_API_KEY) throw error;
      }
      const places = await searchPlaces(data.query, data.maxResults);
      return JSON.stringify({ query: data.query, provider: 'google_places', places });
    } catch (error) {
      return `場所検索に失敗しました: ${error instanceof Error ? error.message : String(error)} [failure_type=places_unavailable recoverable=true]`;
    }
  }
}
