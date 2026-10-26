import type { RequestEnvelope } from '@shannon/common';
import {
  createShannonCoreBridge,
  type ShannonCoreBridge,
  type ShannonCoreContextResult,
  type ShannonCoreReplyResult,
} from './shannonCoreBridge.js';
import type { DiscordReactionInput } from './oneHeadConverse.js';

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

/** One head: a reaction someone put on a message or took off, to the head (`POST /v1/platform/reactions`). Never throws. */
export async function sendShannonCoreDiscordReaction(input: DiscordReactionInput): Promise<void> {
  try {
    configuredBridge ??= import('../../config/env.js')
      .then(({ config }) => createShannonCoreBridge(config.shannonCoreBridge));
    const bridge = await configuredBridge;
    await bridge?.sendDiscordReaction(input);
  } catch { /* Best effort: a reaction the head missed changes nothing else. */ }
}

/** Her reply from the companion (`SHANNON_CORE_PLATFORM_REPLY=true`), or why the legacy path answers. Never throws. */
export async function requestShannonCoreDiscordReply(envelope: RequestEnvelope): Promise<ShannonCoreReplyResult> {
  try {
    configuredBridge ??= import('../../config/env.js')
      .then(({ config }) => createShannonCoreBridge(config.shannonCoreBridge));
    const bridge = await configuredBridge;
    return bridge ? await bridge.requestDiscordReply(envelope) : { status: 'ineligible' };
  } catch {
    return { status: 'unavailable' };
  }
}
