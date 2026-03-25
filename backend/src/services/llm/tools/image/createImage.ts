import { StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import OpenAI from 'openai';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from '../../../../config/env.js';
import { models } from '../../../../config/models.js';
import { getTracedOpenAI } from '../../utils/langfuse.js';
import { logger } from '../../../../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default class CreateImageTool extends StructuredTool {
  name = 'create-image';
  description =
    'A tool to create an image from a text description. Use this when you need to create an image.';
  schema = z.object({
    text: z
      .string()
      .describe('The text description of the image you want to create'),
  });
  private openai: OpenAI;
  private outputDir: string;

  constructor() {
    super();
    const openaiApiKey = config.openaiApiKey;
    if (!openaiApiKey) {
      throw new Error('OPENAI_API_KEY environment variable is not set.');
    }
    this.openai = getTracedOpenAI(new OpenAI({ apiKey: openaiApiKey }));

    // 画像保存ディレクトリ
    this.outputDir = join(__dirname, '../../../../../saves/images/generated');
    if (!existsSync(this.outputDir)) {
      mkdirSync(this.outputDir, { recursive: true });
    }
  }

  private static SAFETY_SUFFIX =
    ' Style: friendly and safe for all audiences.' +
    ' STRICT RULES: Do NOT depict any of the following phobia triggers —' +
    ' blood/gore/wounds (hemophobia), needles/syringes/sharp objects (trypanophobia),' +
    ' clusters of small holes or bumps (trypophobia),' +
    ' spiders/snakes/insects shown prominently (arachnophobia/ophidiophobia/entomophobia),' +
    ' creepy clowns or dolls (coulrophobia/pediophobia),' +
    ' dental or surgical procedures, exposed organs or bones.' +
    ' Instead use cheerful, symbolic, or abstract representations. Keep the mood positive and welcoming.';

  async _call(data: z.infer<typeof this.schema>): Promise<string> {
    try {
      const safePrompt = data.text + CreateImageTool.SAFETY_SUFFIX;
      const response = await this.openai.images.generate({
        model: models.imageGeneration,
        prompt: safePrompt,
        n: 1,
        size: '1024x1024',
      });

      // gpt-image-1/1.5 はbase64のみ返す（URLは非対応）
      const b64Json = response.data?.[0]?.b64_json;
      if (b64Json) {
        const filename = `img_${Date.now()}.png`;
        const filepath = join(this.outputDir, filename);
        const imageBuffer = Buffer.from(b64Json, 'base64');
        writeFileSync(filepath, imageBuffer);
        logger.info(`🎨 画像生成完了: ${filepath}`, 'magenta');
        return `Image created and saved to: ${filepath}`;
      }

      // フォールバック: URLがある場合（dall-e系モデルとの互換用）
      const url = response.data?.[0]?.url;
      if (url) {
        return `Image created url: ${url}`;
      }

      return 'Image was generated but no data was returned.';
    } catch (error) {
      logger.error('Image generation error:', error);
      return `An error occurred while generating the image: ${error}`;
    }
  }
}
