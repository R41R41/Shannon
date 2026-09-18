import { StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { computeRoute } from '../../../maps/googleMapsService.js';

export default class ComputeRouteTool extends StructuredTool {
  name = 'compute-route';
  description = 'Google Routes APIで移動距離・所要時間・地図用ルート線を計算する。交通情報は必ずこの結果を使い、推測しない。公共交通は運行時刻が変わるため公式交通機関もfetch-urlで確認する。';
  schema = z.object({
    origin: z.string().min(1).max(300),
    destination: z.string().min(1).max(300),
    intermediates: z.array(z.string().min(1).max(300)).max(10).optional(),
    travelMode: z.enum(['DRIVE', 'WALK', 'BICYCLE', 'TRANSIT', 'TWO_WHEELER']).default('DRIVE'),
  });

  async _call(data: z.infer<typeof this.schema>): Promise<string> {
    try {
      const route = await computeRoute(data);
      return JSON.stringify({ provider: 'google_routes', ...route });
    } catch (error) {
      return `Google Routes検索に失敗しました: ${error instanceof Error ? error.message : String(error)} [failure_type=routes_unavailable recoverable=true]`;
    }
  }
}
