import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';
import { createTracedModel } from '../utils/langfuse.js';
import { PromptType } from '@shannon/common';
import axios from 'axios';
import { addDays, format } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';
import { z } from 'zod';
import { config } from '../../../config/env.js';
import { models } from '../../../config/models.js';
import { loadPrompt } from '../config/prompts.js';
import { logger } from '../../../utils/logger.js';

const OPENAI_API_KEY = config.openaiApiKey;
const jst = 'Asia/Tokyo';

/** エージェントの出力 */
export interface WeatherOutput {
  text: string;
  imagePrompt?: string;
}

// 天気予報のスキーマ定義
const WeatherSchema = z.object({
  date: z.string(),
  overview: z.string(),
  regions: z.array(
    z.object({
      region: z.string(),
      weather: z.string(),
      temperature: z.string().nullable(),
      chanceOfRain: z.string().nullable(),
      hourlyEmojis: z.array(z.string()).nullable(),
    })
  ),
  advice: z.string(),
  closing: z.string(),
  imagePrompt: z.string().describe(
    '天気に合った画像を生成するためのプロンプト（英語）。photorealistic style。明日の天気の雰囲気を描写。'
  ),
});

// 型定義
type WeatherResult = z.infer<typeof WeatherSchema>;

interface CityForecast {
  city: string;
  telop: string;
  temperature: string;
  chanceOfRain: string;
  weather: string;
  hourlyEmojis: string[];
}

interface WeatherApiForecastItem {
  telop: string;
  temperature: {
    min: { celsius: string };
    max: { celsius: string };
  };
  chanceOfRain: Record<string, string>;
  detail: {
    weather: string;
  };
}

interface WeatherApiResponse {
  forecasts: WeatherApiForecastItem[];
}

interface Forecast {
  date: string;
  forecasts: string;
  weatherData?: WeatherResult;
}

export class PostWeatherAgent {
  private model: ChatOpenAI;
  private cities: [string, string][];
  private displayCities: string[];
  private searchCities: string[];
  private url: string;
  private systemPrompts: Map<PromptType, string>;
  private cityForecasts: CityForecast[] | null = null;
  private forecasts: Forecast[] = [];

  constructor(
    systemPrompts: Map<PromptType, string>,
    cities: string[] = ['仙台', '東京', '名古屋', '大阪', '福岡']
  ) {
    this.model = createTracedModel({
      modelName: models.scheduledPost,
      apiKey: OPENAI_API_KEY,
    });
    this.cities = [
      ['稚内', '011000'],
      ['根室', '014010'],
      ['札幌', '016010'],
      ['函館', '017010'],
      ['青森', '020010'],
      ['盛岡', '030010'],
      ['仙台', '040010'],
      ['秋田', '050010'],
      ['山形', '060010'],
      ['福島', '070010'],
      ['水戸', '080010'],
      ['宇都宮', '090010'],
      ['前橋', '100010'],
      ['熊谷', '110020'],
      ['銚子', '120020'],
      ['東京', '130010'],
      ['八丈島', '130030'],
      ['横浜', '140010'],
      ['新潟', '150010'],
      ['富山', '160010'],
      ['金沢', '170010'],
      ['福井', '180010'],
      ['甲府', '190010'],
      ['長野', '200010'],
      ['岐阜', '210010'],
      ['浜松', '220040'],
      ['名古屋', '230010'],
      ['津', '240010'],
      ['大津', '250010'],
      ['京都', '260010'],
      ['大阪', '270000'],
      ['神戸', '280010'],
      ['奈良', '290010'],
      ['和歌山', '300010'],
      ['鳥取', '310010'],
      ['松江', '320010'],
      ['岡山', '330010'],
      ['広島', '340010'],
      ['山口', '350020'],
      ['徳島', '360010'],
      ['高松', '370000'],
      ['松山', '380010'],
      ['高知', '390010'],
      ['福岡', '400010'],
      ['佐賀', '410010'],
      ['長崎', '420010'],
      ['熊本', '430010'],
      ['大分', '440010'],
      ['宮崎', '450010'],
      ['鹿児島', '460010'],
      ['那覇', '471010'],
    ];
    this.displayCities = cities;
    this.searchCities = [
      '函館',
      '仙台',
      '水戸',
      '熊谷',
      '東京',
      '名古屋',
      '金沢',
      '新潟',
      '浜松',
      '大阪',
      '広島',
      '高知',
      '福岡',
      '那覇',
    ];
    this.url = 'https://weather.tsukumijima.net/api/forecast?city=';
    this.systemPrompts = systemPrompts;
  }

  public static async create(): Promise<PostWeatherAgent> {
    const promptsName: PromptType[] = [
      'forecast',
      'weather_to_emoji',
    ];
    const systemPrompts = new Map();
    for (const name of promptsName) {
      systemPrompts.set(name, await loadPrompt(name));
    }
    return new PostWeatherAgent(systemPrompts);
  }

