import axios from 'axios';
import { config } from '../../config/env.js';
import { models } from '../../config/models.js';
import { logger } from '../../utils/logger.js';

export interface VoicepeakEmotion {
  happy?: number;
  fun?: number;
  angry?: number;
  sad?: number;
}

export interface VoicepeakOptions {
  narrator?: string;
  speed?: number;
  pitch?: number;
  emotion?: VoicepeakEmotion;
}

const VOICEPEAK_COOLDOWN_MS = 200;
const VOICEPEAK_MAX_RETRIES = 2;

export class VoicepeakClient {
  private static instance: VoicepeakClient;
  private serverUrl: string;
  private defaultNarrator: string;
  private lastCallTime = 0;

  private constructor() {
    this.serverUrl = config.voicepeak.serverUrl;
    this.defaultNarrator = config.voicepeak.narrator;
  }

  public static getInstance(): VoicepeakClient {
    if (!VoicepeakClient.instance) {
      VoicepeakClient.instance = new VoicepeakClient();
    }
    return VoicepeakClient.instance;
  }

  /**
   * テキストから VoicePeak 感情パラメータを推定する（0〜100）
   * 全文を一度だけ分析し、全センテンスに共通適用する想定
   */
  public async analyzeEmotionForTTS(text: string): Promise<VoicepeakEmotion> {
    try {
      const response = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: models.ttsPreprocess,
          messages: [
            {
              role: 'system',
              content:
                '以下のテキストの感情を分析し、音声合成用の感情パラメータをJSON形式で返してください。' +
                '各値は0〜100の整数。キーは happy, fun, angry, sad の4つ。' +
                '例: {"happy":60,"fun":40,"angry":0,"sad":0}' +
                '\nJSONのみ出力。説明不要。',
            },
            { role: 'user', content: text },
          ],
          temperature: 0,
          max_tokens: 64,
        },
        {
          headers: {
            Authorization: `Bearer ${config.openaiApiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 10000,
        },
      );

      const raw = response.data?.choices?.[0]?.message?.content?.trim();
      if (raw) {
        const parsed = JSON.parse(raw);
        const emotion: VoicepeakEmotion = {
          happy: Math.min(100, Math.max(0, Math.round(parsed.happy ?? 0))),
          fun: Math.min(100, Math.max(0, Math.round(parsed.fun ?? 0))),
          angry: Math.min(100, Math.max(0, Math.round(parsed.angry ?? 0))),
          sad: Math.min(100, Math.max(0, Math.round(parsed.sad ?? 0))),
        };
        logger.info(
          `[VOICEPEAK] Emotion: happy=${emotion.happy} fun=${emotion.fun} angry=${emotion.angry} sad=${emotion.sad}`,
          'cyan',
        );
        return emotion;
      }
    } catch (error) {
      logger.warn('[VOICEPEAK] 感情分析失敗, デフォルト感情を使用');
    }
    return { happy: 30, fun: 30, angry: 0, sad: 0 };
  }

  /**
   * 英語をカタカナ読みに変換（TTS の発音改善用）
   * ASCII 英字を含まないテキストはそのまま返す
   */
  async convertEnglishToKatakana(text: string): Promise<string> {
    if (!/[a-zA-Z]/.test(text)) return text;

    try {
      const response = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: models.ttsPreprocess,
          messages: [
            {
              role: 'system',
              content:
                'テキスト中の英語（単語・複合語・スネークケース等）を全て自然なカタカナ読みに置き換えてください。' +
                'スネークケース（例: oak_log）はアンダースコアを無視して一つの名前として読む（例: オークログ）。' +
                '日本語・記号・数字はそのまま残す。変換後のテキストのみ出力。',
            },
            { role: 'user', content: text },
          ],
          temperature: 0,
          max_tokens: Math.max(256, text.length * 3),
        },
        {
          headers: {
            Authorization: `Bearer ${config.openaiApiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 10000,
        },
      );

      const result = response.data?.choices?.[0]?.message?.content;
      if (result) {
        const converted = result.trim();
        if (converted !== text) {
          logger.debug(`[VOICEPEAK] EN→カナ: "${text.substring(0, 60)}" → "${converted.substring(0, 60)}"`);
        }
        return converted;
      }
      return text;
    } catch (error) {
      logger.warn('[VOICEPEAK] EN→カナ変換失敗, 元テキスト使用');
      return text;
    }
  }

