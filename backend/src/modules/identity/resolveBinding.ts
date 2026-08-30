import type { RequestContext } from '../access/index.js';
import type { AllowedMemoryChannel, IdentityProfileRecord, StoredChannelBinding } from './bindingWrite.js';

export class IdentityGateError extends Error {
  constructor(readonly code: 'FORBIDDEN' | 'UNAVAILABLE') {
    super(code);
  }
}

function linkedBindingStatus(binding: StoredChannelBinding | undefined, nowMs: number): 'unlinked' | 'linked' | 'expired' {
  if (!binding) return 'unlinked';
  if (binding.expiresAtIso && Date.parse(binding.expiresAtIso) <= nowMs) return 'expired';
  return 'linked';
}

/** No stored profile yet: keep current prod behavior. Once saved, audience flags apply. */
export function isRadarPersonalFeedAllowed(profile: IdentityProfileRecord | null, _nowMs = Date.now()): boolean {
  if (!profile) return true;
  return profile.audience.radarPersonalFeed === true;
}

export function isMemoryChannelAllowed(
  profile: IdentityProfileRecord | null,
  channel: AllowedMemoryChannel,
  nowMs = Date.now(),
): boolean {
  if (!profile) return true;
  if (!profile.audience.memoryChannels.includes(channel)) return false;
  if (channel === 'discord_text') return linkedBindingStatus(profile.bindings.discord, nowMs) === 'linked';
  return true;
}

export function assertRadarPersonalFeedAccess(profile: IdentityProfileRecord | null, nowMs = Date.now()): void {
  if (!isRadarPersonalFeedAllowed(profile, nowMs)) throw new IdentityGateError('FORBIDDEN');
}

export interface IdentityBindingLookup {
  findForContext(context: RequestContext): Promise<IdentityProfileRecord | null>;
  findByDiscordUserId(projectId: string, discordUserId: string): Promise<IdentityProfileRecord | null>;
  findByFirebaseUid(projectId: string, firebaseUid: string): Promise<IdentityProfileRecord | null>;
  findByLineUserId(projectId: string, lineUserId: string): Promise<IdentityProfileRecord | null>;
}
