import { StructuredTool } from '@langchain/core/tools';
import fetch from 'node-fetch';
import { z } from 'zod';
import { logger } from '../../../../utils/logger.js';

// 気象庁の地域コードマッピング
const jmaAreaCodes: Record<string, { code: string; name: string }> = {
  '東京': { code: '130000', name: '東京都' },
  '東京都': { code: '130000', name: '東京都' },
  '大阪': { code: '270000', name: '大阪府' },
  '大阪府': { code: '270000', name: '大阪府' },
  '京都': { code: '260000', name: '京都府' },
  '京都府': { code: '260000', name: '京都府' },
  '名古屋': { code: '230000', name: '愛知県' },
  '愛知': { code: '230000', name: '愛知県' },
  '愛知県': { code: '230000', name: '愛知県' },
  '福岡': { code: '400000', name: '福岡県' },
  '福岡県': { code: '400000', name: '福岡県' },
  '札幌': { code: '016000', name: '北海道（石狩・空知・後志）' },
  '北海道': { code: '016000', name: '北海道（石狩・空知・後志）' },
  '横浜': { code: '140000', name: '神奈川県' },
  '神奈川': { code: '140000', name: '神奈川県' },
  '神奈川県': { code: '140000', name: '神奈川県' },
  '広島': { code: '340000', name: '広島県' },
  '広島県': { code: '340000', name: '広島県' },
  '仙台': { code: '040000', name: '宮城県' },
  '宮城': { code: '040000', name: '宮城県' },
  '宮城県': { code: '040000', name: '宮城県' },
  '千葉': { code: '120000', name: '千葉県' },
  '千葉県': { code: '120000', name: '千葉県' },
  '埼玉': { code: '110000', name: '埼玉県' },
  'さいたま': { code: '110000', name: '埼玉県' },
  '埼玉県': { code: '110000', name: '埼玉県' },
  '沖縄': { code: '471000', name: '沖縄本島地方' },
  '那覇': { code: '471000', name: '沖縄本島地方' },
  '兵庫': { code: '280000', name: '兵庫県' },
  '兵庫県': { code: '280000', name: '兵庫県' },
  '神戸': { code: '280000', name: '兵庫県' },
  '新潟': { code: '150000', name: '新潟県' },
  '新潟県': { code: '150000', name: '新潟県' },
  '長野': { code: '200000', name: '長野県' },
  '長野県': { code: '200000', name: '長野県' },
  '静岡': { code: '220000', name: '静岡県' },
  '静岡県': { code: '220000', name: '静岡県' },
};

export default class SearchWeatherTool extends StructuredTool {
  name = 'search-weather';
  description =
    'A weather search tool using Japan Meteorological Agency (気象庁) official data. Returns accurate weather forecasts for Japanese locations.';
  schema = z.object({
    date: z.string().describe('The date you want to search for (YYYY-MM-DD)'),
    location: z.string().describe('The location in Japan (e.g., 東京, 大阪, 名古屋)'),
  });

  constructor() {
    super();
  }

