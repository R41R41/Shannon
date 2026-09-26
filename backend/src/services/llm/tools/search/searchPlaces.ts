import { StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { searchPlaces } from '../../../maps/googleMapsService.js';

export default class SearchPlacesTool extends StructuredTool {
  name = 'search-places';
  description = 'Google Places APIで施設・観光地・飲食店を検索し、住所、評価、営業時間、公式サイト、Google Maps URLを確認する。一般Web検索と並列実行して情報源を補完する。';
  schema = z.object({
    query: z.string().min(1).max(300).describe('地名を含む具体的な検索。例: 浜松駅 うなぎ ランチ'),
    maxResults: z.number().int().min(1).max(12).default(8),
  });

  async _call(data: z.infer<typeof this.schema>): Promise<string> {
    try {
      const places = await searchPlaces(data.query, data.maxResults);
      return JSON.stringify({ query: data.query, provider: 'google_places', places });
    } catch (error) {
      return `Google Places検索に失敗しました: ${error instanceof Error ? error.message : String(error)} [failure_type=places_unavailable recoverable=true]`;
    }
  }
}
