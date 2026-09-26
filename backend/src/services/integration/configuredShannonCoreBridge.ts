import type { RequestEnvelope } from '@shannon/common';
import {
  createShannonCoreBridge,
  type ShannonCoreBridge,
  type ShannonCoreContextResult,
} from './shannonCoreBridge.js';

let configuredBridge: Promise<ShannonCoreBridge | null> | undefined;

export async function mirrorCompletedDiscordTurn(envelope: RequestEnvelope, reply: string): Promise<void> {
  configuredBridge ??= import('../../config/env.js')
    .then(({ config }) => createShannonCoreBridge(config.shannonCoreBridge));
  const bridge = await configuredBridge;
  await bridge?.mirrorDiscordTurn(envelope, reply);
}

export async function readShannonCoreDiscordContext(envelope: RequestEnvelope): Promise<ShannonCoreContextResult> {
  try {
    configuredBridge ??= import('../../config/env.js')
      .then(({ config }) => createShannonCoreBridge(config.shannonCoreBridge));
    const bridge = await configuredBridge;
    return bridge ? bridge.readDiscordContext(envelope) : { status: 'ineligible' };
  } catch {
    return { status: 'unavailable' };
  }
}
