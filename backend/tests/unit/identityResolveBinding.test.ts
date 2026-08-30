import { describe, expect, it } from 'vitest';
import {
  assertRadarPersonalFeedAccess,
  IdentityGateError,
  isMemoryChannelAllowed,
  isRadarPersonalFeedAllowed,
} from '../../src/modules/identity/resolveBinding.js';
import type { IdentityProfileRecord } from '../../src/modules/identity/bindingWrite.js';

const profile = (overrides: Partial<IdentityProfileRecord> = {}): IdentityProfileRecord => Object.freeze({
  firebaseProjectId: 'dev-project',
  firebaseUid: 'firebase-user',
  bindings: Object.freeze({}),
  audience: Object.freeze({
    memoryChannels: Object.freeze(['discord_text', 'web']),
    lineDeliveryEnabled: false,
    radarPersonalFeed: false,
  }),
  revision: 1,
  ...overrides,
});

describe('identity resolveBinding', () => {
  it('allows radar when no profile is stored yet', () => {
    expect(isRadarPersonalFeedAllowed(null)).toBe(true);
    expect(() => assertRadarPersonalFeedAccess(null)).not.toThrow();
  });

  it('requires radarPersonalFeed once a profile exists', () => {
    expect(isRadarPersonalFeedAllowed(profile())).toBe(false);
    expect(isRadarPersonalFeedAllowed(profile({ audience: Object.freeze({ memoryChannels: Object.freeze([]), lineDeliveryEnabled: false, radarPersonalFeed: true }) }))).toBe(true);
    expect(() => assertRadarPersonalFeedAccess(profile())).toThrow(IdentityGateError);
  });

  it('allows discord memory without a profile or with linked discord binding', () => {
    expect(isMemoryChannelAllowed(null, 'discord_text')).toBe(true);
    expect(isMemoryChannelAllowed(profile({ bindings: Object.freeze({ discord: Object.freeze({ externalId: '123456789012345678', label: 'Discord', linkedAtIso: '2026-01-01T00:00:00.000Z' }) }) }), 'discord_text')).toBe(true);
  });

  it('blocks discord memory when audience excludes discord_text or binding is missing', () => {
    expect(isMemoryChannelAllowed(profile({ audience: Object.freeze({ memoryChannels: Object.freeze(['web']), lineDeliveryEnabled: false, radarPersonalFeed: false }) }), 'discord_text')).toBe(false);
    expect(isMemoryChannelAllowed(profile(), 'discord_text')).toBe(false);
  });
});