  /**
   * 感情分析 + 全文カタカナ変換を並列実行し、前処理済みデータを返す。
   * Minebot voice 等のバッチ TTS で使用。
   */
  async preprocessBatch(
    fullText: string,
    sentences: string[],
  ): Promise<{ emotion: VoicepeakEmotion; convertedSentences: string[] }> {
    const t0 = Date.now();
    const [emotion, ...convertedSentences] = await Promise.all([
      this.analyzeEmotionForTTS(fullText),
      ...sentences.map(s => this.convertEnglishToKatakana(s)),
    ]);
    logger.info(
      `[VOICEPEAK] preprocessBatch: ${sentences.length} sentences parallelized in ${Date.now() - t0}ms`,
      'cyan',
    );
    return { emotion, convertedSentences };
  }

  /**
   * 前処理済みテキストから WAV 音声を生成（カタカナ変換スキップ）。
   */
  async synthesizePreprocessed(convertedText: string, options?: VoicepeakOptions): Promise<Buffer> {
    return this._synthesizeCore(convertedText, options);
  }

  /**
   * テキストからWAV音声を生成
   * @returns WAVバイナリのBuffer
   */
  async synthesize(text: string, options?: VoicepeakOptions): Promise<Buffer> {
    const convertedText = await this.convertEnglishToKatakana(text);
    return this._synthesizeCore(convertedText, options);
  }

  private async _synthesizeCore(convertedText: string, options?: VoicepeakOptions): Promise<Buffer> {
    const body = {
      text: convertedText,
      narrator: options?.narrator ?? this.defaultNarrator,
      speed: options?.speed ?? 100,
      pitch: options?.pitch ?? 0,
      emotion: options?.emotion,
    };

    logger.info(`[VOICEPEAK] Synthesizing: "${convertedText.substring(0, 50)}..."`, 'cyan');

    // Enforce cooldown between calls to prevent CLI instance collision
    const elapsed = Date.now() - this.lastCallTime;
    if (elapsed < VOICEPEAK_COOLDOWN_MS) {
      await new Promise(r => setTimeout(r, VOICEPEAK_COOLDOWN_MS - elapsed));
    }

    for (let attempt = 0; attempt <= VOICEPEAK_MAX_RETRIES; attempt++) {
      try {
        this.lastCallTime = Date.now();
        const response = await axios.post(`${this.serverUrl}/tts`, body, {
          responseType: 'arraybuffer',
          timeout: 30000,
          headers: { 'Content-Type': 'application/json' },
        });

        const wavBuffer = Buffer.from(response.data);
        logger.info(`[VOICEPEAK] Generated ${wavBuffer.length} bytes`, 'green');
        return wavBuffer;
      } catch (error) {
        const is500 = axios.isAxiosError(error) && error.response?.status === 500;
        if (is500 && attempt < VOICEPEAK_MAX_RETRIES) {
          const wait = VOICEPEAK_COOLDOWN_MS * (attempt + 2);
          logger.warn(`[VOICEPEAK] Instance busy, retry ${attempt + 1}/${VOICEPEAK_MAX_RETRIES} after ${wait}ms`);
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
        if (axios.isAxiosError(error)) {
          const detail = error.response
            ? `status=${error.response.status} ${Buffer.from(error.response.data).toString()}`
            : error.message;
          logger.error(`[VOICEPEAK] TTS request failed: ${detail}`);
        } else {
          logger.error(`[VOICEPEAK] TTS request failed: ${error}`);
        }
        throw error;
      }
    }
    throw new Error('[VOICEPEAK] Unreachable');
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await axios.get(`${this.serverUrl}/health`, { timeout: 5000 });
      return res.status === 200;
    } catch {
      return false;
    }
  }
}