  private async getUrl(city: string): Promise<WeatherApiResponse> {
    const response = await axios.get<WeatherApiResponse>(`${this.url}${city}`);
    return response.data;
  }

  private async getTelop(forecastData: WeatherApiForecastItem): Promise<string> {
    return forecastData.telop;
  }

  private getTemperature(forecastData: WeatherApiForecastItem): string {
    const temperatureData = forecastData.temperature;
    const min = temperatureData.min.celsius;
    const max = temperatureData.max.celsius;
    return `${min}-${max}℃`;
  }

  private getChanceOfRain(forecastData: WeatherApiForecastItem): string {
    const chanceOfRainData = forecastData.chanceOfRain;
    logger.debug(`chanceOfRainData: ${JSON.stringify(chanceOfRainData)}`);
    const t00_06 = chanceOfRainData['T00_06'] || '0%';
    const t06_12 = chanceOfRainData['T06_12'] || '0%';
    const t12_18 = chanceOfRainData['T12_18'] || '0%';
    const t18_24 = chanceOfRainData['T18_24'] || '0%';
    const result = `${t00_06}${t06_12}${t12_18}${t18_24}`;
    logger.debug(`chanceOfRain result: ${result}`);
    return result;
  }

  private getWeather(forecastData: WeatherApiForecastItem): string {
    const weatherData = forecastData.detail.weather;
    return weatherData.replace('\u3000', '');
  }

  private async setCityForecasts(): Promise<void> {
    const forecasts: CityForecast[] = [];
    for (const city of this.cities) {
      if (this.searchCities.includes(city[0])) {
        const data = await this.getUrl(city[1]);
        const forecastData = data['forecasts'][1];
        const cityName = city[0];
        const telop = await this.getTelop(forecastData);
        const temperature = this.getTemperature(forecastData);
        const chanceOfRain = this.getChanceOfRain(forecastData);
        const weather = this.getWeather(forecastData);

        // 6時間ごとの天気絵文字を生成
        const weatherEmoji = this.getWeatherEmoji(weather);
        const hourlyEmojis = [weatherEmoji, weatherEmoji, weatherEmoji, weatherEmoji];

        const forecast = {
          city: cityName,
          telop,
          temperature,
          chanceOfRain,
          weather,
          hourlyEmojis
        };
        forecasts.push(forecast);
      }
    }
    this.cityForecasts = forecasts;
  }

  private getTomorrowDate(): string {
    const now = toZonedTime(new Date(), jst);
    const tomorrow = addDays(now, 1);
    const date = format(tomorrow, 'yyyy年MM月dd日');
    const weekdayInt = tomorrow.getDay();
    const weekdayStr = ['日', '月', '火', '水', '木', '金', '土'];
    return `${date}(${weekdayStr[weekdayInt]})`;
  }

  private async getMaxChanceOfRain(chanceOfRain: string): Promise<string> {
    logger.debug(`Input chanceOfRain: ${chanceOfRain}`);
    const chanceOfRainList = chanceOfRain
      .split('%')
      .map(Number)
      .filter((n) => !isNaN(n));
    logger.debug(`chanceOfRainList: ${JSON.stringify(chanceOfRainList)}`);

    if (chanceOfRainList.length === 0) {
      return '0%';
    }

    const maxChanceOfRain = Math.max(...chanceOfRainList);
    return `${maxChanceOfRain}%`;
  }

