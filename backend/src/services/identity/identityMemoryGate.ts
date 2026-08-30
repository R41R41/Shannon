import type { RequestEnvelope } from '@shannon/common';
import {
  isMemoryChannelAllowed,
  type IdentityBindingLookup,
} from '../../modules/identity/resolveBinding.js';

function withMemoryDisabled(envelope: RequestEnvelope): RequestEnvelope {
  return Object.freeze({
    ...envelope,
    metadata: Object.freeze({
      ...envelope.metadata,
      memoryDisabled: true,
    }),
  });
}

export async function applyDiscordIdentityMemoryGate(
  envelope: RequestEnvelope,
  projectId: string,
  lookup: IdentityBindingLookup,
  nowMs = Date.now(),
): Promise<RequestEnvelope> {
  if (envelope.channel !== 'discord' || envelope.discord?.isVoiceChannel === true) return envelope;
  const profile = await lookup.findByDiscordUserId(projectId, envelope.sourceUserId);
  return isMemoryChannelAllowed(profile, 'discord_text', nowMs) ? envelope : withMemoryDisabled(envelope);
}

export async function applyWebIdentityMemoryGate(
  envelope: RequestEnvelope,
  projectId: string,
  lookup: IdentityBindingLookup,
  nowMs = Date.now(),
): Promise<RequestEnvelope> {
  if (envelope.channel !== 'web') return envelope;
  const profile = await lookup.findByFirebaseUid(projectId, envelope.sourceUserId);
  return isMemoryChannelAllowed(profile, 'web', nowMs) ? envelope : withMemoryDisabled(envelope);
}
