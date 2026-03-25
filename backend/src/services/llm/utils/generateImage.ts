import OpenAI from 'openai';
import { config } from '../../../config/env.js';
import { models } from '../../../config/models.js';
import { getTracedOpenAI } from './langfuse.js';
import { logger } from '../../../utils/logger.js';

const openai = getTracedOpenAI(new OpenAI({ apiKey: config.openaiApiKey }));

/**
 * OpenAI gpt-image でテキストから画像を生成し、Buffer を返す。
 * 失敗時は null を返す。
 */
export async function generateImage(
  prompt: string,
  size: '1024x1024' | '1536x1024' | '1024x1536' = '1024x1024',
  quality: 'low' | 'medium' | 'high' | 'auto' = 'low',
): Promise<Buffer | null> {
  try {
    logger.info(
      `[generateImage] 生成中... model=${models.imageGeneration} size=${size} quality=${quality}`,
      'cyan',
    );

    const response = await openai.images.generate({
      model: models.imageGeneration,
      prompt,
      n: 1,
      size,
      quality,
      output_format: 'jpeg',
    } as Parameters<typeof openai.images.generate>[0]);

    const b64 = response.data?.[0]?.b64_json;
    if (b64) {
      const buf = Buffer.from(b64, 'base64');
      logger.info(
        `[generateImage] 成功 (${(buf.length / 1024).toFixed(1)} KB)`,
        'green',
      );
      return buf;
    }

    // URL形式で返ってきた場合
    const url = response.data?.[0]?.url;
    if (url) {
      const { default: axios } = await import('axios');
      const imgRes = await axios.get(url, { responseType: 'arraybuffer' });
      const buf = Buffer.from(imgRes.data);
      logger.info(
        `[generateImage] 成功 (URL→Buffer, ${(buf.length / 1024).toFixed(1)} KB)`,
        'green',
      );
      return buf;
    }

    logger.warn('[generateImage] レスポンスに画像データなし');
    return null;
  } catch (error: unknown) {
    logger.error(`[generateImage] エラー: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