  private async getComment(): Promise<WeatherResult> {
    const prompt = this.systemPrompts.get('forecast');
    if (!prompt) {
      throw new Error('forecast prompt not found');
    }

    const systemContent = prompt;
    const lastForecast = this.forecasts.length > 0 ? this.forecasts[this.forecasts.length - 1] : null;

    // 天気データを構造化
    const cityData = this.cityForecasts?.map(forecast => {
      const city = forecast.city;
      const temperature = forecast.temperature;
      const weather = forecast.weather;
      const chanceOfRain = forecast.chanceOfRain;
      const hourlyEmojis = forecast.hourlyEmojis;

      return {
        city,
        temperature,
        weather,
        chanceOfRain,
        hourlyEmojis
      };
    });

    const humanContent = `明日の日付: ${this.getTomorrowDate()}\n` +
      `各都市の明日の天気:\n` +
      cityData?.map(data => {
        return `city: ${data.city}\ntemperature: ${data.temperature}\nweather: ${data.weather}\nchanceOfRain: ${data.chanceOfRain}\nhourlyEmojis: ${JSON.stringify(data.hourlyEmojis)}`;
      })
        .join('\n') +
      `${lastForecast ? `\nToday's weather:\n${lastForecast.forecasts}` : ''}`;

    // スキーマ情報を追加したシステムメッセージ - 都市名を使用するように指示
    const enhancedSystemContent = `${systemContent}`;

    try {
      // 構造化出力を得るためのモデル設定
      const structuredLLM = this.model.withStructuredOutput(WeatherSchema);

      // LLMに問い合わせ
      const result = await structuredLLM.invoke([
        new SystemMessage(enhancedSystemContent),
        new HumanMessage(humanContent),
      ]);

      return result;
    } catch (error) {
      logger.error('Error getting weather comment:', error);

      // エラーが発生した場合、基本的な天気予報を返す
      const defaultResult: WeatherResult = {
        date: this.getTomorrowDate(),
        overview: "天気情報の取得に失敗しました。",
        regions: [
          {
            region: "仙台",
            weather: "情報取得エラー",
            temperature: "不明",
            chanceOfRain: "不明",
            hourlyEmojis: ["❓", "❓", "❓", "❓"]
          },
          {
            region: "東京",
            weather: "情報取得エラー",
            temperature: "不明",
            chanceOfRain: "不明",
            hourlyEmojis: ["❓", "❓", "❓", "❓"]
          },
          {
            region: "名古屋",
            weather: "情報取得エラー",
            temperature: "不明",
            chanceOfRain: "不明",
            hourlyEmojis: ["❓", "❓", "❓", "❓"]
          },
          {
            region: "大阪",
            weather: "情報取得エラー",
            temperature: "不明",
            chanceOfRain: "不明",
            hourlyEmojis: ["❓", "❓", "❓", "❓"]
          },
          {
            region: "福岡",
            weather: "情報取得エラー",
            temperature: "不明",
            chanceOfRain: "不明",
            hourlyEmojis: ["❓", "❓", "❓", "❓"]
          }
        ],
        advice: "天気情報の取得がうまくいかなかったみたい…別の情報源で確認してみてね",
        closing: "ごめんね〜また次はちゃんと取れるといいな",
        imagePrompt: "photorealistic, high quality photograph of a cloudy sky over a Japanese city, overcast weather, no people, no characters, no anime, no illustration, no text, no letters, no words, no watermarks",
      };

      return defaultResult;
    }
  }

  private async setForecasts(date: string, forecast: string, weatherData?: WeatherResult): Promise<void> {
    this.forecasts.push({
      date: date,
      forecasts: forecast,
      weatherData: weatherData
    });
  }

  public async createPost(): Promise<WeatherOutput> {
    await this.setCityForecasts();

    // 構造化された天気予報データを取得
    const weatherData = await this.getComment();

    // 構造化データから整形された文字列を生成
    const formattedForecast = this.formatWeatherResult(weatherData);

    const date = this.getTomorrowDate();
    this.setForecasts(date, formattedForecast, weatherData);

    return {
      text: formattedForecast,
      imagePrompt: weatherData.imagePrompt,
    };
  }

  // 天気予報の構造化データを整形するメソッド
  private formatWeatherResult(result: WeatherResult): string {
    let formattedResult = `【明日${result.date}の天気】\n\n`;

    // 地域ごとの天気
    result.regions.forEach(region => {
      // 地域名のパディング（2文字以下の場合は全角スペースを追加）
      const padding = region.region.length <= 2 ? '　'.repeat(3 - region.region.length) : '';
      const regionName = region.region + padding;

      // 6時間ごとの天気絵文字を表示（ない場合はデフォルトの絵文字を4つ表示）
      const hourlyEmojis = region.hourlyEmojis && region.hourlyEmojis.length === 4
        ? region.hourlyEmojis.join('')
        : this.getWeatherEmoji(region.weather).repeat(4);

      formattedResult += `${regionName}：${hourlyEmojis}, ${region.temperature || '不明'}, ${region.chanceOfRain || '0%'}\n`;
    });

    formattedResult += `\n${result.overview}\n\n`;
    formattedResult += `${result.advice}\n\n`;
    formattedResult += result.closing;

    return formattedResult;
  }

  // 天気に応じた絵文字を返すヘルパーメソッド
  private getWeatherEmoji(weather: string): string {
    const weatherMap: Record<string, string> = {
      '晴れ': '☀️',
      '曇り': '☁️',
      '雨': '🌧️',
      '雪': '❄️',
      '雷': '⚡',
      '霧': '🌫️',
      '台風': '🌀',
      '曇のち晴': '🌤️',
      '晴のち曇': '🌥️',
      '晴れ時々曇り': '⛅',
      '曇り時々晴れ': '🌤️',
      '雨時々晴れ': '🌦️',
      '晴れ時々雨': '🌦️',
      '曇り時々雨': '🌧️',
      '雨時々曇り': '🌧️',
      '雪時々晴れ': '🌨️',
      '晴れ時々雪': '🌨️',
      '曇り時々雪': '🌨️',
      '雪時々曇り': '🌨️',
    };

    // 部分一致で検索
    for (const [key, emoji] of Object.entries(weatherMap)) {
      if (weather.includes(key)) {
        return emoji;
      }
    }

    // デフォルトの絵文字
    return '🌈';
  }
}
