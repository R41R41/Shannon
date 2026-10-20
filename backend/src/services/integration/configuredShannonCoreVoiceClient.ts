import { createShannonCoreVoiceClient, type ShannonCoreVoiceClient } from './shannonCoreVoiceClient.js';

let configured: Promise<ShannonCoreVoiceClient | null> | undefined;
let override: ShannonCoreVoiceClient | null | undefined;

/**
 * The voice client built from `config.shannonCoreBridge` (same URL, token and bindings as the text bridge), or null
 * when `SHANNON_DC_VOICE` is off or the bridge is not configured. Never throws.
 */
export async function getConfiguredShannonCoreVoiceClient(): Promise<ShannonCoreVoiceClient | null> {
  if (override !== undefined) return override;
  configured ??= import('../../config/env.js')
    .then(({ config }) => (config.dcVoice.enabled ? createShannonCoreVoiceClient(config.shannonCoreBridge) : null))
    .catch(() => null);
  return configured;
}

/** Tests only. `undefined` restores the configured client. */
export function setShannonCoreVoiceClientForTests(client: ShannonCoreVoiceClient | null | undefined): void {
  override = client;
  configured = undefined;
}
