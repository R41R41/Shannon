import type { IdentityProfileRecord, StoredChannelBinding } from './bindingWrite.js';
import { IdentityGateError } from './resolveBinding.js';

function linkedLineBinding(binding: StoredChannelBinding | undefined, lineUserId: string, nowMs: number): boolean {
  if (!binding || binding.externalId !== lineUserId) return false;
  if (binding.expiresAtIso && Date.parse(binding.expiresAtIso) <= nowMs) return false;
  return true;
}

/** No stored profile yet: keep current behavior. Once saved, binding + audience flags apply. */
export function isLineDeliveryAllowed(
  profile: IdentityProfileRecord | null,
  lineUserId: string,
  nowMs = Date.now(),
): boolean {
  if (!profile) return true;
  if (!profile.audience.lineDeliveryEnabled) return false;
  return linkedLineBinding(profile.bindings.line, lineUserId, nowMs);
}

export function assertLinePersonalAccess(
  profile: IdentityProfileRecord | null,
  lineUserId: string,
  nowMs = Date.now(),
): void {
  if (!isLineDeliveryAllowed(profile, lineUserId, nowMs)) throw new IdentityGateError('FORBIDDEN');
}
