import { StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { ArtifactService } from '../../../artifacts/artifactService.js';
import type { TripBrief } from '../../../artifacts/types.js';

const shortText = (max: number) => z.string().trim().min(1).max(max);
const httpUrl = z.string().url().refine(
  (value) => value.startsWith('https://') || value.startsWith('http://'),
  'http(s) URL only',
);

const travelBriefSchema = z.object({
  title: shortText(120).describe('資料タイトル。例: みんなで楽しむ浜松日帰り旅'),
  subtitle: z.string().trim().max(180).optional().describe('短い副題'),
  date: shortText(80).describe('日付。未確定なら「日程調整中」と明記'),
  introduction: shortText(800).describe('旅の狙いと全体像を2〜4文で'),
  participants: z.string().trim().max(120).optional().describe('参加者や人数'),
  meetingPoint: z.string().trim().max(200).optional().describe('集合場所・時刻'),
  weatherNote: z.string().trim().max(300).optional().describe('天気・気温・服装メモ'),
  stops: z.array(z.object({
    time: shortText(30).describe('開始時刻または時間帯'),
    title: shortText(120).describe('立ち寄り先・行動'),
    description: shortText(600).describe('何をするか、選定理由、注意点'),
    place: z.string().trim().max(180).optional(),
    travel: z.string().trim().max(180).optional().describe('前後の移動手段・所要時間'),
    cost: z.string().trim().max(100).optional(),
    reservation: z.string().trim().max(140).optional(),
  })).min(1).max(14),
  highlights: z.array(shortText(240)).max(8).optional(),
  rainPlan: z.array(shortText(300)).max(8).optional(),
  notes: z.array(shortText(300)).max(10).optional(),
  sources: z.array(z.object({
    label: shortText(140),
    url: httpUrl,
    note: z.string().trim().max(240).optional(),
  })).min(1).max(20).describe('実際に確認した参照元URL。公式サイトを優先'),
});

export default class CreateTravelBriefTool extends StructuredTool<any> {
  name = 'create-travel-brief';
  description = '調査済みの旅行計画から、共有用HTML・PDF・Discordプレビュー画像を安全なサーバーテンプレートで生成する。先にgoogle-searchとfetch-urlで公式情報を確認し、実在する参照URLをsourcesへ渡すこと。';
  schema = travelBriefSchema;

  async _call(data: TripBrief): Promise<string> {
    const manifest = await new ArtifactService().createTravelBrief(data);
    return JSON.stringify({
      status: 'created',
      artifactId: manifest.id,
      title: manifest.title,
      expiresAt: manifest.expiresAt,
      files: manifest.files.map((file) => ({ role: file.role, fileName: file.fileName })),
      next: 'Discordではsend-artifact-on-discordにartifactIdと現在のguildId/channelIdを渡してください。',
    });
  }
}
