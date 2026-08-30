import { describe, expect, it } from 'vitest';
import { InMemoryIdentityProfileRepository } from '../../src/adapters/identity/MongoIdentityProfileRepository.js';
import { IdentityBindingWriteService } from '../../src/modules/identity/index.js';
import { assertLinePersonalAccess, isLineDeliveryAllowed } from '../../src/modules/identity/lineIdentityGate.js';
import { IdentityGateError } from '../../src/modules/identity/resolveBinding.js';
import { authorizeLinePersonal, InMemoryLineIdentityPort } from '../../src/services/line/lineIdentityPort.js';
import type { RequestContext } from '../../src/modules/access/index.js';

const lineUserId = 'U' + 'a'.repeat(32);
const context: RequestContext = Object.freeze({
  requestId: 'req-line',
  principal: Object.freeze({ uid: 'firebase-user', projectId: 'dev-project', name: 'Test', email: 'test@example.test' }),
  capabilities: Object.freeze(['profile:read']),
  expiresAtMs: Date.now() + 60_000,
});

describe('LINE identity gate', () => {
  it('allows personal traffic when no profile is stored yet', () => {
    expect(isLineDeliveryAllowed(null, lineUserId)).toBe(true);
    expect(() => assertLinePersonalAccess(null, lineUserId)).not.toThrow();
  });

  it('requires linked LINE binding and lineDeliveryEnabled once a profile exists', async () => {
    const profiles = new InMemoryIdentityProfileRepository();
    const write = new IdentityBindingWriteService(profiles);
    await write.link(context, 'line', { confirm: true, lineUserId });
    const profile = await profiles.find(context);
    expect(isLineDeliveryAllowed(profile, lineUserId)).toBe(false);

    await write.updateAudience(context, {
      confirm: true,
      memoryChannels: ['web'],
      lineDeliveryEnabled: true,
      radarPersonalFeed: true,
    });
    const allowed = await profiles.find(context);
    expect(isLineDeliveryAllowed(allowed, lineUserId)).toBe(true);
    expect(isLineDeliveryAllowed(allowed, 'U' + 'b'.repeat(32))).toBe(false);
  });

  it('finds profiles by LINE user id and authorizes through the LINE port', async () => {
    const profiles = new InMemoryIdentityProfileRepository();
    const write = new IdentityBindingWriteService(profiles);
    await write.link(context, 'line', { confirm: true, lineUserId });
    await write.updateAudience(context, {
      confirm: true,
      memoryChannels: ['web'],
      lineDeliveryEnabled: true,
      radarPersonalFeed: false,
    });
    const stored = await profiles.findByLineUserId('dev-project', lineUserId);
    expect(stored?.bindings.line?.externalId).toBe(lineUserId);

    const port = new InMemoryLineIdentityPort();
    if (stored) port.seed(stored);
    await expect(authorizeLinePersonal(port, 'dev-project', lineUserId)).resolves.toBeUndefined();

    const blocked = new InMemoryLineIdentityPort();
    if (stored) {
      blocked.seed({
        ...stored,
        audience: { ...stored.audience, lineDeliveryEnabled: false },
      });
    }
    await expect(authorizeLinePersonal(blocked, 'dev-project', lineUserId)).rejects.toBeInstanceOf(IdentityGateError);
  });
});
