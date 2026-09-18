/**
 * ランタイムで LLM モデルを切り替え可能にするマネージャー。
 * models.ts の静的設定をベースに、API 経由でオーバーライドできる。
 */
import { models } from './models.js';
import { logger } from '../utils/logger.js';

type ModelKey = keyof Omit<typeof models, 'minebot'>;
type MinebotModelKey = keyof typeof models.minebot;

const overrides: Partial<Record<ModelKey, string>> = {};
const minebotOverrides: Partial<Record<MinebotModelKey, string>> = {};

/**
 * GPT-6 Astra is intentionally disabled for Shannon. Its price profile is not
 * appropriate for automatic routing, and an API override must not bypass that
 * product decision.
 */
export function assertModelIsAllowed(model: string): void {
  if (/^gpt-6-astra(?:-|$)/i.test(model.trim())) {
    throw new Error('GPT-6 Astra is disabled for Shannon because of its cost.');
  }
}

export const modelManager = {
  get(key: ModelKey): string {
    return overrides[key] ?? models[key];
  },

  getMinebotModel(key: MinebotModelKey): string {
    return minebotOverrides[key] ?? models.minebot[key];
  },

  set(key: ModelKey, model: string): void {
    assertModelIsAllowed(model);
    logger.info(`[ModelManager] ${key}: ${modelManager.get(key)} → ${model}`, 'cyan');
    overrides[key] = model;
  },

  setMinebotModel(key: MinebotModelKey, model: string): void {
    assertModelIsAllowed(model);
    logger.info(`[ModelManager] minebot.${key}: ${modelManager.getMinebotModel(key)} → ${model}`, 'cyan');
    minebotOverrides[key] = model;
  },

  reset(key: ModelKey): void {
    delete overrides[key];
    logger.info(`[ModelManager] ${key} をデフォルト (${models[key]}) にリセット`, 'cyan');
  },

  resetAll(): void {
    Object.keys(overrides).forEach((k) => delete overrides[k as ModelKey]);
    Object.keys(minebotOverrides).forEach((k) => delete minebotOverrides[k as MinebotModelKey]);
    logger.info('[ModelManager] 全モデルをデフォルトにリセット', 'cyan');
  },

  getAll(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const key of Object.keys(models) as Array<keyof typeof models>) {
      if (key === 'minebot') {
        for (const mk of Object.keys(models.minebot) as MinebotModelKey[]) {
          result[`minebot.${mk}`] = modelManager.getMinebotModel(mk);
        }
      } else {
        result[key] = modelManager.get(key as ModelKey);
      }
    }
    return result;
  },

  getOverrides(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [k, v] of Object.entries(overrides)) {
      result[k] = v;
    }
    for (const [k, v] of Object.entries(minebotOverrides)) {
      result[`minebot.${k}`] = v;
    }
    return result;
  },
};
