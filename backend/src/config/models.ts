/**
 * Centralized LLM model configuration.
 *
 * All model names are defined here. Changing a model across
 * the entire application only requires editing this file.
 *
 * Usage:
 *   import { models } from '../../config/models.js';
 *   const llm = new ChatOpenAI({ modelName: models.functionCalling });
 */

export const models = {
  /** Main function-calling agent model (Discord/WebUI). Fast non-reasoning default. */
  functionCalling: 'gpt-4.1-mini',

  /** Emotion analysis model (lightweight, fast) */
  emotion: 'gpt-4.1-nano',

  /** Minebot planning model (reasoning-focused) */
  planning: 'o4-mini',

  /** Content generation: reply to comments, fortune, etc. */
  contentGeneration: 'gpt-5.5',

  /** Scheduled posting agents (weather, news, about-today) */
  scheduledPost: 'gpt-5-mini',

  /** Auto-tweet: exploration phase (tool-calling agent) */
  autoTweetExplore: 'gpt-4.1-mini',

  /** Auto-tweet: creative generation phase */
  autoTweetGenerate: 'gpt-5.5',

  /** Auto-tweet: review phase */
  autoTweetReview: 'gpt-4.1-mini',

  /** Legacy alias: used by generateTweetText, scheduled post review, etc. */
  autoTweet: 'gpt-4.1-mini',

  /** Vision / image description (gpt-4.1-mini: no thinking tokens, good vision support) */
  vision: 'gpt-4.1-mini',

  /** Image generation */
  imageGeneration: 'gpt-image-1.5',

  /** Blueprint creation (minebot) */
  blueprint: 'gpt-4.1-mini',

  /** Emergency responder (minebot) */
  emergency: 'gpt-4.1-mini',

  /** Realtime API (voice) */
  realtime: 'gpt-realtime-mini',

  /** TTS text preprocessing (English→Katakana) */
  ttsPreprocess: 'gpt-4.1-nano',

  /** Audio transcription */
  whisper: 'whisper-1',

  // --- Minebot config (used by MinebotConfig) ---
  minebot: {
    centralAgent: 'gpt-4.1-mini',
    execution: 'gpt-4.1-mini',
    functionCalling: 'gpt-4.1-mini',
  },
} as const;

export type ModelName = (typeof models)[keyof Omit<typeof models, 'minebot'>];
