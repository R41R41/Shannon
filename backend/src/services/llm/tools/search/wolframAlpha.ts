import { StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { createRequire } from 'module';
import { config } from '../../../../config/env.js';
import { logger } from '../../../../utils/logger.js';
const require = createRequire(import.meta.url);
const WolframAlphaAPI = require('@wolfram-alpha/wolfram-alpha-api');

export default class WolframAlphaTool extends StructuredTool {
  name = 'wolfram-alpha-tool';
  description =
    'A versatile knowledge tool that answers science and data-based questions including mathematical calculations, physics, chemistry, astronomy, geography, finance and more';
  schema = z.object({
    query: z
      .string()
      .describe(
        'English question content (example: 2x + 3 = 7 solution, Mount Fuji height, 2024 Olympic gold medal count, Tokyo to Osaka distance, stock price data, nutrition calculation, next holiday, sunrise/sunset time, etc.)'
      ),
  });
  private wolframClient: any;
  private disabled: boolean;

  constructor() {
    super();
    const wolframAppId = config.wolframAlpha.appId;
    this.disabled = !wolframAppId;

    if (this.disabled) {
      logger.warn('[WolframAlpha] WOLFRAM_ALPHA_APPID is not set. Tool will return an error message when called.');
      this.wolframClient = null;
    } else {
      this.wolframClient = WolframAlphaAPI(wolframAppId);
    }
  }

  async _call(data: z.infer<typeof this.schema>): Promise<string> {
    if (this.disabled) {
      return 'Wolfram Alphaは現在利用できません（WOLFRAM_ALPHA_APPID が未設定です）。';
    }

    try {
      const result = await this.wolframClient.getFull({
        input: data.query,
        format: 'plaintext',
      });
      if (typeof result === 'object') {
        return JSON.stringify(result);
      }
      return result || 'No answer found.';
    } catch (error) {
      logger.error('Wolfram Alpha error:', error);
      return `An error occurred during calculation: ${error}`;
    }
  }
}