  async _call(data: z.infer<typeof this.schema>): Promise<string> {
    try {
      const areaInfo = jmaAreaCodes[data.location];

      if (!areaInfo) {
        return `「${data.location}」の地域コードが見つかりません。対応地域: ${Object.keys(jmaAreaCodes).join(', ')}`;
      }

      // 気象庁APIから天気予報を取得
      const url = `https://www.jma.go.jp/bosai/forecast/data/forecast/${areaInfo.code}.json`;

      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Shannon-Weather-Bot/1.0',
        },
      });

      if (!response.ok) {
        throw new Error(`気象庁API error: ${response.status}`);
      }

      const result = await response.json() as Array<{
        timeSeries?: Array<{
          timeDefines?: string[];
          areas?: Array<{
            weathers?: string[];
            weatherCodes?: string[];
            winds?: string[];
            temps?: string[];
            pops?: string[];
            tempsMin?: string[];
            tempsMax?: string[];
          }>;
        }>;
      }>;

      // 天気予報データを解析
      const timeSeries = result[0]?.timeSeries;
      if (!timeSeries || timeSeries.length === 0) {
        throw new Error('天気予報データが取得できませんでした');
      }

      // 天気情報（3日分）
      const weatherSeries = timeSeries[0];
      const timeDefines = weatherSeries.timeDefines || [];
      const areas = weatherSeries.areas || [];
      const mainArea = areas[0]; // 主要地域

      // 気温情報
      const tempSeries = timeSeries[2];
      const tempAreas = tempSeries?.areas || [];
      const tempArea = tempAreas[0];

      // 降水確率情報
      const popSeries = timeSeries[1];
      const popAreas = popSeries?.areas || [];
      const popArea = popAreas[0];

      let weatherReport = `📍 ${areaInfo.name}の天気予報（気象庁公式）\n\n`;

      // 指定日の予報を探す
      const targetDate = data.date;
      const targetIndex = timeDefines.findIndex((t: string) => t.startsWith(targetDate));

      if (targetIndex >= 0 && mainArea) {
        const weather = mainArea.weathers?.[targetIndex] || '不明';
        const weatherCode = mainArea.weatherCodes?.[targetIndex];
        const wind = mainArea.winds?.[targetIndex] || '';

        // 気温
        const temps = tempArea?.temps || [];
        const minTemp = temps[0] || '-';
        const maxTemp = temps[1] || '-';

        // 降水確率（時間帯別）
        const pops = popArea?.pops || [];

        weatherReport += `📅 ${targetDate}（${this.getDayOfWeek(targetDate)}）\n`;
        weatherReport += `━━━━━━━━━━━━━━━━━━━━\n`;
        weatherReport += `🌤️ 天気: ${weather}\n`;
        weatherReport += `🌡️ 気温: ${minTemp}℃ ～ ${maxTemp}℃\n`;

        if (pops.length > 0) {
          weatherReport += `💧 降水確率:\n`;
          const popLabels = ['00-06時', '06-12時', '12-18時', '18-24時'];
          pops.slice(0, 4).forEach((pop: string, i: number) => {
            if (pop) {
              weatherReport += `   ${popLabels[i] || `${i * 6}時`}: ${pop}%\n`;
            }
          });
        }

        if (wind) {
          weatherReport += `💨 風: ${wind}\n`;
        }

      } else {
        // 指定日が見つからない場合、週間予報を表示
        weatherReport += `⚠️ ${targetDate}の詳細予報は見つかりませんでした。\n\n`;

        weatherReport += `【直近の天気予報】\n`;
        timeDefines.slice(0, 3).forEach((time: string, i: number) => {
          const date = time.split('T')[0];
          const weather = mainArea?.weathers?.[i] || '不明';
          weatherReport += `  ${date}（${this.getDayOfWeek(date)}）: ${weather}\n`;
        });

        // 週間予報も取得
        const weeklyForecast = result[1];
        if (weeklyForecast?.timeSeries) {
          weatherReport += `\n【週間予報】\n`;
          const weeklyTime = weeklyForecast.timeSeries[0];
          const weeklyAreas = weeklyTime?.areas?.[0];
          const weeklyDates = weeklyTime?.timeDefines || [];

          weeklyDates.slice(0, 5).forEach((time: string, i: number) => {
            const date = time.split('T')[0];
            const pop = weeklyAreas?.pops?.[i] || '-';
            const minT = weeklyAreas?.tempsMin?.[i] || '-';
            const maxT = weeklyAreas?.tempsMax?.[i] || '-';
            weatherReport += `  ${date}: ${minT}～${maxT}℃ 降水${pop}%\n`;
          });
        }
      }

      weatherReport += `\n※ データ出典: 気象庁`;

      return weatherReport;

    } catch (error) {
      logger.error('Weather search tool error:', error);
      return `天気情報の取得に失敗しました: ${error}\n\n気象庁のデータを取得できませんでした。`;
    }
  }

  private getDayOfWeek(dateStr: string): string {
    const days = ['日', '月', '火', '水', '木', '金', '土'];
    const date = new Date(dateStr);
    return days[date.getDay()];
  }
}
