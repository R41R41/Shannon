import { createOpenAiFcaModel } from '../fca/openAiFcaModel.js';
import type { RadarFcaModel } from './radarFca.js';

/** Explicit stateless provider adapter. Tools exist only for the current kernel catalog. */
export function createRadarFcaModel(input: { apiKey: string; model: string }): RadarFcaModel {
  try {
    return createOpenAiFcaModel({ apiKey: input.apiKey, model: input.model, maxTokens: 1200, temperature: 0.4, timeoutMs: 30000 });
  } catch {
    throw new Error('RADAR_FCA_MODEL_CONFIG_INVALID');
  }
}
